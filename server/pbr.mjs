/* ==========================================================================
 * server/pbr.mjs —— 本地 PBR 素材（ambientCG CC0）
 *
 * ★ 2026-11-09：把可用的现实素材抓到自己本地，让 openVideoForge 直接调用。
 *   ambientCG 是 **CC0**（公共领域）—— 没有署名要求、没有使用限制。
 *
 * 目录结构：
 *   <OUT_DIR>\素材库\PBR\<assetId>\*.jpg
 *   <OUT_DIR>\素材库\PBR\index.json
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

/** PBR 素材根目录 */
export function pbrDir(outDir) {
  return path.join(outDir, '素材库', 'PBR');
}

/** 读清单（没有就返回空） */
export function pbrIndex(outDir) {
  const f = path.join(pbrDir(outDir), 'index.json');
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { items: Array.isArray(j.items) ? j.items : [], generatedAt: j.generatedAt || null, res: j.res || null };
  } catch (_) { return { items: [], generatedAt: null, res: null }; }
}

/** 列出全部（PBR 清单本身有 3D 预览图，不必再做缩略图） */
export function listPbr(outDir) {
  const idx = pbrIndex(outDir);
  const items = idx.items.map((i) => ({
    id: i.id,
    name: i.name || i.id,
    label: i.label || i.role || i.id,
    role: i.role || null,
    maps: i.maps || {},
    bytes: i.bytes || 0,
    license: i.license || 'CC0',
    source: i.source || null,
    attribution: null,
  }));
  return { count: items.length, items, dir: pbrDir(outDir) };
}

/**
 * 取某个材质的某个贴图文件。
 * 只允许落在 <PBR>/<assetId>/ 之内（防路径穿越）。
 */
export function pbrFilePath(assetId, fileName, outDir) {
  if (!assetId || !fileName) return { ok: false, error: '缺少参数' };
  const root = path.resolve(pbrDir(outDir));
  const dir = path.join(root, safeId(assetId));
  const p = path.resolve(path.join(dir, path.basename(String(fileName))));
  if (!p.startsWith(dir + path.sep) && p !== dir) return { ok: false, error: '非法路径' };
  if (!fs.existsSync(p)) return { ok: false, error: '没有这个贴图：' + fileName };
  return { ok: true, path: p, bytes: fs.statSync(p).size };
}

/** 只留安全字符 */
function safeId(name) {
  return String(name || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
}
