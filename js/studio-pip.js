/* ==========================================================================
 * studio-pip.js · 画中画「当前视角」（v0.6）
 *
 * 参考 3D 棚拍右上角的「当前视角」小窗：始终显示当前相机看到什么。
 * 实现：把主 WebGL canvas 每 ~180ms drawImage 到小 canvas（preserveDrawingBuffer=true 所以可行，
 * 不做第二次 3D 渲染，几乎零开销）。
 * ========================================================================== */

import * as THREE from 'three';
import {
  applyRealLook, defaultLook, REAL_LOOK_PRESETS,
  loadHdriTexture, getEnvFor, getLook, setLook, isReal, setReal,
} from './real-look.js?v=76';

const $ = (sel, root) => (root || document).querySelector(sel);

let pip = null;
let canvas = null;
let ctx = null;
let timer = 0;
let big = true;
let prev = null;          // 独立的小尺寸 renderer（真渲染，不是缩主画布）
let prevSize = [0, 0];
let pipCam = null;        // 小窗专用的相机副本（不动主相机，避免改 aspect 影响出图）
let mode = (typeof localStorage !== 'undefined' && localStorage.getItem('wb-pip-mode')) || 'final'; // final | clay
let grainTile = null;

/* ★ 2026-11-08：「渲染」= 把**成片预览**变成真实世界肉眼看到的效果。
 *   —— 只影响这个小窗，主视口继续用白膜（改模型本来就该看形体）。
 *   —— look 存在 localStorage，下次打开还在。
 *   —— 状态放在 real-look.js（单一数据源），**出图管线也用它**。
 */
let look = getLook();
let realLook = isReal();

function loadLook() {
  try {
    const raw = localStorage.getItem('wb-pip-look');
    if (raw) {
      const j = JSON.parse(raw);
      if (j && j.preset) { setLook(j); return j; }
    }
  } catch (_) {}
  return defaultLook();
}
function saveLook() {
  try { localStorage.setItem('wb-pip-look', JSON.stringify(look)); } catch (_) {}
  setLook(look);
}

/* ── HDRI 环境贴图（PMREM 按 renderer 分别算，见 real-look.getEnvFor） ──── */
let hdriPending = null;           // 正在加载的 id

/** 加载一张 HDRI（只下 .hdr，PMREM 各 renderer 自己做） */
async function ensureHdri(id) {
  if (!id) return null;
  if (hdriPending === id) return null;
  hdriPending = id;
  try {
    const tex = await loadHdriTexture(id);
    hdriPending = null;
    if (!tex) return null;
    getEnvFor(prev, id);          // 立刻给 PIP 自己的 renderer 算一份 PMREM
    tick();
    return tex;
  } catch (err) {
    hdriPending = null;
    console.warn('[pip] HDRI 加载失败', id, err);
    return null;
  }
}

/** 外观里选了 HDRI 就异步准备它 */
function syncHdri() {
  const id = look && look.hdri;
  if (!id) return;
  if (hdriPending === id) return;
  if (hdriPending === id) return;
  ensureHdri(id);
}

/** 生成一张噪点砖（颗粒用），只建一次 */
function noiseTile() {
  if (grainTile) return grainTile;
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const x = c.getContext('2d');
  const img = x.createImageData(96, 96);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 190 + Math.random() * 65;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  grainTile = c;
  return c;
}

const ed = () => (window.__wb && window.__wb.editor) || null;

function toast(msg, kind = 'ok', ms = 2000) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

/** app.js 每次 openEditor 会清掉 #edViewport 里所有 canvas，所以在 tick/build 里兜底重建 */
function ensureCanvas() {
  if (!pip) return;
  let c = $('#pipCanvas', pip);
  if (!c) {
    c = document.createElement('canvas');
    c.id = 'pipCanvas';
    const w = big ? 320 : 190;
    c.width = w;
    c.height = Math.round(w * 0.56);
    pip.insertBefore(c, pip.querySelector('.vp-pip-tools'));
  }
  canvas = c;
  ctx = c.getContext('2d');
}

function build() {
  const vp = $('#edViewport');
  if (!vp || $('#vpPip')) return null;
  const box = document.createElement('div');
  box.id = 'vpPip';
  box.className = 'vp-pip';
  // ★ 2026-11-08：宽度必须和画布缓冲一致（320），否则：
  //   画布缓冲 320×179，显示出来 234×131 —— 比例差 0.07%，
  //   而且 PIP 的投影比例跟实际显示对不上。CSS 里也同步改了。
  box.style.width = '320px';
  box.innerHTML = `
    <div class="vp-pip-head">
      <span class="dot"></span><b>成片预览</b>
      <button type="button" class="pip-mode" id="pipMode" title="切换 成片 / 白膜">成片</button>
      <button type="button" class="pip-real" id="pipReal" title="真实感：把成片预览变成真实世界肉眼看到的效果（不影响主视口）">真实</button>
      <span class="pip-dev" id="pipDev" hidden></span>
      <span class="sp" id="pipSize">—</span>
    </div>
    <canvas id="pipCanvas" width="320" height="179"></canvas>
    <div class="vp-pip-tools">
      <button type="button" id="pipBig" title="放大/缩小">⤢</button>
      <button type="button" id="pipRender" title="调外观：材质 / 色泽 / 光线（不是出图）">渲染</button>
      <button type="button" id="pipHide" title="隐藏（可在顶栏「相机」页重新打开）">×</button>
    </div>`;
  vp.appendChild(box);
  pip = box;
  ensureCanvas();
  syncModeChip();

  $('#pipMode', box).addEventListener('click', (ev) => {
    ev.stopPropagation();
    mode = mode === 'final' ? 'clay' : 'final';
    try { localStorage.setItem('wb-pip-mode', mode); } catch (_) {}
    syncModeChip();
    tick();
  });

  $('#pipBig', box).addEventListener('click', () => {
    big = !big;
    box.classList.toggle('mini', !big);
    // ★ 2026-11-08：窗开大一点 —— 真实感要看得出效果，236px 太小了
    const w = big ? 320 : 190;
    if (canvas) { canvas.width = w; canvas.height = Math.round(w * 0.56); }
    box.style.width = w + 'px';
  });
  $('#pipRender', box).addEventListener('click', () => {
    // ★ 2026-11-08：这个按钮**不是**"保存当前视角图片"，
    //   而是"把**成片预览**变成真实世界肉眼看到的效果"——
    //   赋予这个视图（**不是全局**）材质 / 色泽 / 光线 / HDRI。
    //   语义是**开启 + 打开外观面板**（不是来回切换）——
    //   之前做成切换，结果第二次点击反而把真实感关了，用户一脸问号。
    //   要关掉用旁边那个橙色「真实·开」小按钮。
    realLook = true;
    setReal(true);
    try { localStorage.setItem('wb-pip-real', '1'); } catch (_) {}
    syncRealChip();
    syncHdri();
    tick();
    if (window.__openLookPanel) window.__openLookPanel();
    else toast('外观面板未就绪', 'warn');
  });
  $('#pipHide', box).addEventListener('click', () => {
    box.classList.add('hidden');
    toast('已隐藏画中画（顶栏「相机」页可再打开）');
  });
  $('#pipReal', box).addEventListener('click', () => {
    // 开关：真实感 ⇄ 白膜（主视口始终不变）
    realLook = !realLook;
    setReal(realLook);
    try { localStorage.setItem('wb-pip-real', realLook ? '1' : '0'); } catch (_) {}
    syncRealChip();
    syncHdri();
    tick();
    toast(realLook ? '成片预览：真实感开' : '成片预览：回到白膜');
  });
  syncRealChip();
  pip = box;
  return box;
}

/** 「真实」指示灯 */
function syncRealChip() {
  const b = $('#pipReal');
  if (!b) return;
  b.classList.toggle('on', realLook);
  b.textContent = realLook ? '真实·开' : '真实';
  // ★ 标题保持短（"成片预览"），真实状态由那个橙色小按钮表达 ——
  //   之前把标题改成"成片预览 · 真实"，把头部挤到按钮叠在一起了。
  const t = document.querySelector('#vpPip b');
  if (t) t.textContent = mode === 'final' ? '成片预览' : '白膜对照';
}

/** v49：小窗当前是哪台设备的视角（选中设备时切换） */
function syncDeviceChip() {
  const chip = $('#pipDev');
  if (!chip) return;
  const id = window.__wb && window.__wb.pipCamId;
  const e = ed();
  const dev = id && e && e.deviceById ? e.deviceById(id) : null;
  if (dev) {
    chip.hidden = false;
    chip.textContent = (dev.device === 'drone' ? '无人机' : '手机') + ' · ' + Math.round(dev.fov) + '°';
  } else {
    chip.hidden = true;
    chip.textContent = '';
  }
}

function syncModeChip() {
  const b = $('#pipMode');
  if (!b) return;
  b.textContent = mode === 'final' ? '成片' : '白膜';
  b.classList.toggle('clay', mode === 'clay');
  const title = document.querySelector('#vpPip b');
  if (title) title.textContent = mode === 'final' ? '成片预览' : '白膜对照';
}

function tick() {
  if (!pip || pip.classList.contains('hidden')) return;
  const view = $('#view-editor');
  if (!view || view.hidden) return;
  const e = ed();
  if (!e || !e.renderer || !e.scene || !e.camera) return;
  ensureCanvas();
  if (!canvas || !ctx) return;

  const w = canvas.width, h = canvas.height;
  const g = (e.getColorGrade && e.getColorGrade()) || { contrast: 1, saturation: 1, vignette: 0 };

  try {
    // 1) 独立小渲染器：2× 内部分辨率真渲染（场景/灯光/阴影都在）
    if (!prev || prevSize[0] !== w * 2 || prevSize[1] !== h * 2) {
      if (prev) { prev.dispose(); }
      prev = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
      prev.setPixelRatio(1);
      prev.setSize(w * 2, h * 2, false);
      prev.shadowMap.enabled = true;
      prev.shadowMap.type = THREE.PCFSoftShadowMap;
      prevSize = [w * 2, h * 2];
    }
    prev.toneMapping = THREE.ACESFilmicToneMapping;
    prev.toneMappingExposure = realLook
      ? Number(look.exposure || 1) * Number(e.exposure || 1)
      : Number(e.exposure || 1);
    // v2.1：小窗是「成片预览」——可以切设备机位，且永不显示网格/选中框/灯光辅助线/设备本体
    //
    // ★ 2026-11-08 22:45：视角必须和 3D VIEW **一致**。
    //   之前有两个问题：
    //   ① 设备相机"自动接管"小窗 —— 选中/新加一台无人机，小窗就变成航拍视角，
    //      和主视口完全不是一个东西（用户反馈：成片预览比 3D view 远得多）。
    //      现在改成**显式切换**（设备面板的「视角」按钮），默认永远跟主相机。
    //   ② 就算不接管，小窗也是拿主相机的 aspect 去渲染一张不同比例的画布 ——
    //      主视口 1266×666(1.90)、小窗 320×179(1.79)，横向会被压掉 6%。
    //      现在用**相机副本**渲染，并把**水平视野**对齐主视口（同宽取景，小窗才看得清）。
    const devCam = (window.__wb && window.__wb.pipCam) || null;
    const useDev = !!(devCam && devCam.parent);
    const srcCam = useDev ? devCam : e.camera;
    if (!pipCam) pipCam = new THREE.PerspectiveCamera();
    pipCam.position.copy(srcCam.position);
    pipCam.quaternion.copy(srcCam.quaternion);
    pipCam.near = srcCam.near;
    pipCam.far = srcCam.far;
    if (useDev) {
      pipCam.fov = srcCam.fov;
      pipCam.aspect = w / h;
    } else {
      // 水平视野 = 主视口的水平视野
      const mainAspect = srcCam.aspect || (w / h);
      const hFov = 2 * Math.atan(Math.tan((srcCam.fov * Math.PI) / 360) * mainAspect);
      pipCam.fov = (2 * Math.atan(Math.tan(hFov / 2) / (w / h)) * 180) / Math.PI;
      pipCam.aspect = w / h;
    }
    pipCam.updateProjectionMatrix();
    const shotCam = pipCam;
    const restoreHelpers = e.hideEditorHelpers ? e.hideEditorHelpers() : null;
    // ★ 2026-11-08：**真实感只在这一句渲染期间生效**。
    //   applyRealLook 会临时换掉背景/环境光/太阳/物体材质，
    //   渲完立刻还原 —— 中间没有 await，主视口的 RAF 插不进来，
    //   所以主视口看到的一直是白膜，一点没变。
    let restoreLook = null;
    if (realLook) {
      const env = getEnvFor(prev, look && look.hdri);
      try { restoreLook = applyRealLook(THREE, e.scene, e, look, prev, env); }
      catch (_) { restoreLook = null; }
    }
    prev.render(e.scene, shotCam);
    if (restoreLook) restoreLook();
    if (restoreHelpers) restoreHelpers();
    const src = prev.domElement;

    ctx.clearRect(0, 0, w, h);

    if (mode === 'clay') {
      // 白膜对照：只做最基础的显示，和主视口一致（用来对比）
      ctx.drawImage(src, 0, 0, w, h);
      const size0 = $('#pipSize');
      if (size0) size0.textContent = (w * 2) + '×' + (h * 2);
      return;
    }

    /* ---------- 成片管线：与导出同一条（js/grade-pipeline.js） ---------- */
    const FG = window.FilmGrade;
    if (FG) {
      // 真实感模式下，**用外观自己的调色**（预览专属），不动全局调色。
      const lg = realLook ? (look.grade || {}) : {};
      const gr = realLook
        ? {
            contrast: Number(lg.contrast != null ? lg.contrast : 1),
            saturation: Number(lg.saturation != null ? lg.saturation : 1) * (1 + Number(lg.vibrance || 0) * 0.55),
            vignette: Number(lg.vignette != null ? lg.vignette : 0),
            warmth: Math.max(0, Math.min(1, 0.45 + Number(lg.warm || 0) * 3.2)),
            bloom: realLook ? 0.42 : undefined,
            letterbox: realLook ? null : undefined,
          }
        : { contrast: g.contrast, saturation: g.saturation, vignette: g.vignette };
      FG.apply(ctx, src, w, h, Object.assign({}, (e.getFilmLook && e.getFilmLook()) || {}, gr));
    } else {
      ctx.drawImage(src, 0, 0, w, h);
    }

    const size = $('#pipSize');
    if (size) size.textContent = (w * 2) + '×' + (h * 2);
  } catch (_) {
    /* 渲染失败（上下文丢失等）时退回缩主画布 */
    try { ctx.drawImage(e.renderer.domElement, 0, 0, w, h); } catch (__) { /* 忽略 */ }
  }
}

function ensure() {
  const vp = $('#edViewport');
  if (!vp) { pip = null; return; }
  build();
  if (!timer) timer = setInterval(tick, 300);
}

function init() {
  ensure();
  const view = $('#view-editor');
  if (view) {
    const mo = new MutationObserver(() => { if (!view.hidden) setTimeout(ensure, 80); });
    mo.observe(view, { attributes: true, attributeFilter: ['hidden'] });
  }
  // 打开时若被隐藏过，顶栏「相机」页点击可恢复
  document.addEventListener('click', (ev) => {
    if (ev.target.closest('[data-tab="cam"]') && pip) pip.classList.remove('hidden');
  });
  window.__studioPip = {
    show: () => { pip && pip.classList.remove('hidden'); tick(); },
    hide: () => pip && pip.classList.add('hidden'),
    refresh: () => { tick(); syncDeviceChip(); },
    /** ★ 2026-11-08：外观（材质/色泽/光线）**只作用于成片预览**，不碰全局场景。 */
    getLook: () => JSON.parse(JSON.stringify(look)),
    setLook: (l) => {
      look = Object.assign({}, look, l || {});
      saveLook();
      syncHdri();
      tick();
      return look;
    },
    /** ★ 出图管线也要用外观 —— 暴露共享状态 */
    shared: { getLook, setLook, isReal, setReal, getEnvFor },
    /** ★ HDRI 环境贴图（本地素材库，Poly Haven CC0） */
    setHdri: async (id) => {
      look.hdri = id || null;
      saveLook();
      const item = await ensureHdri(id);
      tick();
      return item ? { ok: true, id } : { ok: false, id, error: 'HDRI 没加载出来' };
    },
    getHdriEnv: () => getEnvFor(prev, look && look.hdri),
    setPreset: (id) => {
      const p = REAL_LOOK_PRESETS.find((x) => x.id === id);
      if (!p) return null;
      look = {
        preset: p.id,
        sky: Object.assign({}, p.sky),
        light: Object.assign({}, p.light),
        material: Object.assign({}, p.material),
        grade: Object.assign({}, p.grade),
        exposure: p.exposure,
        // ★ 预设不指定 HDRI 时**保留当前选的**（别让用户点一下预设就把 HDRI 洗掉了）
        hdri: p.hdri !== undefined ? p.hdri : (look.hdri || null),
      };
      saveLook();
      realLook = true;
      setReal(true);
      try { localStorage.setItem('wb-pip-real', '1'); } catch (_) {}
      syncRealChip();
      syncHdri();
      tick();
      return look;
    },
    getReal: () => realLook,
    setReal: (v) => {
      realLook = !!v;
      setReal(realLook);
      try { localStorage.setItem('wb-pip-real', realLook ? '1' : '0'); } catch (_) {}
      syncRealChip();
      tick();
      return realLook;
    },
    presets: () => REAL_LOOK_PRESETS,
    /** 切到某台设备视角 / null 回主视角 */
    focus: (id) => {
      const e = ed();
      const dev = id && e && e.deviceById ? e.deviceById(id) : null;
      window.__wb.pipCam = dev ? dev.cam : null;
      window.__wb.pipCamId = dev ? dev.id : null;
      tick(); syncDeviceChip();
    },
  };
}

document.addEventListener('wb-device-focus', () => { syncDeviceChip(); });
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
