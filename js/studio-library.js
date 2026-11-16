/* ==========================================================================
 * studio-library.js · 编辑器内左下「素材库」（v0.6）
 *
 * 参考酷家乐 3D 棚拍左栏的四段素材（模板 / 模型 / 材质 / 灯光库），落地成：
 *   模板  —— 6 个预设环境（切环境 = 换整个场景骨架）
 *   模型  —— 33 个程序化白膜资产，按类别分组
 *   材质  —— 12 色黏土涂装，作用到当前选中资产
 *   灯光  —— 5 套灯光预设（方位/俯仰/色温/强度/半球光）
 *
 * 不改 app.js：它在 .ed-rail 里渲染自己的 5 个分类按钮，并在点击时用 #edDrawer。
 * 本文件在 .ed-rail 末尾追加一条分隔线 + 4 个按钮，自建一个独立抽屉 #studioLib，
 * 打开时先把 app.js 的抽屉关掉，避免两个抽屉叠在一起。
 * ========================================================================== */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ed = () => (window.__wb && window.__wb.editor) || null;

const CLAY_COLORS = [
  ['#f2efe8', '象牙白'], ['#e3dfd4', '暖灰'], ['#c9c5b8', '石灰'], ['#d4882a', '黄铜'],
  ['#c2533f', '陶红'], ['#4a7db8', '雾蓝'], ['#4e8d6e', '玉绿'], ['#23262d', '墨黑'],
  ['#8a6d40', '深棕'], ['#d4b68a', '沙金'], ['#6e8a75', '鼠尾草'], ['#b9b4a6', '水泥'],
];

const LIGHT_PRESETS = [
  { id: 'noon', name: '正午', desc: '顶光 · 硬阴影', opt: { azimuth: 180, elevation: 70, kelvin: 5500, intensity: 1.35, shadowSoft: 0.25, hemi: 1.05, fog: true, on: true } },
  { id: 'dusk', name: '黄昏', desc: '低角度 · 暖', opt: { azimuth: 250, elevation: 12, kelvin: 2600, intensity: 1.15, shadowSoft: 0.45, hemi: 0.62, fog: true, on: true } },
  { id: 'night', name: '夜景', desc: '冷 · 低照度', opt: { azimuth: 300, elevation: 32, kelvin: 8200, intensity: 0.42, shadowSoft: 0.7, hemi: 0.36, fog: true, on: true } },
  { id: 'studio3', name: '影棚三点', desc: '均匀 · 弱阴影', opt: { azimuth: 135, elevation: 55, kelvin: 5600, intensity: 1.0, shadowSoft: 0.9, hemi: 1.25, fog: false, on: true } },
  { id: 'side', name: '单侧硬光', desc: '侧逆 · 雕塑感', opt: { azimuth: 92, elevation: 28, kelvin: 6000, intensity: 1.65, shadowSoft: 0.15, hemi: 0.42, fog: true, on: true } },
];

const CAT_LABEL = {
  people: '人物', vehicles: '载具', buildings: '建筑', nature: '自然', props: '道具',
  person: '人物', car: '载具', building: '建筑', tree: '自然', prop: '道具', cube: '基础体',
};

/* 环境缩略：用极简线稿（深底黄铜线，与入口页模板卡一致） */
const ENV_ART = {
  room: '<rect x="18" y="20" width="72" height="40"/><rect x="26" y="28" width="20" height="24"/><rect x="52" y="28" width="18" height="24"/><path d="M18 60h72"/>',
  street: '<path d="M14 62l22-30 12 16 10-12 26 26z"/><path d="M14 62h80"/><circle cx="34" cy="24" r="4"/>',
  temple: '<path d="M50 14l34 16H16z"/><path d="M24 30v30M76 30v30M34 30v30M66 30v30"/><path d="M16 62h68"/>',
  office: '<rect x="20" y="18" width="18" height="14"/><rect x="42" y="18" width="18" height="14"/><rect x="64" y="18" width="18" height="14"/><rect x="20" y="36" width="18" height="12"/><rect x="42" y="36" width="18" height="12"/><rect x="64" y="36" width="18" height="12"/><path d="M20 50h62"/>',
  wild: '<path d="M12 60c14-8 26-6 38 0s26 6 38 0"/><path d="M50 22v22M50 30l-10-8M50 34l10-9M50 40l-7-6"/><circle cx="50" cy="16" r="6"/>',
  studio: '<path d="M18 58c0-20 14-34 32-34s32 14 32 34"/><path d="M18 58h64"/><circle cx="50" cy="30" r="2.4"/>',
};

let root = null;   // #studioLib
let curTab = 'tpl';

function toast(msg, kind = 'ok', ms = 2200) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

function closeAppDrawer() {
  const d = $('#edDrawer');
  if (d && !d.hidden) {
    d.hidden = true;
    $$('.ed-rail button').forEach(b => b.classList.remove('active'));
  }
}

/* ------------------------------------------------------------ */
/* 抽屉骨架                                                      */
/* ------------------------------------------------------------ */
function ensurePanel() {
  if (root) return root;
  const body = $('.ed-body');
  if (!body) return null;
  const el = document.createElement('aside');
  el.id = 'studioLib';
  el.className = 'lib-panel';
  el.hidden = true;
  el.innerHTML = `
    <header class="lib-head">
      <div class="lib-tabs" role="tablist">
        ${[['tpl', '模板'], ['model', '模型'], ['mat', '材质'], ['light', '灯光库']]
      .map(([id, name]) => `<button class="lib-tab${id === curTab ? ' on' : ''}" type="button" role="tab" data-libtab="${id}">${name}</button>`).join('')}
      </div>
      <button class="lib-close" type="button" title="收起">×</button>
    </header>
    <div class="lib-body" id="libBody"></div>`;
  body.appendChild(el);
  root = el;

  el.addEventListener('click', (e) => {
    const t = e.target.closest('[data-libtab]');
    if (t) { curTab = t.dataset.libtab; renderTab(); return; }
    if (e.target.closest('.lib-close')) { close(); return; }
    const tpl = e.target.closest('[data-tpl]');
    if (tpl) { applyTemplate(tpl.dataset.tpl); return; }
    const mineBtn = e.target.closest('[data-myasset]');
    if (mineBtn) { (window.WBMyAssets && window.WBMyAssets.addToScene(mineBtn.dataset.myasset)); return; }
    const asset = e.target.closest('[data-asset]');
    // ★ 2026-11-08：改成**拖拉拽放置**（物体跟鼠标走，左键放下）
    if (asset) { addAsset(asset.dataset.asset); return; }
    const parts = e.target.closest('[data-paint-parts]');
    if (parts) {
      const e2 = ed();
      if (!e2 || !e2.selected) { toast('先选中一个物体', 'warn'); return; }
      const n = e2.paintParts ? e2.paintParts() : 0;
      toast('已分块配色：' + n + ' 块');
      return;
    }
    const color = e.target.closest('[data-color]');
    if (color) { paint(color.dataset.color); return; }
    const light = e.target.closest('[data-light]');
    if (light) { applyLight(light.dataset.light); return; }
  });
  return el;
}

function open(tab) {
  const el = ensurePanel();
  if (!el) return;
  closeAppDrawer();
  if (tab) curTab = tab;
  $$('.lib-tab', el).forEach(b => b.classList.toggle('on', b.dataset.libtab === curTab));
  renderTab();
  el.hidden = false;
}

function close() {
  if (root) root.hidden = true;
  $$('.lib-rail-btn').forEach(b => b.classList.remove('on'));
}

function toggle(tab) {
  if (!root || root.hidden) { open(tab); return; }
  if (curTab === tab) close();
  else open(tab);
}

/* ------------------------------------------------------------ */
/* 四个 tab 的内容                                              */
/* ------------------------------------------------------------ */
function renderTab() {
  if (!root) return;
  const box = $('#libBody', root);
  if (!box) return;
  if (curTab === 'tpl') box.innerHTML = tplHtml();
  else if (curTab === 'model') box.innerHTML = modelHtml();
  else if (curTab === 'mat') box.innerHTML = matHtml();
  else box.innerHTML = lightHtml();
  bindThumbs(box);
}

function tplHtml() {
  const envs = window.WB_ENVIRONMENTS || [];
  const cur = ed() ? ed().envId : '';
  return `
    <div class="lib-sec-title">环境模板<span>${envs.length} 个</span></div>
    <div class="lib-tpl-grid">
      ${envs.map((e, i) => `
        <button class="lib-tpl${e.id === cur ? ' on' : ''}" type="button" data-tpl="${e.id}">
          <span class="lib-tpl-prev">
            <svg viewBox="0 0 100 72" fill="none" stroke="#b08d57" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round">${ENV_ART[e.id] || ''}</svg>
          </span>
          <span class="lib-tpl-meta">
            <b>${e.name}</b>
            <i>${e.desc || ''}</i>
          </span>
          <span class="lib-tpl-idx">${String(i + 1).padStart(2, '0')}</span>
        </button>`).join('')}
    </div>
    <div class="lib-hint">切换环境会重置相机与灯光到该环境的默认值。</div>`;
}

function modelHtml() {
  const mine = (window.WBMyAssets && window.WBMyAssets.list()) || [];
  const mineHead = '<div class="lib-sec-title">我的资产<span>' + mine.length + '</span></div>';
  const mineGrid = mine.length
    ? '<div class="lib-model-grid">' + mine.map(a =>
        '<button class="lib-model" type="button" data-myasset="' + a.id + '" title="' + a.name + '（用户导入，保留材质/颜色）">' +
          '<span class="lib-model-thumb">◈</span>' +
          '<span class="lib-model-name">' + a.name + '</span>' +
        '</button>').join('') + '</div>'
    : '<div class="lib-hint">还没有用户资产：回入口「我的场景库 → 导入 3D 模型」（GLB/GLTF，支持材质与颜色）。</div>';
  const assets = window.WB_ASSETS || [];
  const groups = {};
  assets.forEach(a => {
    if (a.id === '__empty') return;
    const cat = a.cat || 'cube';
    (groups[cat] = groups[cat] || []).push(a);
  });
  return mineHead + mineGrid + Object.keys(groups).map(cat => `
    <div class="lib-sec-title">${CAT_LABEL[cat] || cat}<span>${groups[cat].length}</span></div>
    <div class="lib-model-grid">
      ${groups[cat].map(a => `
        <button class="lib-model" type="button" data-asset="${a.id}" title="${a.name}">
          <span class="lib-model-thumb" data-asset-thumb="${a.id}">◍</span>
          <span class="lib-model-name">${a.name}</span>
        </button>`).join('')}
    </div>`).join('') + `<div class="lib-hint">点击放到场景中心；用右侧「对象」页调位置/旋转/涂装。</div>`;
}

function matHtml() {
  return `
    <div class="lib-sec-title">涂装<span>12 色</span></div>
    <div class="lib-row">
      <label class="lib-check"><input type="checkbox" id="paintAll"> 整件上色</label>
      <button class="lib-btn" type="button" data-paint-parts="1">分块配色</button>
    </div>
    <div class="lib-color-grid">
      ${CLAY_COLORS.map(([hex, name]) => `
        <button class="lib-color" type="button" data-color="${hex}" title="${name} ${hex}">
          <span class="sw" style="background:${hex}"></span>
          <span class="nm">${name}</span>
        </button>`).join('')}
    </div>
    <div class="lib-hint">先点场景里要上色的**那一块**（如坐垫、扶手），再点色块 —— 只改这一块；勾「整件上色」则整件替换。带材质的模型（GLB）同样按块上色，不会把整件刷成一个颜色。</div>`;
}

function lightHtml() {
  return `
    <div class="lib-sec-title">灯光预设<span>${LIGHT_PRESETS.length} 套</span></div>
    <div class="lib-light-list">
      ${LIGHT_PRESETS.map(l => `
        <button class="lib-light" type="button" data-light="${l.id}">
          <span class="lib-light-icon">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <circle cx="12" cy="12" r="4" fill="currentColor"/>
              <g stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
                <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/>
              </g>
            </svg>
          </span>
          <span class="lib-light-meta"><b>${l.name}</b><i>${l.desc}</i></span>
        </button>`).join('')}
    </div>
    <div class="lib-hint">应用后可在右侧「环境」页继续微调方位/仰角/色温。</div>`;
}

/* 用离屏缩略图（editor 的 makeAssetThumbs）把模型格填上真缩略图 */
function bindThumbs(box) {
  if (curTab !== 'model') return;
  const editorCls = window.__wb && window.__wb.editor && window.__wb.editor.constructor;
  if (!editorCls || !editorCls.makeAssetThumbs) return;
  editorCls.makeAssetThumbs(72).then(map => {
    $$('[data-asset-thumb]', box).forEach(el => {
      const url = map[el.dataset.assetThumb];
      if (url) el.innerHTML = `<img alt="" src="${url}">`;
    });
  }).catch(() => {});
}

/* ------------------------------------------------------------ */
/* 动作                                                          */
/* ------------------------------------------------------------ */
function applyTemplate(id) {
  const e = ed();
  if (!e) return;
  e.loadEnv(id);
  const badge = $('#edEnvBadge');
  const env = (window.WB_ENVIRONMENTS || []).find(x => x.id === id);
  if (badge && env) badge.textContent = env.name;
  renderTab();
  toast('已切换环境：' + (env ? env.name : id));
  if (window.__studioInspector && window.__studioInspector.syncPanels) {
    window.__studioInspector.syncPanels();
  }
}

function addAsset(id) {
  const e = ed();
  if (!e) return;
  if (window.__studioTopbar && window.__studioTopbar.checkpoint) window.__studioTopbar.checkpoint();
  const a = (window.WB_ASSETS || []).find(x => x.id === id);
  // ★ 2026-11-08：**拖拉拽放置** —— 物体跟鼠标走，左键放下，Esc 取消。
  if (e.beginPlace) {
    const rec = e.beginPlace(id);
    toast('移动鼠标选位置，左键放下：' + (a ? a.name : id));
    return;
  }
  e.addAsset(id);
  toast('已放置：' + (a ? a.name : id));
}

function paint(hex) {
  const e = ed();
  if (!e) return;
  if (!e.selected) { toast('先点选一个资产，再上色', 'warn'); return; }
  const all = !!($('#paintAll') && $('#paintAll').checked);
  e.setColor(hex, { all });
  const part = e.pickMesh && (e.pickMesh.name || e.pickMesh.type);
  toast(all ? '整件涂装 ' + hex : ('已给「' + (part || '选中块') + '」上色 ' + hex));
}

function applyLight(id) {
  const e = ed();
  const p = LIGHT_PRESETS.find(x => x.id === id);
  if (!e || !p) return;
  if (e.setLight) e.setLight(p.opt);
  else Object.assign(e.lightOpts || {}, p.opt), e.applyLighting && e.applyLighting();
  if (window.__studioInspector && window.__studioInspector.syncPanels) {
    window.__studioInspector.syncPanels();
  }
  toast('灯光：' + p.name);
}

/* ------------------------------------------------------------ */
/* 左轨按钮                                                      */
/* ------------------------------------------------------------ */
const RAIL_BTNS = [
  { tab: 'tpl', label: '模板', svg: '<path d="M4 4h7v7H4V4zm9 0h7v4h-7V4zM4 13h7v7H4v-7zm9-3h7v10h-7V10z" fill="currentColor"/>' },
  { tab: 'model', label: '模型', svg: '<path d="M12 2l9 5v10l-9 5-9-5V7l9-5zm0 2.3L5.5 8 12 11.7 18.5 8 12 4.3z" fill="currentColor"/>' },
  { tab: 'mat', label: '材质', svg: '<path d="M12 2.5a9.5 9.5 0 100 19c1.4 0 2.2-.9 2.2-2 0-1.2-.9-2-.9-2.9 0-.8.6-1.4 1.5-1.4h1.6A5.6 5.6 0 0022 10c0-4.2-4.5-7.5-10-7.5zM7 12.5a1.6 1.6 0 110-3.2 1.6 1.6 0 010 3.2zm3.2-4.2a1.6 1.6 0 110-3.2 1.6 1.6 0 010 3.2zm4.2 0a1.6 1.6 0 110-3.2 1.6 1.6 0 010 3.2z" fill="currentColor"/>' },
  { tab: 'light', label: '灯光库', svg: '<path d="M12 3a6.5 6.5 0 00-3.7 11.8c.5.4.7.9.7 1.4V17h6v-.8c0-.5.2-1 .7-1.4A6.5 6.5 0 0012 3zM9 18.5h6V20H9v-1.5z" fill="currentColor"/>' },
  // ★ 2026-11-08：左轨**第 10 位** —— 资产库。
  //   前面 9 个都是"程序化白膜"，这个是**你自己的东西**：
  //   外部工具导出的模型 / 自己建的模型 / 场景模型 / 材质 / 灯光。
  //   数据落盘（<OUT_DIR>\资产库\），关网页、重启浏览器都不丢。
  { tab: 'library', label: '资产库', svg: '<path d="M4 4h4v16H4V4zm6 0h4v16h-4V4zm6 0h4v16h-4V4z" fill="currentColor"/>', appDrawer: true },
];

function mountRail() {
  const rail = $('.ed-rail');
  if (!rail || rail.querySelector('.lib-rail-btn')) return;
  const sep = document.createElement('div');
  sep.className = 'lib-rail-sep';
  rail.appendChild(sep);
  RAIL_BTNS.forEach(b => {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'lib-rail-btn';
    el.dataset.libtoggle = b.tab;
    el.title = b.label;
    el.setAttribute('aria-label', b.label);
    el.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17">${b.svg}</svg><span>${b.label}</span>`;
    el.addEventListener('click', () => {
      closeAppDrawer();
      $$('.lib-rail-btn').forEach(x => x.classList.toggle('on', x === el));
      // ★ 2026-11-08：「资产库」走 app.js 的抽屉（#edDrawer），
      //   那边的网格会拉**落盘的资产库**；其余 4 个走本模块的面板。
      if (b.appDrawer) {
        if (window.__openDrawer) window.__openDrawer('library');
        return;
      }
      toggle(b.tab);
    });
    rail.appendChild(el);
  });
}

/* 编辑器每次打开：rail 会被 app.js 重建，所以观察重建后重新挂 */
function init() {
  const view = $('#view-editor');
  if (!view) return;
  const tryMount = () => { mountRail(); };
  tryMount();
  const mo = new MutationObserver(() => tryMount());
  const rail = $('.ed-rail');
  if (rail) mo.observe(rail, { childList: true });
  document.addEventListener('click', (ev) => {
    // app.js 的资产分类按钮被点时，收起我们的抽屉
    const inRail = ev.target.closest('.ed-rail button:not(.lib-rail-btn)');
    if (inRail && root && !root.hidden) close();
  }, true);
  window.__studioLibrary = { open, close, toggle, get tab() { return curTab; } };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
