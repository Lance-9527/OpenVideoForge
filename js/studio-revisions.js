import { studioBase, absStudioUrl, resolveStudioBase } from './studio-endpoint.js?v=77';
/* ==========================================================================
 * studio-revisions.js · 版本记录 + A/B 对比（v35）
 *
 * 一次 Blender 出片 = 一条 revision 记录（job / 场景版本 / 参数 / 产物 URL / 本地路径）。
 * 记录在 localStorage（最多 40 条），面板里可以：
 *   · 选 A / B 并排看两版首帧 + 参数差异
 *   · 一键载入 A 或 B 的场景版本（scene_id + revision）继续改
 *   · 生成 A/B 拼图并存到输出目录
 * 对外：window.WBRevisions = { list, add, open, clear }
 * ========================================================================== */
const KEY = 'wb-revisions';
const STUDIO = () => studioBase();
let panel = null;

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function toast(msg, kind = 'ok') {
  const box = $('#toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
}

function list() {
  try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (_) { return []; }
}
function save(arr) {
  try { localStorage.setItem(KEY, JSON.stringify(arr.slice(0, 40))); } catch (_) {}
}
/** 新增一条版本记录（monitor / handoff 都会调） */
function add(rec) {
  if (!rec || !rec.job_id) return null;
  const arr = list().filter(r => r.job_id !== rec.job_id);
  const entry = Object.assign({
    id: 'rev_' + Date.now().toString(36),
    at: Date.now(),
  }, rec);
  arr.unshift(entry);
  save(arr);
  render();
  return entry;
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------ */
/* 面板                                                          */
/* ------------------------------------------------------------ */
function build() {
  if (panel) return panel;
  const el = document.createElement('aside');
  el.id = 'revisionPanel';
  el.className = 'rev-panel';
  el.hidden = true;
  el.innerHTML = `
    <header class="rev-head">
      <b>版本 · A/B 对比</b>
      <span class="rev-count" id="revCount">0 版</span>
      <button type="button" class="rev-x" id="revClose" title="收起">×</button>
    </header>
    <div class="rev-body">
      <div class="rev-pick">
        <label>A <select id="revA"></select></label>
        <label>B <select id="revB"></select></label>
      </div>
      <div class="rev-grid">
        <figure class="rev-card" id="revCardA"><img id="revImgA" alt=""><figcaption id="revCapA">—</figcaption></figure>
        <figure class="rev-card" id="revCardB"><img id="revImgB" alt=""><figcaption id="revCapB">—</figcaption></figure>
      </div>
      <div class="rev-diff" id="revDiff">—</div>
      <div class="rev-acts">
        <button type="button" class="rev-btn" id="revLoadA">载入 A 继续改</button>
        <button type="button" class="rev-btn" id="revLoadB">载入 B 继续改</button>
        <button type="button" class="rev-btn ghost" id="revCompare">拼图对比并存盘</button>
      </div>
      <div class="rev-list" id="revList"></div>
      <div class="rev-hint">记录来自每次成功出片；「载入」会调用 <code>studio.scene.load {scene_id, revision}</code> 回到那一版的场景与相机轨迹。</div>
    </div>`;
  document.body.appendChild(el);
  panel = el;
  $('#revClose', el).onclick = () => { el.hidden = true; };
  $('#revA', el).onchange = () => render();
  $('#revB', el).onchange = () => render();
  $('#revLoadA', el).onclick = () => loadRev('A');
  $('#revLoadB', el).onclick = () => loadRev('B');
  $('#revCompare', el).onclick = () => makeCompare();
  $('#revList', el).onclick = (ev) => {
    const b = ev.target.closest('[data-del]');
    if (!b) return;
    save(list().filter(r => r.id !== b.dataset.del));
    render();
  };
  return el;
}

function revUrl(r, kind) {
  const out = (r.outputs || []).find(o => o.kind === kind);
  return out ? absStudioUrl(out.url) : '';
}

function render() {
  const el = build();
  const arr = list();
  $('#revCount', el).textContent = arr.length + ' 版';
  const opts = arr.map((r, i) => `<option value="${r.id}">${i + 1}. ${r.prefix || '白膜'} · ${fmtTime(r.at)}</option>`).join('');
  const selA = $('#revA', el), selB = $('#revB', el);
  const keepA = selA.value, keepB = selB.value;
  selA.innerHTML = opts || '<option value="">（还没有记录）</option>';
  selB.innerHTML = opts || '<option value="">（还没有记录）</option>';
  if (arr.some(r => r.id === keepA)) selA.value = keepA;
  if (arr.some(r => r.id === keepB)) selB.value = keepB;
  else if (arr.length > 1) selB.value = arr[1].id;
  // A/B 不能是同一版：自动错开
  if (arr.length > 1 && selA.value && selA.value === selB.value) {
    const other = arr.find(r => r.id !== selA.value);
    if (other) selB.value = other.id;
  }

  const A = arr.find(r => r.id === selA.value) || arr[0] || null;
  const B = arr.find(r => r.id === selB.value) || arr[1] || null;

  const fill = (side, rec) => {
    const img = $('#revImg' + side, el), cap = $('#revCap' + side, el);
    if (!rec) { img.removeAttribute('src'); cap.textContent = '—'; return; }
    const u = revUrl(rec, 'first_frame');
    if (u) img.src = u; else img.removeAttribute('src');
    const r = rec.render || {};
    const sec = r.frame_count && r.fps ? (r.frame_count / r.fps).toFixed(1) + 's' : '';
    cap.innerHTML = `<b>${rec.prefix || '白膜'}</b><span>${r.width || '?'}×${r.height || '?'} · ${r.fps || '?'}fps · ${r.frame_count || '?'} 帧 ${sec ? '· ' + sec : ''}</span><span>${fmtTime(rec.at)} · ${rec.blender || ''}</span>`;
  };
  fill('A', A); fill('B', B);

  // 参数差异
  const diff = $('#revDiff', el);
  if (!A || !B) diff.textContent = arr.length < 2 ? '再出一次片就能对比（至少 2 版）' : '—';
  else {
    const ra = A.render || {}, rb = B.render || {};
    const rows = [
      ['分辨率', `${ra.width}×${ra.height}`, `${rb.width}×${rb.height}`],
      ['帧率', ra.fps, rb.fps],
      ['帧数', ra.frame_count, rb.frame_count],
      ['环绕圈数', A.turns ?? '—', B.turns ?? '—'],
      ['场景版本', `r${A.revision ?? '?'}`, `r${B.revision ?? '?'}`],
      ['文件体积', `${Math.round((A.outputs || []).find(o => o.kind === 'video')?.bytes / 1024 || 0)} KB`, `${Math.round((B.outputs || []).find(o => o.kind === 'video')?.bytes / 1024 || 0)} KB`],
    ];
    diff.innerHTML = `<table><tr><td></td><td>A</td><td>B</td></tr>${rows.map(([k, a, b]) => `<tr><td>${k}</td><td class="${a === b ? '' : 'd'}">${a}</td><td class="${a === b ? '' : 'd'}">${b}</td></tr>`).join('')}</table>`;
  }

  // 列表
  $('#revList', el).innerHTML = arr.map((r, i) => `
    <div class="rev-row">
      <span class="rev-i">${String(i + 1).padStart(2, '0')}</span>
      <span class="rev-meta"><b>${r.prefix || '白膜'}</b><em>${fmtTime(r.at)} · ${r.render?.width}×${r.render?.height} · ${r.render?.frame_count}帧</em></span>
      <a class="rev-open" href="${revUrl(r, 'video')}" target="_blank" rel="noopener">MP4</a>
      <a class="rev-open" href="${revUrl(r, 'first_frame')}" target="_blank" rel="noopener">PNG</a>
      <button type="button" class="rev-del" data-del="${r.id}" title="删除记录">✕</button>
    </div>`).join('') || '<div class="rev-empty">还没有版本记录</div>';
}

function current(side) {
  const arr = list();
  const sel = $('#rev' + side, panel);
  return arr.find(r => r.id === sel.value) || (side === 'A' ? arr[0] : arr[1]) || null;
}

async function loadRev(side) {
  const rec = current(side);
  if (!rec) { toast('没有可载入的版本', 'warn'); return; }
  if (!rec.scene_id) { toast('这条记录没有 scene_id，无法回载', 'warn'); return; }
  try {
    const out = await window.WB_AGENT.run('studio.scene.load', { scene_id: rec.scene_id, revision: rec.revision });
    toast(out.ok ? '已载入 ' + side + ' 版（r' + rec.revision + '）' : '载入失败：' + out.error, out.ok ? 'ok' : 'warn');
  } catch (e) { toast('载入失败：' + e.message, 'warn'); }
}

async function makeCompare() {
  const A = current('A'), B = current('B');
  if (!A || !B) { toast('需要至少两版', 'warn'); return; }
  const load = (u) => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = u; });
  try {
    const [ia, ib] = await Promise.all([load(revUrl(A, 'first_frame')), load(revUrl(B, 'first_frame'))]);
    const w = ia.width, h = ia.height;
    const cv = document.createElement('canvas');
    cv.width = w * 2; cv.height = h + 46;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#14110d';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(ia, 0, 0, w, h);
    ctx.drawImage(ib, w, 0, w, h);
    ctx.fillStyle = '#f3ecdb';
    ctx.font = '600 18px Inter, system-ui, sans-serif';
    ctx.fillText('A · ' + (A.prefix || '白膜') + ' · r' + A.revision, 14, h + 30);
    ctx.fillText('B · ' + (B.prefix || '白膜') + ' · r' + B.revision, w + 14, h + 30);
    const url = cv.toDataURL('image/png');
    const name = 'AB对比_' + (A.prefix || 'A') + '_vs_' + (B.prefix || 'B') + '.png';
    if (window.WBSave) await window.WBSave.save(url, name);
    else { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); }
    toast('对比图已生成：' + name);
  } catch (e) { toast('拼图失败：' + e.message, 'warn'); }
}

function open() { build().hidden = false; render(); }
function toggle() { if (!panel || panel.hidden) open(); else panel.hidden = true; }

window.WBRevisions = { list, add, open, toggle, clear: () => { save([]); render(); } };

/* 顶栏按钮 */
let mounted = false;
function mount() {
  if (mounted) return;
  const tools = document.querySelector('.tb-tools');
  if (!tools) return;
  const b = document.createElement('button');
  b.id = 'wbRevisions';
  b.className = 'tb-btn';
  b.type = 'button';
  b.textContent = '版本对比';
  b.title = 'A/B 对比每次出片的版本（可回载场景继续改）';
  b.onclick = toggle;
  const anchor = document.querySelector('#wbBlenderBridge');
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(b, anchor.nextSibling);
  else tools.appendChild(b);
  mounted = true;
  const n = list().length;
  if (n) b.textContent = '版本对比 ' + n;
}
const mo = new MutationObserver(() => { mount(); });
mo.observe(document.body, { childList: true, subtree: true });
mount();

export { list, add, open, toggle };
