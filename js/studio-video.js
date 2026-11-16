/* ==========================================================================
 * studio-video.js · 白膜预演视频导出（v1.6，零依赖）
 *
 * 思路：不引 ffmpeg、不装编码器。
 *   1) 独立 WebGLRenderer 按目标分辨率离屏渲染（不劫持主视口画布）；
 *   2) 每帧按时间线采样机位（timeline.sampleShots，与播放完全同一套插值）；
 *   3) 画到一张 2D canvas 上（可选过 FilmGrade 成片管线），
 *   4) canvas.captureStream(fps) + MediaRecorder 录成 WebM（VP9 优先，退 VP8）。
 *
 * 已知：MediaRecorder 是**实时录制**，所以导出耗时 ≈ 分镜总时长；
 * 需要 MP4 时用 ffmpeg 转一次（README 里有命令）。
 * ========================================================================== */
import * as THREE from 'three';
import { sampleShots, shotsTotalDuration } from './timeline.js?v=75';

const ed = () => (window.__wb && window.__wb.editor) || null;
const tlm = () => (window.__wb && window.__wb.timeline) || null;

function pickMime() {
  const cands = [
    'video/mp4;codecs=avc1.42E01E',   // H.264 MP4（Chrome 130+ 原生可录）
    'video/mp4;codecs=avc1',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  for (const m of cands) {
    try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (_) {}
  }
  return null;
}

/**
 * 导出预演视频。
 * @param {{w?:number,h?:number,fps?:number,mode?:'wb'|'film',download?:boolean,onProgress?:Function,signal?:{cancelled:boolean}}} opts
 * @returns {Promise<{ok:boolean, bytes?:number, seconds?:number, mime?:string, error?:string}>}
 */
export async function exportVideo(opts = {}) {
  const w = Math.max(320, Math.min(3840, opts.w || 1280));
  const h = Math.max(180, Math.min(2160, opts.h || 720));
  const fps = Math.max(12, Math.min(60, opts.fps || 30));
  const mode = opts.mode === 'film' ? 'film' : 'wb';
  const download = opts.download !== false;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const signal = opts.signal || { cancelled: false };

  const e = ed();
  const t = tlm();
  if (!e || !e.scene || !e.camera) return { ok: false, error: '请先打开一个场景' };
  if (!t) return { ok: false, error: '时间线未就绪' };

  const shots = (t.getShots ? t.getShots() : []).map(s => s);
  if (!shots.length) return { ok: false, error: '还没有镜头：先在底部时间线加几个镜头' };

  const mime = pickMime();
  if (!mime) return { ok: false, error: '当前浏览器不支持 MediaRecorder 录制' };

  const total = shotsTotalDuration(shots);
  if (!(total > 0)) return { ok: false, error: '分镜总时长为 0' };

  /* ---------- 离屏渲染器 ---------- */
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = Number(e.exposure || 1);

  const cam = new THREE.PerspectiveCamera(Number(e.camera.fov) || 45, w / h, Number(e.camera.near) || 0.1, Number(e.camera.far) || 500);

  /* ---------- 2D 输出面 ---------- */
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');

  const chunks = [];
  const stream = out.captureStream(fps);
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(w * h * fps * 0.12) });
  } catch (err) {
    renderer.dispose();
    return { ok: false, error: '录制初始化失败：' + ((err && err.message) || err) };
  }
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };

  const done = new Promise((resolve) => { rec.onstop = resolve; });
  rec.start(250);

  const FG = window.FilmGrade;
  const filmParams = mode === 'film' && FG ? FG.fromEditor(e) : null;
  if (filmParams && filmParams.off) filmParams.letterbox = null;

  /* ---------- 按实时时钟推进 ---------- */
  const applyCam = (c) => {
    const r = Math.max(0.05, c.r);
    const tx = c.t[0], ty = c.t[1], tz = c.t[2];
    cam.position.set(
      tx + r * Math.sin(c.phi) * Math.sin(c.theta),
      ty + r * Math.cos(c.phi),
      tz + r * Math.sin(c.phi) * Math.cos(c.theta)
    );
    cam.lookAt(tx, ty, tz);
    if (c.fov && Math.abs(c.fov - cam.fov) > 0.01) {
      cam.fov = c.fov;
      cam.updateProjectionMatrix();
    }
  };

  const start = performance.now();
  let raf = 0;
  let timer = 0;
  let lastT = -1;
  // ★ 2026-11-10：**不要只靠 rAF 驱动**。
  //   页面在后台/被遮挡时，Chrome 会**饿死 rAF**（实测：页面 hidden 时
  //   第一个 rAF 回调等了 **214 秒**）⇒ 1 秒的视频导出要 337 秒。
  //   ⇒ 加一个 setTimeout 兜底（后台标签页的 setTimeout 会被限到 1 秒，
  //     但**不会饿死**），谁先到谁执行下一步。
  const schedule = () => {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      frame();
    };
    raf = requestAnimationFrame(once);
    timer = setTimeout(once, 16);
  };
  const frame = () => {
    if (signal.cancelled) { try { rec.stop(); } catch (_) {} return; }
    const elapsed = (performance.now() - start) / 1000;
    const ct = Math.min(total, elapsed);
    const sample = sampleShots(shots, ct);
    if (sample && sample.cam) applyCam(sample.cam);

    // ★ 2026-11-08：视频录制也套上「成片预览」那套真实感
    const RL = window.__ovfRealLook;
    const restoreReal = (RL && RL.isReal())
      ? RL.applyCurrent(e.scene, e, renderer)
      : null;
    renderer.render(e.scene, cam);
    if (restoreReal) restoreReal();

    if (mode === 'film' && FG) {
      // 调色跟小窗用同一份（真实感开着时）
      const gopts = (RL && RL.isReal())
        ? Object.assign({}, FG.fromEditor(e), RL.gradeForLook(RL.getLook()))
        : Object.assign({}, FG.fromEditor(e), {});
      FG.apply(ctx, renderer.domElement, w, h, gopts);
    } else {
      ctx.drawImage(renderer.domElement, 0, 0, w, h);
    }

    if (Math.abs(ct - lastT) > 0.05) {
      lastT = ct;
      onProgress(ct / total, ct, total);
    }

    if (ct >= total) {
      // 多录 250ms 收尾，避免最后一帧被切掉
      setTimeout(() => { try { rec.stop(); } catch (_) {} }, 260);
      return;
    }
    schedule();
  };
  schedule();

  await done;
  cancelAnimationFrame(raf);
  try { clearTimeout(timer); } catch (_) {}
  try { stream.getTracks().forEach(tr => tr.stop()); } catch (_) {}
  renderer.dispose();

  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  if (download) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const ext = /mp4/i.test(mime) ? '.mp4' : '.webm';
    a.download = '白膜预演_' + (mode === 'film' ? '成片_' : '') + w + 'x' + h + '_' + Math.round(total) + 's' + ext;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  return { ok: true, bytes: blob.size, seconds: +total.toFixed(2), mime, w, h, fps, mode };
}

/* ------------------------------------------------------------ */
/* 导出对话框                                                    */
/* ------------------------------------------------------------ */
let dlg = null;

export function openVideoDialog() {
  closeVideoDialog();
  const e = ed();
  const t = tlm();
  const shots = (t && t.getShots) ? t.getShots() : [];
  const total = shots.length ? shotsTotalDuration(shots) : 0;

  dlg = document.createElement('div');
  dlg.id = 'videoDlg';
  dlg.className = 'vid-dialog';
  dlg.innerHTML = `
    <div class="vid-card">
      <header><b>导出白膜视频</b><button type="button" data-close>×</button></header>
      <div class="vid-body">
        <div class="vid-row">
          <label>分辨率</label>
          <select id="vidRes">
            <option value="1280x720">1280 × 720</option>
            <option value="1920x1080" selected>1920 × 1080</option>
            <option value="2560x1440">2560 × 1440</option>
            <option value="3840x2160">3840 × 2160</option>
          </select>
        </div>
        <div class="vid-row">
          <label>帧率</label>
          <select id="vidFps"><option value="24">24</option><option value="30" selected>30</option><option value="60">60</option></select>
        </div>
        <div class="vid-row">
          <label>画面</label>
          <select id="vidMode">
            <option value="wb" selected>白膜（原样）</option>
            <option value="film">成片（辉光/颗粒/遮幅）</option>
          </select>
        </div>
        <div class="vid-meta" id="vidMeta">${shots.length ? shots.length + ' 个镜头 · 总时长 ' + total.toFixed(1) + 's' : '还没有镜头（先在底部时间线加镜头）'}</div>
        <div class="vid-bar"><i id="vidBar" style="width:0%"></i></div>
        <div class="vid-hint" id="vidHint">录制是实时的：导出耗时 ≈ 视频时长。输出优先 MP4（H.264 avc1），浏览器不支持时自动退 WebM。</div>
      </div>
      <footer>
        <button type="button" class="vid-btn ghost" data-close>取消</button>
        <button type="button" class="vid-btn" id="vidStart" ${shots.length ? '' : 'disabled'}>开始导出</button>
      </footer>
    </div>`;
  document.body.appendChild(dlg);

  dlg.addEventListener('click', (ev) => {
    if (ev.target === dlg || ev.target.closest('[data-close]')) closeVideoDialog();
  });

  const bar = dlg.querySelector('#vidBar');
  const hint = dlg.querySelector('#vidHint');
  const startBtn = dlg.querySelector('#vidStart');
  const signal = { cancelled: false };
  dlg.__signal = signal;

  startBtn.addEventListener('click', async () => {
    const [w, h] = dlg.querySelector('#vidRes').value.split('x').map(Number);
    const fps = Number(dlg.querySelector('#vidFps').value);
    const mode = dlg.querySelector('#vidMode').value;
    startBtn.disabled = true;
    startBtn.textContent = '录制中…';
    const res = await exportVideo({
      w, h, fps, mode, download: true, signal,
      onProgress: (k, ct, tot) => {
        bar.style.width = Math.round(k * 100) + '%';
        hint.textContent = '录制中 ' + ct.toFixed(1) + ' / ' + tot.toFixed(1) + 's（不要切走标签页）';
      },
    });
    startBtn.disabled = false;
    startBtn.textContent = '开始导出';
    if (!res.ok) {
      hint.textContent = '失败：' + res.error;
      return;
    }
    bar.style.width = '100%';
    hint.textContent = '完成：' + (res.bytes / 1024 / 1024).toFixed(2) + ' MB · ' + res.seconds + 's · ' + res.mime;
  });
}

export function closeVideoDialog() {
  if (!dlg) return;
  if (dlg.__signal) dlg.__signal.cancelled = true;
  dlg.remove();
  dlg = null;
}

/* ------------------------------------------------------------ */
/* 挂载                                                          */
/* ------------------------------------------------------------ */
function mount() {
  window.__studioVideo = { exportVideo, openVideoDialog, closeVideoDialog };
  const mo = new MutationObserver(() => {
    const right = document.querySelector('.tb-right');
    if (!right || right.querySelector('#tbVideo')) return;
    const b = document.createElement('button');
    b.className = 'tb-btn main';
    b.id = 'tbVideo';
    b.type = 'button';
    b.title = '把分镜导出成视频（WebM）';
    b.textContent = '导出视频';
    b.addEventListener('click', openVideoDialog);
    const render = right.querySelector('#tbRender');
    if (render) right.insertBefore(b, render);
    else right.appendChild(b);
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();
