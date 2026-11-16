/* ============================================================================
 * js/studio-sources.js —— 入口页「外部素材源」面板
 *
 * 用户要的是：**打开 openVideoForge 就能直接选外面现成做好的模型**。
 * 这个面板把外部工具的目录 + 收件箱直接摆在入口页，不需要记指令。
 *
 * 三种用法都在这里：
 *   ① 「打开工具」→ 跳到那个工具（带参数），人在那边导出；
 *   ② 「一键真实街区」→ ロケハン 那条能全自动（我们自己查 OSM 原始数据）；
 *   ③ 「导入收件箱」→ 把导出物收编成资产库里的模型。
 * ========================================================================== */
import { SOURCES, INBOX_NAME } from './worldgen/sources.js?v=76';

const $ = (s, r) => (r || document).querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let inboxState = null;

/* ---------------------------------------------------------------
 * 调工具：优先走**本地 Agent 桥**的 HTTP /tool
 *
 * 为什么不用 window.WB_AGENT.run：
 *   WB_AGENT.run 只查**页面本地**的 COMMANDS 表，不会转发给桥。
 *   wb_source_list / wb_inbox_* 是**桥侧**的工具（要读本机文件系统），
 *   所以页面得直接打桥的 /tool。桥开了 CORS，页面在 8802、桥在 8787，
 *   跨端口没问题（studio-agent.js 的 /hi、/result 也是这么发的）。
 * ------------------------------------------------------------- */
const bridgeUrl = () => `http://127.0.0.1:${(window.WB_BRIDGE_PORT || 8787)}`;

async function callTool(name, args) {
  // ① 桥侧工具：直接打 /tool
  try {
    const r = await fetch(bridgeUrl() + '/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args: args || {} }),
    });
    const j = await r.json();
    if (j && j.ok) return { ok: true, data: j };
  } catch (_) { /* 桥没起 → 走下面的本地表 */ }
  // ② 页面本地指令
  if (window.WB_AGENT && window.WB_AGENT.run) {
    try {
      const r2 = await window.WB_AGENT.run(name, args || {});
      if (r2 && r2.ok) return { ok: true, data: r2.data };
      return { ok: false, error: r2 && r2.error };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }
  return { ok: false, error: '本地 Agent 桥未启动' };
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

/* ── 渲染素材源卡片 ─────────────────────────────────────────────────────── */
function renderSources(catalog) {
  const grid = $('#srcGrid');
  if (!grid) return;
  inboxState = catalog.inbox || null;

  grid.innerHTML = (catalog.sources || SOURCES).map((s) => `
    <div class="src-card" data-src="${esc(s.id)}">
      <div class="src-head">
        <b>${esc(s.name)}</b>
        <span class="src-jp">${esc(s.jp || '')}</span>
      </div>
      <div class="src-what">${esc(s.what)}</div>
      <div class="src-tags">
        ${(s.exports || []).map((e) => `<i>${esc(e)}</i>`).join('')}
        ${s.auto === 'osm' ? '<i class="hot">可一键</i>' : ''}
      </div>
      <div class="src-credit${s.credit ? ' must' : ''}">${esc(s.creditNote || '无需署名')}</div>
      <div class="src-actions">
        ${s.auto === 'osm'
          ? `<button class="btn primary" data-act="osm" data-src="${esc(s.id)}">一键真实街区</button>`
          : `<button class="btn" data-act="open" data-src="${esc(s.id)}">打开工具</button>`}
        <button class="btn ghost" data-act="info" data-src="${esc(s.id)}">说明</button>
      </div>
    </div>
  `).join('');

  renderInbox(catalog.inbox);
}

/* ── 渲染收件箱 ───────────────────────────────────────────────────────── */
function renderInbox(inbox) {
  const box = $('#srcInbox');
  const hint = $('#srcInboxHint');
  if (!box) return;
  inboxState = inbox;
  if (!inbox) {
    box.innerHTML = '<div class="src-empty">收件箱还没建好</div>';
    return;
  }
  if (hint) {
    hint.innerHTML = `把导出的文件放进 <code>${esc(inbox.dir)}</code>，再点「导入」`;
  }
  if (!inbox.files.length) {
    box.innerHTML = `<div class="src-empty">收件箱是空的 · 支持 ${inbox.accept.join(' ')}</div>`;
    return;
  }
  box.innerHTML = inbox.files.map((f) => `
    <div class="src-file">
      <span class="sf-name" title="${esc(f.path)}">${esc(f.name)}</span>
      <span class="sf-size">${(f.bytes / 1024).toFixed(0)} KB</span>
      ${f.kind === 'model'
        ? `<button class="btn" data-act="import" data-file="${esc(f.name)}">导入</button>`
        : `<span class="sf-kind">${f.kind === 'image' ? '图片' : '场景'}</span>`}
    </div>
  `).join('');
}

/* ── 交互 ─────────────────────────────────────────────────────────────── */
async function loadSources() {
  const r = await callTool('wb_source_list', {});
  if (!r || !r.ok) {
    renderSources({ sources: SOURCES, inbox: null });
    const box = $('#srcInbox');
    if (box && !box.querySelector('.src-empty')) {
      box.innerHTML = `<div class="src-empty">本地 Agent 桥未启动 · 启动后刷新即可看到收件箱</div>`;
    }
    return;
  }
  renderSources(r.data || {});
}

async function doImport(file) {
  const btn = document.querySelector(`[data-act="import"][data-file="${CSS.escape(file)}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '导入中…'; }
  const r = await callTool('wb_inbox_import', { file });
  if (r && r.ok) {
    const d = r.data || {};
    toast(`已导入 ${d.file} → 资产库`, 'ok');
    // ★ 顺手渲缩略图（库里卡片要有图）
    const id = d.asset && d.asset.id;
    if (id) {
      try {
        const th = await import('./thumb.js?v=76');
        await th.renderThumbForLibrary(id, window.WB_BRIDGE_PORT || 8787);
      } catch (_) { /* 缩略图失败不影响导入 */ }
    }
    await loadSources();
    // ★ 资产库面板也要刷新（导入的东西要能立刻在左轨第 10 位看到）
    if (window.__initAssetLibrary) window.__initAssetLibrary();
    if (typeof window.__renderMyAssets === 'function') window.__renderMyAssets();
  } else {
    toast('导入失败：' + ((r && (r.error || (r.data && r.data.error))) || '未知'), 'warn');
    if (btn) { btn.disabled = false; btn.textContent = '导入'; }
  }
}

async function doOsm() {
  const lat = prompt('纬度（十进制度数）', '31.2304');
  if (lat === null) return;
  const lng = prompt('经度（十进制度数）', '121.4737');
  if (lng === null) return;
  const radius = Number(prompt('取样半径（米，50–3000）', '400')) || 400;

  // ★ 2026-11-08：真实世界必须在**编辑器**里建（几何在页面侧）。
  //   之前直接在入口页调 wb_world_build → 桥找不到编辑器 → 世界没出来（实测踩到）。
  //   所以先开一个场景、切到编辑器，再发指令。
  toast('正在打开编辑器…');
  try {
    if (window.__wb && window.__wb.openEditor) await window.__wb.openEditor({ env: 'room' });
    if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  } catch (_) { /* 忽略 */ }
  await new Promise((r) => setTimeout(r, 1500));

  toast('正在抓取真实街区（首次约 30–60 秒，之后走本地缓存）…');
  const r = await callTool('wb_world_build', { kind: 'osm', lat: Number(lat), lng: Number(lng), radius });
  if (r && r.ok) {
    const d = r.data || r;
    toast(`真实街区已载入：${(d.stats && d.stats.buildings) || 0} 栋 / ${(d.stats && d.stats.roads) || 0} 条路`, 'ok');
    if (d.warning) toast(d.warning, 'warn');
  } else {
    toast('抓取失败：' + ((r && (r.error || (r.data && r.data.error))) || '未知'), 'warn');
  }
}

function bind() {
  const sec = $('#srcSec');
  if (!sec) return;

  sec.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const sid = btn.dataset.src;
    if (act === 'open') {
      const s = SOURCES.find((x) => x.id === sid);
      if (s) window.open(s.tool, '_blank', 'noopener');
    } else if (act === 'info') {
      const s = SOURCES.find((x) => x.id === sid);
      if (!s) return;
      window.open(s.info, '_blank', 'noopener');
    } else if (act === 'osm') {
      await doOsm();
    } else if (act === 'import') {
      await doImport(btn.dataset.file);
    }
  });

  const refresh = $('#srcRefresh');
  if (refresh) refresh.addEventListener('click', loadSources);
}

export function initSources() {
  bind();
  loadSources();
}
window.__initSources = initSources;

// 自动挂载：脚本在 index.html 末尾加载，DOM 已就绪；若被别处提前引入则等 DOMContentLoaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSources, { once: true });
} else {
  initSources();
}
