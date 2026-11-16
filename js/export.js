/* ============================================================
 * OpenVideoForge · 分镜导出（storyboard export）
 * ------------------------------------------------------------
 * 把时间线上的镜头导成三类交付物：
 *   1. 分镜接触表 PNG —— 一张纸，4 列网格，每格缩略图 + 编号 + 镜头名 + 起止时间码
 *   2. 镜头清单 JSON / CSV —— 给 AI 视频工具、剪辑、客户过的机器可读清单
 *   3. PNG 序列 —— 每个镜头一张原始截图，01_镜头名.png
 *
 * 设计边界：
 *   - 抓图不归本模块管。调用方注入 renderShot(shot) => Promise<dataURL>，
 *     由它负责切相机、等一帧、从编辑器 / 播放器取像素。本模块只消费 dataURL。
 *   - 无第三方依赖、无构建、无网络；纯浏览器 API（Canvas / Blob / URL / <a download>）。
 *   - 顶层不碰 DOM，纯函数可以单独在 Node 里跑（见 product/docs/export.test.mjs）。
 *
 * 镜头数据契约（timeline / 编辑器侧提供）：
 *   shot = {
 *     id:       string,                           // 唯一 id（缺省时用序号）
 *     label:    string,                           // 镜头名，如「推近 · 主角特写」
 *     duration: number,                           // 秒
 *     cam:      { r, phi, theta, t:[x,y,z], fov },// 机位（透传给 renderShot / 清单）
 *     ease:     string                            // 缓动名（透传，如 'easeInOut'）
 *   }
 * ============================================================ */

/* ------------------------------------------------------------ */
/* 常量                                                          */
/* ------------------------------------------------------------ */

/** 导出清单的 schema 标识（外部工具可据此识别） */
export const STORYBOARD_SCHEMA = 'whitebox.storyboard/1';

/** 文生图 / 分镜常用的字体栈：标题衬线（Fraunces 缺字回退 Georgia），正文系统字体 */
export const FONT_SERIF = '"Fraunces", Georgia, "Times New Roman", "Songti SC", "SimSun", serif';
export const FONT_SANS = 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
export const FONT_MONO = '"SF Mono", "Cascadia Code", Consolas, "Courier New", monospace';

/** 接触表默认版式（宽 1600 CSS px，24px 外边距，4 列） */
export const SHEET_DEFAULTS = Object.freeze({
  width: 1600,
  padding: 24,
  gutter: 18,
  cols: 4,
  headerH: 96,
  labelH: 58,
  footerH: 34,
  maxScale: 2,        // 高 DPI：2 倍绘制
  maxPixelSide: 16000 // 画布单边上限（Chrome 约 16384），超过则自动降采样
});

const CSV_HEADER = [
  '序号', '镜头名', '时长(s)', '开始时间码', '结束时间码',
  '机位半径r', '方位角phi', '仰角theta', '目标X', '目标Y', '目标Z', '视场角fov', '缓动ease'
];

/* ------------------------------------------------------------ */
/* 小工具（纯函数，Node 可直接测）                                */
/* ------------------------------------------------------------ */

/** 数字兜底：非有限数一律 0，负数夹到 0 */
function num(v, dflt = 0) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

/** 保留 3 位小数，消掉 0.1+0.2 这类浮点噪声 */
function round3(v) {
  return Math.round(num(v) * 1000) / 1000;
}

/** 两位补零 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * 秒 → 时间码 mm:ss.s（分钟可超过 99，不换行成小时）
 * 先四舍五入到 0.1s 再拆分，避免出现 00:60.0
 *   formatTimecode(0)      => '00:00.0'
 *   formatTimecode(65.43)  => '01:05.4'
 *   formatTimecode(-3)     => '00:00.0'
 */
export function formatTimecode(sec) {
  const safe = Math.max(0, num(sec));            // 负数（含拖动越界）夹到 0
  const tenths = Math.round(safe * 10);
  const m = Math.floor(tenths / 600);
  const s = (tenths % 600) / 10;
  return `${pad2(m)}:${s.toFixed(1).padStart(4, '0')}`;
}

/** Windows 保留设备名（大小写不敏感） */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * 文件名安全化：去路径分隔符 / 非法字符 / 控制符，收空白，去首尾点，避开 Windows 保留名。
 * 中文原样保留。
 *   safeFileName('屋顶 / 追逐: 第1镜?')  => '屋顶-追逐-第1镜'
 *   safeFileName('   ')                  => '未命名'
 */
export function safeFileName(name, fallback = '未命名', maxLen = 60) {
  let s = String(name == null ? '' : name);
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ');   // 控制符
  s = s.replace(/[<>:"/\\|?*]/g, '-');             // 各系统非法字符
  s = s.replace(/\s*-\s*/g, '-');                  // 「A - B」收成 A-B，避免横线两侧留洞
  s = s.replace(/\s+/g, ' ').trim();               // 收空白
  s = s.replace(/-{2,}/g, '-');                    // 连续的横线收成一条
  s = s.replace(/^[-.\s]+|[-.\s]+$/g, '');         // 首尾的横线 / 点 / 空白
  if (!s) return fallback;
  if (RESERVED.test(s)) s = '_' + s;
  if (s.length > maxLen) s = s.slice(0, maxLen).replace(/[-.\s]+$/, '');
  return s || fallback;
}

/**
 * 分镜网格布局：给定镜头数 N，算行列。
 * 规则：最多 4 列；镜头数不足 4 时列数 = 镜头数（不留空格）；行数向上取整。
 *   computeGrid(0)  => { cols: 1, rows: 0 }
 *   computeGrid(1)  => { cols: 1, rows: 1 }
 *   computeGrid(4)  => { cols: 4, rows: 1 }
 *   computeGrid(5)  => { cols: 4, rows: 2 }
 *   computeGrid(13) => { cols: 4, rows: 4 }
 */
export function computeGrid(count, maxCols = SHEET_DEFAULTS.cols) {
  const n = Math.max(0, Math.floor(num(count)));
  const cols = n > 0 ? Math.min(Math.max(1, maxCols), n) : 1;
  const rows = n > 0 ? Math.ceil(n / cols) : 0;
  return { cols, rows };
}

/**
 * 把镜头数组规范化成带累计时间的行：
 *   [{ index, id, label, duration, start, end, cam, ease }]
 * index 从 1 开始；start/end 单位秒，保留 3 位小数。
 */
export function buildShotRows(shots) {
  const list = Array.isArray(shots) ? shots : [];
  let t = 0;
  return list.map((shot, i) => {
    const s = shot || {};
    const index = i + 1;
    const duration = Math.max(0, round3(s.duration));
    const start = round3(t);
    const end = round3(start + duration);
    t = end;
    return {
      index,
      id: s.id == null ? `shot_${index}` : String(s.id),
      label: String(s.label == null ? '' : s.label).trim() || `镜头 ${index}`,
      duration,
      start,
      end,
      cam: s.cam || null,
      ease: s.ease == null ? null : s.ease
    };
  });
}

/** 总时长（秒） */
export function totalDuration(shots) {
  const rows = buildShotRows(shots);
  return rows.length ? rows[rows.length - 1].end : 0;
}

/** 序列号补零：总数决定宽度，最少 2 位（5 个镜头 => 01..05，120 个 => 001..120） */
export function padIndex(index, total) {
  const width = Math.max(2, String(Math.max(1, Math.floor(num(total)))).length);
  return String(Math.max(1, Math.floor(num(index)))).padStart(width, '0');
}

/**
 * 接触表版式计算（不画图，只算几何，方便单测与自适应）
 * 返回 { width, height, cols, rows, cellW, cellH, thumbW, thumbH, ... }
 */
export function computeSheetLayout(count, opts = {}) {
  const o = { ...SHEET_DEFAULTS, ...(opts || {}) };
  const { cols, rows } = computeGrid(count, o.cols);
  const innerW = o.width - o.padding * 2;
  const gutters = cols > 1 ? (cols - 1) * o.gutter : 0;
  const cellW = (innerW - gutters) / cols;
  const thumbH = Math.round((cellW * 9) / 16);       // 16:9 缩略图
  const cellH = thumbH + o.labelH;
  const contentH = rows > 0 ? rows * cellH + (rows - 1) * o.gutter : 0;
  const height = o.padding * 2 + o.headerH + contentH + o.footerH;
  return {
    ...o, cols, rows, innerW, cellW, cellH, thumbW: cellW, thumbH,
    contentH, height: Math.round(height)
  };
}

/** 接触表文件名：<片名>_storyboard.png */
export function storyboardFileName(meta) {
  const title = meta && meta.title ? meta.title : '未命名分镜';
  return `${safeFileName(title, '未命名分镜')}_storyboard.png`;
}

/** 镜头清单文件名：<片名>_shots.json / <片名>_shots.csv */
export function shotListFileName(meta, ext) {
  const title = meta && meta.title ? meta.title : '未命名分镜';
  return `${safeFileName(title, '未命名分镜')}_shots.${ext}`;
}

/** PNG 序列单张文件名：01_镜头名.png */
export function packFileName(row, total) {
  const label = row && row.label ? row.label : '镜头';
  return `${padIndex(row && row.index != null ? row.index : 1, total)}_${safeFileName(label, '镜头', 40)}.png`;
}

/** 清单的 JSON 结构（纯函数，便于单测 / 直接给外部工具） */
export function buildShotListPayload(shots, meta) {
  const rows = buildShotRows(shots);
  const m = meta || {};
  return {
    schema: STORYBOARD_SCHEMA,
    generator: 'OpenVideoForge · 分镜导出',
    title: String(m.title == null ? '未命名分镜' : m.title),
    subtitle: m.subtitle == null ? null : String(m.subtitle),
    author: m.author == null ? null : String(m.author),
    exportedAt: new Date().toISOString(),
    shotCount: rows.length,
    totalDuration: round3(totalDuration(rows)),
    shots: rows.map(r => ({
      index: r.index,
      id: r.id,
      label: r.label,
      duration: r.duration,
      start: r.start,
      end: r.end,
      startTimecode: formatTimecode(r.start),
      endTimecode: formatTimecode(r.end),
      cam: r.cam,
      ease: r.ease
    }))
  };
}

/** CSV 单元格转义：含逗号 / 引号 / 换行时加引号，内部引号翻倍 */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * 镜头清单 CSV（含 UTF-8 BOM，Excel 打开中文不乱码；CRLF 换行）
 * 返回字符串本身（测试可直接断言首字符是 \uFEFF）。
 */
export function buildCSV(shots, meta) {
  const rows = buildShotRows(shots);
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    const cam = r.cam || {};
    const t = Array.isArray(cam.t) ? cam.t : [null, null, null];
    lines.push([
      r.index,
      r.label,
      r.duration.toFixed(3),
      formatTimecode(r.start),
      formatTimecode(r.end),
      cam.r == null ? '' : String(cam.r),
      cam.phi == null ? '' : String(cam.phi),
      cam.theta == null ? '' : String(cam.theta),
      t[0] == null ? '' : String(t[0]),
      t[1] == null ? '' : String(t[1]),
      t[2] == null ? '' : String(t[2]),
      cam.fov == null ? '' : String(cam.fov),
      r.ease == null ? '' : String(r.ease)
    ].map(csvCell).join(','));
  }
  // 末行也带 CRLF，方便 Windows 编辑器与 Excel
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/* ------------------------------------------------------------ */
/* 浏览器侧辅助：下载 / Canvas                                   */
/* ------------------------------------------------------------ */

const isBrowser = () => typeof document !== 'undefined' && typeof URL !== 'undefined';

/** 触发一次下载；objectURL 延迟 10s 回收（Chrome 过早 revoke 会取消下载） */
function downloadBlob(filename, blob) {
  if (!isBrowser()) throw new Error('下载只能在浏览器里进行（缺少 document/URL）');
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try { a.remove(); } catch (e) { /* 忽略 */ }
    try { URL.revokeObjectURL(url); } catch (e) { /* 忽略 */ }
  }, 10000);
}

/** 延时 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** canvas → Blob（老浏览器回退到 dataURL 转 Blob） */
function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    if (canvas.toBlob) {
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('接触表编码失败（toBlob 返回空）'))), 'image/png');
      return;
    }
    try {
      const dataURL = canvas.toDataURL('image/png');
      resolve(dataURLToBlob(dataURL));
    } catch (e) { reject(e); }
  });
}

/** dataURL → Blob（PNG 序列走 objectURL，统一在 10s 后 revoke） */
function dataURLToBlob(dataURL) {
  const comma = dataURL.indexOf(',');
  const head = dataURL.slice(0, comma);
  const body = dataURL.slice(comma + 1);
  const mime = (head.match(/data:([^;]+)/) || [])[1] || 'image/png';
  const bin = head.indexOf(';base64') >= 0 ? atob(body) : decodeURIComponent(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i) & 0xff;
  return new Blob([arr], { type: mime });
}

/** 载入一张图片（dataURL / blobURL 均可） */
function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片解码失败'));
    img.src = src;
  });
}

/**
 * 保证序列产物是真正的 PNG 字节。
 * renderShot 可能返回 JPEG（体积小、抓图快），但契约要求 01_xxx.png，
 * 扩展名必须和内容一致，否则外部工具（剪辑 / 图床上传）会误判格式。
 */
async function ensurePngDataURL(dataURL) {
  if (/^data:image\/png[;,]/i.test(dataURL)) return dataURL;
  const img = await loadImage(dataURL);
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) throw new Error('抓图尺寸为 0，无法转 PNG');
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 Canvas 2D 上下文');
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/png');
}

/** 校验注入的抓图函数，早失败早报错 */
function ensureRenderShot(renderShot) {
  if (typeof renderShot !== 'function') {
    throw new Error('缺少 renderShot：请注入 renderShot(shot) => Promise<dataURL> 再导出');
  }
  return renderShot;
}

/**
 * 顺序抓图（不能并发：renderShot 会切相机，并发会互相踩）。
 * 单张失败只记 null，不中断整体。
 * 返回与 shots 等长的数组：dataURL 或 null。
 */
async function captureFrames(rows, renderShot, onProgress) {
  const out = [];
  let failed = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let dataURL = null;
    try {
      const r = await renderShot(row);
      if (typeof r !== 'string' || !r) throw new Error('renderShot 未返回 dataURL 字符串');
      dataURL = r;
    } catch (e) {
      failed++;
      dataURL = null;
      // 抓图失败不打断整体，只在进度里体现；控制台留一条便于排查
      if (typeof console !== 'undefined') console.warn(`[storyboard] 镜头 ${row.index}「${row.label}」抓图失败：`, e && e.message ? e.message : e);
    }
    out.push(dataURL);
    if (typeof onProgress === 'function') {
      try { onProgress({ phase: 'capture', done: i + 1, total: rows.length, failed, label: row.label }); } catch (e) { /* 回调异常不影响导出 */ }
    }
  }
  return out;
}

/** 圆角矩形路径 */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/** 文字截断：超宽时末尾加省略号 */
function ellipsize(ctx, text, maxWidth) {
  const s = String(text == null ? '' : text);
  if (ctx.measureText(s).width <= maxWidth) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? s.slice(0, lo) + '…' : '…';
}

/** 画一张缩略图（cover 裁剪，保持 16:9 不变形） */
function drawCover(ctx, img, x, y, w, h) {
  const iw = img.width || img.naturalWidth || 16;
  const ih = img.height || img.naturalHeight || 9;
  const srcAspect = iw / ih;
  const dstAspect = w / h;
  let sx = 0, sy = 0, sw = iw, sh = ih;
  if (srcAspect > dstAspect) {          // 源更宽：左右裁
    sw = ih * dstAspect;
    sx = (iw - sw) / 2;
  } else if (srcAspect < dstAspect) {    // 源更高：上下裁
    sh = iw / dstAspect;
    sy = (ih - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

/** 占位格：抓图失败 / 无缩略图时画一个斜纹格，不破坏排版 */
function drawPlaceholder(ctx, x, y, w, h, text) {
  ctx.save();
  ctx.fillStyle = '#ece9e1';
  roundRect(ctx, x, y, w, h, 4);
  ctx.fill();
  ctx.strokeStyle = '#d9d5c9';
  ctx.lineWidth = 1;
  ctx.stroke();
  // 斜纹
  ctx.save();
  roundRect(ctx, x, y, w, h, 4);
  ctx.clip();
  ctx.strokeStyle = 'rgba(160,155,140,0.18)';
  ctx.lineWidth = 1;
  for (let i = -h; i < w; i += 14) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + h);
    ctx.lineTo(x + i + h, y);
    ctx.stroke();
  }
  ctx.restore();
  // 说明文字
  ctx.fillStyle = '#8a8678';
  ctx.font = `500 14px ${FONT_SANS}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text || '抓图失败', x + w / 2, y + h / 2);
  ctx.restore();
}

/** 画内容：标题 / 网格 / 页脚（纯 Canvas 2D，坐标用 CSS px，外部已 scale） */
function drawSheet(ctx, layout, rows, frames, meta) {
  const { width, height, padding, headerH, cellW, cellH, thumbW, thumbH, gutter, footerH } = layout;
  const cols = layout.cols;

  // 纸底 + 细边框
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);

  // ---- 页眉 ----
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#1f232b';
  ctx.font = `600 32px ${FONT_SERIF}`;
  ctx.fillText(ellipsize(ctx, meta.title, width - padding * 2 - 220), padding, padding + 30);

  ctx.fillStyle = '#6b7280';
  ctx.font = `14px ${FONT_SANS}`;
  const subParts = [];
  if (meta.subtitle) subParts.push(meta.subtitle);
  subParts.push(`${rows.length} 个镜头`);
  subParts.push(`总时长 ${formatTimecode(totalDuration(rows))}`);
  ctx.fillText(ellipsize(ctx, subParts.join(' · '), width - padding * 2 - 220), padding, padding + 56);

  // 右上角：日期（等宽）
  ctx.textAlign = 'right';
  ctx.fillStyle = '#8a8f99';
  ctx.font = `12px ${FONT_MONO}`;
  ctx.fillText(meta.date, width - padding, padding + 56);
  ctx.textAlign = 'left';

  // 页眉分割线（细金线 + 浅线，Cinemap 风）
  const ruleY = padding + headerH - 14;
  ctx.fillStyle = '#c8891a';
  ctx.fillRect(padding, ruleY, 42, 2);
  ctx.fillStyle = '#e4e1d7';
  ctx.fillRect(padding + 42, ruleY + 1, width - padding * 2 - 42, 1);

  // ---- 网格 ----
  const startY = padding + headerH;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = padding + c * (cellW + gutter);
    const y = startY + r * (cellH + gutter);
    const frame = frames[i];

    // 缩略图（圆角裁切）
    ctx.save();
    roundRect(ctx, x, y, cellW, thumbH, 4);
    ctx.clip();
    if (frame) {
      const img = frame.__img;
      if (img) drawCover(ctx, img, x, y, cellW, thumbH);
      else drawPlaceholder(ctx, x, y, cellW, thumbH, '缩略图缺失');
    } else {
      drawPlaceholder(ctx, x, y, cellW, thumbH, '抓图失败');
    }
    ctx.restore();
    // 缩略图描边
    ctx.strokeStyle = '#d9d5c9';
    ctx.lineWidth = 1;
    roundRect(ctx, x + 0.5, y + 0.5, cellW - 1, thumbH - 1, 4);
    ctx.stroke();

    // 编号徽标（左上角，深底金字）
    const badgeW = 34, badgeH = 22;
    ctx.fillStyle = 'rgba(35,38,45,0.92)';
    roundRect(ctx, x + 8, y + 8, badgeW, badgeH, 3);
    ctx.fill();
    ctx.fillStyle = '#ffd250';
    ctx.font = `600 12px ${FONT_MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(padIndex(row.index, rows.length), x + 8 + badgeW / 2, y + 8 + badgeH / 2 + 0.5);

    // 镜头名
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#23262d';
    ctx.font = `600 15px ${FONT_SANS}`;
    ctx.fillText(ellipsize(ctx, row.label, cellW - 4), x, y + thumbH + 22);

    // 起止时间码
    ctx.fillStyle = '#6b7280';
    ctx.font = `12px ${FONT_MONO}`;
    ctx.fillText(
      `${formatTimecode(row.start)} – ${formatTimecode(row.end)}`,
      x, y + thumbH + 42
    );

    // 时长（右对齐，同基线）
    ctx.textAlign = 'right';
    ctx.fillStyle = '#9aa0a8';
    ctx.font = `11px ${FONT_MONO}`;
    ctx.fillText(`${row.duration.toFixed(1)}s`, x + cellW, y + thumbH + 42);
    ctx.textAlign = 'left';
  }

  // ---- 页脚 ----
  const footY = height - padding;
  ctx.fillStyle = '#e4e1d7';
  ctx.fillRect(padding, footY - footerH + 8, width - padding * 2, 1);
  ctx.fillStyle = '#8a8f99';
  ctx.font = `11px ${FONT_MONO}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('OpenVideoForge · 分镜接触表', padding, footY - 4);
  ctx.textAlign = 'right';
  ctx.fillText(`${meta.date} · ${rows.length} 镜头`, width - padding, footY - 4);
  ctx.textAlign = 'left';
}

/* ------------------------------------------------------------ */
/* 对外导出 1：分镜接触表 PNG                                     */
/* ------------------------------------------------------------ */

/**
 * 生成并自动下载分镜接触表 PNG。
 *
 * @param {Object}   opts
 * @param {Array}    opts.shots       镜头数组（见文件头契约）
 * @param {Function} opts.renderShot  (shot) => Promise<dataURL>，必填
 * @param {Object}   [opts.meta]      { title, subtitle, author, date }
 * @param {Function} [opts.onProgress] ({phase,done,total,failed,label}) => void
 * @returns {Promise<{ok:boolean,count:number,failed:number,filename:string,width:number,height:number}>}
 */
export async function exportContactSheet({ shots, renderShot, meta, onProgress } = {}) {
  const rows = buildShotRows(shots);
  const m = normalizeMeta(meta);
  const layout = computeSheetLayout(rows.length);

  // 1) 顺序抓图（失败只占位）
  const frames = await captureFrames(rows, ensureRenderShot(renderShot), onProgress);
  // 2) 预解码图片（避免绘制阶段 await，保持一次同步画完）
  const decoded = [];
  for (let i = 0; i < frames.length; i++) {
    const dataURL = frames[i];
    if (!dataURL) { decoded.push(null); continue; }
    try {
      const img = await loadImage(dataURL);
      decoded.push({ __img: img });
    } catch (e) {
      decoded.push(null);
      if (typeof console !== 'undefined') console.warn('[storyboard] 缩略图解码失败：', e && e.message ? e.message : e);
    }
  }

  // 3) 画布（2x 高 DPI；超高时按单边上限降采样）
  if (!isBrowser()) throw new Error('exportContactSheet 只能在浏览器里运行');
  const scale = Math.min(SHEET_DEFAULTS.maxScale, SHEET_DEFAULTS.maxPixelSide / Math.max(1, layout.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(layout.width * scale));
  canvas.height = Math.max(1, Math.round(layout.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 Canvas 2D 上下文');
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  drawSheet(ctx, layout, rows, decoded, m);

  // 4) 下载
  const filename = storyboardFileName(m);
  const blob = await canvasToBlob(canvas);
  downloadBlob(filename, blob);

  return {
    ok: true,
    count: rows.length,
    failed: decoded.filter(x => !x).length,
    filename,
    width: layout.width,
    height: layout.height
  };
}

/* ------------------------------------------------------------ */
/* 对外导出 2：镜头清单 JSON                                      */
/* ------------------------------------------------------------ */

/** 下载镜头清单 JSON（每镜头含 index/label/duration/start/end/cam/ease） */
export function exportShotListJSON(shots, meta) {
  const payload = buildShotListPayload(shots, meta);
  const filename = shotListFileName(meta, 'json');
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
  downloadBlob(filename, blob);
  return { ok: true, count: payload.shotCount, filename };
}

/* ------------------------------------------------------------ */
/* 对外导出 3：镜头清单 CSV                                       */
/* ------------------------------------------------------------ */

/** 下载镜头清单 CSV（UTF-8 BOM，Excel 中文不乱码） */
export function exportShotListCSV(shots, meta) {
  const csv = buildCSV(shots, meta);
  const filename = shotListFileName(meta, 'csv');
  // 带上 charset，部分 Windows 浏览器靠它判断编码；BOM 本身已足够
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  downloadBlob(filename, blob);
  return { ok: true, count: buildShotRows(shots).length, filename };
}

/* ------------------------------------------------------------ */
/* 对外导出 4：PNG 序列                                           */
/* ------------------------------------------------------------ */

/**
 * 逐张导出每个镜头的 PNG（01_镜头名.png）。
 *
 * 为什么串行 + 节流：Chrome 对「同一时刻多个下载」会弹拦截，且 renderShot 要切相机。
 * 每张之间间隔 320ms（落在要求的 200–400ms 内），单张失败跳过并计数。
 *
 * @param {Object}   opts
 * @param {Array}    opts.shots
 * @param {Function} opts.renderShot
 * @param {Object}   [opts.meta]
 * @param {Function} [opts.onProgress] ({phase:'pack',done,total,failed,label,filename}) => void
 * @param {number}   [opts.intervalMs=320] 张与张之间的间隔
 * @returns {Promise<{ok:boolean,count:number,failed:number,files:string[]}>}
 */
export async function exportShotPack({ shots, renderShot, meta, onProgress, intervalMs = 320 } = {}) {
  if (!isBrowser()) throw new Error('exportShotPack 只能在浏览器里运行');
  const rs = ensureRenderShot(renderShot);
  const rows = buildShotRows(shots);
  const gap = Math.max(200, Math.min(400, num(intervalMs, 320))); // 夹在 200–400ms
  const files = [];
  let failed = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const name = packFileName(row, rows.length);
    try {
      const dataURL = await rs(row);
      if (typeof dataURL !== 'string' || !dataURL) throw new Error('renderShot 未返回 dataURL 字符串');
      // 扩展名是 .png，内容也必须是 PNG：JPEG 截图在这里转一次
      const pngURL = await ensurePngDataURL(dataURL);
      const blob = dataURLToBlob(pngURL);
      downloadBlob(name, blob);          // objectURL 在内部 10s 后 revoke
      files.push(name);
    } catch (e) {
      failed++;
      if (typeof console !== 'undefined') console.warn(`[storyboard] PNG 序列第 ${row.index} 张失败：`, e && e.message ? e.message : e);
    }
    if (typeof onProgress === 'function') {
      try {
        onProgress({ phase: 'pack', done: i + 1, total: rows.length, failed, label: row.label, filename: name });
      } catch (e) { /* 忽略回调异常 */ }
    }
    // 最后一张之后不必再等
    if (i < rows.length - 1) await sleep(gap);
  }

  return { ok: failed === 0, count: files.length, failed, files };
}

/* ------------------------------------------------------------ */
/* 内部：meta 规范化                                              */
/* ------------------------------------------------------------ */

function normalizeMeta(meta) {
  const m = meta || {};
  const date = m.date || new Date().toISOString().slice(0, 10);
  return {
    title: String(m.title == null ? '未命名分镜' : m.title),
    subtitle: m.subtitle == null ? '' : String(m.subtitle),
    author: m.author == null ? '' : String(m.author),
    date: String(date)
  };
}
