/* ==========================================================================
 * studio-ctxmenu.js · 物体右键菜单（v64）
 *
 * 用途：镜头里的物体默认是"一个组合"，右键点它可以：
 *   · 解开组合 —— 把组里每个子物体拆成独立物体（各自可选中/移动/旋转）
 *   · 删除选中
 *   · 隐藏/取消
 *
 * 触发：在 3D 视口里右键点到某个物体（右键拖空白处仍然是平移，不弹菜单）。
 * ========================================================================== */
const $ = (s, r) => (r || document).querySelector(s);
const ed = () => (window.__wb && window.__wb.editor) || null;

let menu = null;
let lastAt = { x: 0, y: 0 };

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

/** HTML 转义（★ 之前漏了 —— 少了它「套 PBR 材质」选择器整个函数直接抛 ReferenceError） */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function build() {
  if (menu && document.body.contains(menu)) return menu;
  const el = document.createElement('div');
  el.id = 'edCtxMenu';
  el.className = 'ed-ctx';
  el.hidden = true;
  el.innerHTML = `
    <div class="ed-ctx-head" id="ctxTitle">物体</div>
    <button type="button" class="ed-ctx-item" data-act="group">组合</button>
    <button type="button" class="ed-ctx-item" data-act="ungroup">解开组合</button>
    <button type="button" class="ed-ctx-item" data-act="reset">复位（初始水平位姿）</button>
    <button type="button" class="ed-ctx-item" data-act="paintParts">分块配色</button>
    <button type="button" class="ed-ctx-item" data-act="setPbr">套 PBR 材质…</button>
    <button type="button" class="ed-ctx-item" data-act="addToLibrary">添加到资产库</button>
    <button type="button" class="ed-ctx-item danger" data-act="delete">删除选中</button>
    <button type="button" class="ed-ctx-item muted" data-act="close">取消</button>`;
  document.body.appendChild(el);
  el.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const e = ed();
    hide();
    if (!e || !e.selected) return;
    if (act === 'reset') {
      const ok = e.resetSelected ? e.resetSelected() : false;
      toast(ok ? '已复位到初始位置/朝向' : '没有可复位的初始位姿', ok ? 'ok' : 'warn');
      return;
    }
    if (act === 'group') {
      const n = e.groupSelected ? e.groupSelected() : 0;
      toast(n ? ('已组合 ' + n + ' 个物体（可整体选中/旋转，右键可解开）') : '先 Ctrl+点击选够 2 个物体再组合', n ? 'ok' : 'warn', 3600);
      return;
    }
    if (act === 'ungroup') {
      const n = e.ungroupSelected ? e.ungroupSelected() : 0;
      toast(n ? ('已解开组合：' + n + ' 个独立物体（可分别选中/旋转）') : '这个物体没有子物体，解不开', n ? 'ok' : 'warn', 3600);
    } else if (act === 'paintParts') {
      const n = e.paintParts ? e.paintParts() : 0;
      toast('已分块配色：' + n + ' 块');
    } else if (act === 'setPbr') {
      // ★ 2026-11-09：给**这一个物体**指定 PBR 贴图。
      //   （全局的按部位自动分配在「渲染外观」面板里；这里是手动逐个指定）
      setPbrForSelected(e);
    } else if (act === 'addToLibrary') {
      // ★ 2026-11-08：把选中的物体导出成 GLB 存进**落盘的资产库**，
      //   之后在左轨第 10 格「资产库」里随时能再拿出来用。
      addToLibrary(e);
    } else if (act === 'delete') {
      e.deleteSelected && e.deleteSelected();
    }
  });
  menu = el;
  return el;
}

function hide() { if (menu) menu.hidden = true; }

/**
 * ★ 2026-11-08：把选中的物体存进资产库。
 * 导出成 GLB → POST 到桥的 /library/upload → 落到 资产库/models/。
 *
 * 用户要求（21:00 补充）：
 *   「选中的资产添加到资产**对应的分类**里面，顺便**附上名称**，
 *     比如树就是 xx树，人就是 xx人」
 *   ⇒ 分类按资产类别走（人→人物，树/车/建筑→道具…）
 *   ⇒ 名称带上类别词（树 / 人 / 车…），重名自动加序号
 */
async function addToLibrary(e) {
  const rec = e.selected;
  if (!rec) { toast('先选中一个物体', 'warn'); return; }
  const def = (window.WB_ASSETS || []).find((a) => a.id === rec.assetId);
  const baseName = def ? def.name : (rec.assetId || '模型');
  const category = categoryOf(def, rec);
  toast('正在导出到资产库…');
  try {
    // 先问一下库里有没有同名，好加序号
    const name = await uniqueName(baseName);
    const r = await e.exportSelectedToLibrary(name, category);
    if (!r || !r.ok) {
      toast('存不进资产库：' + ((r && r.error) || '未知'), 'warn', 4000);
      return;
    }
    const catLabel = { character: '人物', material: '材质', light: '灯光', scene: '场景', prop: '道具' }[category] || '道具';
    toast('已存进资产库：' + r.name + '（' + catLabel + '组，左轨第 10 格可再取用）', 'ok', 4200);
    if (window.__initAssetLibrary) window.__initAssetLibrary();
  } catch (err) {
    toast('导出失败：' + String((err && err.message) || err), 'warn', 4000);
  }
}

/** 资产 → 资产库分类 */
function categoryOf(def, rec) {
  const cat = (def && def.cat) || '';
  if (cat === 'people') return 'character';
  if (cat === 'vehicles') return 'prop';
  if (cat === 'nature') return 'prop';
  if (cat === 'buildings') return 'prop';
  if (cat === 'props') return 'prop';
  if (rec && rec.externalAsset) {
    const c = rec.externalAsset.category;
    if (c === 'character') return 'character';
    if (c === 'material') return 'material';
    if (c === 'scene') return 'scene';
    return 'prop';
  }
  return 'prop';
}

/** 重名加序号：「树」→「树2」→「树3」（名字仍然以类别词结尾） */
async function uniqueName(base) {
  const p = window.__studioPip;
  let items = [];
  try {
    const r = await fetch('http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/tool', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'wb_library_list', args: {} }),
    });
    const j = await r.json();
    items = (j && j.items) || [];
  } catch (_) { items = []; }
  const names = new Set(items.map((i) => i.name));
  if (!names.has(base)) return base;
  for (let i = 2; i < 999; i++) {
    const n = base + i;
    if (!names.has(n)) return n;
  }
  return base + Date.now();
}

function partCount(rec) {
  const e = ed();
  if (e && e.partCount) return e.partCount(rec);
  return rec && rec.group ? rec.group.children.length : 0;
}

/**
 * ★ 2026-11-09：给**选中的物体**指定一个 PBR 贴图（ambientCG CC0）。
 *
 * 为什么需要：
 *   · 全局的「按部位自动分配」是猜的（按几何尺寸判角色），
 *     用户想让某个物体用哪种真实贴图，得能**手动指定**。
 *   · 外部导入的 GLB 自带材质 —— 想换成真实 PBR 也得有个入口。
 */
async function setPbrForSelected(e) {
  let items = [];
  try {
    const mod = await import('./pbr-mat.js?v=76');
    items = await mod.pbrList();
  } catch (err) { toast('读 PBR 素材库失败：' + ((err && err.message) || err), 'warn'); return; }
  if (!items.length) {
    toast('本地还没有 PBR 素材。跑 node tools/fetch-pbr.mjs 下载（ambientCG CC0）', 'warn', 5000);
    return;
  }
  const rec = e.selected;
  const cur = rec && rec.pbrId ? rec.pbrId : '';
  // 弹一个简单的选择框
  const box = document.createElement('div');
  box.className = 'ed-ctx';
  box.style.minWidth = '260px';
  box.style.maxHeight = '60vh';
  box.style.overflow = 'auto';
  const groups = {};
  for (const it of items) (groups[it.role || 'neutral'] = groups[it.role || 'neutral'] || []).push(it);
  const LABEL = { wall: '墙', road: '路', ground: '地', floor: '地板', roof: '屋顶', building: '楼体', neutral: '其他' };
  box.innerHTML = '<div class="ed-ctx-head">给这个物体指定 PBR 贴图</div>'
    + '<button type="button" class="ed-ctx-item" data-pbr="">不指定（按部位自动）</button>'
    + Object.keys(groups).sort().map((role) => `
      <div class="ed-ctx-head" style="opacity:.7">${esc(LABEL[role] || role)}</div>`
      + groups[role].map((it) => `
        <button type="button" class="ed-ctx-item${it.id === cur ? ' on' : ''}" data-pbr="${esc(it.id)}">
          <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${esc(it.thumb ? '#ccc' : '#c9c2b4')};margin-right:6px;vertical-align:-1px"></span>${esc(it.label || it.name)}
        </button>`).join('')).join('');
  document.body.appendChild(box);
  const r = box.getBoundingClientRect();
  box.style.left = Math.min(window.innerWidth - r.width - 12, 12) + 'px';
  box.style.top = '12px';
  box.style.zIndex = '1200';
  const close = () => { box.remove(); document.removeEventListener('click', outside, true); };
  const outside = (ev) => { if (!box.contains(ev.target)) close(); };
  setTimeout(() => document.addEventListener('click', outside, true), 0);
  box.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-pbr]');
    if (!b) return;
    const id = b.dataset.pbr || null;
    const r2 = e.setObjectPbr ? e.setObjectPbr(id) : { ok: false, error: '编辑器不支持' };
    close();
    toast(r2.ok ? (id ? '已指定 PBR：' + id : '已恢复自动分配') : ('设置失败：' + (r2.error || '')), r2.ok ? 'ok' : 'warn');
  });
}

function show(clientX, clientY, rec) {
  const el = build();
  const e = ed();
  const count = partCount(rec);
  const selCount = (e && e.selection ? e.selection.length : 1) || 0;
  const gBtn = el.querySelector('[data-act="group"]');
  if (gBtn) {
    const showGroup = selCount >= 2;
    gBtn.hidden = !showGroup;
    gBtn.textContent = '组合（' + selCount + ' 个）';
  }
  const title = $('#ctxTitle', el);
  if (title) title.textContent = (selCount >= 2 ? ('已选 ' + selCount + ' 个物体') : (rec && rec.assetId ? String(rec.assetId).replace('external:', 'GLB ').slice(0, 18) : '物体')) + (selCount < 2 && count > 1 ? ' · ' + count + ' 块' : '');
  const un = el.querySelector('[data-act="ungroup"]');
  if (un) {
    if (selCount >= 2) { un.hidden = true; }
    else { un.hidden = false; un.disabled = count < 2; un.textContent = count > 1 ? ('解开组合（' + count + ' 块）') : '解开组合（已是单体）'; }
  }
  el.hidden = false;
  const r = el.getBoundingClientRect();
  const x = Math.min(clientX, innerWidth - r.width - 8);
  const y = Math.min(clientY, innerHeight - r.height - 8);
  el.style.left = Math.max(8, x) + 'px';
  el.style.top = Math.max(8, y) + 'px';
}

/** 绑定到编辑器画布（每次打开编辑器都可能换 canvas，所以按事件冒泡监听 window） */
function init() {
  window.addEventListener('contextmenu', (ev) => {
    const canvas = ev.target && ev.target.tagName === 'CANVAS' ? ev.target : null;
    if (!canvas) return;
    const e = ed();
    if (!e) return;
    ev.preventDefault();
    ev.stopPropagation();
    const hit = e.objectAt ? e.objectAt(ev.clientX, ev.clientY) : null;
    if (!hit) { hide(); return; }
    const sel = e.selection || [];
    if (!sel.includes(hit.rec)) { e.select(hit.rec); if (hit.mesh) e.pickMesh = hit.mesh; }
    show(ev.clientX, ev.clientY, hit.rec);
  }, true);
  document.addEventListener('pointerdown', (ev) => {
    if (menu && !menu.hidden && !ev.target.closest('#edCtxMenu')) hide();
  }, true);
  window.addEventListener('blur', hide);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hide(); });
  window.__studioCtxMenu = { show, hide };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
