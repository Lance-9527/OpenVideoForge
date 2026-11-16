/* ==========================================================================
 * studio-curve.js · 曲线 / 逐帧 / 关键帧过滤（v0.6）
 *
 * 挂在右栏「动画」页下方，补上参考编辑器底部那组能力里最实用的三项：
 *   1. 运动曲线：把镜头间的相机距离 r 采样成一条折线，关键帧处画虚线，播放时画播放头
 *   2. 逐帧：跳至最前 / 上一帧 / 下一帧 / 跳至最后（1/30 s 步进）
 *   3. 关键帧过滤：按名称过滤下方关键帧列表
 * ========================================================================== */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const FPS = 30;
const tl = () => (window.__wb && window.__wb.timeline) || null;

let wrap = null;
let svg = null;
let filterEl = null;
let raf = 0;

function fmt(sec) {
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

function shotsOf() {
  const t = tl();
  if (!t) return [];
  try { return t.getShots(); } catch (_) { return []; }
}

function totalOf(shots) {
  return shots.reduce((a, s) => a + (Number(s.duration) || 3), 0);
}

/* 采样相机距离 r（用时间线的 interpCam，球坐标最短弧） */
function sampleR(shots, t) {
  const api = window.WB_TIMELINE;
  if (!shots.length || !api || !api.interpCam) return 0;
  let acc = 0;
  for (let i = 0; i < shots.length; i++) {
    const d = Number(shots[i].duration) || 3;
    if (t <= acc + d || i === shots.length - 1) {
      const a = shots[i];
      const b = shots[Math.min(i + 1, shots.length - 1)];
      const k = d > 0 ? Math.max(0, Math.min(1, (t - acc) / d)) : 1;
      const cam = api.interpCam(a.cam, b.cam, k, a.ease || 'inout');
      return Number(cam.r) || 0;
    }
    acc += d;
  }
  return 0;
}

function build() {
  const panel = $('.sr-panel[data-panel="anim"]');
  if (!panel || panel.querySelector('.cv-wrap')) return null;
  const box = document.createElement('div');
  box.className = 'cv-wrap';
  box.innerHTML = `
    <div class="cv-head"><b>运动曲线</b><span id="cvInfo">—</span></div>
    <svg class="cv-svg" id="cvSvg" viewBox="0 0 300 108" preserveAspectRatio="none"></svg>
    <div class="cv-frames">
      <button type="button" data-cv="first" title="跳至最前">⏮ 最前</button>
      <button type="button" data-cv="prev" title="上一帧">◀ 上一帧</button>
      <button type="button" data-cv="next" title="下一帧">下一帧 ▶</button>
      <button type="button" data-cv="last" title="跳至最后">最后 ⏭</button>
    </div>
    <input class="cv-filter" id="cvFilter" type="search" placeholder="按名称过滤关键帧（下面列表）" autocomplete="off">`;
  panel.appendChild(box);
  wrap = box;
  svg = $('#cvSvg', box);
  filterEl = $('#cvFilter', box);

  box.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cv]');
    if (!b) return;
    const t = tl();
    if (!t) return;
    const total = t.totalDuration();
    const cur = typeof t._time === 'number' ? t._time : 0;
    const step = 1 / FPS;
    if (b.dataset.cv === 'first') t.seek(0);
    else if (b.dataset.cv === 'last') t.seek(total);
    else if (b.dataset.cv === 'prev') t.seek(Math.max(0, cur - step));
    else if (b.dataset.cv === 'next') t.seek(Math.min(total, cur + step));
  });

  filterEl.addEventListener('input', () => filterKeys());

  // 列表重建后重新套过滤
  const list = document.querySelector('.sr-keylist');
  if (list) new MutationObserver(() => filterKeys()).observe(list, { childList: true });

  if (!raf) raf = requestAnimationFrame(loop);
  return box;
}

function filterKeys() {
  const q = (filterEl && filterEl.value || '').trim().toLowerCase();
  $$('.sr-key').forEach(row => {
    const name = (row.querySelector('.sr-key-name') || {}).textContent || '';
    row.style.display = !q || name.toLowerCase().includes(q) ? '' : 'none';
  });
}

function draw() {
  if (!svg) return;
  const shots = shotsOf();
  const total = totalOf(shots);
  const W = 300, H = 108, PAD = 8;
  const info = $('#cvInfo');
  if (info) info.textContent = shots.length ? shots.length + ' 帧 · ' + fmt(total) : '暂无关键帧';
  if (!shots.length) {
    svg.innerHTML = '<text class="tick" x="150" y="56" text-anchor="middle">还没有关键帧</text>';
    return;
  }

  // 采样
  const N = 120;
  const rs = [];
  for (let i = 0; i <= N; i++) rs.push(sampleR(shots, (i / N) * total));
  const maxR = Math.max(...rs, 1), minR = Math.min(...rs, 0);
  const span = Math.max(0.001, maxR - minR);
  const x = (t) => PAD + (t / Math.max(0.001, total)) * (W - PAD * 2);
  const y = (r) => H - PAD - ((r - minR) / span) * (H - PAD * 2);

  const parts = [];
  // 网格
  for (let g = 1; g < 4; g++) {
    const gy = PAD + (g / 4) * (H - PAD * 2);
    parts.push(`<line class="grid" x1="${PAD}" y1="${gy.toFixed(1)}" x2="${W - PAD}" y2="${gy.toFixed(1)}"/>`);
  }
  // 关键帧竖线
  let acc = 0;
  shots.forEach((s, i) => {
    const d = Number(s.duration) || 3;
    parts.push(`<line class="keyline" x1="${x(acc).toFixed(1)}" y1="${PAD}" x2="${x(acc).toFixed(1)}" y2="${H - PAD}"/>`);
    if (i === 0 || i === shots.length - 1) {
      parts.push(`<text class="tick" x="${(x(acc) + 2).toFixed(1)}" y="${H - 1}">${fmt(acc)}</text>`);
    }
    acc += d;
  });
  // 曲线
  const pts = rs.map((r, i) => `${x((i / N) * total).toFixed(1)},${y(r).toFixed(1)}`).join(' ');
  parts.push(`<polyline class="curve" points="${pts}"/>`);
  // 播放头
  const t = tl();
  const cur = (t && typeof t._time === 'number') ? t._time : 0;
  parts.push(`<line class="playhead" x1="${x(cur).toFixed(1)}" y1="${PAD}" x2="${x(cur).toFixed(1)}" y2="${H - PAD}"/>`);
  // 图例
  parts.push(`<text class="tick" x="${PAD}" y="10">r 最大 ${maxR.toFixed(1)}</text>`);
  parts.push(`<text class="tick" x="${W - PAD}" y="10" text-anchor="end">${fmt(cur)} / ${fmt(total)}</text>`);

  svg.innerHTML = parts.join('');
}

function loop() {
  draw();
  raf = requestAnimationFrame(loop);
}

function init() {
  const view = $('#view-editor');
  if (!view) return;
  const mo = new MutationObserver(() => { if (!view.hidden) setTimeout(build, 120); });
  mo.observe(view, { attributes: true, attributeFilter: ['hidden'] });
  build();
  window.__studioCurve = { draw, sampleR, filterKeys };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
