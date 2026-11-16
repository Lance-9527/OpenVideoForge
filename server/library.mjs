/* ============================================================================
 * server/library.mjs —— 资产库（**落盘持久化**）
 *
 * 用户的要求（2026-11-08）：
 *   「资产库包含——场景模型（比如从网站弄来的、自建的）、人物模型、材质、灯光等等，
 *     而且可以复用+调用；不能因为我关掉网页，下次资产库就归零了」
 *
 * ⇒ 关键点：
 *   ① **不存 localStorage**，存本机磁盘（<OUT_DIR>\资产库\）——
 *      关网页、重启浏览器、换浏览器都不丢。
 *   ② 分 kind：model（3D 模型）/ world（场景模型）/ material（材质）/ light（灯光）。
 *   ③ 每个条目都带 **source + attribution**（从哪来的、要不要署名），
 *      这样"资产可复用"的同时"出处不丢"。
 *   ④ 内置条目（材质/灯光预设）也进同一张表 —— 资产库是一个**统一的池子**，
 *      不是"内置的 + 外置的"两张皮。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { defaultOutDir } from './paths.mjs';

export const LIB_DIR_NAME = '资产库';
export const LIB_INDEX = 'index.json';

/** 资产种类 → 分类标签 */
export const KIND_CATEGORY = {
  model: 'model',
  world: 'scene',
  material: 'material',
  light: 'light',
};

export function libDir(outDir) {
  const d = path.join(outDir || process.env.WBWB_OUT_DIR || defaultOutDir(), LIB_DIR_NAME);
  fs.mkdirSync(d, { recursive: true });
  fs.mkdirSync(path.join(d, 'models'), { recursive: true });
  return d;
}

/** id 安全化（同时防路径穿越） */
export function safeId(name) {
  const s = String(name || 'item')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 60) || 'item';
  return s;
}
function fileOf(id) {
  const s = safeId(id);
  if (!/^[\w一-龥.-]+$/.test(s)) return null;
  return s + '.json';
}

/* ── 内置条目（材质 / 灯光 / 场景模板） ──────────────────────────────── */

/** 材质预设：白膜常用的一批 */
export const BUILTIN_MATERIALS = [
  { id: 'mat_white', name: '哑光白（白膜）', material: { color: '#e8e4dc', roughness: 0.92, metalness: 0.0 } },
  { id: 'mat_warm', name: '暖砂', material: { color: '#d9c9a8', roughness: 0.88, metalness: 0.0 } },
  { id: 'mat_concrete', name: '清水混凝土', material: { color: '#b9b6ae', roughness: 0.96, metalness: 0.02 } },
  { id: 'mat_brick', name: '红砖', material: { color: '#a05a44', roughness: 0.9, metalness: 0.0 } },
  { id: 'mat_glass', name: '玻璃', material: { color: '#9fc4d6', roughness: 0.08, metalness: 0.15, transparent: true, opacity: 0.45 } },
  { id: 'mat_metal', name: '拉丝金属', material: { color: '#9aa0a6', roughness: 0.32, metalness: 0.85 } },
  { id: 'mat_wood', name: '原木', material: { color: '#b58a55', roughness: 0.78, metalness: 0.0 } },
  { id: 'mat_fabric', name: '织物', material: { color: '#8fa3b8', roughness: 1.0, metalness: 0.0 } },
  { id: 'mat_foliage', name: '植被', material: { color: '#6f8f5c', roughness: 0.95, metalness: 0.0 } },
  { id: 'mat_road', name: '沥青路面', material: { color: '#4a4a4c', roughness: 0.98, metalness: 0.0 } },
  { id: 'mat_water', name: '水面', material: { color: '#5c8ba6', roughness: 0.15, metalness: 0.1 } },
  { id: 'mat_neon', name: '霓虹（自发光）', material: { color: '#f2f2f2', roughness: 0.4, metalness: 0.0, emissive: '#ff3d7f', emissiveIntensity: 2.2 } },
];

/** 灯光预设：把「什么时间什么气氛」存下来，随时调出来 */
export const BUILTIN_LIGHTS = [
  { id: 'light_noon', name: '正午', light: { azimuth: 134, elevation: 62, kelvin: 5600, intensity: 1.35, hemi: 0.55, shadowSoft: 0.35 } },
  { id: 'light_dusk', name: '黄昏', light: { azimuth: 258, elevation: 11, kelvin: 3200, intensity: 1.1, hemi: 0.32, shadowSoft: 0.75 } },
  { id: 'light_night', name: '夜景', light: { azimuth: 205, elevation: 26, kelvin: 4300, intensity: 0.38, hemi: 0.28, shadowSoft: 0.7 } },
  { id: 'light_studio', name: '影棚', light: { azimuth: 90, elevation: 48, kelvin: 5400, intensity: 1.0, hemi: 0.85, shadowSoft: 0.9 } },
  { id: 'light_side', name: '侧光', light: { azimuth: 45, elevation: 22, kelvin: 4800, intensity: 1.25, hemi: 0.2, shadowSoft: 0.45 } },
  { id: 'light_moon', name: '月光', light: { azimuth: 300, elevation: 38, kelvin: 7200, intensity: 0.3, hemi: 0.18, shadowSoft: 0.85 } },
  { id: 'light_overcast', name: '阴天', light: { azimuth: 160, elevation: 70, kelvin: 6200, intensity: 0.85, hemi: 0.95, shadowSoft: 1.0 } },
];

/** 场景模型预设：程序化环境，直接当场景模型存进资产库 */
export const BUILTIN_WORLDS = [
  { id: 'world_city_medium', name: '城市·中场景', spec: { kind: 'env', env: 'city', size: 'medium', seed: 7 } },
  { id: 'world_city_large', name: '城市·大场景', spec: { kind: 'env', env: 'city', size: 'large', seed: 7 } },
  { id: 'world_city_xxl', name: '城市·巨型', spec: { kind: 'env', env: 'city', size: 'xxl', seed: 7 } },
  { id: 'world_nightcity', name: '夜景城市', spec: { kind: 'env', env: 'nightcity', size: 'medium', seed: 11 } },
  { id: 'world_beach', name: '海滩', spec: { kind: 'env', env: 'beach', size: 'medium' } },
  { id: 'world_alley', name: '小巷', spec: { kind: 'env', env: 'alley', size: 'medium' } },
  { id: 'world_office', name: '办公室', spec: { kind: 'env', env: 'office', size: 'medium' } },
];

/** 内置条目 → 资产库记录 */
function builtinRecords() {
  const out = [];
  for (const m of BUILTIN_MATERIALS) {
    out.push({
      id: m.id, kind: 'material', category: 'material', name: m.name,
      material: m.material, builtin: true, source: 'built-in', attribution: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }
  for (const l of BUILTIN_LIGHTS) {
    out.push({
      id: l.id, kind: 'light', category: 'light', name: l.name,
      light: l.light, builtin: true, source: 'built-in', attribution: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }
  for (const w of BUILTIN_WORLDS) {
    out.push({
      id: w.id, kind: 'world', category: 'scene', name: w.name,
      spec: w.spec, builtin: true, source: 'built-in', attribution: null,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }
  return out;
}

/* ── 读写 index.json ─────────────────────────────────────────────────── */

function readIndex(outDir) {
  const p = path.join(libDir(outDir), LIB_INDEX);
  let user = [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (Array.isArray(j)) user = j;
    else if (Array.isArray(j.items)) user = j.items;
  } catch (_) { user = []; }
  // 内置条目 + 用户条目（用户条目覆盖同名内置）
  const map = new Map();
  for (const b of builtinRecords()) map.set(b.id, b);
  for (const u of user) map.set(u.id, { ...u, builtin: false });
  return [...map.values()];
}

function writeIndex(items, outDir) {
  const dir = libDir(outDir);
  const user = items.filter((i) => !i.builtin);
  fs.writeFileSync(path.join(dir, LIB_INDEX), JSON.stringify({ version: 1, items: user }, null, 2), 'utf8');
}

/* ── 对外 API ─────────────────────────────────────────────────────────── */

/** 列全部（可按 kind / category 过滤） */
export function libraryList(outDir, filter = {}) {
  const items = readIndex(outDir);
  let out = items;
  if (filter.kind) out = out.filter((i) => i.kind === filter.kind);
  if (filter.category) out = out.filter((i) => i.category === filter.category);
  if (filter.q) {
    const q = String(filter.q).toLowerCase();
    out = out.filter((i) => String(i.name).toLowerCase().includes(q) || String(i.source || '').toLowerCase().includes(q));
  }
  out = out.slice().sort((a, b) => {
    if (!!a.builtin !== !!b.builtin) return a.builtin ? 1 : -1;   // 用户资产在前
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
  const counts = { model: 0, world: 0, material: 0, light: 0 };
  for (const i of items) counts[i.kind] = (counts[i.kind] || 0) + 1;
  return {
    dir: libDir(outDir),
    count: items.length,
    counts,
    userCount: items.filter((i) => !i.builtin).length,
    items: out,
  };
}

/** 加一条（同名覆盖） */
export function libraryAdd(entry, outDir) {
  const items = readIndex(outDir);
  const id = safeId(entry.id || entry.name);
  const now = new Date().toISOString();
  const prev = items.find((i) => i.id === id);
  const rec = {
    ...entry,
    id,
    kind: entry.kind || 'model',
    category: entry.category || KIND_CATEGORY[entry.kind || 'model'],
    name: String(entry.name || id),
    builtin: false,
    source: entry.source || 'local',
    attribution: entry.attribution || null,
    createdAt: prev && !prev.builtin ? prev.createdAt : now,
    updatedAt: now,
  };
  const next = items.filter((i) => i.id !== id).concat(rec);
  writeIndex(next, outDir);
  return { ok: true, item: rec };
}

/** 删一条（内置条目不能删；模型文件一并删） */
export function libraryRemove(id, outDir) {
  const items = readIndex(outDir);
  const rec = items.find((i) => i.id === id);
  if (!rec) return { ok: false, error: '资产库里没有这一条：' + id };
  if (rec.builtin) return { ok: false, error: '内置条目不能删（可以"另存为"改成自己的）' };
  if (rec.kind === 'model' && rec.file) {
    const f = path.join(libDir(outDir), rec.file);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* 忽略 */ }
  }
  // ★ 缩略图也跟着删，别留孤儿文件
  try {
    const tp = path.join(libraryThumbDir(outDir), safeId(id) + '.png');
    if (fs.existsSync(tp)) fs.unlinkSync(tp);
  } catch (_) { /* 忽略 */ }
  writeIndex(items.filter((i) => i.id !== id), outDir);
  return { ok: true, removed: id };
}

/** 把一个 GLB 文件收进资产库（复制进 models/，不依赖外部进程） */
export function libraryImportModel(filePath, meta, outDir) {
  const dir = libDir(outDir);
  const base = path.basename(filePath);
  const id = safeId(meta.id || base.replace(/\.[^.]+$/, ''));
  const ext = path.extname(base).toLowerCase() || '.glb';
  const dest = path.join(dir, 'models', id + ext);
  fs.copyFileSync(filePath, dest);
  const bytes = fs.statSync(dest).size;
  const rec = {
    id,
    kind: 'model',
    category: meta.category || 'prop',
    name: meta.name || base,
    file: path.join('models', id + ext).split(path.sep).join('/'),
    bytes,
    thumb: meta.thumb || null,
    source: meta.source || 'local',
    attribution: meta.attribution || null,
    note: meta.note || '',
    tags: meta.tags || [],
  };
  return libraryAdd(rec, outDir);
}

/** 取模型文件的绝对路径（只能取资产库 models/ 里的） */
export function libraryFilePath(id, outDir) {
  const items = readIndex(outDir);
  const rec = items.find((i) => i.id === id && i.kind === 'model');
  if (!rec || !rec.file) return { ok: false, error: '没有这个模型资产：' + id };
  const dir = libDir(outDir);
  const p = path.join(dir, rec.file);
  if (!p.startsWith(path.join(dir, 'models'))) return { ok: false, error: '非法路径' };
  if (!fs.existsSync(p)) return { ok: false, error: '文件不在了：' + rec.file };
  return { ok: true, path: p, item: rec };
}

/* ── 分件索引（"精准 copy 某个地方的某个物体"） ──────────────────────── */

/**
 * ★ 2026-11-09：给模型建**分件索引**。
 *
 * 用户的需求：「需要某个地方的某个物体都可以直接精准 copy」。
 * 一个 GLB（比如一整个教室）里有几百个 mesh —— 桌子、椅子、黑板、窗。
 * 之前只能整个模型一起放进场景，没法只拿其中一个。
 *
 * 现在：页面加载 GLB 后把每个 mesh 的名字 / 包围盒 / 位置 / 颜色报回来，
 * 存进 index.json，之后就能：
 *   · 按名字搜到「教室里的黑板」
 *   · 只把那一个分件放进场景
 *
 * 分件由**页面**算（浏览器里才有 three.js），服务端只存。
 */
export function librarySaveParts(id, parts, outDir) {
  const items = readIndex(outDir);
  const rec = items.find((i) => i.id === id);
  if (!rec) return { ok: false, error: '资产库里没有这一条：' + id };
  if (!Array.isArray(parts)) return { ok: false, error: 'parts 必须是数组' };
  // 只留必要字段，别把 index 撑爆
  const clean = parts.slice(0, 2000).map((p, i) => ({
    i,
    name: String(p.name || ('件' + (i + 1))).slice(0, 80),
    size: Array.isArray(p.size) ? p.size.map((v) => +Number(v || 0).toFixed(3)) : [0, 0, 0],
    pos: Array.isArray(p.pos) ? p.pos.map((v) => +Number(v || 0).toFixed(3)) : [0, 0, 0],
    color: String(p.color || '').slice(0, 24),
    tris: Number(p.tris || 0) || 0,
  }));
  rec.parts = clean;
  rec.partCount = clean.length;
  rec.updatedAt = new Date().toISOString();
  writeIndex(items, outDir);
  return { ok: true, id: rec.id, partCount: clean.length };
}

/* ── 缩略图 ───────────────────────────────────────────────────────────── */

/**
 * ★ 2026-11-08：资产库缩略图。
 *   之前卡片上只能显示「模型/场景/材质」几个字，库里有什么根本认不出来。
 *   缩略图由**页面**渲染（浏览器里才有 WebGL），把 PNG 送回来存到 thumbs/。
 */
export function libraryThumbDir(outDir) {
  return path.join(libDir(outDir), 'thumbs');
}

/** 存缩略图（base64 PNG 或 dataURL），并更新 index 的 thumb 字段 */
export function librarySaveThumb(id, data, outDir) {
  const items = readIndex(outDir);
  const rec = items.find((i) => i.id === id);
  if (!rec) return { ok: false, error: '资产库里没有这一条：' + id };
  // dataURL → base64
  let b64 = String(data || '');
  const i = b64.indexOf(',');
  if (b64.startsWith('data:') && i > 0) b64 = b64.slice(i + 1);
  if (!b64) return { ok: false, error: '缺少缩略图数据' };
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch (_) { return { ok: false, error: '缩略图数据坏了' }; }
  if (!buf.length || buf.length > 4 * 1024 * 1024) return { ok: false, error: '缩略图大小不对' };
  // 校验是不是 PNG（magic）
  if (!(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)) {
    return { ok: false, error: '只接受 PNG' };
  }
  const dir = libraryThumbDir(outDir);
  fs.mkdirSync(dir, { recursive: true });
  const name = safeId(id) + '.png';
  fs.writeFileSync(path.join(dir, name), buf);
  rec.thumb = 'thumbs/' + name;
  rec.updatedAt = new Date().toISOString();
  writeIndex(items, outDir);
  return { ok: true, thumb: rec.thumb, bytes: buf.length, id: rec.id };
}

/** 取缩略图（只允许 thumbs/ 目录内） */
export function libraryThumbPath(id, outDir) {
  if (!id) return { ok: false, error: '缺少 id' };
  const dir = libraryThumbDir(outDir);
  const safe = safeId(id);
  const p = path.join(dir, safe + '.png');
  if (!p.startsWith(path.resolve(dir))) return { ok: false, error: '非法路径' };
  if (!fs.existsSync(p)) return { ok: false, error: '没有缩略图：' + id };
  return { ok: true, path: p, bytes: fs.statSync(p).size };
}

/** 把"当前世界"存成资产库里的场景模型 */
export function librarySaveWorld(spec, name, outDir, extra = {}) {
  return libraryAdd({
    id: extra.id || name,
    kind: 'world',
    category: 'scene',
    name,
    spec,
    thumb: extra.thumb || null,
    source: extra.source || (spec && spec.kind) || 'local',
    attribution: extra.attribution || (spec && spec.attribution) || null,
    note: extra.note || '',
    stats: extra.stats || null,
  }, outDir);
}
