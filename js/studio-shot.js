import { studioBase, absStudioUrl, resolveStudioBase } from './studio-endpoint.js?v=77';
/* ==========================================================================
 * studio-shot.js · 电商棚拍（简化版：像酷家乐那样，左选 / 中看 / 右调）
 *
 * 设计原则（2026-10-31 用户定的）：
 *   · **中间是主视觉** —— 一张大图 = 上一次的真实渲染结果（Blender 真渲染，所见即所得）。
 *   · **左边只做"选"** —— 选商品、选场景模板，不做复杂操作。
 *   · **右边只做"微调"** —— 选中商品的位姿三件套 + 两个效果开关。
 *   · **重活归 agent** —— 摆件、构图、批量出图由 agent 通过 wb_studio_render 驱动；
 *     人只需要看着渲染图说"这个换成彩棚/这个再往左挪一点"。
 *
 * 与白膜那条线无关：白膜是短剧分镜的形体占位；这里是电商成片（Cycles + 真实材质）。
 * ========================================================================== */
const BRIDGE = 'http://127.0.0.1:8787';
const VF = () => studioBase();
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function toast(msg, kind = 'ok', ms = 3000) {
  const box = $('#toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

async function call(tool, args = {}) {
  const r = await fetch(BRIDGE + '/tool', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: tool, args }),
  });
  const j = await r.json();
  if (!j || j.ok === false) throw new Error((j && j.error) || '桥调用失败');
  return j.data;
}

/* ---------------------------------------------------------------- 状态 */
const PRESETS = [
  ['white_seamless', '白底电商图', '纯白无缝，最通用'],
  ['warm_wood', '暖木桌面', '家居/食品'],
  ['living_room', '家居角落', '软装家具'],
  ['black_mirror', '黑镜展台', '3C/腕表'],
  ['color_studio', '彩棚', '有颜色的背景'],
];

const state = {
  assets: [],
  items: [],
  selected: -1,
  preset: 'white_seamless',
  backdropColor: '#dddddd',
  backdropTouched: false,
  effects: {
    dof: { enabled: false, fstop: 2.4 },
    glare: { enabled: false, threshold: 1.3 },
  },
  w: 900, h: 900, samples: 160,
  framing: 'medium',
  jobId: null, resultUrl: null, resultVideo: null, busy: false,
};

let dlg = null;

const itemColor = (index) => ['#4f8cff', '#31c48d', '#f6a94a', '#e06c75', '#9aa4b2'][index % 5];

function addItem(asset) {
  const index = state.items.length;
  const angle = index * 2.399;                                   // 黄金角错开
  state.items.push({
    asset_id: asset.id,
    name: asset.name || asset.id,
    position: [Math.round(Math.cos(angle) * 0.15 * 1000) / 1000, 0, Math.round(Math.sin(angle) * 0.15 * 1000) / 1000],
    rotationY: 0,
    scale: 1,
  });
  state.selected = state.items.length - 1;
  paint();
}

/** 取景档位：近景 / 中景 / 全景（简单三档，够用；再细就交给 agent 用相机参数）。 */
const FRAMINGS = {
  close:  { position: [0.22, -0.34, 0.16], target: [0, 0, 0.04], label: '近景' },
  medium: { position: [0.34, -0.55, 0.24], target: [0, 0, 0.05], label: '中景' },
  wide:   { position: [0.52, -0.85, 0.40], target: [0, 0, 0.08], label: '全景' },
};

function currentCamera() {
  const framing = FRAMINGS[state.framing] || FRAMINGS.medium;
  return { position: framing.position, target: framing.target, vertical_fov: 32 };
}

function quatFromY(deg) {
  const half = (deg * Math.PI) / 360;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

function currentObjects() {
  return state.items.map((item, index) => ({
    asset_id: item.asset_id,
    name: item.name || ('object_' + index),
    position: item.position,
    quaternion: quatFromY(item.rotationY),
    scale: [item.scale, item.scale, item.scale],
  }));
}

function currentEffects() {
  const out = {};
  if (state.effects.dof.enabled) out.dof = { enabled: true, fstop: Number(state.effects.dof.fstop) };
  if (state.effects.glare.enabled) out.glare = { enabled: true, threshold: Number(state.effects.glare.threshold) };
  return out;
}

function hexToRgb(hex) {
  const text = String(hex || '#dddddd').replace('#', '');
  const full = text.length === 3 ? text.split('').map((c) => c + c).join('') : text;
  const value = parseInt(full.slice(0, 6), 16);
  return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255, 1.0];
}

/* ------------------------------------------------------------ 绘制 */
function assetsSignature() {
  return state.assets.map((a) => a.id).join(',');
}

function paint() {
  if (!dlg) return;
  if ($('#shAssets') && $('#shAssets').dataset.sig !== assetsSignature()) paintAssets();
  paintItems();
  paintInspector();
  paintPreset();
  paintFramings();
  const status = $('#shStatus');
  if (status) status.textContent = state.busy ? '渲染中…' : (state.resultUrl ? '已完成' : '还没渲染');
  const btn = $('[data-sh="render"]');
  if (btn) btn.disabled = state.busy;
}

function paintAssets() {
  const box = $('#shAssets');
  if (!box) return;
  box.dataset.sig = assetsSignature();
  if (!state.assets.length) {
    box.innerHTML = '<div class="sh-empty">没有可用模型</div>';
    return;
  }
  const samples = state.assets.filter((a) => a.group === 'sample');
  const others = state.assets.filter((a) => a.group !== 'sample');
  const row = (a) => `
    <button type="button" class="sh-asset" data-add="${state.assets.indexOf(a)}">
      <span class="sh-dot" style="background:${itemColor(state.assets.indexOf(a))}"></span>
      <span class="sh-asset-name">${a.name || a.id}</span>
    </button>`;
  box.innerHTML =
    (samples.length ? '<div class="sh-group">商品样例</div>' + samples.map(row).join('') : '') +
    (others.length ? '<div class="sh-group">我的模型</div>' + others.map(row).join('') : '');
}

function paintItems() {
  const box = $('#shItems');
  if (!box) return;
  box.innerHTML = state.items.length
    ? state.items.map((item, index) => `
      <div class="sh-item ${index === state.selected ? 'on' : ''}" data-pick="${index}">
        <span class="sh-dot" style="background:${itemColor(index)}"></span>
        <span class="sh-item-name">${item.name}</span>
        <button type="button" class="sh-x" data-del="${index}" title="移除">✕</button>
      </div>`).join('')
    : '<div class="sh-empty">还没放商品 —— 左边点一下</div>';
}

/** 右边：只给选中商品的三件套 + 两个效果开关。 */
function paintInspector() {
  const box = $('#shInspector');
  if (!box) return;
  const item = state.items[state.selected];
  const fx = `
    <h4>效果</h4>
    <label class="sh-check"><input type="checkbox" data-fx="dof.enabled" ${state.effects.dof.enabled ? 'checked' : ''}> 景深（虚化背景）</label>
    <label class="sh-check"><input type="checkbox" data-fx="glare.enabled" ${state.effects.glare.enabled ? 'checked' : ''}> 辉光（高光呼吸）</label>`;
  if (!item) {
    box.innerHTML = '<div class="sh-empty">选中一个商品来微调</div>' + fx;
    return;
  }
  const num = (label, key, value, step, suffix) => `
    <div class="sh-row"><span>${label}</span>
      <input type="number" step="${step}" value="${value}" data-num="${key}"><em>${suffix}</em></div>`;
  box.innerHTML = `
    <h4>${item.name}</h4>
    ${num('左右 X', 'x', item.position[0], 0.01, 'm')}
    ${num('前后 Z', 'z', item.position[2], 0.01, 'm')}
    ${num('高度 Y', 'y', item.position[1], 0.01, 'm')}
    ${num('旋转', 'ry', item.rotationY, 1, '°')}
    ${num('大小', 'scale', item.scale, 0.05, '×')}
    ${fx}`;
}

function paintFramings() {
  const box = $('#shFramings');
  if (!box) return;
  box.innerHTML = Object.entries(FRAMINGS).map(([key, f]) => `
    <button type="button" class="sh-framing ${key === state.framing ? 'on' : ''}" data-framing="${key}">${f.label}</button>`).join('');
}

function paintPreset() {
  const box = $('#shPreset');
  if (!box) return;
  const current = PRESETS.find((p) => p[0] === state.preset) || PRESETS[0];
  box.innerHTML = PRESETS.map(([v, t, d]) => `
    <button type="button" class="sh-preset ${v === state.preset ? 'on' : ''}" data-preset="${v}">
      <b>${t}</b><span>${d}</span>
    </button>`).join('');
  $('#shPresetName').textContent = current[1];
}

/* ------------------------------------------------------------ 渲染 */
async function loadAssets() {
  try {
    const listed = await call('wb_studio_assets');
    const managed = (listed && listed.assets) || [];
    // ★ 商品样例**永远置顶**（自己生成的模型，可商用）：即使受管资产里已经有同名文件也照样列出。
    let samples = [];
    try { samples = ((await call('wb_studio_samples')) || {}).assets || []; } catch (e) { samples = []; }
    const seen = new Set(samples.map((a) => a.id));
    state.assets = [...samples, ...managed.filter((a) => !seen.has(a.id))];
  } catch (error) {
    state.assets = [];
    toast('读不到模型：' + (error.message || error), 'warn', 5000);
  }
  paint();
}

async function renderNow() {
  if (state.busy) return;
  if (!state.items.length) { toast('先放一个商品', 'warn'); return; }
  state.busy = true;
  state.resultUrl = null;
  paint();
  $('#shPreview').innerHTML = '<div class="sh-empty">Blender 渲染中…（Cycles，稍等）</div>';
  try {
    const job = await call('wb_studio_render', {
      objects: currentObjects(),
      preset: state.preset,
      effects: currentEffects(),
      camera: currentCamera(),
      ...(state.backdropTouched ? { environment: { backdrop_color: hexToRgb(state.backdropColor) } } : {}),
      product_material: 'keep',
      drop_to_floor: true,
      samples: Number(state.samples),
      w: Number(state.w), h: Number(state.h),
    });
    state.jobId = job && job.job_id;
    if (!state.jobId) throw new Error('后端没给 job_id');
    await pollJob();
  } catch (error) {
    state.busy = false;
    $('#shPreview').innerHTML = '<div class="sh-empty sh-err">渲染失败：' + (error.message || error) + '</div>';
    paint();
  }
}

async function pollJob() {
  for (let i = 0; i < 300; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let job;
    try { job = await call('wb_render_status', { job_id: state.jobId }); } catch (e) { continue; }
    const status = job && job.status;
    if (status === 'succeeded') {
      state.busy = false;
      const outputs = (job.manifest && job.manifest.outputs) || [];
      const frame = outputs.find((o) => o.kind === 'first_frame');
      const video = outputs.find((o) => o.kind === 'video');
      state.resultUrl = frame ? frame.url : null;
      state.resultVideo = video ? video.url : null;
      showResult();
      paint();
      toast('渲染完成 ✓');
      return;
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      state.busy = false;
      $('#shPreview').innerHTML = '<div class="sh-empty sh-err">渲染' + status + '</div>';
      paint();
      return;
    }
    $('#shStatus').textContent = '渲染中…';
  }
  state.busy = false;
  paint();
}

function showResult() {
  const box = $('#shPreview');
  if (!box) return;
  if (!state.resultUrl) { box.innerHTML = '<div class="sh-empty">没有产物</div>'; return; }
  box.innerHTML = `
    <img class="sh-shot" src="${absStudioUrl(state.resultUrl)}" alt="棚拍渲染结果">
    <div class="sh-result-bar">
      <a class="btn" href="${VF + state.resultUrl}" target="_blank" rel="noreferrer">看大图</a>
      ${state.resultVideo ? `<a class="btn" href="${VF + state.resultVideo}" target="_blank" rel="noreferrer">看视频</a>` : ''}
    </div>`;
}

/* ------------------------------------------------------------ 弹窗 */
function ensureDialog() {
  // ★ 已存在就复用（哪怕被从 DOM 里摘掉了）⇒ 不要重建：
  //   重建会把用户已经摆好的东西全弄丢（内容都在旧节点里）。
  if (dlg) {
    if (!document.body.contains(dlg)) document.body.appendChild(dlg);
    return dlg;
  }
  const el = document.createElement('div');
  el.id = 'shotDlg';
  el.className = 'sh-overlay';
  el.hidden = true;
  el.innerHTML = `
    <div class="sh-card">
      <div class="sh-head">
        <b>电商棚拍</b>
        <span class="sh-sub">Blender 真渲染 · 所见即所得</span>
        <span class="sh-status" id="shStatus"></span>
        <button type="button" class="sh-x" data-sh="close">✕</button>
      </div>
      <div class="sh-body">
        <aside class="sh-left">
          <h4>商品</h4>
          <div class="sh-list" id="shAssets"></div>
          <button type="button" class="btn sh-wide" data-sh="samples">载入商品样例</button>
          <h4>已放</h4>
          <div class="sh-list" id="shItems"></div>
        </aside>
        <main class="sh-center">
          <div class="sh-preview" id="shPreview">
            <div class="sh-empty">左边放个商品，右边点「渲染」—— 出来的就是成品</div>
          </div>
        </main>
        <aside class="sh-right">
          <h4>场景</h4>
          <div class="sh-presets" id="shPreset"></div>
          <div class="sh-current">当前：<b id="shPresetName"></b></div>
          <h4>取景</h4>
          <div class="sh-framings" id="shFramings"></div>
          <label class="sh-check"><input type="checkbox" id="shBackdropUse"> 自定义背景色</label>
          <input type="color" id="shBackdrop" value="#dddddd" hidden>
          <div class="sh-inspector" id="shInspector"></div>
          <button type="button" class="sh-render" data-sh="render">渲染</button>
          <div class="sh-advanced">
            <label>尺寸 <input type="number" id="shW" value="900" step="50" min="256" max="1920"></label>
            <label>采样 <input type="number" id="shSamples" value="160" step="32" min="32" max="512"></label>
          </div>
        </aside>
      </div>
    </div>`;
  document.body.appendChild(el);
  wire(el);
  dlg = el;
  return el;
}

function wire(el) {
  el.addEventListener('click', async (event) => {
    if (event.target.closest('[data-sh="close"]')) { state.opened = false; el.hidden = true; return; }
    if (event.target.closest('[data-sh="samples"]')) { await loadAssets(); return; }
    if (event.target.closest('[data-sh="render"]')) { await renderNow(); return; }
    const framing = event.target.closest('[data-framing]');
    if (framing) { state.framing = framing.dataset.framing; paintFramings(); return; }
    const preset = event.target.closest('[data-preset]');
    if (preset) { state.preset = preset.dataset.preset; state.backdropTouched = false; paint(); return; }
    const add = event.target.closest('[data-add]');
    if (add) { addItem(state.assets[Number(add.dataset.add)]); return; }
    const del = event.target.closest('[data-del]');
    if (del) {
      state.items.splice(Number(del.dataset.del), 1);
      if (state.selected >= state.items.length) state.selected = state.items.length - 1;
      paint();
      return;
    }
    const pick = event.target.closest('[data-pick]');
    if (pick) { state.selected = Number(pick.dataset.pick); paint(); }
  });
  el.addEventListener('input', (event) => {
    const target = event.target;
    if (target.dataset.fx) {
      const [group, key] = target.dataset.fx.split('.');
      state.effects[group][key] = target.checked;
      return;
    }
    if (target.dataset.num) {
      const item = state.items[state.selected];
      if (!item) return;
      const value = Number(target.value);
      if (target.dataset.num === 'x') item.position[0] = value;
      if (target.dataset.num === 'z') item.position[2] = value;
      if (target.dataset.num === 'y') item.position[1] = value;
      if (target.dataset.num === 'ry') item.rotationY = value;
      if (target.dataset.num === 'scale') item.scale = value;
      return;
    }
    if (target.id === 'shBackdrop') { state.backdropColor = target.value; state.backdropTouched = true; }
  });
  el.addEventListener('change', (event) => {
    const target = event.target;
    if (target.id === 'shBackdropUse') {
      state.backdropTouched = target.checked;
      const color = $('#shBackdrop');
      if (color) color.hidden = !target.checked;
    }
    if (target.id === 'shW') state.w = Number(target.value);
    if (target.id === 'shSamples') state.samples = Number(target.value);
  });
}

async function open() {
  const el = ensureDialog();
  state.opened = true;
  el.hidden = false;
  paint();
  await loadAssets();
}

/* ---------------------------------------------------------- 入口按钮 */
function addButton(anchorSel, label) {
  const anchor = document.querySelector(anchorSel);
  if (!anchor || document.querySelector('[data-shot-open]')) return;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'sh-open';
  b.dataset.shotOpen = '1';
  b.textContent = label || '电商棚拍';
  b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); open(); };
  anchor.insertAdjacentElement('afterend', b);
}

function init() {
  const put = () => addButton('#modelCount', '电商棚拍');
  put();
  setInterval(put, 1500);
  // 自愈：主应用切页面/开别的面板会清掉 body 下的浮层 ⇒ 弹窗被悄悄移除。
  setInterval(() => {
    if (!dlg) return;
    if (!document.body.contains(dlg)) document.body.appendChild(dlg);
    // ★ 被外部关掉（hidden）就自动恢复 —— 主应用切页面/开别的面板会顺手把浮层收起。
    //   用户点 ✕ 时会把 state.opened 置 false，所以不会跟用户对着干。
    if (state.opened && dlg.hidden) dlg.hidden = false;
  }, 400);
  window.WBShot = { open, state, renderNow };
}

// ★ 模块脚本一般在 DOMContentLoaded 之前执行，但**页面已就绪时直接执行**才是稳的。
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
