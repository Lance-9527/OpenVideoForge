/* ============================================================================
 * server/inbox.mjs —— 外部素材收件箱
 *
 * 人从外部工具（背景ガチャ / ワールドガチャ / ロケハン …）导出文件，
 * 丢进收件箱目录，openVideoForge 一键把它们登记进资产库，
 * 之后就跟内置资产一样用：摆位 → 打光 → 拍照/出片 → 导出。
 *
 * 为什么要有"收件箱"这一层：
 *   那些工具是**纯浏览器端**的，模型是在你的浏览器里生成并下载的，
 *   没有一个公开的素材 API 可供程序去取。所以最稳的一步永远是
 *   "人导出一次 → 之后反复用"。收件箱就是把这一步变成顺手动作。
 *
 * 版权：收进来的是**输出物**，可以在作品里自由使用（含商用）；
 *   但请勿把导出的 GLB 原样当素材包再分发。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { defaultOutDir } from './paths.mjs';
import { INBOX_NAME, INBOX_ACCEPT, findSource } from '../js/worldgen/sources.js';

export function inboxDir(outDir) {
  const d = path.join(outDir || process.env.WBWB_OUT_DIR || defaultOutDir(), INBOX_NAME);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 列出收件箱里可导入的文件 */
export function scanInbox(outDir) {
  const dir = inboxDir(outDir);
  let items = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    items = [];
  }
  const files = [];
  for (const it of items) {
    if (!it.isFile()) continue;
    const ext = path.extname(it.name).toLowerCase();
    if (!INBOX_ACCEPT.includes(ext)) continue;
    const abs = path.join(dir, it.name);
    let st;
    try { st = fs.statSync(abs); } catch (_) { continue; }
    files.push({
      name: it.name,
      path: abs,
      ext,
      bytes: st.size,
      mtime: st.mtimeMs,
      ageHours: +((Date.now() - st.mtimeMs) / 3600000).toFixed(1),
      kind: ext === '.glb' || ext === '.gltf' ? 'model' : ext === '.json' ? 'scene' : 'image',
    });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return {
    dir,
    name: INBOX_NAME,
    accept: INBOX_ACCEPT,
    count: files.length,
    files,
    models: files.filter((f) => f.kind === 'model').length,
    images: files.filter((f) => f.kind === 'image').length,
  };
}

/**
 * 猜这个文件是从哪个工具导出来的（文件名里常带工具名或日文名）
 * 猜不到就标 unknown —— 不硬编。
 */
export function guessSource(fileName) {
  const n = fileName.toLowerCase();
  // 先按 id 精确匹配，再退回关键词。
  //   （不先匹配的话 'worldgacha_town.glb' 里的 'gacha' 会先命中 haikeigacha —— 踩过）
  const ids = ['haikeigacha', 'worldgacha', 'posegacha', 'comicmodeler', 'rokehan'];
  for (const id of ids) if (n.includes(id)) return id;
  const table = [
    ['haikeigacha', ['haikei', '背景', 'へい']],
    ['worldgacha', ['world', 'ワールド', '世界']],
    ['rokehan', ['rokehan', 'ロケハン', '街']],
    ['posegacha', ['pose', 'ポーズ']],
    ['comicmodeler', ['comic', 'モデル']],
  ];
  for (const [id, keys] of table) {
    for (const k of keys) if (n.includes(k.toLowerCase())) return id;
  }
  return null;
}

/** 从收件箱取一个文件的绝对路径（只能取收件箱里的，防路径穿越） */
export function resolveInboxFile(name, outDir) {
  const dir = inboxDir(outDir);
  const base = path.basename(String(name || ''));
  const abs = path.join(dir, base);
  if (!abs.startsWith(dir)) return { ok: false, error: '非法路径' };
  if (!fs.existsSync(abs)) return { ok: false, error: '收件箱里没有这个文件：' + base };
  const ext = path.extname(base).toLowerCase();
  if (!INBOX_ACCEPT.includes(ext)) return { ok: false, error: '不支持的格式：' + ext };
  return { ok: true, path: abs, name: base, dir };
}

/** 生成一条出处说明（写进资产元数据，出片时可以带上） */
export function provenance(fileName, sourceId) {
  const sid = sourceId || guessSource(fileName);
  const src = sid ? findSource(sid) : null;
  const bits = [];
  if (src) bits.push(`工具：${src.name} (${src.info})`);
  else bits.push('工具：未标注（外部导入）');
  bits.push(`原始文件：${fileName}`);
  if (src && src.credit) bits.push(`署名要求：${src.credit}`);
  return { source: sid || 'unknown', sourceName: src ? src.name : null, text: bits.join(' · ') };
}
