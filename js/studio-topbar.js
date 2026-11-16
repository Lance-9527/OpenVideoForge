/* ==========================================================================
 * studio-topbar.js · 编辑器顶栏重排 + 工具（v0.5）
 *
 * 参考酷家乐 3D 棚拍顶栏的分组：
 *   左：返回 / 场景名
 *   中：保存 · 撤销 · 恢复 ｜ 对象坐标 · 吸附 · 灯光 · 相机 · 空对象 · 场景剪辑
 *   右：消息 · 帮助 · 手册 ｜ 立即渲染
 *
 * 做法：**搬动原有按钮，不重建**（app.js 在 init() 里用 onclick 绑过 #edBack/#edSave/#edGrid/#edShot，
 * 元素被搬走但对象还在，绑定不丢）。新增按钮由本文件创建。
 * ========================================================================== */

import * as THREE from 'three';

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const ed = () => (window.__wb && window.__wb.editor) || null;
const tl = () => (window.__wb && window.__wb.timeline) || null;

let hist = [];
let fut = [];
/* ★ 2026-11-08：撤销/恢复期间**禁止再记检查点**。
 *   原因：undo/redo 内部调 `e.loadScene()`，而 loadScene 会调 `loadEnv()`
 *   —— `loadEnv` 被 patch 过（自动 checkpoint），于是：
 *     undo → loadScene → loadEnv → checkpoint() → **fut.length = 0**
 *   redo 栈被自己的撤销动作清空 ⇒ **「恢复」永远失效**（实测：加物体→撤销→恢复，物体回不来）。
 *   这个标志把 loadScene 期间的所有 checkpoint 挡掉。 */
let suppressCheckpoint = false;

function toast(msg, kind = 'ok', ms = 2400) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

function snap() {
  const e = ed();
  if (!e) return null;
  try { return JSON.stringify(e.serialize()); } catch (_) { return null; }
}

function checkpoint() {
  if (suppressCheckpoint) return;      // ★ 撤销/恢复期间不记点
  const s = snap();
  if (!s) return;
  if (hist[hist.length - 1] !== s) {
    hist.push(s);
    if (hist.length > 40) hist.shift();
  }
  fut.length = 0;
}

/** ★ 撤销/恢复期间执行一段代码，期间不记检查点 */
async function quietly(fn) {
  const was = suppressCheckpoint;
  suppressCheckpoint = true;
  try { await fn(); } finally { suppressCheckpoint = was; }
}

async function undo() {
  const e = ed();
  if (!e || !hist.length) { toast('没有可撤销的操作', 'warn'); return; }
  const cur = snap();
  const s = hist.pop();
  if (cur) fut.push(cur);
  try {
    await quietly(() => e.loadScene(JSON.parse(s)));
    toast('已撤销');
  } catch (err) { toast('撤销失败：' + err.message, 'err'); }
  syncToggles();
}

async function redo() {
  const e = ed();
  if (!e || !fut.length) { toast('没有可恢复的操作', 'warn'); return; }
  const cur = snap();
  const s = fut.pop();
  if (cur) hist.push(cur);
  try {
    await quietly(() => e.loadScene(JSON.parse(s)));
    toast('已恢复');
  } catch (err) { toast('恢复失败：' + err.message, 'err'); }
  syncToggles();
}

/* 把「会改场景」的方法包一层，自动记检查点（每个实例只包一次） */
function patchEditor(e) {
  if (!e || e.__v05patched) return;
  e.__v05patched = true;
  const wrap = (name) => {
    const orig = e[name];
    if (typeof orig !== 'function') return;
    e[name] = function (...args) {
      checkpoint();
      return orig.apply(this, args);
    };
  };
  /* ★ 2026-11-08：补上新增的入口 —— 之前只有 4 个方法被包，
   *   于是「拖拉拽放置」「复制」「进屋」这些新路径**撤销不了**（实测：拖放后撤销没反应）。
   *   · beginPlace / beginPlaceExternal → 一开始拖放就记点（此时场景还没加物体，快照=放置前）
   *   · duplicateAsset / enterBuilding → 直接改场景，记点
   */
  ['addAsset', 'deleteSelected', 'loadEnv', 'setTransform',
    'beginPlace', 'beginPlaceExternal', 'duplicateAsset', 'enterBuilding',
  ].forEach(wrap);
}

/* ------------------------------------------------------------ */
/* 空对象：往资产库里注册一个可选的空组                            */
/* ------------------------------------------------------------ */
function ensureEmptyAsset() {
  if (!window.WB_ASSETS || window.WB_ASSETS.some(a => a.id === '__empty')) return;
  window.WB_ASSETS.push({
    id: '__empty',
    name: '空对象',
    cat: 'prop',
    desc: '定位标记 / 机位参考',
    make() {
      const g = new THREE.Group();
      const geo = new THREE.OctahedronGeometry(0.3, 0);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xd4b68a, wireframe: true }));
      mesh.position.y = 1.2;
      g.add(mesh);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.42, 0.015, 6, 32),
        new THREE.MeshBasicMaterial({ color: 0x8fac96 })
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.02;
      g.add(ring);
      g.add(new THREE.AxesHelper(0.8));
      return g;
    },
  });
}

/* ------------------------------------------------------------ */
/* 顶栏结构                                                      */
/* ------------------------------------------------------------ */
function buildTopbar() {
  const top = $('.ed-top');
  if (!top || top.querySelector('#tbUndo')) return;

  const back = $('#edBack');
  const badge = $('#edEnvBadge');
  const name = $('#edName');
  const save = $('#edSave');
  const grid = $('#edGrid');
  const shot = $('#edShot');
  const storyboard = $('#edStoryboard');
  const render = $('#edRender');

  // 清空（元素先摘下来）
  const keep = [back, badge, name].filter(Boolean);
  top.innerHTML = '';

  const grp = (cls, ...els) => {
    const d = document.createElement('div');
    d.className = 'tb-group ' + (cls || '');
    els.filter(Boolean).forEach(el => d.appendChild(el));
    return d;
  };
  const mk = (id, label, title, onClick) => {
    const b = document.createElement('button');
    b.className = 'tb-btn';
    b.id = id;
    b.type = 'button';
    b.title = title || label;
    b.textContent = label;
    b.addEventListener('click', onClick);
    return b;
  };
  const mkIcon = (id, svg, title, onClick) => {
    const b = mk(id, '', title, onClick);
    b.innerHTML = svg;
    b.classList.add('tb-icon');
    return b;
  };

  const left = document.createElement('div');
  left.className = 'tb-left';
  keep.forEach(el => left.appendChild(el));

  // 原有「截图 / 网格」收进工具组，保证 app.js 的绑定仍在
  if (shot) shot.classList.add('tb-mini');
  if (grid) grid.classList.add('tb-mini');

  const seg = document.createElement('div');
  seg.className = 'tb-seg';
  if (save) { save.className = 'tb-btn primary'; save.textContent = '保存'; seg.appendChild(save); }
  seg.appendChild(mk('tbUndo', '撤销', '撤销上一步（Ctrl+Z）', undo));
  seg.appendChild(mk('tbRedo', '恢复', '恢复（Ctrl+Shift+Z）', redo));

  const tools = document.createElement('div');
  tools.className = 'tb-tools';
  tools.appendChild(mk('tbCoord', '对象坐标', '显示/隐藏选中框与坐标', () => toggleCoord()));
  tools.appendChild(mk('tbSnap', '吸附', '位置吸附到 0.5 m 网格', () => toggleSnap()));

  // v0.8：拖拽模式（自由 / 贴地 / 高度）—— 解决"选中物只能平面位移"的困惑
  const dragSeg = document.createElement('div');
  dragSeg.className = 'tb-seg drag-seg';
  dragSeg.innerHTML = `
    <span class="tb-seg-label">拖拽</span>
    <button type="button" data-drag="free" title="自由：沿相机平面三轴移动（默认）">自由</button>
    <button type="button" data-drag="ground" title="贴地：只改 XZ，Y 保持不变">贴地</button>
    <button type="button" data-drag="y" title="高度：只改 Y">高度</button>`;
  dragSeg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-drag]');
    if (!b) return;
    setDragMode(b.dataset.drag);
  });
  tools.appendChild(dragSeg);

  tools.appendChild(mk('tbLight', '灯光', '显示灯光方向辅助线', () => toggleLight()));
  tools.appendChild(mk('tbDrop', '落地', '把选中对象放到地面（按包围盒底部对齐）', () => dropSelected()));
  tools.appendChild(mk('tbNoOverlap', '去重叠', '把互相穿插的物体在水平面分开（确定性布局求解，不是物理引擎）', () => solveNoOverlap()));
  tools.appendChild(mk('tbCam', '相机', '把当前相机存为一个镜头', () => addShot()));
  tools.appendChild(mk('tbEmpty', '空对象', '放一个空对象作定位标记', () => addEmpty()));
  tools.appendChild(mk('tbClip', '场景剪辑', '折叠/展开底部镜头时间线', () => toggleClip()));
  // ★ 2026-11-08：预设 / 批量出图 / 分享链接
  if (window.__ovfSavePreset) {
    tools.appendChild(mk('tbPreset', '存为预设', '把当前画面整套存下来，之后在入口页一键调出来', () => window.__ovfSavePreset()));
    tools.appendChild(mk('tbBatch', '批量出图', '绕当前目标转一圈，每个角度出一张 JPG', () => window.__ovfBatchRender({ count: 4 })));
    tools.appendChild(mk('tbShare', '复制链接', '把当前状态编码成链接，打开即还原', () => window.__ovfShareLink()));
  }
  if (shot) tools.appendChild(shot);
  if (grid) tools.appendChild(grid);

  const meta = document.createElement('div');
  meta.className = 'tb-meta';
  meta.appendChild(mk('tbMsg', '消息', '今天的工作台状态', () => showMessages()));
  meta.appendChild(mk('tbHelp', '帮助', '快捷键与操作提示', () => showHelp()));
  meta.appendChild(mk('tbManual', '手册', '打开《白膜 HTML 规范》', () => openManual()));
  if (storyboard) meta.appendChild(storyboard);

  const right = document.createElement('div');
  right.className = 'tb-right';
  right.appendChild(meta);
  const rc = mk('tbRender', '立即渲染', '按当前分辨率出图并下载', () => {
    if (window.__studioInspector && window.__studioInspector.grab) {
      window.__studioInspector.grab(true);
      return;
    }
    const legacy = $('#edRender');
    if (legacy) legacy.click();
    else toast('渲染面板不可用', 'warn');
  });
  rc.className = 'tb-btn render';
  right.appendChild(rc);

  top.appendChild(left);
  top.appendChild(seg);
  top.appendChild(tools);
  top.appendChild(right);
}

/* ------------------------------------------------------------ */
/* 工具动作                                                      */
/* ------------------------------------------------------------ */
let st = { coord: true, snap: false, light: false, drag: 'free' };

function setDragMode(m) {
  const e = ed();
  st.drag = m;
  if (e && e.setDragMode) e.setDragMode(m);
  syncToggles();
  const label = m === 'free' ? '自由（相机平面三轴）' : (m === 'ground' ? '贴地（只改 XZ）' : '高度（只改 Y）');
  toast('拖拽模式：' + label + '（拖动时按住 Shift 临时切高度 / Alt 临时切贴地）', 'ok', 3200);
}

function toggleCoord() {
  const e = ed(); if (!e) return;
  st.coord = !st.coord;
  e.selHelper.visible = st.coord && !!e.selected;
  if (!st.coord) e.select(null);
  syncToggles();
  toast(st.coord ? '已显示选中框 / 坐标' : '已隐藏选中框 / 坐标');
}

function toggleSnap() {
  const e = ed(); if (!e) return;
  st.snap = e.setSnap(!st.snap);
  syncToggles();
  toast(st.snap ? '吸附开启：位置对齐 0.5 m 网格' : '吸附关闭');
}

function toggleLight() {
  const e = ed(); if (!e) return;
  st.light = e.setLightHelpers(!st.light);
  syncToggles();
  toast(st.light ? '已显示灯光方向辅助线' : '已隐藏灯光辅助线');
}

function addShot() {
  const t = tl(); if (!t) { toast('时间线未就绪', 'warn'); return; }
  const s = t.addShotFromCamera();
  toast(s ? '已把当前相机存为镜头：' + s.label : '加镜头失败', s ? 'ok' : 'warn');
}

function addEmpty() {
  const e = ed(); if (!e) return;
  ensureEmptyAsset();
  checkpoint();
  e.addAsset('__empty');
  toast('已放置空对象');
}

function dropSelected() {
  const e = ed();
  if (!e || !e.selected) { toast('先选中一个对象', 'warn'); return; }
  const r = e.dropToGround();
  toast(r ? '已落地（底部 y=' + r.bottom + '）' : '落地失败', r ? 'ok' : 'warn');
}

/** v68 · 去重叠：确定性布局求解（水平面 MTV 分离），不是刚体物理引擎 */
function solveNoOverlap() {
  const e = ed();
  if (!e || !e.solveLayout) { toast('场景未就绪', 'warn'); return; }
  const r = e.solveLayout({});
  if (!r || !r.ok) { toast((r && r.reason) || '求解失败', 'warn'); return; }
  toast(r.moved
    ? ('已分开 ' + r.moved + ' 个穿插物体（' + r.pairs.length + ' 对，' + r.iterations + ' 轮收敛）')
    : '没有发现穿插', r.moved ? 'ok' : 'warn');
}

function toggleClip() {
  const btn = $('#wb-timeline .tl-collapse');
  if (btn) { btn.click(); return; }
  toast('时间线未挂载', 'warn');
}

function showMessages() {
  const e = ed();
  const parts = [
    '场景：' + (($('#edName') || {}).value || '未命名'),
    '资产 ' + (e ? e.objects.length : 0) + ' 个',
    '机位 ' + (e ? e.cams.length : 0) + ' 个',
    '镜头 ' + (tl() ? tl().getShots().length : 0) + ' 个',
  ];
  toast(parts.join(' · '), 'ok', 4200);
}

function showHelp() {
  closeHelp();
  const box = document.createElement('div');
  box.id = 'tbHelpModal';
  box.className = 'tb-modal';
  box.innerHTML = `
    <div class="tb-modal-card">
      <header><b>操作与快捷键</b><button type="button" data-close>×</button></header>
      <div class="tb-modal-body">
        <p><b>视图</b>：左键旋转 · 滚轮缩放 · 右键/Shift 平移 · 点击选中</p>
        <p><b>飞行</b>：<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 前后左右 · <kbd>Q</kbd>/<kbd>E</kbd> 降/升 · 按住 <kbd>Shift</kbd> 加速</p>
        <p><b>拖拽选中物体</b>：默认自由三轴 · 顶栏可切「贴地 / 高度」 · 按住 <kbd>Shift</kbd> 临时调高度、<kbd>Alt</kbd> 临时贴地 · <kbd>G</kbd> 一键落地</p>
        <p><b>镜头</b>：<kbd>Space</kbd> 播放/暂停 · <kbd>←</kbd>/<kbd>→</kbd> 上/下一镜头 · 顶栏「相机」抓当前机位</p>
        <p><b>撤销</b>：<kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销 · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 恢复</p>
        <p><b>出图</b>：右栏「相机」页选分辨率 → 抓取当前视角 / 渲染并下载 PNG；右上角小窗是实时渲染预览</p>
      </div>
    </div>`;
  document.body.appendChild(box);
  box.addEventListener('click', (ev) => {
    if (ev.target === box || ev.target.closest('[data-close]')) closeHelp();
  });
}

function closeHelp() {
  const old = $('#tbHelpModal');
  if (old) old.remove();
}

function openManual() {
  window.open('spec/白膜HTML规范.md', '_blank');
}

function syncToggles() {
  const set = (id, on) => {
    const b = document.getElementById(id);
    if (b) b.classList.toggle('on', !!on);
  };
  set('tbCoord', st.coord);
  set('tbSnap', st.snap);
  set('tbLight', st.light);
  $$('.drag-seg [data-drag]').forEach(b => b.classList.toggle('on', b.dataset.drag === st.drag));
}

/* 编辑器每次打开：换实例 → 重新 patch + 复位开关 */
function onEditorShown() {
  const e = ed();
  if (!e) return;
  patchEditor(e);
  ensureEmptyAsset();
  st = { coord: true, snap: false, light: false, drag: st.drag || 'free' };
  if (e.setDragMode) e.setDragMode(st.drag);
  e.selHelper.visible = false;
  syncToggles();
}

function init() {
  buildTopbar();
  const view = $('#view-editor');
  if (view) {
    const mo = new MutationObserver(() => { if (!view.hidden) setTimeout(onEditorShown, 60); });
    mo.observe(view, { attributes: true, attributeFilter: ['hidden'] });
    if (!view.hidden) onEditorShown();
  }
  document.addEventListener('keydown', (ev) => {
    const view = $('#view-editor');
    if (!view || view.hidden) return;
    const tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (!(ev.ctrlKey || ev.metaKey) && (ev.key === 'g' || ev.key === 'G')) {
      ev.preventDefault();
      dropSelected();
      return;
    }
    if (!(ev.ctrlKey || ev.metaKey)) return;
    if (ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      ev.shiftKey ? redo() : undo();
    }
  });
  window.__studioTopbar = { undo, redo, checkpoint, addShot, addEmpty, toggleSnap, toggleLight, toggleCoord };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
