import { studioBase, absStudioUrl, resolveStudioBase } from './studio-endpoint.js?v=77';
/* ==========================================================================
 * studio-render-monitor.js · Blender 渲染任务实时进度 HUD（v31）
 *
 * 目的：让「用户」和「Agent」看同一个进度真相 —— 提交 Blender 渲染后，
 * 不管是谁提交的（页面按钮 / MCP 工具），都能在页面右下角看到：
 *   阶段（排队/渲染/编码/完成）· 百分比 · 已用时 · 输出文件按钮 · sha256 短码
 *
 * 对外接口：
 *   window.WBRender.watch(jobId)   开始盯着某任务（自动去重）
 *   window.WBRender.stop()         停止轮询
 *   window.WBRender.job            当前任务 id
 * 命令：studio.render.watch {job_id}
 * ========================================================================== */
const API = () => studioBase() + '/api/studio';
const LS_KEY = 'wb-last-render-job';

let hud = null, timer = 0, currentJob = '', startedAt = 0;
let epoch = 0, inFlight = 0, filesSignature = '', cancelRequestJob = '';
const recordedJobs = new Set();
let frameFetchAt = 0, frameInfo = null;
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const log = (...a) => { try { console.log('[render]', ...a); } catch (_) {} };

function toast(msg, kind = 'ok') {
  const box = document.getElementById('toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
}

const STAGE = {
  queued: '排队中',
  pending: '等待中',
  running: 'Blender 渲染中',
  rendering: 'Blender 渲染中',
  encoding: '编码中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '服务中断',
};

const fmtSec = (ms) => (ms / 1000).toFixed(1) + 's';
const fmtBytes = (n) => n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : Math.round(n / 1024) + ' KB';

async function getJob(jobId) {
  const r = await fetch(API() + '/renders/' + encodeURIComponent(jobId));
  const body = await r.json();
  if (!r.ok || body.code !== '000000') throw new Error(body.detail?.message || body.detail || body.message || '任务查询失败');
  return body.data;
}

function ensureHud() {
  if (hud && document.body.contains(hud)) return hud;
  hud = document.createElement('section');
  hud.id = 'wbRenderHud';
  hud.className = 'rb-hud';
  hud.innerHTML = `
    <header class="rb-head">
      <span class="rb-dot"></span>
      <b>Blender 渲染</b>
      <span class="rb-stage" id="rbStage">—</span>
      <span class="rb-time" id="rbTime">0.0s</span>
      <button type="button" class="rb-x" id="rbClose" title="收起（任务仍在后台跑）">×</button>
    </header>
    <div class="rb-bar"><i id="rbFill"></i></div>
    <div class="rb-mid"><img class="rb-thumb" id="rbThumb" alt=""><div class="rb-meta" id="rbMeta">—</div></div>
    <div class="rb-files" id="rbFiles"></div>
    <footer class="rb-foot">
      <span class="rb-hint" id="rbHint">渲染在后台进行，可以继续调整场景</span>
      <button type="button" class="rb-btn ghost" id="rbCancel">取消任务</button>
    </footer>`;
  document.body.appendChild(hud);
  hud.querySelector('#rbClose').onclick = () => { hud.classList.add('hidden'); };
  hud.querySelector('#rbCancel').onclick = async () => {
    if (!currentJob) return;
    const job = currentJob;
    cancelRequestJob = job;
    hud.querySelector('#rbCancel').disabled = true;
    try {
      const response = await fetch(API() + '/renders/' + encodeURIComponent(job) + '/cancel', { method: 'POST' });
      const body = await response.json();
      if (!response.ok || body.code !== '000000') throw new Error(body.detail?.message || body.message || '服务未确认取消');
      toast('已请求取消');
    } catch (e) { toast('取消失败：' + e.message, 'warn'); }
    finally {
      if (cancelRequestJob === job) cancelRequestJob = '';
      if (currentJob === job) hud.querySelector('#rbCancel').disabled = TERMINAL.has(hud.dataset.status);
    }
  };
  return hud;
}

/** v35：帧级进度 —— 直接问本地桥扫任务目录，拿「已渲染帧数 + 最新帧」 */
function setThumb(h, url) {
  const t = h.querySelector('#rbThumb');
  if (!t || !url) return;
  let abs = url;
  try { abs = absStudioUrl(url); } catch (_) {}
  if (t.getAttribute('src') !== abs) t.src = abs;
}

async function updateFrameProgress(h, st, r, m, pct) {
  if (TERMINAL.has(st)) { if (frameInfo?.latest_url) setThumb(h, frameInfo.latest_url); return; }
  if (!currentJob) return;
  if (Date.now() - frameFetchAt < 1200) return;
  frameFetchAt = Date.now();
  try {
    const res = await fetch('http://127.0.0.1:8787/tool', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'wb_render_frames', args: { job_id: currentJob, total: Number(r.frame_count) || null } }),
    });
    const j = await res.json();
    if (!j || !j.ok || !h.isConnected) return;
    frameInfo = j.data;
    const total = frameInfo.total || Number(r.frame_count) || frameInfo.count;
    const meta = h.querySelector('#rbMeta');
    if (meta && total) {
      meta.textContent = [Math.round(pct * 100) + '%', frameInfo.count + '/' + total + ' 帧',
        r.width ? r.width + '×' + r.height : '', r.fps ? r.fps + 'fps' : '', m.blender_version || ''].filter(Boolean).join(' · ');
    }
    if (frameInfo.latest_url) setThumb(h, frameInfo.latest_url);
  } catch (_) {}
}

function render(state) {
  const h = ensureHud();
  const st = String(state.status || '');
  const stage = STAGE[st] || st || '—';
  const pct = Math.max(0, Math.min(1, Number(state.progress) || 0));
  h.dataset.status = st;
  h.querySelector('#rbStage').textContent = stage;
  h.querySelector('#rbTime').textContent = fmtSec(Date.now() - startedAt);
  h.querySelector('#rbFill').style.width = Math.round(pct * 100) + '%';
  const m = state.manifest || {};
  const r = m.render || {};
  h.querySelector('#rbMeta').textContent = [
    Math.round(pct * 100) + '%',
    r.width ? r.width + '×' + r.height : '',
    r.fps ? r.fps + 'fps' : '',
    r.frame_count ? r.frame_count + ' 帧' : '',
    m.blender_version || '',
  ].filter(Boolean).join(' · ');

  void updateFrameProgress(h, st, r, m, pct);

  const files = h.querySelector('#rbFiles');
  const out = (Array.isArray(m.outputs) ? m.outputs : []).map(f => ({...f, safeUrl: outputUrl(f.url)})).filter(f => f.safeUrl);
  const signature = JSON.stringify([currentJob, out]);
  if (signature !== filesSignature) {
    filesSignature = signature;
    files.replaceChildren();
    out.forEach(f => {
      const label = f.kind === 'video' ? '▸ 视频 MP4' : (f.kind === 'first_frame' ? '▸ 首帧 PNG' : '▸ ' + f.kind);
      const link = document.createElement('a');
      link.className = 'rb-file'; link.href = f.safeUrl; link.target = '_blank'; link.rel = 'noopener';
      link.title = String(f.path || ''); link.textContent = label;
      const size = document.createElement('em'); size.textContent = fmtBytes(Number(f.bytes) || 0); link.appendChild(size);
      const btn = document.createElement('button');
      btn.type = 'button'; btn.className = 'rb-save'; btn.title = `存到 ${defaultOutDir()}`; btn.textContent = '存盘';
      const job = currentJob;
      btn.onclick = () => saveOutput(f, btn, job);
      files.append(link, btn);
    });
  }

  const done = TERMINAL.has(st);
  h.querySelector('#rbCancel').disabled = done || cancelRequestJob === currentJob;
  if (st === 'succeeded') {
    const validation = m.validation || {};
    h.querySelector('#rbHint').textContent = validation.passed === true && validation.decoded_frames
      ? '已验证：' + validation.decoded_frames + ' 帧解码通过' + (validation.network_calls === 0 ? ' · 0 次外部调用' : '')
      : '任务完成；未提供帧解码校验，需检查 manifest';
  } else if (st === 'failed' || st === 'interrupted') {
    h.querySelector('#rbHint').textContent = (STAGE[st] || st) + '：' + (state.error || '任务已结束');
  } else if (st === 'cancelled') {
    h.querySelector('#rbHint').textContent = '任务已取消';
  } else {
    h.querySelector('#rbHint').textContent = '渲染在后台进行，可以继续调整场景';
  }
  return h;
}

/** 把 Blender 产物存到固定输出目录（沿用 WBSave → 本地桥落盘） */
function outputUrl(value, job = currentJob) {
  try {
    const url = new URL(value, studioBase());
    const prefix = '/api/studio/renders/' + encodeURIComponent(job) + '/files/';
    const file = url.pathname.slice(prefix.length);
    if (url.origin !== new URL(studioBase()).origin || url.username || url.password || url.search || url.hash
        || !url.pathname.startsWith(prefix) || !/^[a-zA-Z0-9_.-]+$/.test(file) || file === '.' || file === '..') return '';
    return url.href;
  } catch (_) { return ''; }
}

async function saveOutput(f, btn, job = currentJob) {
  if (!f || !f.url) return;
  const url = outputUrl(f.url, job);
  if (!url) { toast('存盘失败：产物不是当前本地 Blender 任务的文件', 'warn'); return; }
  const ext = f.kind === 'video' ? '.mp4' : '.png';
  const name = (f.kind === 'video' ? 'Blender白膜_' : 'Blender首帧_') + String(job).slice(0, 8) + ext;
  if (btn) { btn.disabled = true; btn.textContent = '保存中'; }
  try {
    if (window.WBSave && window.WBSave.save) {
      const r = await window.WBSave.save(url, name);
      if (r && r.ok) { if (btn) btn.textContent = '已存盘'; return; }
    }
    window.open(url, '_blank');
    if (btn) btn.textContent = '打开';
  } catch (e) {
    toast('存盘失败：' + e.message, 'warn');
    if (btn) { btn.disabled = false; btn.textContent = '存盘'; }
  }
}

async function tick() {
  if (!currentJob) return;
  const job = currentJob, token = epoch;
  if (inFlight === token) return;
  inFlight = token;
  try {
    const state = await getJob(job);
    if (token !== epoch || job !== currentJob) return;
    render(state);
    if (TERMINAL.has(String(state.status))) {
      clearInterval(timer); timer = 0;
      const ok = state.status === 'succeeded';
      toast(ok ? 'Blender 渲染完成，可下载 MP4 / 首帧' : '渲染' + (STAGE[state.status] || state.status), ok ? 'ok' : 'warn', 4000);
      if (ok && window.WBRevisions) {
        try {
          const ed = window.__wb && window.__wb.editor;
          window.WBRevisions.add({
            job_id: currentJob,
            scene_id: ed?.studioSceneId || null,
            revision: ed?.studioRevision ?? null,
            render: state.manifest?.render,
            outputs: state.manifest?.outputs || [],
            blender: state.manifest?.blender_version,
            prefix: (document.querySelector('#edName')?.value || '白膜').trim(),
            turns: null,
          });
        } catch (_) {}
      }
      if (window.WB_AGENT && window.WB_AGENT.log) {
        window.WB_AGENT.log(ok ? 'ok' : 'err', 'render ' + state.status,
          JSON.stringify({ job_id: currentJob, outputs: (state.manifest?.outputs || []).map(f => f.kind) }));
      }
    }
  } catch (e) {
    if (token !== epoch || job !== currentJob) return;
    clearInterval(timer); timer = 0;
    ensureHud().querySelector('#rbHint').textContent = '查询失败：' + e.message;
  } finally { if (inFlight === token) inFlight = 0; }
}

function watch(jobId) {
  if (!jobId) return { ok: false, error: '缺少 job_id' };
  if (currentJob === String(jobId) && timer) return { ok: true, job_id: currentJob, watching: true };
  const sameJob = currentJob === String(jobId);
  epoch++;
  currentJob = String(jobId);
  if (!sameJob) {
    // 换任务：清掉上一任务的帧缓存与缩略图，避免显示旧画面
    frameInfo = null;
    frameFetchAt = 0;
    const t = hud && hud.querySelector('#rbThumb');
    if (t) t.removeAttribute('src');
  }
  try { localStorage.setItem(LS_KEY, currentJob); } catch (_) {}
  startedAt = startedAt && sameJob ? startedAt : Date.now();
  ensureHud().classList.remove('hidden');
  render({ status: 'queued', progress: 0 });
  log('watch', currentJob);
  if (timer) clearInterval(timer);
  timer = setInterval(tick, 800);
  tick();
  return { ok: true, job_id: currentJob, watching: true };
}

function stop() {
  epoch++;
  if (timer) clearInterval(timer);
  timer = 0;
  currentJob = '';
  if (hud) hud.classList.add('hidden');
  return { ok: true };
}

/* 页面提交渲染后自动接管（studio-bridge 调用） */
window.WBRender = { watch, stop, get job() { return currentJob; } };

/* 注册页面命令，供 MCP wb_raw / wb_render_watch 调用 */
let registered = false;
function registerCommand() {
  if (registered || !window.WB_AGENT || !window.WB_AGENT.register) return;
  try {
    window.WB_AGENT.register('studio.render.watch', (args) => watch(args && args.job_id));
    registered = true;
  } catch (_) { /* 命令总线还没就绪，稍后再试 */ }
}
registerCommand();
setInterval(registerCommand, 1500);

/* 恢复上次任务：刷新页面后还能看到进度 */
try {
  const last = localStorage.getItem(LS_KEY);
  if (last) {
    setTimeout(async () => {
      try {
        const state = await getJob(last);
        if (!currentJob && !TERMINAL.has(String(state.status))) watch(last);
      } catch (_) { /* 服务重启后旧任务查不到，忽略 */ }
    }, 1200);
  }
} catch (_) {}

export { watch, stop };
