import { studioBase, absStudioUrl, resolveStudioBase } from './studio-endpoint.js?v=77';
/* ==========================================================================
 * studio-myassets.js · 用户资产（3D 模型导入 / 复用）
 *
 * ★ 2026-11-08：数据源改了。
 *   原来：localStorage `wb-my-assets` —— 关网页/清缓存就没了，
 *         而且模型本体在 VideoForge 8765（要开 Blender 才有）。
 *   现在：**资产库**（服务端落盘 <OUT_DIR>\资产库\）是唯一数据源，
 *         模型文件也存那儿（assets/models/），不依赖任何外部进程。
 *         localStorage 只留一份"给编辑器面板快读"的缓存，
 *         缓存丢了也不影响资产库 —— 重新从资产库拉回来即可。
 *
 * 两处用到：
 *   1) 入口「导入 3D 模型」（GLB/GLTF，含材质与颜色）
 *   2) 编辑器「模型」素材库 →「我的资产」分组，点一下就能加进当前场景
 * ========================================================================== */
const API = () => studioBase() + '/api/studio';
const BRIDGE = () => `http://127.0.0.1:${(window.WB_BRIDGE_PORT || 8787)}`;
const KEY = 'wb-my-assets';
const $ = (s, r) => (r || document).querySelector(s);

function toast(msg, kind = 'ok') {
  const box = $('#toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3200);
}

const fmtBytes = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

/** 内存里的模型清单（来自资产库） */
let mem = null;
let memAt = 0;

function list() {
  if (mem) return mem;
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (_) { return []; }
}
function save(arr) { try { localStorage.setItem(KEY, JSON.stringify(arr.slice(0, 60))); } catch (_) {} }
function add(asset, extra = {}) {
  const arr = list().filter(a => a.id !== asset.id);
  arr.unshift(Object.assign({ id: asset.id, name: asset.name || 'model.glb', bytes: asset.bytes || 0, at: Date.now() }, extra));
  save(arr);
  mem = null;
  renderEntry();
  return arr[0];
}
function remove(id) {
  save(list().filter(a => a.id !== id));
  mem = null;
  renderEntry();
}

/** 从资产库同步模型清单（资产库是唯一数据源） */
async function syncFromLibrary() {
  try {
    const r = await fetch(BRIDGE() + '/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'wb_library_list', args: { kind: 'model' } }),
    });
    const j = await r.json();
    if (!j || !j.ok) throw new Error('bridge');
    const items = (j.items || []).map((i) => ({
      id: i.id, name: i.name, bytes: i.bytes || 0,
      at: Date.parse(i.updatedAt || i.createdAt || '') || Date.now(),
      source: i.source || 'local', attribution: i.attribution || null,
      category: i.category || 'prop',
    }));
    mem = items;
    memAt = Date.now();
    save(items);                    // 同步写缓存（缓存只是给面板快读）
    return items;
  } catch (_) {
    return list();                 // 桥没起 → 用缓存
  }
}

/** 上传一个本地模型到**资产库**（落盘；不依赖 VideoForge/Blender） */
async function upload(file, onProgress) {
  // ① 优先资产库（自己的盘）
  try {
    const buf = await file.arrayBuffer();
    let bin = '';
    const bytes = new Uint8Array(buf);
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    const b64 = btoa(bin);
    const r = await fetch(BRIDGE() + '/library/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, base64: b64 }),
    });
    const j = await r.json();
    if (r.ok && j.ok) {
      mem = null;
      // ★ 2026-11-08：顺手渲一张缩略图（卡片上要认得出是什么）
      try {
        const th = await import('./thumb.js?v=76');
        await th.renderThumbForLibrary(j.id, window.WB_BRIDGE_PORT || 8787);
      } catch (_) { /* 缩略图失败不影响导入 */ }
      return { id: j.id, name: j.name, bytes: j.bytes };
    }
  } catch (_) { /* 桥没起 → 退回 8765 */ }
  // ② 退回 VideoForge 资产库（老路径）
  const fd = new FormData();
  fd.append('file', file, file.name);
  const r = await fetch(API() + '/assets', { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.code && j.code !== '000000')) {
    throw new Error((j.detail && j.detail.message) || j.detail || j.message || ('HTTP ' + r.status));
  }
  const d = j.data || {};
  return { id: d.id, name: d.name || file.name, bytes: d.bytes || file.size };
}

/** 打开一个「新建场景 + 导入这个模型」的编辑器 */
async function openWithModel(asset) {
  const newBtn = $('#enCardNew');
  if (!newBtn) { toast('入口按钮未就绪', 'warn'); return false; }
  newBtn.click();
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    await new Promise(r => setTimeout(r, 200));
    const e = window.__wb && window.__wb.editor;
    if (e && $('#view-editor') && !$('#view-editor').hidden) break;
  }
  await new Promise(r => setTimeout(r, 400));
  if (!window.WB_AGENT) { toast('页面桥未就绪，先点「模型 → 我的资产」添加', 'warn'); return false; }
  const res = await window.WB_AGENT.run('studio.asset.import', { asset_id: asset.id });
  if (res && res.ok) { toast('已导入：' + asset.name + '（可在「模型 → 我的资产」继续添加）'); return true; }
  toast('导入失败：' + ((res && res.error) || '未知错误'), 'warn');
  return false;
}

/** 编辑器里：把「我的资产」加入当前场景 */
async function addToScene(id) {
  if (!window.WB_AGENT) { toast('页面桥未就绪', 'warn'); return false; }
  const res = await window.WB_AGENT.run('studio.asset.import', { asset_id: id });
  if (res && res.ok) { toast('已加入场景'); return true; }
  toast('加入失败：' + ((res && res.error) || '未知错误'), 'warn');
  return false;
}

/* ---------------- 入口：我的模型网格 ---------------- */
let selectedId = null;
let lastSig = '';

function renderEntry() {
  const grid = $('#mineModelGrid');
  const count = $('#modelCount');
  const arr = list();
  if (count) count.textContent = arr.length + ' 个';
  if (!grid) return;
  const sig = JSON.stringify(arr);
  if (sig === lastSig) {
    // 列表没变：只同步选中态，避免定时刷新把 .on 和 hover 状态刷掉
    grid.querySelectorAll('.mine-card').forEach(c => c.classList.toggle('on', c.dataset.model === selectedId));
    return;
  }
  lastSig = sig;
  if (!arr.length) {
    grid.innerHTML = `<div class="mine-empty">还没有模型 —— 点上方「导入 3D 模型」，或把 .glb 拖进来。<br>导入后会进<b>资产库</b>（存本机磁盘，关网页 / 重启浏览器都不丢），之后随时复用。</div>`;
    return;
  }
  grid.innerHTML = arr.map(a => `
    <div class="mine-card" data-model="${a.id}" title="单击选中 · 双击放进场景">
      <span class="mine-thumb"><span class="mine-thumb-ico">◈</span></span>
      <span class="mine-body">
        <span class="mine-title">${a.name}</span>
        <span class="mine-sub">${fmtBytes(a.bytes)} · ${new Date(a.at).toLocaleDateString('zh-CN')}</span>
      </span>
      <span class="mine-badge native">${a.source === 'videoforge-previz' ? '白膜 · 3D' : '3D 模型'}</span>
      <span class="mine-acts">
        <button type="button" class="mine-act" data-mact="open" data-id="${a.id}">放进场景</button>
        <button type="button" class="mine-act" data-mact="export" data-id="${a.id}" title="下载 GLB 到输出目录">导出</button>
        <button type="button" class="mine-act danger" data-mact="del" data-id="${a.id}">删除</button>
      </span>
    </div>`).join('');
  grid.querySelectorAll('.mine-card').forEach(card => {
    card.onclick = async (ev) => {
      const act = ev.target.closest('[data-mact]');
      const id = card.dataset.model;
      const a = list().find(x => x.id === id);
      if (!a) return;
      if (act) {
        const k = act.dataset.mact;
        if (k === 'open') return openWithModel(a);
        if (k === 'export') return exportModel(a, act);
        if (k === 'del') {
          if (!confirm('从「我的模型」移除「' + a.name + '」？（已放进场景的不受影响）')) return;
          remove(id); toast('已删除模型记录');
          return;
        }
        return;
      }
      selectedId = (selectedId === id) ? null : id;
      grid.querySelectorAll('.mine-card').forEach(x => x.classList.toggle('on', x.dataset.model === selectedId));
    };
    card.ondblclick = async () => {
      const a = list().find(x => x.id === card.dataset.model);
      if (a) await openWithModel(a);
    };
  });
}

/* ---------------- 入口：绑定导入 ---------------- */
async function importFiles(files) {
  if (!files || !files.length) return;
  for (const file of files) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!['glb', 'gltf'].includes(ext)) { toast('只支持 .glb / .gltf：' + file.name, 'warn'); continue; }
    toast('正在导入 ' + file.name + ' …');
    try {
      const asset = await upload(file);
      add(asset);
      // ★ 资产库面板要刷新（左轨第 10 位立刻能看到新模型）
      if (window.__initAssetLibrary) window.__initAssetLibrary();
      toast('已导入：' + asset.name + '（已进资产库，可随时复用）');
    } catch (e) {
      toast('导入失败：' + e.message, 'warn', 4000);
    }
  }
}

/** v68：导出模型 GLB（下载到输出目录） */
async function exportModel(asset, btn) {
  try {
    if (btn) { btn.disabled = true; btn.textContent = '导出中…'; }
    const r = await fetch(API() + '/assets/' + encodeURIComponent(asset.id) + '/file');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const name = (asset.name || 'model.glb').replace(/\.[^.]+$/, '') + '.glb';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 8000);
    toast('已导出：' + name);
  } catch (e) {
    toast('导出失败：' + e.message, 'warn', 4000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '导出'; }
  }
}

function init() {
  const modelCard = $('#enCardModel');
  const input = $('#modelInput');
  if (modelCard && input) {
    modelCard.onclick = () => input.click();
    input.onchange = async () => {
      await importFiles(input.files);
      input.value = '';
    };
  }
  // 拖拽到「我的模型」区域也能导入
  const sec = $('#mineModelGrid');
  if (sec) {
    const wrap = sec.closest('section') || sec;
    wrap.addEventListener('dragover', (e) => { e.preventDefault(); });
    wrap.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) await importFiles(e.dataTransfer.files);
    });
  }
  renderEntry();
  // ★ 从资产库同步（资产库是唯一数据源；这里只是把清单拉回来给面板用）
  syncFromLibrary().then(() => renderEntry());
  window.addEventListener('focus', () => { syncFromLibrary().then(() => renderEntry()); });
  setInterval(() => { syncFromLibrary().then(() => renderEntry()); }, 6000);
}

window.WBMyAssets = { list, add, remove, upload, openWithModel, addToScene, render: renderEntry, sync: syncFromLibrary };

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
