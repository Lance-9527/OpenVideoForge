/* ==========================================================================
 * studio-reels.js · 片库 / 预演播放 / AI 生成场景（v0.8）
 *
 * 参考 cinemap player 的片库观感（深色、海报卡、能力徽标、播放页），
 * 落到白膜预演：「片库」= 你保存的各个场景及其分镜，点开就是全屏播放（3D 真渲染），
 * 另外给一条 AI 生成场景的入口（复制规范提示词 → 任意 AI 产出白膜 HTML → 导入）。
 * ========================================================================== */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const tl = () => (window.__wb && window.__wb.timeline) || null;
const scenes = () => (window.__wb && window.__wb.scenes) || [];

function toast(msg, kind = 'ok', ms = 2600) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

function fmt(sec) {
  const m = Math.floor(sec / 60), s = Math.round(sec - m * 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function reelOf(rec) {
  const shots = Array.isArray(rec.shots) ? rec.shots : [];
  const dur = shots.reduce((a, s) => a + (Number(s.duration) || 3), 0);
  return { shots, dur };
}

/* ------------------------------------------------------------ */
/* 视图骨架                                                      */
/* ------------------------------------------------------------ */
function build() {
  if ($('#view-reel')) return;
  const view = document.createElement('div');
  view.id = 'view-reel';
  view.hidden = true;
  view.innerHTML = `
    <header class="rl-top">
      <button class="rl-back" id="rlBack" type="button" title="返回">←</button>
      <div class="rl-title">
        <b>片库</b>
        <span id="rlCount">0 部</span>
      </div>
      <div class="rl-actions">
        <button class="rl-btn ghost" id="rlImport" type="button">导入白膜 HTML</button>
        <button class="rl-btn ghost" id="rlOpenFolder" type="button">打开输出文件夹</button>
        <button class="rl-btn" id="rlAi" type="button">AI 生成场景</button>
      </div>
    </header>
    <div class="rl-note">这里的「片」= 你保存的场景 + 分镜时间线。点「播放」进入影院模式，按 <kbd>Esc</kbd> 退出。</div>
    <div class="rl-grid" id="rlGrid"></div>
    <div class="rl-empty" id="rlEmpty" hidden>
      还没有成片 —— 回入口页做一个场景、加几个镜头、保存，这里就会出现。
    </div>`;
  document.body.appendChild(view);

  $('#rlBack', view).addEventListener('click', hide);
  $('#rlImport', view).addEventListener('click', () => {
    const f = $('#fileInput');
    if (f) f.click();
  });
  $('#rlAi', view).addEventListener('click', openAiDialog);
  $('#rlOpenFolder', view).addEventListener('click', () => {
    if (window.WBSave && window.WBSave.openFolder) window.WBSave.openFolder();
    else toast('保存模块未就绪', 'warn');
  });

  view.addEventListener('click', (e) => {
    const play = e.target.closest('[data-play]');
    if (play) { playReel(play.dataset.play); return; }
    const shot = e.target.closest('[data-shots]');
    if (shot) { openSceneForShots(shot.dataset.shots); return; }
  });
}

/* ------------------------------------------------------------ */
/* 列表                                                          */
/* ------------------------------------------------------------ */
function render() {
  build();
  const grid = $('#rlGrid');
  if (!grid) return;
  const list = scenes().filter(s => Array.isArray(s.shots) && s.shots.length);
  $('#rlCount').textContent = list.length + ' 部';
  $('#rlEmpty').hidden = list.length > 0;

  grid.innerHTML = list.map(rec => {
    const { shots, dur } = reelOf(rec);
    const env = (rec.data && rec.data.env) || 'room';
    const poster = rec.thumb
      ? `<img alt="" src="${rec.thumb}">`
      : '<span class="rl-ph">◍</span>';
    return `
      <article class="rl-card" data-id="${rec.id}">
        <div class="rl-poster">
          ${poster}
          <div class="rl-badges">
            <span class="rl-badge">${shots.length} 镜头</span>
            <span class="rl-badge">${fmt(dur)}</span>
            <span class="rl-badge dim">16:9</span>
          </div>
          <button class="rl-play" type="button" data-play="${rec.id}" title="播放预演">▶</button>
        </div>
        <div class="rl-meta">
          <b>${rec.title || '未命名场景'}</b>
          <span>${env} · ${new Date(rec.createdAt || Date.now()).toLocaleDateString('zh-CN')}</span>
        </div>
        <div class="rl-tools">
          <button class="rl-tool" type="button" data-play="${rec.id}">播放</button>
          <button class="rl-tool" type="button" data-shots="${rec.id}">分镜表</button>
        </div>
      </article>`;
  }).join('');
}

function show() {
  build();
  render();
  $('#view-reel').hidden = false;
}
function hide() {
  const v = $('#view-reel');
  if (v) v.hidden = true;
}

/* ------------------------------------------------------------ */
/* 播放：进编辑器 → 影院模式 → 播时间线                            */
/* ------------------------------------------------------------ */
let cinemaTimer = 0;

function enterCinema() {
  const view = $('#view-editor');
  if (!view) return;
  view.classList.add('cinema');
  clearTimeout(cinemaTimer);
  const esc = (e) => {
    if (e.key === 'Escape') exitCinema();
  };
  document.addEventListener('keydown', esc, { once: true });
  window.__reelEsc = esc;
}

function exitCinema() {
  const view = $('#view-editor');
  if (view) view.classList.remove('cinema');
  const t = tl();
  if (t) t.stop();
  document.removeEventListener('keydown', window.__reelEsc || (() => {}));
  window.__reelEsc = null;
  show();
}

function playReel(id) {
  const rec = scenes().find(s => s.id === id);
  if (!rec) { toast('场景不存在', 'warn'); return; }
  hide();
  if (window.__wb && window.__wb.openEditor) {
    window.__wb.openEditor({ recId: id });
  }
  // 等编辑器 + 时间线挂载完成
  cinemaTimer = setTimeout(() => {
    enterCinema();
    const t = tl();
    if (t) {
      t.seek(0);
      t.play();
      toast('影院模式：Esc 退出 · 空格 暂停/播放', 'ok', 3200);
    } else {
      exitCinema();
      toast('这个场景还没有分镜，先去加几个镜头', 'warn', 3000);
    }
  }, 900);
}

function openSceneForShots(id) {
  hide();
  if (window.__wb && window.__wb.openEditor) window.__wb.openEditor({ recId: id });
  setTimeout(() => {
    if (window.__studioInspector && window.__studioInspector.grab) {
      // 打开分镜表（app.js 暴露的入口）
      if (window.__wb.openEditorStoryboard) window.__wb.openEditorStoryboard();
    }
  }, 900);
}

/* ------------------------------------------------------------ */
/* AI 生成场景                                                   */
/* ------------------------------------------------------------ */
function openAiDialog() {
  closeDialog();
  const box = document.createElement('div');
  box.id = 'rlAiDlg';
  box.className = 'rl-dialog';
  box.innerHTML = `
    <div class="rl-dialog-card">
      <header>
        <b>AI 生成白膜场景</b>
        <button type="button" data-close>×</button>
      </header>
      <div class="rl-dialog-body">
        <p>三步：</p>
        <ol>
          <li>复制下面这段「白膜 HTML 规范提示词」；</li>
          <li>连同你的镜头需求发给任意 AI（DeepSeek / ChatGPT / Claude / 通义）；</li>
          <li>把它返回的 <code>.html</code> 拖进窗口（或点「选择文件」），场景库直接可播。</li>
        </ol>
        <textarea id="rlPrompt" readonly></textarea>
        <div class="rl-dialog-actions">
          <button type="button" class="rl-btn" id="rlCopy">复制提示词</button>
          <button type="button" class="rl-btn ghost" id="rlPick">选择文件</button>
        </div>
        <p class="rl-hint" id="rlPromptState">正在读取 spec/AI提示词.md …</p>
      </div>
    </div>`;
  document.body.appendChild(box);
  box.addEventListener('click', (e) => {
    if (e.target === box || e.target.closest('[data-close]')) closeDialog();
  });
  $('#rlPick', box).addEventListener('click', () => {
    const f = $('#fileInput');
    if (f) f.click();
    closeDialog();
  });
  $('#rlCopy', box).addEventListener('click', async () => {
    const ta = $('#rlPrompt', box);
    try {
      await navigator.clipboard.writeText(ta.value || '');
      toast('提示词已复制，发给 AI 吧');
    } catch (_) {
      ta.select();
      document.execCommand && document.execCommand('copy');
      toast('已选中，按 Ctrl+C 复制', 'ok');
    }
  });

  fetch('spec/AI提示词.md')
    .then(r => r.ok ? r.text() : Promise.reject(new Error('HTTP ' + r.status)))
    .then(text => {
      const ta = $('#rlPrompt', box);
      if (ta) ta.value = text;
      const s = $('#rlPromptState', box);
      if (s) s.textContent = '已载入规范提示词（' + text.length + ' 字）';
    })
    .catch(err => {
      const s = $('#rlPromptState', box);
      if (s) s.textContent = '读取失败：' + err.message + '（可直接打开 spec/AI提示词.md）';
    });
}

function closeDialog() {
  const d = $('#rlAiDlg');
  if (d) d.remove();
}

/* ------------------------------------------------------------ */
/* 入口挂载                                                      */
/* ------------------------------------------------------------ */
function mountNav() {
  const nav = document.querySelector('.studio-nav');
  if (!nav || nav.querySelector('[data-nav="reels"]')) return;
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'studio-nav-item';
  item.dataset.nav = 'reels';
  item.innerHTML = `<svg class="ico" viewBox="0 0 24 24" width="16" height="16"><path d="M3 5h18v14H3V5zm2 2v10h14V7H5zm2 2h4v6H7V9zm6 0h4v2h-4V9zm0 4h4v2h-4v-2z" fill="currentColor"/></svg><span>片库 · 预演播放</span><span class="tag-new">新</span>`;
  item.addEventListener('click', () => {
    $$('.studio-nav-item').forEach(x => x.classList.toggle('is-active', x === item));
    show();
  });
  const anchor = nav.querySelector('[data-nav="library"]');
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(item, anchor.nextSibling);
  else nav.appendChild(item);
}

function init() {
  const mo = new MutationObserver(() => mountNav());
  const entry = $('#view-entry');
  if (entry) mo.observe(entry, { childList: true, subtree: true });
  mountNav();
  // app.js 的开放式接口：Esc 退出影院、显示片库
  window.__studioReels = { show, hide, render, playReel, exitCinema };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
