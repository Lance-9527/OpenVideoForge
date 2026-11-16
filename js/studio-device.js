/* ==========================================================================
 * studio-device.js · 设备机位：手机 / 无人机视角，直接在那个角度出图 / 出片（v1.8）
 *
 * 用法：
 *   顶栏「机位」→ 加手机 / 加无人机 → 列表里 视角 / 拍照 / 录视频
 *   指令：device.add / device.list / device.shoot / device.remove
 * ========================================================================== */
const $ = (s, r) => (r || document).querySelector(s);
const ed = () => (window.__wb && window.__wb.editor) || null;

let panel = null;
let activeId = null;

/** 真机角标：REC 红点 + 机型 + 时间码 + 电池（可选，拍摄时烧进画面） */
function drawDeviceHud(ctx, w, h, device, seconds) {
  const s = Math.max(1, w / 1080);
  const pad = Math.round(28 * s);
  const fs1 = Math.round(22 * s);
  const name = device === 'drone' ? 'WHITEBOX AIR 2' : 'WHITEBOX PHONE 15';
  const dur = Math.max(1, Number(seconds) || 3);
  const t = (() => {
    const m = Math.floor(dur / 60), sec = Math.floor(dur % 60);
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0') + ':00';
  })();
  ctx.save();
  ctx.font = '600 ' + fs1 + 'px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  // 顶部：REC 点 + 机型
  const topY = pad;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(pad - 8, topY - fs1, Math.round(w * 0.30), fs1 * 2.1);
  ctx.fillStyle = '#e04b3f';
  ctx.beginPath();
  ctx.arc(pad + fs1 * 0.5, topY, fs1 * 0.42, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText('REC  ' + name, pad + fs1 * 1.3, topY);
  // 顶部右侧：时间码
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(w - pad - Math.round(w * 0.20), topY - fs1, Math.round(w * 0.20), fs1 * 2.1);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.fillText(t, w - pad - Math.round(fs1 * 0.4), topY);
  // 底部：画幅信息
  ctx.textAlign = 'left';
  ctx.font = '500 ' + Math.round(fs1 * 0.86) + 'px Inter, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fillText(w + '×' + h + ' · 30P · WB', pad, h - pad);
  ctx.restore();
}

function hudOn() {
  const el = document.getElementById('devHud');
  return !!(el && el.checked);
}
let camTimer = 0;

function toast(msg, kind = 'ok') {
  const box = $('#toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 2800);
}

/* ------------------------------------------------------------ */
/* 出图：设备镜头 → 2D canvas（过成片管线）→ 下载                 */
/* ------------------------------------------------------------ */
function shootImage(id, opts) {
  const e = ed();
  const d = e && e.deviceById(id);
  if (!d) return { ok: false, error: '找不到该机位' };
  const o = opts || {};
  const aspect = o.aspect || (d.device === 'phone' ? 9 / 16 : 16 / 9);
  const longSide = Number(o.longSide) || 1920;
  const w = aspect >= 1 ? longSide : Math.round(longSide * aspect);
  const h = aspect >= 1 ? Math.round(longSide / aspect) : longSide;

  const raw = e.renderFromCamera(d.cam, w, h);   // png dataURL
  const img = new Image();
  return new Promise((resolve) => {
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      const FG = window.FilmGrade;
      const film = e.getFilmLook ? e.getFilmLook() : { on: false };
      if (FG && film.on) FG.apply(ctx, img, w, h, Object.assign({}, film, { letterbox: o.letterbox === undefined ? film.letterbox : o.letterbox }));
      else ctx.drawImage(img, 0, 0, w, h);
      if (o.hud === undefined ? hudOn() : o.hud) drawDeviceHud(ctx, w, h, d.device, 0);
      const url = cv.toDataURL('image/jpeg', 0.92);
      if (o.download !== false) {
        const a = document.createElement('a');
        a.href = url;
        a.download = (d.device === 'drone' ? '无人机' : '手机') + '机位_' + w + 'x' + h + '.jpg';
        a.click();
      }
      resolve({ ok: true, w, h, bytes: Math.round((url.length - 22) * 0.75), device: d.device, id });
    };
    img.onerror = () => resolve({ ok: false, error: '图像加载失败' });
    img.src = raw;
  });
}

/* ------------------------------------------------------------ */
/* 出片：设备镜头录制（无人机带航线运动，手机带轻微手持晃动）      */
/* ------------------------------------------------------------ */
function shootVideo(id, opts) {
  const e = ed();
  const d = e && e.deviceById(id);
  if (!d) return Promise.resolve({ ok: false, error: '找不到该机位' });
  if (typeof MediaRecorder === 'undefined') return Promise.resolve({ ok: false, error: '浏览器不支持录制' });

  const o = opts || {};
  const seconds = Math.max(1, Math.min(60, Number(o.seconds) || 3));
  const aspect = o.aspect || (d.device === 'phone' ? 9 / 16 : 16 / 9);
  const longSide = Number(o.longSide) || 1280;
  const w = aspect >= 1 ? longSide : Math.round(longSide * aspect);
  const h = aspect >= 1 ? Math.round(longSide / aspect) : longSide;

  const cands = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mime = cands.find(m => { try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; } });
  if (!mime) return Promise.resolve({ ok: false, error: '没有可用的录制编码' });

  const base = d.group.position.clone();
  const look = d.lookAt.clone();
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  const stream = out.captureStream(30);
  const chunks = [];
  let rec;
  try {
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(w * h * 30 * 0.12) });
  } catch (err) {
    return Promise.resolve({ ok: false, error: '录制初始化失败：' + ((err && err.message) || err) });
  }
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  const done = new Promise(r => { rec.onstop = r; });
  rec.start(200);

  const FG = window.FilmGrade;
  const film = e.getFilmLook ? e.getFilmLook() : { on: false };
  const restoreScene = (e.hideEditorHelpers ? e.hideEditorHelpers() : null);
  const start = performance.now();
  let raf = 0;

  const frame = () => {
    const t = (performance.now() - start) / 1000;
    const k = Math.min(1, t / seconds);
    if (d.device === 'drone') {
      // 航线：低空推近 + 侧移 + 抬升（预演常用）
      const ang = k * Math.PI * 0.55;
      d.group.position.set(
        base.x + Math.sin(ang) * 2.2,
        base.y + k * 1.4,
        base.z + (1 - Math.cos(ang)) * 2.2
      );
    } else {
      // 手持：轻微位移 + 呼吸感
      d.group.position.set(
        base.x + Math.sin(t * 2.3) * 0.012,
        base.y + Math.sin(t * 1.7) * 0.009,
        base.z + Math.cos(t * 2.1) * 0.010
      );
    }
    e.updateDevice(d);
    e.renderer.setSize(w, h, false);
    d.cam.aspect = w / h;
    d.cam.updateProjectionMatrix();
    // ★ 2026-11-08：设备机位出图也套上「成片预览」那套真实感
    const RL = window.__ovfRealLook;
    const restoreReal = (RL && RL.isReal())
      ? RL.applyCurrent(e.scene, e, e.renderer)
      : null;
    e.renderer.render(e.scene, d.cam);
    if (restoreReal) restoreReal();

    if (FG && film.on) {
      const gopts = (RL && RL.isReal())
        ? Object.assign({}, film, RL.gradeForLook(RL.getLook()))
        : film;
      FG.apply(ctx, e.renderer.domElement, w, h, gopts);
    }
    else ctx.drawImage(e.renderer.domElement, 0, 0, w, h);
    if (o.hud === undefined ? hudOn() : o.hud) drawDeviceHud(ctx, w, h, d.device, t);

    if (k >= 1) {
      setTimeout(() => { try { rec.stop(); } catch (_) {} }, 220);
      return;
    }
    // ★ 2026-11-10：**不要只靠 rAF**（页面在后台时 rAF 会被饿死，
    //   实测：hidden 页面的第一个 rAF 要等 214 秒 ⇒ 设备实拍会卡住）。
    let fired = false;
    const once = () => { if (fired) return; fired = true; frame(); };
    raf = requestAnimationFrame(once);
    setTimeout(once, 16);
  };
  {
    let fired = false;
    const once = () => { if (fired) return; fired = true; frame(); };
    raf = requestAnimationFrame(once);
    setTimeout(once, 16);
  }

  return done.then(() => {
    cancelAnimationFrame(raf);
    if (restoreScene) restoreScene();
    try { stream.getTracks().forEach(t => t.stop()); } catch (_) {}
    // 还原设备与主渲染器
    d.group.position.copy(base);
    e.updateDevice(d);
    const old = e.renderer.getSize(new (e.camera.position.constructor)(0, 0, 0)) || null;
    if (e._onResize) e._onResize();
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    if (o.download !== false) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const ext = /mp4/i.test(mime) ? '.mp4' : '.webm';
      a.download = (d.device === 'drone' ? '无人机' : '手机') + '机位_' + w + 'x' + h + '_' + seconds + 's' + ext;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    return { ok: true, bytes: blob.size, seconds, mime, w, h, device: d.device, id };
  });
}

/* ------------------------------------------------------------ */
/* 面板                                                          */
/* ------------------------------------------------------------ */
function build() {
  if (panel) return panel;
  const el = document.createElement('aside');
  el.id = 'devicePanel';
  el.className = 'dev-panel';
  el.hidden = true;
  el.innerHTML = `
    <header class="dev-head">
      <b>设备机位</b>
      <span class="dev-status" id="devCount">0 台</span>
      <button class="dev-close" type="button" title="收起">×</button>
    </header>
    <div class="dev-add">
      <button type="button" class="dev-btn" id="devAddPhone">＋ 手机机位</button>
      <button type="button" class="dev-btn" id="devAddDrone">＋ 无人机机位</button>
    </div>
    <div class="dev-opts">
      <label>时长 <input type="number" id="devSec" value="3" min="1" max="60" step="1">s</label>
      <label>画幅
        <select id="devAspect">
          <option value="auto" selected>自动</option>
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
          <option value="1:1">1:1</option>
        </select>
      </label>
    </div>
    <div class="dev-list" id="devList"></div>
    <div class="dev-aim" id="devAim">
      <div class="dev-aim-head"><b id="devAimName">未选设备</b><button type="button" id="devLookSel">对准选中物体</button></div>
      <label>水平 <input type="range" id="devYaw" min="-180" max="180" step="1" value="0"><span id="devYawV">0°</span></label>
      <label>俯仰 <input type="range" id="devPitch" min="-80" max="80" step="1" value="0"><span id="devPitchV">0°</span></label>
      <label>焦距 <input type="range" id="devFov" min="10" max="120" step="1" value="50"><span id="devFovV">50°</span></label>
      <label>翻转 <input type="range" id="devRoll" min="-180" max="180" step="1" value="0"><span id="devRollV">0°</span></label>
      <label class="dev-check"><input type="checkbox" id="devHud"> 真机角标（REC / 机型 / 时间码）</label>
    </div>
    <div class="dev-foot">
      <button type="button" class="dev-btn" id="devOpenOut">打开输出文件夹</button>
    </div>
    <div class="dev-hint">视口里左键拖 = 三轴自由移动（Shift 贴地）· 右键拖 = 转角度（Alt+右拖 = 翻转）<br>手机默认竖屏 9:16、无人机默认 16:9；无人机录像走「推近 + 侧移 + 抬升」航线，手机带手持晃动。</div>`;
  document.body.appendChild(el);
  panel = el;

  $('.dev-close', el).addEventListener('click', () => { el.hidden = true; });
  const syncAim = () => {
    const e2 = ed();
    if (!activeId) {
      const first = e2 && e2.devices && e2.devices[0];
      if (first) activeId = first.id;
    }
    const dev = e2 && activeId ? e2.deviceById(activeId) : null;
    const nm = $('#devAimName', el);
    if (!dev) { if (nm) nm.textContent = '未选设备（点上面某台设备）'; return; }
    if (nm) nm.textContent = (dev.device === 'drone' ? '无人机' : '手机') + ' · 自由调整';
    const y = $('#devYaw', el), p = $('#devPitch', el), f = $('#devFov', el), rl = $('#devRoll', el);
    if (y) { y.value = String(Math.round(dev.yaw == null ? 0 : dev.yaw)); $('#devYawV', el).textContent = y.value + '°'; }
    if (p) { p.value = String(Math.round(dev.pitch == null ? 0 : dev.pitch)); $('#devPitchV', el).textContent = p.value + '°'; }
    if (f) { f.value = String(Math.round(dev.cam.fov)); $('#devFovV', el).textContent = f.value + '°'; }
    if (rl) { rl.value = String(Math.round(Number(dev.roll) || 0)); $('#devRollV', el).textContent = rl.value + '°'; }
  };
  const applyAim = () => {
    const e2 = ed();
    if (!e2 || !activeId) return;
    e2.setDeviceAim(activeId, {
      yaw: Number($('#devYaw', el).value),
      pitch: Number($('#devPitch', el).value),
      fov: Number($('#devFov', el).value),
      roll: Number(($('#devRoll') || {}).value) || 0,
    });
    $('#devYawV', el).textContent = $('#devYaw', el).value + '°';
    $('#devPitchV', el).textContent = $('#devPitch', el).value + '°';
    $('#devFovV', el).textContent = $('#devFov', el).value + '°';
    const rv = $('#devRoll', el);
    if (rv) $('#devRollV', el).textContent = rv.value + '°';
  };
  ['devYaw', 'devPitch', 'devFov', 'devRoll'].forEach(id => {
    const elx = $('#' + id, el);
    if (elx) elx.addEventListener('input', applyAim);
  });
  $('#devLookSel', el).addEventListener('click', () => {
    const e2 = ed();
    if (!e2 || !activeId) { toast('先点一台设备', 'warn'); return; }
    const r = e2.aimDeviceAt(activeId);
    if (r) { syncAim(); toast('已对准：yaw ' + r.yaw + '° / pitch ' + r.pitch + '°'); }
  });
  $('#devOpenOut', el).addEventListener('click', () => {
    if (window.WBSave && window.WBSave.openFolder) window.WBSave.openFolder();
  });
  $('#devAddPhone', el).addEventListener('click', () => addDevice('phone'));
  $('#devAddDrone', el).addEventListener('click', () => addDevice('drone'));
  $('#devList', el).addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-dev]');
    if (!b) {
      const row = ev.target.closest('.dev-row');
      const rid = row && row.dataset.id;
      if (rid) { activeId = rid; const e3 = ed(); if (e3 && e3.focusDevice) e3.focusDevice(rid); render(); syncAim(); }
      return;
    }
    const id = b.dataset.id;
    const act = b.dataset.dev;
    if (act === 'pick') {
      activeId = id;
      const e2 = ed();
      if (e2 && e2.focusDevice) e2.focusDevice(id);
      render(); syncAim();
      toast('已聚焦：视口里左键拖动改位置（Shift 调高）· 右键拖动改角度');
      return;
    }
    if (act === 'view') return toggleView(id);
    if (act === 'del') { const e = ed(); e && e.removeDevice(id); if (window.__wb.pipCamId === id) window.__wb.pipCam = null; render(); return; }
    const opts = readOpts();
    b.disabled = true;
    const r = act === 'photo' ? await shootImage(id, opts) : await shootVideo(id, opts);
    b.disabled = false;
    toast(r.ok ? (act === 'photo' ? '已出图 ' + r.w + '×' + r.h : '已录 ' + r.seconds + 's · ' + (r.bytes / 1024 / 1024).toFixed(2) + ' MB') : '失败：' + r.error, r.ok ? 'ok' : 'warn');
    if (act === 'video' && r.ok) window.__lastDeviceShoot = r;
  });
  el.__syncAim = syncAim;
  return el;
}

function readOpts() {
  const a = $('#devAspect').value;
  const aspect = a === 'auto' ? 0 : (a === '16:9' ? 16 / 9 : a === '9:16' ? 9 / 16 : 1);
  const sec = Number(($('#devSec') || {}).value);
  return { aspect, seconds: Math.max(1, Math.min(60, Number.isFinite(sec) ? sec : 3)) };
}

function addDevice(kind) {
  const e = ed();
  if (!e) { toast('先打开一个场景', 'warn'); return null; }
  if (window.__studioTopbar && window.__studioTopbar.checkpoint) window.__studioTopbar.checkpoint();
  const t = e.target || { x: 0, y: 1, z: 0 };
  const rec = e.addDeviceCam(kind, {
    x: t.x + 2.6, y: kind === 'drone' ? Math.max(2.4, t.y + 1.6) : 1.45, z: t.z + 2.2,
    lookX: t.x, lookY: kind === 'drone' ? 0.6 : 1.2, lookZ: t.z,
  });
  if (rec) {
    rec.aspect = kind === 'phone' ? 9 / 16 : 16 / 9;
    e.updateDevice(rec);
    // ★ 2026-11-08 22:45：**新加设备不再自动接管小窗**。
    //   小窗默认永远跟 3D VIEW 同一个视角（用户要求）。
    //   想从这台设备看 → 在设备面板点「视角」按钮（可随时点「回主视角」回来）。
    if (window.__studioPip && window.__studioPip.refresh) window.__studioPip.refresh();
  }
  render();
  show();
  toast(kind === 'drone' ? '已添加无人机机位（可在设备面板点「视角」用它出图）' : '已添加手机机位（可在设备面板点「视角」用它出图）');
  return rec;
}

function toggleView(id) {
  const e = ed();
  const d = e && e.deviceById(id);
  if (!d) return;
  if (window.__wb.pipCamId === id) { window.__wb.pipCam = null; window.__wb.pipCamId = null; toast('小窗回到主视角'); }
  else { window.__wb.pipCam = d.cam; window.__wb.pipCamId = id; toast('小窗切到' + (d.device === 'drone' ? '无人机' : '手机') + '视角'); }
  // 让小窗标题上的设备标记立刻跟上
  if (window.__studioPip && window.__studioPip.refresh) window.__studioPip.refresh();
  render();
}

function render() {
  if (!panel) return;
  const e = ed();
  const list = (e && e.listDevices()) || [];
  $('#devCount').textContent = list.length + ' 台';
  if (!activeId && list.length) activeId = list[0].id;
  const box = $('#devList');
  box.innerHTML = list.length ? list.map(d => `
    <div class="dev-row${window.__wb.pipCamId === d.id ? ' on' : ''}" data-id="${d.id}" title="点击选中：小窗切到这台设备">
      <span class="dev-ico">${d.device === 'drone' ? '⬢' : '▯'}</span>
      <div class="dev-info">
        <b>${d.device === 'drone' ? '无人机' : '手机'}</b>
        <span>${d.pos.join(', ')} · ${Math.round(d.fov)}°</span>
      </div>
      <div class="dev-acts">
        <button type="button" data-dev="pick" data-id="${d.id}">调整</button>
        <button type="button" data-dev="view" data-id="${d.id}">${window.__wb.pipCamId === d.id ? '回主视角' : '视角'}</button>
        <button type="button" data-dev="photo" data-id="${d.id}">拍照</button>
        <button type="button" data-dev="video" data-id="${d.id}">录视频</button>
        <button type="button" data-dev="del" data-id="${d.id}" title="删除">✕</button>
      </div>
    </div>`).join('') : '<div class="dev-empty">还没有设备机位：点上面「＋ 手机机位 / ＋ 无人机机位」</div>';
  if (panel && panel.__syncAim) panel.__syncAim();
}

function bindEditorCallbacks() {
  const e = ed();
  if (!e || e.__devCbBound) return;
  e.__devCbBound = true;
  const prevCb = e.opts && e.opts.onDeviceChange;
  const prevFocusCb = e.opts && e.opts.onDeviceFocus;
  if (e.opts) e.opts.onDeviceFocus = (dev) => { if (typeof prevFocusCb === 'function') prevFocusCb(dev); render(); if (window.__studioPip && window.__studioPip.refresh) window.__studioPip.refresh(); };
  if (e.opts) {
    e.opts.onDeviceChange = (dev) => {
      if (typeof prevCb === 'function') prevCb(dev);
      if (panel && panel.__syncAim) panel.__syncAim();
    };
  }
}

function show() { build().hidden = false; bindEditorCallbacks(); render(); }
function hide() { if (panel) panel.hidden = true; }
function toggle() { if (!panel || panel.hidden) show(); else hide(); }

/* ------------------------------------------------------------ */
function init() {
  window.WB_DEVICE = window.__studioDevice = { add: addDevice, shootImage, shootVideo, show, hide, toggle, list: () => (ed() ? ed().listDevices() : []) };
  const mo = new MutationObserver(() => {
    const tools = document.querySelector('.tb-tools');
    if (!tools || tools.querySelector('#tbDevice')) return;
    const b = document.createElement('button');
    b.className = 'tb-btn';
    b.id = 'tbDevice';
    b.type = 'button';
    b.title = '手机 / 无人机机位：直接在那个角度出图或出片';
    b.textContent = '机位';
    b.addEventListener('click', toggle);
    const anchor = tools.querySelector('#tbEmpty');
    if (anchor) anchor.parentNode.insertBefore(b, anchor.nextSibling);
    else tools.appendChild(b);
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
