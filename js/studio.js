/* ==========================================================================
 * studio.js · 入口页「模板中心」改造（v0.3）
 *
 * 参考酷家乐电商棚拍 / 视颂模板页的信息架构：
 *   左侧分组导航 · 顶栏（学习教程 / 场景库 / 新建）· 大标题 + 多维筛选 chips
 *   · 模板卡片网格 + hover「用这个模板」· AI 搜索框（本地模糊匹配）
 *
 * 不改 app.js 的任何渲染逻辑：
 *   - app.js 往 #envGrid / #mineGrid 写卡片、用委托 click 打开编辑器；
 *   - 本文件只「加壳 + 装饰卡片 + 过滤」，卡片本身与点击链路保持原样。
 * ========================================================================== */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* 环境 → 模板标签（对应参考页的「行业 / 空间 / 商品」三行筛选） */
const ENV_TAGS = {
  room:   { space: '室内', style: '居家' },
  street: { space: '室外', style: '建筑' },
  temple: { space: '室外', style: '古风' },
  office: { space: '室内', style: '办公' },
  wild:   { space: '室外', style: '自然' },
  studio: { space: '抽象', style: '极简' },
};

const FILTERS = [
  { key: 'space', label: '空间', options: ['全部', '室内', '室外', '抽象'] },
  { key: 'style', label: '风格', options: ['全部', '居家', '建筑', '古风', '办公', '自然', '极简'] },
];

const ICONS = {
  star: '<path d="M12 2.6l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.4l6.5-.9L12 2.6z" fill="currentColor"/>',
  grid: '<path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z" fill="currentColor"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5zm0 8.6l6.6-3.7L12 4.2 5.4 7.9 12 11.6zM3 13l9 5 9-5v2l-9 5-9-5v-2z" fill="currentColor"/>',
  upload: '<path d="M12 3l5 5h-3v6h-4V8H7l5-5zM5 18h14v2H5v-2z" fill="currentColor"/>',
  book: '<path d="M4 3h7a3 3 0 013 3v13a3 3 0 00-3-3H4V3zm16 0h-4a3 3 0 00-3 3v13a3 3 0 013-3h4V3z" fill="currentColor"/>',
  cube: '<path d="M12 2l9 5v10l-9 5-9-5V7l9-5zm0 2.3L5.5 8 12 11.7 18.5 8 12 4.3z" fill="currentColor"/>',
  trash: '<path d="M9 3h6l1 2h4v2H4V5h4l1-2zm-3 6h12l-1 12H7L6 9z" fill="currentColor"/>',
  library: '<path d="M4 4h4v16H4V4zm6 0h4v16h-4V4zm6 2l4 1-3 13-4-1 3-13z" fill="currentColor"/>',
};

let activeSpace = '全部';
let activeStyle = '全部';
let query = '';

function toast(msg, kind = 'ok', ms = 3000) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

/* ------------------------------------------------------------ */
/* 1. 顶栏补按钮                                                  */
/* ------------------------------------------------------------ */
function buildTopbar(entry) {
  const acts = $('.en-top-actions', entry);
  if (!acts || acts.querySelector('#studioNew')) return;
  const makeBtn = (text, cls, id) => {
    const b = document.createElement('button');
    b.className = 'btn ' + cls;
    b.id = id;
    b.type = 'button';
    b.textContent = text;
    return b;
  };
  const newBtn = makeBtn('＋ 新建场景', 'primary studio-new-btn', 'studioNew');
  newBtn.addEventListener('click', () => {
    const c = $('#enCardNew');
    if (c) c.click();
  });
  acts.insertBefore(newBtn, acts.firstChild);
}

/* ------------------------------------------------------------ */
/* 2. 左侧导航                                                    */
/* ------------------------------------------------------------ */
function buildNav(entry) {
  if ($('.studio-nav', entry)) return;
  const nav = document.createElement('aside');
  nav.className = 'studio-nav';
  nav.setAttribute('aria-label', '工作台导航');

  const group = (label, items) => `
    <div class="studio-nav-group">
      ${label ? `<div class="studio-nav-label">${label}</div>` : ''}
      ${items.map(it => `
        <button class="studio-nav-item${it.active ? ' is-active' : ''}" type="button"
                data-nav="${it.id}"${it.disabled ? ' disabled' : ''}>
          <svg class="ico" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">${ICONS[it.icon] || ''}</svg>
          <span>${it.text}</span>
          ${it.tag ? `<span class="tag-new">${it.tag}</span>` : ''}
          ${it.badge ? `<span class="badge">${it.badge}</span>` : ''}
        </button>`).join('')}
    </div>`;

  nav.innerHTML = [
    group('', [{ id: 'pick', icon: 'star', text: '精选推荐' }]),
    group('模板中心', [
      { id: 'templates', icon: 'grid', text: '场景模板', active: true, tag: '新' },
      { id: 'library', icon: 'library', text: '我的场景库' },
    ]),
    group('创作', [
      { id: 'import', icon: 'upload', text: '导入白膜 HTML' },
      { id: 'spec', icon: 'book', text: '白膜规范' },
    ]),
    group('工作台', [
      { id: 'assets', icon: 'cube', text: '资产库' },
      { id: 'trash', icon: 'trash', text: '回收站', tag: '空' },
    ]),
  ].join('');

  const scroll = $('.en-scroll', entry);
  entry.insertBefore(nav, scroll);

  const flashTo = (sel) => {
    const el = $(sel);
    if (!el) return false;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1200);
    return true;
  };

  nav.addEventListener('click', (e) => {
    const b = e.target.closest('[data-nav]');
    if (!b) return;
    const id = b.dataset.nav;
    $$('.studio-nav-item', nav).forEach(x => x.classList.toggle('is-active', x === b));
    const scrollBox = $('.en-scroll', entry);
    if (id === 'pick') scrollBox.scrollTo({ top: 0, behavior: 'smooth' });
    else if (id === 'templates') flashTo('#envGrid') || scrollBox.scrollTo({ top: 0, behavior: 'smooth' });
    else if (id === 'library') flashTo('#mineGrid');
    else if (id === 'import') {
      const c = $('#enCardImport'); if (c) c.click();
    } else if (id === 'spec') {
      toast('操作文档在 docs/：collaboration-contract.md / packaging-and-plugin.md', 'ok', 4200);
    } else if (id === 'assets') {
      // ★ 2026-11-08：资产库 = 落盘持久化的统一池子（模型/场景模型/材质/灯光）。
      //   不再跳到「我的模型」（那个是 localStorage 的，关网页会丢）。
      flashTo('#assetLibGrid') || flashTo('#assetLibSec');
    } else if (id === 'trash') {
      toast('本版本不保留回收站；删除即从 localStorage 移除', 'warn', 3600);
    }
  });
}

/* ------------------------------------------------------------ */
/* 3. 工具条：标题 + 搜索 + 筛选                                   */
/* ------------------------------------------------------------ */
function buildToolbar(entry) {
  if ($('.studio-toolbar', entry)) return;
  const firstSec = $('.en-sec', entry);           // 预设环境那一段
  if (!firstSec) return;

  const wrap = document.createElement('div');
  wrap.className = 'studio-toolbar';

  const searchHtml = `
    <div class="studio-search">
      <svg class="lens" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
        <path d="M10.5 4a6.5 6.5 0 014.9 10.7l4.2 4.2-1.4 1.4-4.2-4.2A6.5 6.5 0 1110.5 4zm0 2a4.5 4.5 0 100 9 4.5 4.5 0 000-9z" fill="currentColor"/>
      </svg>
      <input id="studioSearch" type="search" placeholder="试试描述词：客厅 / 古风" autocomplete="off" aria-label="搜索模板">
      <span class="ai-pill" title="本地关键词匹配，不是在线 AI">AI 描述词</span>
    </div>`;

  wrap.innerHTML = `
    <div class="studio-title-row">
      <h2 class="studio-title">场景模板</h2>
      <span class="studio-count" id="studioCount"></span>
    </div>
    ${searchHtml}
    <div class="studio-filters">
      ${FILTERS.map(f => `
        <div class="studio-filter-row" data-key="${f.key}">
          <span class="studio-filter-key">${f.label}</span>
          ${f.options.map(o => `<button class="studio-chip${o === '全部' ? ' is-on' : ''}" type="button"
              data-key="${f.key}" data-value="${o}">${o}</button>`).join('')}
        </div>`).join('')}
    </div>`;

  firstSec.parentNode.insertBefore(wrap, firstSec);

  $('#studioSearch', wrap).addEventListener('input', (e) => {
    query = e.target.value.trim().toLowerCase();
    applyFilter();
  });

  wrap.addEventListener('click', (e) => {
    const chip = e.target.closest('.studio-chip');
    if (!chip) return;
    const { key, value } = chip.dataset;
    const row = chip.closest('.studio-filter-row');
    $$('.studio-chip', row).forEach(c => c.classList.toggle('is-on', c === chip));
    if (key === 'space') activeSpace = value;
    if (key === 'style') activeStyle = value;
    applyFilter();
  });
}

/* ------------------------------------------------------------ */
/* 4. 装饰卡片 + 过滤                                             */
/* ------------------------------------------------------------ */
function decorateCards() {
  $$('#envGrid .env-card').forEach((card, i) => {
    const env = card.dataset.env;
    const tags = ENV_TAGS[env] || { space: '', style: '' };
    card.dataset.space = tags.space;
    card.dataset.style = tags.style;
    card.dataset.search = (
      (card.textContent || '') + ' ' + tags.space + ' ' + tags.style + ' ' + env
    ).toLowerCase();

    if (!card.querySelector('.studio-use')) {
      const use = document.createElement('button');
      use.className = 'studio-use';
      use.type = 'button';
      use.textContent = '用这个模板';
      use.addEventListener('click', (ev) => {
        ev.stopPropagation();
        card.click();       // 走 app.js 原有的委托链路：openEditor({env})
      });
      card.appendChild(use);
    }
    if (!card.querySelector('.studio-badge')) {
      const badge = document.createElement('span');
      badge.className = 'studio-badge';
      badge.textContent = (tags.space ? tags.space + ' · ' : '') + (tags.style || '模板');
      card.appendChild(badge);
    }
  });
  applyFilter();
}

function applyFilter() {
  const cards = $$('#envGrid .env-card');
  let shown = 0;
  cards.forEach(c => {
    const okSpace = activeSpace === '全部' || c.dataset.space === activeSpace;
    const okStyle = activeStyle === '全部' || c.dataset.style === activeStyle;
    const okText = !query || (c.dataset.search || '').includes(query);
    const show = okSpace && okStyle && okText;
    c.hidden = !show;
    if (show) shown++;
  });

  const countEl = $('#studioCount');
  if (countEl) countEl.textContent = shown + ' / ' + cards.length + ' 个模板';

  // 空结果提示
  const grid = $('#envGrid');
  let empty = $('#studioEmpty');
  if (!shown && cards.length) {
    if (!empty) {
      empty = document.createElement('div');
      empty.id = 'studioEmpty';
      empty.className = 'studio-empty';
      empty.textContent = '没有匹配的模板 —— 换个关键词，或点「＋ 新建场景」从空房间开始';
      grid.parentNode.insertBefore(empty, grid.nextSibling);
    }
    empty.hidden = false;
  } else if (empty) {
    empty.hidden = true;
  }
}

/* ------------------------------------------------------------ */
/* 5. 启动：等 app.js 首次渲染完（卡片写完）再装饰                  */
/* ------------------------------------------------------------ */
function init() {
  const entry = $('#view-entry');
  if (!entry) return;
  buildTopbar(entry);
  buildNav(entry);
  buildToolbar(entry);

  // app.js 的 renderEntry() 可能在本文件之后再次重写 #envGrid（保存/返回时），
  // 用 MutationObserver 保证每次重写后都重新装饰。
  const grid = $('#envGrid');
  if (grid) {
    const mo = new MutationObserver(() => decorateCards());
    mo.observe(grid, { childList: true });
  }
  decorateCards();

  window.__studio = {
    get filter() { return { space: activeSpace, style: activeStyle, query }; },
    applyFilter, decorateCards,
  };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
