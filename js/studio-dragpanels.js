/* ==========================================================================
 * studio-dragpanels.js · 浮层可拖动（v57）
 *
 * 场景区上方那几个浮层（运动轨迹 / 设备机位 / 版本对比 / 成片预览小窗 / 渲染 HUD /
 * 一键出片对话框）原来位置固定，会挡镜头。现在：
 *   · 按住它们的**标题栏**就能拖走（按钮/输入框上不会触发拖拽）
 *   · 位置记在 localStorage（每个面板独立），刷新后回到原处
 *   · 双击标题栏 = 回到默认位置
 *   · 窗口缩放 / 面板尺寸变化时自动夹在可视区内，不会拖丢
 * ========================================================================== */
const PANELS = [
  { key: 'tracks',   sel: '#trackPanel',    head: '.tk-head' },
  { key: 'device',   sel: '#devicePanel',   head: '.dev-head' },
  { key: 'revisions', sel: '#revisionPanel', head: '.rev-head' },
  { key: 'pip',      sel: '#vpPip',         head: '.vp-pip-head' },
  { key: 'hud',      sel: '#wbRenderHud',   head: '.rb-head' },
  { key: 'dialog',   sel: '#handoffDlg .ho-card', head: 'header', dialog: true },
];
const STORE = 'wb-panel-pos';
const MARGIN = 8;

let pos = {};
try { pos = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (_) { pos = {}; }
const savePos = () => { try { localStorage.setItem(STORE, JSON.stringify(pos)); } catch (_) {} };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function apply(el, key) {
  const p = pos[key];
  if (!p) return;
  el.style.position = 'fixed';
  el.style.left = p.x + 'px';
  el.style.top = p.y + 'px';
  el.style.right = 'auto';
  el.style.bottom = 'auto';
  el.style.margin = '0';
}

function clampInto(el) {
  const r = el.getBoundingClientRect();
  const maxX = Math.max(MARGIN, innerWidth - r.width - MARGIN);
  const maxY = Math.max(MARGIN, innerHeight - Math.min(r.height, innerHeight - MARGIN * 2) - MARGIN);
  return { maxX, maxY };
}

function ensure(el, def) {
  if (!el || el.__wbDrag) return;
  const head = el.querySelector(def.head);
  if (!head) return;
  el.__wbDrag = true;
  el.classList.add('wb-drag');
  head.classList.add('wb-drag-handle');
  apply(el, def.key);

  let drag = null;
  head.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.closest('button, input, select, textarea, a, .no-drag')) return;
    const r = el.getBoundingClientRect();
    drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, r };
    el.classList.add('wb-dragging');
    try { head.setPointerCapture(ev.pointerId); } catch (_) {}
    ev.preventDefault(); ev.stopPropagation();
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  });

  function onMove(ev) {
    if (!drag) return;
    const w = drag.r.width, h = drag.r.height;
    const x = clamp(ev.clientX - drag.dx, MARGIN, Math.max(MARGIN, innerWidth - w - MARGIN));
    const y = clamp(ev.clientY - drag.dy, MARGIN, Math.max(MARGIN, innerHeight - Math.min(h, innerHeight - MARGIN * 2) - MARGIN));
    el.style.position = 'fixed';
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.right = 'auto';
    el.style.bottom = 'auto';
    el.style.margin = '0';
  }

  function onUp() {
    window.removeEventListener('pointermove', onMove);
    if (!drag) return;
    drag = null;
    el.classList.remove('wb-dragging');
    const r = el.getBoundingClientRect();
    pos[def.key] = { x: Math.round(r.left), y: Math.round(r.top) };
    savePos();
  }

  head.addEventListener('dblclick', (ev) => {
    if (ev.target.closest('button, input, select, textarea, a')) return;
    delete pos[def.key];
    savePos();
    el.style.left = '';
    el.style.top = '';
    el.style.right = '';
    el.style.bottom = '';
    el.style.margin = '';
    if (def.dialog) el.style.position = '';
    else el.style.position = '';
    ev.stopPropagation();
  });
}

function scan() {
  for (const def of PANELS) {
    const el = document.querySelector(def.sel);
    if (el) ensure(el, def);
  }
  // 拖出视口后（例如窗口变小）夹回来
  for (const def of PANELS) {
    const el = document.querySelector(def.sel);
    if (!el || !el.__wbDrag || el.hidden) continue;
    const r = el.getBoundingClientRect();
    const { maxX, maxY } = clampInto(el);
    if (r.left > maxX || r.top > maxY || r.left < 0 || r.top < 0) {
      const x = clamp(r.left, MARGIN, maxX);
      const y = clamp(r.top, MARGIN, maxY);
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.right = 'auto';
      el.style.bottom = 'auto';
      pos[def.key] = { x: Math.round(x), y: Math.round(y) };
      savePos();
    }
  }
}

const mo = new MutationObserver(() => scan());
mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class'] });
window.addEventListener('resize', scan);
setInterval(scan, 1200);
scan();

window.WBPanels = {
  reset: (key) => {
    if (key) delete pos[key];
    else for (const k of Object.keys(pos)) delete pos[k];
    savePos();
    for (const def of PANELS) {
      const el = document.querySelector(def.sel);
      if (!el) continue;
      el.style.left = ''; el.style.top = ''; el.style.right = ''; el.style.bottom = ''; el.style.margin = '';
    }
  },
  positions: () => ({ ...pos }),
};
