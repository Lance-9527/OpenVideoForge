/* ============================================================
 * OpenVideoForge · 成品示例（showcase）
 * ------------------------------------------------------------
 * 入口页的一块「看看它能做出什么」—— 成品都在 assets/showcase/，
 * 清单在 assets/showcase/manifest.json（可随时替换，不用改代码）。
 *
 * ★ 设计边界：
 *   - 自包含：不依赖别的模块，也不往 window 挂全局（工作台是零构建项目）。
 *   - 静态资源：清单与媒体都走相对路径 ⇒ 仓库克隆下来直接能看，
 *     也能原样挂到 GitHub Pages。
 *   - 署名：真实世界那几条来自 OpenStreetMap（ODbL），
 *     卡片和浮层里都必须显示署名 —— 这条是硬要求，别删。
 * ============================================================ */

const MANIFEST_URL = 'assets/showcase/manifest.json';
const BASE = 'assets/showcase/';

const $ = (sel, root = document) => root.querySelector(sel);

/** 清单（懒加载一次）。 */
let manifestPromise = null;
function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(MANIFEST_URL, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return manifestPromise;
}

/**
 * 打开成品浮层。
 * @param {object} item 清单条目。
 */
function openViewer(item) {
  // ★ 先关掉上一个：连点两张卡会叠出两个浮层，Esc 只能关掉最上面那个
  //   （实测：叠了两层，按 Esc 看着像“没关掉”）。
  closeViewer();

  const overlay = document.createElement('div');
  overlay.className = 'sc-overlay';

  const panel = document.createElement('div');
  panel.className = 'sc-panel';

  // —— 画面：优先放视频，没有就放大图
  if (item.video) {
    const video = document.createElement('video');
    video.src = BASE + item.video;
    video.loop = true;
    video.muted = true;          // 浏览器自动播放策略要求静音
    video.defaultMuted = true;
    video.playsInline = true;
    video.controls = true;
    video.preload = 'metadata';
    panel.appendChild(video);
    // ★ 显式 play()：只靠 autoplay 属性在部分环境会被拦（实测 muted 自动播放
    //   仍可能被拒，视频停在第一帧）。这里兜一手，失败也不影响看图。
    const started = video.play();
    if (started && typeof started.catch === 'function') started.catch(() => {});
  } else if (item.poster) {
    const img = document.createElement('img');
    img.className = 'sc-full';
    img.src = BASE + item.poster;
    img.alt = item.title || '';
    panel.appendChild(img);
  }

  // —— 标题与说明
  const head = document.createElement('div');
  head.className = 'sc-panel-head';
  const titleBox = document.createElement('div');
  const h3 = document.createElement('h3');
  h3.textContent = item.title || '';
  titleBox.appendChild(h3);
  if (item.desc) {
    const desc = document.createElement('p');
    desc.className = 'sc-panel-desc';
    desc.textContent = item.desc;
    titleBox.appendChild(desc);
  }
  head.appendChild(titleBox);

  const close = document.createElement('button');
  close.className = 'sc-panel-close';
  close.type = 'button';
  close.title = '关闭';
  close.textContent = '×';
  close.addEventListener('click', closeViewer);
  head.appendChild(close);
  panel.appendChild(head);

  // —— 底部：标签 / 规格 / 署名
  const foot = document.createElement('div');
  foot.className = 'sc-panel-foot';
  for (const tag of item.tags || []) {
    const el = document.createElement('i');
    el.className = 'sc-tag';
    el.textContent = tag;
    foot.appendChild(el);
  }
  if (item.meta) {
    const meta = document.createElement('span');
    meta.className = 'sc-meta';
    meta.textContent = item.meta;
    foot.appendChild(meta);
  }
  if (item.credit) {
    const credit = document.createElement('span');
    credit.className = 'sc-credit';
    credit.textContent = item.credit;
    foot.appendChild(credit);
  }
  panel.appendChild(foot);

  overlay.appendChild(panel);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeViewer(); });
  document.body.appendChild(overlay);

  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  overlay.__restoreOverflow = prevOverflow;
  document.addEventListener('keydown', onKey);
  window.addEventListener('keydown', onKey);
  close.focus();
}

/** 关掉浮层（Esc / 点背景 / × 都走这里）。 */
function closeViewer() {
  const overlay = $('.sc-overlay');
  if (!overlay) return;
  const video = $('video', overlay);
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
  const restore = overlay.__restoreOverflow || '';
  overlay.remove();
  document.body.style.overflow = restore;
  document.removeEventListener('keydown', onKey);
  window.removeEventListener('keydown', onKey);
}

function onKey(e) {
  if (e.key === 'Escape') closeViewer();
}

/**
 * 渲染成品卡片。
 * @param {Array} items 清单条目。
 */
function renderCards(items) {
  const grid = $('#showcaseGrid');
  if (!grid) return;
  grid.innerHTML = '';

  for (const item of items) {
    const card = document.createElement('button');
    card.className = 'sc-card';
    card.type = 'button';

    const thumb = document.createElement('span');
    thumb.className = 'sc-thumb';
    if (item.poster) {
      const img = document.createElement('img');
      img.src = BASE + item.poster;
      img.alt = item.title || '';
      img.loading = 'lazy';
      thumb.appendChild(img);
    }
    if (item.video) {
      const play = document.createElement('span');
      play.className = 'sc-play';
      play.textContent = '▶';
      thumb.appendChild(play);
    }

    const body = document.createElement('span');
    body.className = 'sc-body';
    const title = document.createElement('span');
    title.className = 'sc-title';
    title.textContent = item.title || '';
    body.appendChild(title);
    if (item.desc) {
      const desc = document.createElement('span');
      desc.className = 'sc-desc';
      desc.textContent = item.desc;
      body.appendChild(desc);
    }
    if (item.tags && item.tags.length) {
      const tags = document.createElement('span');
      tags.className = 'sc-tags';
      for (const t of item.tags) {
        const tag = document.createElement('i');
        tag.className = 'sc-tag';
        tag.textContent = t;
        tags.appendChild(tag);
      }
      body.appendChild(tags);
    }
    if (item.meta) {
      const meta = document.createElement('span');
      meta.className = 'sc-meta';
      meta.textContent = item.meta;
      body.appendChild(meta);
    }

    card.appendChild(thumb);
    card.appendChild(body);
    card.addEventListener('click', () => openViewer(item));
    grid.appendChild(card);
  }
}

/** 装载清单并渲染（清单缺失就整块隐藏，不留空壳）。 */
async function initShowcase() {
  const sec = $('#showcaseSec');
  if (!sec) return;
  const manifest = await loadManifest();
  const items = (manifest && manifest.items) || [];
  if (!items.length) { sec.hidden = true; return; }
  renderCards(items);
  sec.hidden = false;
  const note = $('#showcaseNote');
  if (note && manifest.note) note.textContent = manifest.note;
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initShowcase, { once: true });
} else {
  initShowcase();
}
