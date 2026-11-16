/* ============================================================================
 * server/hdri.mjs —— 本地 HDRI 素材库（环境光照贴图）
 *
 * 为什么要它：白膜场景之所以"不像真的"，缺的不是表面纹理，是**光** ——
 *   没有环境反射（金属/水/玻璃完全不像）、没有间接光（阴影是死黑）。
 *   HDRI 一次解决这两条，而且**对所有材质都生效、不需要 UV**。
 *
 * 存储：<OUT_DIR>\素材库\HDRI\
 *   ├── index.json     清单（槽位/名字/作者/许可证/缩略图）
 *   ├── <id>.hdr       Radiance HDR（1K ≈ 1.4MB）
 *   └── <id>.png       缩略图
 *
 * 来源：Poly Haven（**CC0**，商用自用都行）。tools/fetch-hdri.mjs 负责抓。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const SUBDIR = path.join('素材库', 'HDRI');

/** HDRI 目录 */
export function hdriDir(outDir) {
  return path.join(outDir, SUBDIR);
}

/** 清单 */
export function hdriIndex(outDir) {
  const p = path.join(hdriDir(outDir), 'index.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j.items) ? j : { version: 1, source: 'Poly Haven (CC0)', items: [] };
  } catch (_) {
    return { version: 1, source: 'Poly Haven (CC0)', items: [] };
  }
}

/** 列出全部 HDRI（含每张的元信息）—— 同槽位多个分辨率时，**只留最高分辨率** */
export function listHdri(outDir) {
  const idx = hdriIndex(outDir);
  const dir = hdriDir(outDir);
  // 按 slot 挑最高分辨率（2k > 1k）
  const resRank = (r) => ({ '8k': 4, '4k': 3, '2k': 2, '1k': 1 }[String(r || '1k').toLowerCase()] || 0);
  const best = new Map();
  for (const it of idx.items) {
    const cur = best.get(it.slot);
    if (!cur || resRank(it.res) > resRank(cur.res)) best.set(it.slot, it);
  }
  return [...best.values()]
    .map((it) => {
      const f = path.join(dir, it.file || (it.id + '.hdr'));
      const ok = fs.existsSync(f);
      return {
        id: it.id,
        slot: it.slot,
        slotLabel: it.slotLabel || it.slot,
        name: it.name || it.id,
        file: it.file || (it.id + '.hdr'),
        res: it.res || '1k',
        thumb: it.thumb || null,
        bytes: ok ? fs.statSync(f).size : 0,
        authors: it.authors || [],
        license: it.license || 'CC0',
        source: it.source || 'Poly Haven',
        url: it.url || null,
        categories: it.categories || [],
        attributes: it.attributes || {},
        available: ok,
      };
    })
    .filter((it) => it.available);
}

/** 按 id 找文件（路径必须在 HDRI 目录内，防穿越） */
export function hdriFilePath(id, outDir) {
  if (!id) return { ok: false, error: '缺少 id' };
  const dir = hdriDir(outDir);
  const idx = hdriIndex(outDir);
  // id 可能是 'sunny' 也可能是 'sunny.hdr' / 'sunny_1k.hdr'，都归一化
  const raw = String(id).replace(/[\\/]+/g, '');
  const bare = raw.replace(/\.(hdr|exr|png)$/i, '').replace(/_\d+[kK]$/, '');
  const hits = idx.items.filter((i) => i.id === raw || i.id === bare);
  if (!hits.length) {
    const full = path.join(dir, path.basename(bare + '.hdr'));
    if (!full.startsWith(path.resolve(dir))) return { ok: false, error: '路径越界' };
    if (!fs.existsSync(full)) return { ok: false, error: '找不到：' + id };
    return { ok: true, path: full, bytes: fs.statSync(full).size };
  }
  // ★ 多个分辨率时给**最高**的那个（2K 比 1K 清楚）
  const rank = (r) => ({ '8k': 4, '4k': 3, '2k': 2, '1k': 1 }[String(r || '1k').toLowerCase()] || 0);
  const sorted = hits.slice().sort((a, b) => rank(b.res) - rank(a.res));
  for (const rec of sorted) {
    const full = path.join(dir, path.basename(rec.file || (rec.id + '.hdr')));
    if (!full.startsWith(path.resolve(dir))) continue;
    if (fs.existsSync(full)) return { ok: true, path: full, bytes: fs.statSync(full).size, res: rec.res || '1k' };
  }
  return { ok: false, error: '找不到：' + id };
}

/** 缩略图 */
export function hdriThumbPath(id, outDir) {
  const dir = hdriDir(outDir);
  const safe = String(id || '').replace(/[\\/]+/g, '').replace(/\.[^.]*$/, '');
  const idx = hdriIndex(outDir);
  const rec = idx.items.find((i) => i.id === id);
  const file = rec && rec.thumb ? rec.thumb : (safe + '.png');
  const full = path.join(dir, path.basename(file));
  if (!full.startsWith(path.resolve(dir))) return { ok: false, error: '路径越界' };
  if (!fs.existsSync(full)) return { ok: false, error: '没有缩略图' };
  return { ok: true, path: full };
}
