/* ============================================================================
 * js/studio-assetlibrary.js —— 入口页「资产库」面板（**落盘持久化**）
 *
 * 用户的要求：
 *   「资产库包含——场景模型（从网站弄来的、自建的）、人物模型、材质、灯光等等，
 *     而且可以复用+调用；不能因为我关掉网页，下次资产库就归零了」
 *
 * ⇒ 这一面板取代原来那个「我的模型」（localStorage，关网页会丢）。
 *   数据在 <OUT_DIR>\资产库\index.json，页面只负责显示与调用。
 *
 * 四个分类：
 *   scene      场景模型 —— 程序化环境 / 真实街区，调用即重建整个世界
 *   model      3D 模型 —— 从外部工具导出的 GLB、人物模型、自建的模型
 *   material   材质     —— 套到选中对象上
 *   light      灯光     —— 一键换气氛
 * ========================================================================== */

const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const bridgeUrl = () => `http://127.0.0.1:${(window.WB_BRIDGE_PORT || 8787)}`;

async function callTool(name, args) {
  try {
    const r = await fetch(bridgeUrl() + '/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args: args || {} }),
    });
    const j = await r.json();
    if (j && j.ok) return { ok: true, data: j };
    return { ok: false, error: (j && (j.error || (j.data && j.data.error))) || '调用失败' };
  } catch (e) {
    return { ok: false, error: '本地 Agent 桥未启动' };
  }
}

function toast(msg, kind) {
  const box = $('#toasts');
  if (!box) return;
  const d = document.createElement('div');
  d.className = 'toast' + (kind ? ' ' + kind : '');
  d.textContent = msg;
  box.appendChild(d);
  setTimeout(() => d.remove(), 4200);
}

const CATS = [
  { id: 'all', label: '全部' },
  { id: 'scene', label: '场景模型' },
  { id: 'model', label: '3D 模型' },
  { id: 'character', label: '人物模型' },
  { id: 'material', label: '材质' },
  { id: 'light', label: '灯光' },
];

let libState = { items: [], counts: {}, dir: '' };
let curCat = 'all';
/** ★ 2026-11-09：哪些模型的分件列表是展开的（DOM 会重建，状态得另存） */
const expandedParts = {};

function catOf(it) {
  if (it.category) return it.category;
  if (it.kind === 'world') return 'scene';
  if (it.kind === 'model') return 'prop';
  return it.kind;
}

function renderLibrary() {
  const grid = $('#assetLibGrid');
  const cnt = $('#assetLibCount');
  if (!grid) return;
  const items = curCat === 'all' ? libState.items : libState.items.filter((i) => catOf(i) === curCat);

  // 分类条
  const tabs = $('#assetLibTabs');
  if (tabs) {
    tabs.innerHTML = CATS.map((c) => {
      const n = c.id === 'all' ? libState.items.length : libState.items.filter((i) => catOf(i) === c.id).length;
      return `<button class="alb-tab${curCat === c.id ? ' on' : ''}" data-cat="${c.id}">${esc(c.label)} <b>${n}</b></button>`;
    }).join('');
  }
  if (cnt) cnt.textContent = libState.items.length + ' 条（存本机磁盘，关网页不丢）';

  if (!items.length) {
    grid.innerHTML = '<div class="src-empty">这一类还没有内容</div>';
    return;
  }

  grid.innerHTML = items.map((it) => {
    const c = catOf(it);
    // ★ 缩略图：服务端存相对路径，这里拼成桥上的绝对地址
    const tu = it.thumb
      ? (/^https?:/i.test(it.thumb) || /^data:/i.test(it.thumb)
          ? it.thumb
          : `http://127.0.0.1:${(window.WB_BRIDGE_PORT || 8787)}/library/thumb/${encodeURIComponent(it.id)}`)
      : null;
    const thumb = tu
      ? `<img class="alb-thumb" src="${esc(tu)}" alt="" onerror="this.style.display='none';this.nextElementSibling&&(this.nextElementSibling.style.display='flex')">`
      : '';
    const ph = `<div class="alb-thumb ph alb-ph-${esc(c)}" style="${tu ? 'display:none;' : ''}">${esc((it.kind || '').slice(0, 1).toUpperCase())}</div>`;
    const acts = [];
    if (it.kind === 'model') acts.push(`<button class="btn primary" data-act="place" data-id="${esc(it.id)}">放进场景</button>`);
    if (it.kind === 'world') acts.push(`<button class="btn primary" data-act="loadworld" data-id="${esc(it.id)}">调用</button>`);
    if (it.kind === 'material') acts.push(`<button class="btn primary" data-act="mat" data-id="${esc(it.id)}">套用</button>`);
    if (it.kind === 'light') acts.push(`<button class="btn primary" data-act="light" data-id="${esc(it.id)}">应用</button>`);
    if (!it.builtin) acts.push(`<button class="btn ghost" data-act="del" data-id="${esc(it.id)}">删除</button>`);
    // ★ 2026-11-09：分件（精准 copy 某个物体）
    const nParts = (it.parts || []).length;
    const isOpen = !!expandedParts[it.id];
    if (nParts) {
      acts.push(`<button class="btn ghost" data-act="toggleparts" data-id="${esc(it.id)}">${isOpen ? '收起' : '分件 ' + nParts}</button>`);
    }
    const meta = [];
    if (it.source && it.source !== 'built-in') meta.push(esc(it.source));
    if (it.bytes) meta.push(Math.round(it.bytes / 1024) + ' KB');
    if (it.spec && it.spec.size) meta.push(esc(it.spec.size));
    const partsHtml = nParts ? renderParts(it, isOpen) : '';
    return `
      <div class="alb-card" data-id="${esc(it.id)}">
        ${thumb}${ph}
        <div class="alb-name" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="alb-meta">${esc(meta.join(' · ') || (it.builtin ? '内置' : '本地'))}</div>
        ${it.attribution ? `<div class="alb-credit">${esc(it.attribution)}</div>` : ''}
        <div class="alb-acts">${acts.join('')}</div>
        ${partsHtml}
      </div>`;
  }).join('');
}

/** ★ 2026-11-09：分件列表（点一行 = 只把那一个物体放进场景） */
function renderParts(it, open) {
  const parts = it.parts || [];
  const rows = parts.slice(0, 200).map((p) => `
    <button type="button" class="part-row" data-act="placepart" data-id="${esc(it.id)}" data-part="${p.i}"
            title="大小 ${p.size.map((v) => v.toFixed(1)).join('×')}m · 位置 ${p.pos.map((v) => v.toFixed(1)).join(', ')}">
      <span class="part-dot" style="background:${esc(p.color || '#c9c2b4')}"></span>
      <span class="part-name">${esc(p.name)}</span>
      <span class="part-size">${p.size.map((v) => v.toFixed(1)).join('×')}</span>
    </button>`).join('');
  // ★ 展开状态记在模块变量里 —— renderLibrary() 会重建 DOM，
  //   存在 DOM 上的 hidden 会被冲掉（补缩略图时会重渲染）。
  return `<div class="part-list" data-parts="${esc(it.id)}"${open ? '' : ' hidden'}>${rows}</div>`;
}

async function loadLibrary() {
  const r = await callTool('wb_library_list', {});
  const grid = $('#assetLibGrid');
  if (!grid) return;
  if (!r.ok) {
    grid.innerHTML = '<div class="src-empty">本地 Agent 桥未启动 · 启动后刷新即可看到资产库</div>';
    const d = $('#assetLibDir');
    if (d) d.textContent = '';
    return;
  }
  const data = r.data || {};
  libState = { items: data.items || [], counts: data.counts || {}, dir: data.dir || '' };
  const d = $('#assetLibDir');
  if (d) d.textContent = libState.dir;
  renderLibrary();
  // ★ 2026-11-08：老条目（加缩略图功能之前入库的）没有图 —— 后台慢慢补齐
  backfillThumbs();
}

/* ── 补齐缺失的缩略图（后台一个一个来，别卡 UI） ─────────────────────── */
let backfilling = false;
async function backfillThumbs() {
  if (backfilling) return;
  const need = (libState.items || []).filter((it) => it.kind === 'model' && !it.builtin && !it.thumb);
  if (!need.length) return;
  backfilling = true;
  try {
    const th = await import('./thumb.js?v=76');
    for (const it of need) {
      let ok = false;
      try { ok = await th.renderThumbForLibrary(it.id, window.WB_BRIDGE_PORT || 8787); } catch (_) { ok = false; }
      if (!ok) continue;
      it.thumb = 'thumbs/' + it.id + '.png';
      // 补一张就把界面上的占位换掉
      const card = document.querySelector(`#assetLibGrid .alb-card[data-id="${CSS.escape(it.id)}"]`);
      if (card) {
        const ph = card.querySelector('.alb-thumb.ph');
        const url = 'http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/library/thumb/' + encodeURIComponent(it.id);
        if (ph) {
          const img = document.createElement('img');
          img.className = 'alb-thumb';
          img.alt = '';
          img.src = url;
          ph.replaceWith(img);
        }
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  } catch (_) { /* 补齐失败就算了，不影响使用 */ }
  backfilling = false;
}

/* ── 调用（复用） ─────────────────────────────────────────────────────── */

async function placeModel(id) {
  const r = await callTool('library.place', { id });
  if (!r.ok) { toast('放进场景失败：' + (r.error || '未知'), 'warn'); return; }
  // 切到编辑器
  try {
    if (window.__wb && window.__wb.openEditor) await window.__wb.openEditor({ env: 'room' });
    if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  } catch (_) { /* 忽略 */ }
  setTimeout(async () => {
    const rr = await callTool('library.place', { id });
    if (!rr.ok) toast('放进场景失败：' + (rr.error || '未知'), 'warn');
    else toast('已放进场景');
  }, 1000);
}

/**
 * ★ 2026-11-09：只把**一个分件**放进场景（"精准 copy 某个地方的某个物体"）
 */
async function placePart(id, partIndex) {
  const item = (libState.items || []).find((i) => i.id === id);
  if (!item) { toast('找不到这一条', 'warn'); return; }
  const part = (item.parts || []).find((p) => p.i === partIndex);
  // ★ 编辑器**已经开着** → 只切视图（openEditor 会重建场景，把用户当前的场景弄丢）
  //   编辑器**没开** → 才开一个
  const hasEditor = !!(window.__wb && window.__wb.editor);
  try {
    if (!hasEditor && window.__wb && window.__wb.openEditor) await window.__wb.openEditor({ env: 'room' });
    if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  } catch (_) { /* 忽略 */ }
  await new Promise((r) => setTimeout(r, 600));
  const e = window.__wb && window.__wb.editor;
  if (!e || !e.beginPlaceExternalPart) { toast('编辑器没就绪', 'warn'); return; }
  const url = 'http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/library/file/' + encodeURIComponent(item.id);
  let rec = null;
  try {
    rec = await e.beginPlaceExternalPart({ id: item.id, name: item.name, file_url: url }, partIndex, {});
  } catch (err) {
    toast('取分件失败：' + ((err && err.message) || err), 'warn');
    console.warn('[assetlib] 取分件失败', err);
    return;
  }
  if (!rec) { toast('这个分件取不出来', 'warn'); return; }
  toast('已取出：' + ((part && part.name) || '分件') + '（跟着鼠标走，左键放下）');
}

async function loadWorld(id) {  const item = libState.items.find((i) => i.id === id);
  if (!item || !item.spec) { toast('这条没有世界参数', 'warn'); return; }
  try {
    if (window.__wb && window.__wb.openEditor) await window.__wb.openEditor({ env: 'room' });
    if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  } catch (_) { /* 忽略 */ }
  setTimeout(async () => {
    const r = await callTool('preset.restore', { state: { spec: item.spec, camera: null, light: null, assets: [] } });
    if (!r.ok) toast('调用失败：' + (r.error || '未知'), 'warn');
    else toast('已调用场景模型：' + item.name);
  }, 1000);
}

async function applyMaterial(id) {
  const item = libState.items.find((i) => i.id === id);
  if (!item) return;
  try {
    if (window.__wb && window.__wb.openEditor) await window.__wb.openEditor({ env: 'room' });
    if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  } catch (_) { /* 忽略 */ }
  setTimeout(async () => {
    const r = await callTool('material.apply', { material: item.material, all: true });
    if (!r.ok) toast('套用失败：' + (r.error || '先选中一个对象'), 'warn');
    else toast('已套用材质：' + item.name);
  }, 1000);
}

async function applyLight(id) {
  const item = libState.items.find((i) => i.id === id);
  if (!item) return;
  const r = await callTool('light.apply', { light: item.light });
  if (!r.ok) toast('应用失败：' + (r.error || '未知'), 'warn');
  else toast('已应用灯光：' + item.name);
}

/* ── 绑定 ─────────────────────────────────────────────────────────────── */
/* ★ 2026-11-09：`initAssetLibrary()` 会被调用**很多次**
 *   （DOMContentLoaded + 导入完 + 入库完 + 切页面…），
 *   每次都 addEventListener ⇒ 监听器**叠加**。
 *   后果：「分件」按钮点一下会翻转 N 次 ⇒ **等于没点**（展开又收起）；
 *   「删除」会弹 N 次确认框。
 *   —— 只绑一次。
 */
let assetLibWired = false;

export function initAssetLibrary() {
  const sec = $('#assetLibSec');
  if (sec && !assetLibWired) {
    assetLibWired = true;
    sec.addEventListener('click', async (e) => {
      const tab = e.target.closest('[data-cat]');
      if (tab) { curCat = tab.dataset.cat; renderLibrary(); return; }
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.act === 'place') await placeModel(id);
      else if (btn.dataset.act === 'toggleparts') {
        // ★ 展开/收起分件列表
        const id = btn.dataset.id;
        expandedParts[id] = !expandedParts[id];
        renderLibrary();
      }
      else if (btn.dataset.act === 'placepart') {
        // ★ 只把那一个分件放进场景（"精准 copy 某个地方的某个物体"）
        await placePart(id, Number(btn.dataset.part));
      }
      else if (btn.dataset.act === 'loadworld') await loadWorld(id);
      else if (btn.dataset.act === 'mat') await applyMaterial(id);
      else if (btn.dataset.act === 'light') await applyLight(id);
      else if (btn.dataset.act === 'del') {
        if (!confirm('从资产库删除「' + id + '」？')) return;
        const r = await callTool('wb_library_remove', { id });
        if (!r.ok) toast('删除失败：' + (r.error || '未知'), 'warn');
        else { toast('已删除'); await loadLibrary(); }
      }
    });
  }
  const rf = $('#assetLibRefresh');
  if (rf && !rf.__ovfWired) { rf.__ovfWired = true; rf.addEventListener('click', loadLibrary); }
  loadLibrary();
  if (!window.__ovfAssetLibFocusWired) {
    window.__ovfAssetLibFocusWired = true;
    window.addEventListener('focus', loadLibrary);
  }
}
window.__initAssetLibrary = initAssetLibrary;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initAssetLibrary, { once: true });
} else {
  initAssetLibrary();
}
