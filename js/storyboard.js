/* ============================================================ * OpenVideoForge · 分镜预览模态（storyboard modal） * ------------------------------------------------------------ * 一个自包含的分镜预览窗：打开即按顺序抓图，网格里看到缩略图 + 名称 + 时长， * 底部四个导出按钮直接复用 export.js 的导出实现。 * * 设计边界： *   - 不依赖外部 css / 组件库：所有样式内联（工作台是零构建项目，避免污染 workbench.css）。 *   - 不实现抓图：renderShot(shot) => Promise<dataURL> 由调用方注入。 *   - 模态单例：重复调用 openStoryboard 会先关掉上一个，避免叠窗。 * * 用法：
 *   import { openStoryboard } from './storyboard.js?v=75';
 *   const modal = openStoryboard({
 *     shots,                    // 镜头数组（契约见 export.js 文件头）
 *     renderShot,               // 抓图注入
 *     meta: { title: '广告片 A', subtitle: '第 2 版' },
 *     onExport: ({ kind, ok }) => console.log('导出', kind, ok),
 *   });
 *   modal.close();              // 需要时程序化关闭
 * ============================================================ */

import {
  buildShotRows,
  totalDuration,
  formatTimecode,
  padIndex,
  exportContactSheet,
  exportShotListJSON,
  exportShotListCSV,
  exportShotPack
} from './export.js?v=75';

/* ------------------------------------------------------------ */
/* 视觉常量（与工作台 Cinemap 风一致：暖纸底 + 琥珀点缀）          */
/* ------------------------------------------------------------ */
const UI = {
  overlay: 'position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center;' +
    ' padding:24px; box-sizing:border-box; background:rgba(5,7,13,0.74); backdrop-filter:blur(3px);' +
    ' -webkit-backdrop-filter:blur(3px);',
  panel: 'width:min(1180px, 100%); max-height:90vh; display:flex; flex-direction:column; overflow:hidden;' +
    ' background:#f7f5f0; color:#23262d; border-radius:10px; border:1px solid #d9d5c9;' +
    ' box-shadow:0 24px 80px rgba(0,0,0,0.45); font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
  header: 'flex:0 0 auto; display:flex; align-items:flex-start; justify-content:space-between; gap:16px;' +
    ' padding:16px 20px 14px; border-bottom:1px solid #e4e1d7; background:#fffdf8;',
  title: 'margin:0; font-family:"Fraunces",Georgia,"Times New Roman","Songti SC",serif;' +
    ' font-size:22px; font-weight:600; letter-spacing:.2px; color:#1f232b;',
  meta: 'margin:6px 0 0; font-size:12px; color:#6b7280; font-family:"SF Mono","Cascadia Code",Consolas,monospace;',
  closeBtn: 'flex:0 0 auto; width:32px; height:32px; line-height:1; font-size:20px; cursor:pointer;' +
    ' border:1px solid #e4e1d7; background:#fff; color:#6b7280; border-radius:6px; padding:0;',
  body: 'flex:1 1 auto; overflow:auto; padding:16px 20px; overscroll-behavior:contain;',
  grid: 'display:grid; grid-template-columns:repeat(auto-fill, minmax(190px, 1fr)); gap:14px;',
  card: 'background:#fff; border:1px solid #e4e1d7; border-radius:6px; overflow:hidden;' +
    ' box-shadow:0 1px 2px rgba(0,0,0,0.04);',
  thumbWrap: 'position:relative; aspect-ratio:16/9; background:#ece9e1; display:flex; align-items:center;' +
    ' justify-content:center; overflow:hidden;',
  thumbImg: 'position:absolute; inset:0; width:100%; height:100%; object-fit:cover; display:block; z-index:1;',
  thumbPh: 'font-size:11px; color:#8a8678; text-align:center; padding:0 8px; line-height:1.4;',
  badge: 'position:absolute; left:6px; top:6px; z-index:2; padding:2px 6px; border-radius:3px;' +
    ' background:rgba(35,38,45,0.9); color:#ffd250; font-size:10.5px; font-weight:600;' +
    ' font-family:"SF Mono","Cascadia Code",Consolas,monospace; letter-spacing:.3px;',
  cardMeta: 'padding:8px 10px 9px;',
  cardName: 'font-size:12.5px; font-weight:600; color:#23262d; white-space:nowrap;' +
    ' overflow:hidden; text-overflow:ellipsis;',
  cardTime: 'margin-top:3px; display:flex; justify-content:space-between; gap:8px; font-size:10.5px;' +
    ' color:#6b7280; font-family:"SF Mono","Cascadia Code",Consolas,monospace;',
  footer: 'flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; gap:12px;' +
    ' flex-wrap:wrap; padding:12px 20px; border-top:1px solid #e4e1d7; background:#fffdf8;',
  status: 'font-size:11.5px; color:#6b7280; font-family:"SF Mono","Cascadia Code",Consolas,monospace;' +
    ' min-height:16px; line-height:1.4;',
  btnRow: 'display:flex; gap:8px; flex-wrap:wrap;',
  btn: 'appearance:none; cursor:pointer; font-family:inherit; font-size:12.5px; font-weight:500;' +
    ' padding:8px 14px; border-radius:6px; border:1px solid #d9d5c9; background:#fff; color:#23262d;' +
    ' transition:background .15s, border-color .15s, opacity .15s;',
  btnPrimary: 'appearance:none; cursor:pointer; font-family:inherit; font-size:12.5px; font-weight:600;' +
    ' padding:8px 14px; border-radius:6px; border:1px solid #b07a14; background:#c8891a; color:#fff;' +
    ' transition:background .15s, opacity .15s;',
  btnDisabled: 'opacity:.45; cursor:not-allowed;',
  empty: 'padding:48px 20px; text-align:center; color:#6b7280; font-size:13px; line-height:1.8;'
};

/* 当前打开的模态（单例） */
let active = null;

/* ------------------------------------------------------------ */
/* 小工具                                                         */
/* ------------------------------------------------------------ */

/** 创建元素并套用内联样式：el('div', 'style...', '文本') */
function el(tag, style, text) {
  const node = document.createElement(tag);
  if (style) node.style.cssText = style;
  if (text != null) node.textContent = text;
  return node;
}

/** 给主按钮 / 次按钮套禁用态 */
function setDisabled(btn, disabled) {
  btn.disabled = !!disabled;
  btn.style.opacity = disabled ? '0.45' : '1';
  btn.style.cursor = disabled ? 'not-allowed' : 'pointer';
}

/** 让元素在获得焦点时有可见轮廓（键盘可达性） */
function focusRing(btn) {
  btn.addEventListener('focus', () => { btn.style.outline = '2px solid #c8891a'; btn.style.outlineOffset = '2px'; });
  btn.addEventListener('blur', () => { btn.style.outline = 'none'; });
}

/* ------------------------------------------------------------ */
/* 对外：打开分镜预览                                             */
/* ------------------------------------------------------------ */

/**
 * 打开分镜模态。
 *
 * @param {Object}   opts
 * @param {Array}    opts.shots        镜头数组，契约见 export.js
 * @param {Function} [opts.renderShot] (shot) => Promise<dataURL>；缺省时只允许导出 JSON/CSV
 * @param {Object}   [opts.meta]       { title, subtitle, author, date }
 * @param {Function} [opts.onExport]   ({kind, ok, count, failed, filename, error}) => void
 * @returns {{ close:Function, el:HTMLElement, isOpen:boolean }}
 */
export function openStoryboard({ shots, renderShot, meta, onExport } = {}) {
  if (typeof document === 'undefined') throw new Error('openStoryboard 只能在浏览器里运行');
  if (active) active.close();

  const rows = buildShotRows(shots);
  const m = meta || {};
  const title = String(m.title == null ? '未命名分镜' : m.title);
  const subtitle = m.subtitle == null ? '' : String(m.subtitle);
  const hasRenderer = typeof renderShot === 'function';

  /* ---- 骨架 ---- */
  const overlay = el('div', UI.overlay);
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', '分镜预览');

  const panel = el('div', UI.panel);

  // 页眉
  const header = el('div', UI.header);
  const titleBox = el('div', 'min-width:0;');
  const h = el('h2', UI.title, '分镜预览');
  const metaLine = el('div', UI.meta,
    `${title}` + (subtitle ? ` · ${subtitle}` : '') +
    ` · ${rows.length} 个镜头 · 总时长 ${formatTimecode(totalDuration(rows))}`);
  titleBox.appendChild(h);
  titleBox.appendChild(metaLine);

  const closeBtn = el('button', UI.closeBtn, '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', '关闭分镜预览');
  closeBtn.title = '关闭（Esc）';
  focusRing(closeBtn);

  header.appendChild(titleBox);
  header.appendChild(closeBtn);

  // 主体
  const body = el('div', UI.body);
  const grid = el('div', UI.grid);
  body.appendChild(grid);

  // 页脚
  const footer = el('div', UI.footer);
  const status = el('div', UI.status, hasRenderer ? '准备抓图…' : '未注入抓图函数：只能导出 JSON / CSV 清单');
  const btnRow = el('div', UI.btnRow);

  const mkBtn = (label, primary, titleAttr) => {
    const b = el('button', primary ? UI.btnPrimary : UI.btn, label);
    b.type = 'button';
    if (titleAttr) b.title = titleAttr;
    focusRing(b);
    btnRow.appendChild(b);
    return b;
  };
  const btnSheet = mkBtn('导出接触表 PNG', true, '一张 4 列网格的分镜接触表，打印 / 发客户用');
  const btnJson = mkBtn('导出镜头清单 JSON');
  const btnCsv = mkBtn('导出 CSV');
  const btnPack = mkBtn('导出 PNG 序列', false, '每个镜头一张 01_镜头名.png，顺序下载');
  const btnClose = mkBtn('关闭');

  footer.appendChild(status);
  footer.appendChild(btnRow);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);
  overlay.appendChild(panel);

  /* ---- 卡片（先把骨架铺出来，图抓到一张填一张） ---- */
  const cards = [];   // { row, thumbEl, phEl }
  if (!rows.length) {
    grid.appendChild(el('div', UI.empty,
      '时间线上还没有镜头。\n先在编辑器里保存机位、加镜头，再回来导出分镜表。'));
  } else {
    for (const row of rows) {
      const card = el('div', UI.card);
      const thumb = el('div', UI.thumbWrap);
      const badge = el('span', UI.badge, padIndex(row.index, rows.length));
      const ph = el('div', UI.thumbPh, hasRenderer ? '抓图中…' : '无抓图');
      thumb.appendChild(ph);
      thumb.appendChild(badge);

      const metaBox = el('div', UI.cardMeta);
      const name = el('div', UI.cardName, row.label);
      name.title = row.label;
      const time = el('div', UI.cardTime);
      const t1 = el('span', '', `${formatTimecode(row.start)} – ${formatTimecode(row.end)}`);
      const t2 = el('span', '', `${row.duration.toFixed(1)}s`);
      time.appendChild(t1);
      time.appendChild(t2);
      metaBox.appendChild(name);
      metaBox.appendChild(time);

      card.appendChild(thumb);
      card.appendChild(metaBox);
      grid.appendChild(card);
      cards.push({ row, thumb, ph });
    }
  }

  document.body.appendChild(overlay);

  /* ---- 状态与按钮 ---- */
  const noShots = rows.length === 0;
  const canImage = hasRenderer && !noShots;
  setDisabled(btnSheet, !canImage);
  setDisabled(btnPack, !canImage);
  setDisabled(btnJson, noShots);
  setDisabled(btnCsv, noShots);

  let closed = false;
  let busy = false;
  const prevFocus = document.activeElement;
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';

  const setStatus = (text, kind) => {
    status.textContent = text;
    status.style.color = kind === 'err' ? '#c2533f' : kind === 'warn' ? '#b07a14' : '#6b7280';
  };

  /* ---- 抓图（顺序执行，一张一张填） ---- */
  const thumbCache = new Map();   // id -> dataURL | null（null 表示失败）
  const keyOf = (row) => String(row && row.id != null ? row.id : row && row.index);

  const captureAll = async () => {
    if (!hasRenderer) return;
    if (!rows.length) return;
    let failed = 0;
    for (let i = 0; i < rows.length; i++) {
      if (closed) return;
      const row = rows[i];
      const card = cards[i];
      setStatus(`正在抓图 ${i + 1}/${rows.length} …${failed ? `（失败 ${failed}）` : ''}`);
      try {
        const dataURL = await renderShot(row);
        if (typeof dataURL !== 'string' || !dataURL) throw new Error('renderShot 未返回 dataURL 字符串');
        thumbCache.set(keyOf(row), dataURL);
        if (card && !closed) {
          const img = document.createElement('img');
          img.alt = row.label;
          img.style.cssText = UI.thumbImg;
          img.src = dataURL;
          card.thumb.appendChild(img);
          card.ph.style.display = 'none';
        }
      } catch (e) {
        failed++;
        thumbCache.set(keyOf(row), null);
        if (card && !closed) {
          card.ph.textContent = '抓图失败';
          card.ph.style.color = '#c2533f';
        }
        if (typeof console !== 'undefined') {
          console.warn(`[storyboard] 镜头 ${row.index}「${row.label}」抓图失败：`, e && e.message ? e.message : e);
        }
      }
      // 让出一帧，保证缩略图在长时间抓图时能逐步显示
      await new Promise(r => setTimeout(r, 0));
    }
    if (closed) return;
    setStatus(failed
      ? `抓图完成：${rows.length - failed}/${rows.length} 张成功，${failed} 张失败（导出时用占位格）`
      : `抓图完成：${rows.length}/${rows.length} 张`, failed ? 'warn' : undefined);
  };

  /* ---- 供导出复用的抓图函数：命中缓存，未命中再抓 ---- */
  const cachedRender = async (row) => {
    const key = keyOf(row);
    if (thumbCache.has(key)) {
      const v = thumbCache.get(key);
      if (v) return v;
      throw new Error(`镜头 ${row.index} 抓图失败，无法导出`);
    }
    const dataURL = await renderShot(row);
    if (typeof dataURL !== 'string' || !dataURL) throw new Error('renderShot 未返回 dataURL 字符串');
    thumbCache.set(key, dataURL);
    return dataURL;
  };

  /* ---- 导出动作 ---- */
  let capturePromise = null;
  const ensureCaptured = () => capturePromise || Promise.resolve();

  const runExport = async (kind, fn) => {
    if (busy) return;
    busy = true;
    const allBtns = [btnSheet, btnJson, btnCsv, btnPack];
    allBtns.forEach(b => setDisabled(b, true));
    setStatus('正在导出…');
    let result = null;
    try {
      await ensureCaptured();          // 先等抓图跑完
      result = await fn();
      const detail = result && result.filename
        ? `已导出 ${result.filename}`
        : `已导出 ${result && result.count != null ? result.count : ''} 项`;
      setStatus(detail + (result && result.failed ? `（${result.failed} 项失败）` : ''));
    } catch (e) {
      setStatus('导出失败：' + (e && e.message ? e.message : '未知错误'), 'err');
      result = { ok: false, error: e && e.message ? e.message : String(e) };
    } finally {
      busy = false;
      allBtns.forEach(b => setDisabled(b, b === btnSheet || b === btnPack ? !canImage : noShots));
    }
    if (typeof onExport === 'function') {
      try {
        onExport(Object.assign({ kind }, result || {}));
      } catch (e) { /* 回调异常不影响模态 */ }
    }
  };

  btnSheet.addEventListener('click', () => {
    if (!canImage) return;
    runExport('contact-sheet', () => exportContactSheet({
      shots: rows,
      renderShot: cachedRender,
      meta: m,
      onProgress: p => { if (!closed && p.phase === 'capture') setStatus(`正在绘制接触表 ${p.done}/${p.total} …`); }
    }));
  });
  btnJson.addEventListener('click', () => {
    if (noShots) return;
    runExport('shot-list-json', () => exportShotListJSON(rows, m));
  });
  btnCsv.addEventListener('click', () => {
    if (noShots) return;
    runExport('shot-list-csv', () => exportShotListCSV(rows, m));
  });
  btnPack.addEventListener('click', () => {
    if (!canImage) return;
    runExport('png-pack', () => exportShotPack({
      shots: rows,
      renderShot: cachedRender,
      meta: m,
      onProgress: p => { if (!closed) setStatus(`正在导出 PNG 序列 ${p.done}/${p.total} …`); }
    }));
  });

  /* ---- 关闭：ESC / 点遮罩 / 关闭按钮 ---- */
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown, true);
    overlay.remove();
    document.body.style.overflow = prevOverflow;
    if (prevFocus && typeof prevFocus.focus === 'function') {
      try { prevFocus.focus(); } catch (e) { /* 忽略 */ }
    }
    if (active && active.el === overlay) {
      active.isOpen = false;
      active = null;
    }
  };
  closeBtn.addEventListener('click', close);
  btnClose.addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();   // 点遮罩空白处关闭
  });

  /* ---- 键盘：Esc 关闭 + 基本焦点陷阱 ---- */
  const onKeydown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusables = [...panel.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(node => !node.disabled && node.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKeydown, true);

  /* ---- 启动 ---- */
  closeBtn.focus();
  capturePromise = captureAll();

  const handle = {
    el: overlay,
    isOpen: true,
    close() {
      handle.isOpen = false;
      close();
    }
  };
  active = handle;
  return handle;
}
