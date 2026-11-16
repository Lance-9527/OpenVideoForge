#!/usr/bin/env node
/* ============================================================================
 * tools/fetch-pbr.mjs —— 下载 **ambientCG** 的 PBR 贴图素材（CC0）
 *
 * ★ 2026-11-09：用户要"现实模型" —— 把可用的现实素材**抓到自己本地**，
 *   让 openVideoForge 能直接调用。
 *
 * 为什么选 ambientCG：
 *   · **CC0**（公共领域，跟 Poly Haven 一样）—— 没有署名要求、没有限制
 *   · 2041 个材质，1K 包 5-10MB（含 Color/Normal/Roughness/AO/Metalness/Displacement）
 *   · 可以按 assetId 直接下：https://ambientcg.com/get?file=<id>_1K-JPG.zip
 *   · **完全不需要碰 oyasumi**（那边的条款禁止批量程序化收割，
 *     而且 gacha 工具的"模型"是参数不是文件，根本没法下载）
 *
 * 存到：<OUT_DIR>\素材库\PBR\<assetId>\*.jpg + index.json
 * ========================================================================== */
import { defaultOutDir } from '../server/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = process.argv[2] || defaultOutDir();
const ONLY = process.argv.slice(3);        // 可选：只要这几个 assetId
const RES = process.env.OVF_PBR_RES || '1K-JPG';

/* ── 要抓的材质（按类别前缀） ─────────────────────────────────────────
 * `key` = 世界的**部位**（和 real-look.js 的 classifyEnvMesh 的 role 对应）：
 *   wall=墙  road=路  ground=地  floor=地板  roof=屋顶  building=楼体  neutral=杂项
 * 每个部位抓几种不同质感的，用户可以在外观面板里挑。
 */
const CATEGORIES = [
  { key: 'wall',     prefix: 'Bricks',      label: '砖墙',   n: 3 },
  { key: 'wall',     prefix: 'Concrete',    label: '混凝土', n: 3 },
  { key: 'wall',     prefix: 'Stone',       label: '石材',   n: 2 },
  { key: 'wall',     prefix: 'Rock',        label: '岩石',   n: 2 },
  { key: 'road',     prefix: 'Asphalt',     label: '沥青',   n: 2 },
  { key: 'ground',   prefix: 'Grass',       label: '草地',   n: 2 },
  { key: 'ground',   prefix: 'Ground',      label: '地面',   n: 2 },
  { key: 'ground',   prefix: 'Sand',        label: '沙土',   n: 2 },
  { key: 'floor',    prefix: 'Wood',        label: '木材',   n: 2 },
  { key: 'floor',    prefix: 'Planks',      label: '木地板', n: 2 },
  { key: 'roof',     prefix: 'Tiles',       label: '瓦片',   n: 2 },
  { key: 'roof',     prefix: 'RoofingTiles',label: '屋顶',   n: 2 },
  { key: 'building', prefix: 'Metal',       label: '金属',   n: 2 },
  { key: 'neutral',  prefix: 'Fabric',      label: '织物',   n: 2 },
];

const pbrDir = (out) => path.join(out, '素材库', 'PBR');

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * assetId 前缀 → 世界的哪个部分。
 * 和 real-look.js 的 classifyEnvMesh 的 role 对应。
 */
const ROLE_BY_PREFIX = [
  ['Bricks', 'wall'], ['Brick', 'wall'],
  ['Concrete', 'wall'], ['Asphalt', 'road'], ['Road', 'road'],
  ['Grass', 'ground'], ['Ground', 'ground'], ['Dirt', 'ground'], ['Soil', 'ground'],
  ['Wood', 'floor'], ['Planks', 'floor'], ['Floor', 'floor'],
  ['Stone', 'wall'], ['Marble', 'wall'], ['Rock', 'wall'], ['Slate', 'wall'],
  ['Tiles', 'roof'], ['RoofingTiles', 'roof'], ['Roof', 'roof'],
  ['Metal', 'building'], ['Fabric', 'neutral'], ['Sand', 'ground'],
];
function roleOf(id) {
  const s = String(id || '');
  for (const [pfx, role] of ROLE_BY_PREFIX) {
    if (s.startsWith(pfx)) return role;
  }
  return 'neutral';
}

/** ambientCG 的索引：按类型拉全部，取回 assetId 列表 */
async function fetchAssetIds(type = 'Material') {
  const url = `https://ambientcg.com/api/v2/full_json?type=${type}&limit=2000`;
  const r = await fetch(url);
  if (!r.ok) throw new Error('索引拉取失败 HTTP ' + r.status);
  const j = await r.json();
  return (j.foundAssets || []).map((a) => ({
    id: a.assetId,
    name: a.displayName || a.assetId,
    tags: a.tags || [],
    maps: a.maps || [],
  }));
}

/** 下载一个 assetId 的 1K 包并解压 */
async function downloadOne(assetId, outDir) {
  const url = `https://ambientcg.com/get?file=${assetId}_${RES}.zip`;
  const r = await fetch(url);
  if (!r.ok) return { ok: false, error: 'HTTP ' + r.status };
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) return { ok: false, error: '空文件' };

  const dir = path.join(pbrDir(outDir), assetId);
  fs.mkdirSync(dir, { recursive: true });

  // zip 里就是一堆 jpg —— 自己解（不引第三方依赖）
  const files = unzipSimple(buf, dir);
  return { ok: true, bytes: buf.length, dir, files };
}

/* ── 极简 zip 解包（只处理 store + deflate） ───────────────────────── */
import zlib from 'node:zlib';

function unzipSimple(buf, destDir) {
  const out = [];
  // 找 End of Central Directory
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    // 本地文件头
    if (buf.readUInt32LE(localOff) !== 0x04034b50) continue;
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    let data;
    try {
      data = method === 0 ? raw : zlib.inflateRawSync(raw);
    } catch (_) { continue; }
    const base = path.basename(name).replace(/[\\/]/g, '_');
    if (!base) continue;
    fs.writeFileSync(path.join(destDir, base), data);
    out.push(base);
  }
  return out;
}

/** ambientCG 包里的贴图名 → 我们的角色名 */
function classify(files) {
  const map = {};
  for (const f of files) {
    const l = f.toLowerCase();
    // 注意大小写：ambientCG 的文件名是 `_Color.jpg` / `_NormalGL.jpg`（首字母大写）
    if (/_color\./.test(l)) map.albedo = f;
    else if (/_normal(gl|dx)?\./.test(l)) {
      // three.js 用 **OpenGL 风格**法线（+Y 朝上）⇒ 优先 NormalGL
      if (!map.normal || /_normalgl\./.test(l)) map.normal = f;
    }
    else if (/_rough/.test(l)) map.roughness = f;
    else if (/_displ/.test(l)) map.displacement = f;
    else if (/_ambientocclusion\./.test(l) || /_ao\./.test(l)) map.ao = f;
    else if (/_metalness\./.test(l) || /_metal\./.test(l)) map.metalness = f;
  }
  return map;
}

/** 从包里的预览图里挑一张当缩略图（ambientCG 叫 <id>.png） */
function pickThumb(files, destDir) {
  let cand = files.find((f) => /thumbnail/i.test(f));
  if (!cand) {
    // 否则挑"预览图"：名字里没有 _Color/_Normal/_Rough/_Displ/_AO/_Metal 的图
    cand = files.find((f) => /\.(png|jpe?g)$/i.test(f)
      && !/_color|_normal|_rough|_displ|_ambientocclusion|_ao|_metal/i.test(f));
  }
  if (!cand) return null;
  const target = path.join(destDir, 'thumb' + path.extname(cand).toLowerCase());
  try { fs.copyFileSync(path.join(destDir, cand), target); return path.basename(target); } catch (_) { return null; }
}

/* ── 主流程 ─────────────────────────────────────────────────────────── */
async function main() {
  const outDir = OUT_DIR;
  fs.mkdirSync(pbrDir(outDir), { recursive: true });

  let wanted = [];
  if (ONLY.length) {
    wanted = ONLY.map((id) => ({ id, label: id }));
  } else {
    console.log('拉 ambientCG 索引…');
    const all = await fetchAssetIds('Material');
    console.log(`  索引里有 ${all.length} 个材质`);
    for (const c of CATEGORIES) {
      const hits = all.filter((a) => a.id.startsWith(c.prefix)).slice(0, c.n);
      for (const h of hits) wanted.push({ id: h.id, label: c.label, role: c.key, name: h.name, tags: h.tags });
    }
  }

  const index = [];
  for (let i = 0; i < wanted.length; i++) {
    const w = wanted[i];
    process.stdout.write(`[${i + 1}/${wanted.length}] ${w.id} `);
    const d = path.join(pbrDir(outDir), w.id);
    if (fs.existsSync(path.join(d, 'index.json'))) {
      // 已下载过 —— 补齐新加的字段（role / 缩略图），**不重复下载**
      const old = JSON.parse(fs.readFileSync(path.join(d, 'index.json'), 'utf8'));
      const fixed = Object.assign({}, old, {
        role: old.role || w.role || roleOf(w.id),
        label: old.label && old.label !== old.id ? old.label : (w.label || old.label),
        maps: old.maps || {},
      });
      if (!fixed.maps.albedo) {
        // 老版本正则漏了 albedo —— 重新扫一遍目录
        const files = fs.readdirSync(d);
        const m2 = classify(files);
        if (m2.albedo) {
          fixed.maps = m2;
          const t2 = pickThumb(files, d);
          if (t2) fixed.thumb = '素材库/PBR/' + w.id + '/' + t2;
        }
      }
      fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify(fixed, null, 2), 'utf8');
      index.push(fixed);
      console.log('已存在，补写 role=' + fixed.role + (fixed.maps.albedo ? ' +albedo' : ' (缺albedo!)'));
      continue;
    }
    try {
      const r = await downloadOne(w.id, outDir);
      if (!r.ok) { console.log('✗ ' + r.error); continue; }
      const maps = classify(r.files);
      const thumb = pickThumb(r.files, d);
      const rec = {
        id: w.id,
        name: w.name || w.id,
        label: w.label || w.label,
        // ★ role：决定这个材质贴到世界的哪个部分（ground/road/wall/…）
        role: w.role || w.key || roleOf(w.id),
        dir: '素材库/PBR/' + w.id,
        maps,
        thumb: thumb ? '素材库/PBR/' + w.id + '/' + thumb : null,
        bytes: r.bytes,
        license: 'CC0 1.0 Universal (ambientCG)',
        source: 'https://ambientcg.com/view?id=' + w.id,
        attribution: null,
        tags: w.tags || [],
      };
      fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify(rec, null, 2), 'utf8');
      fs.writeFileSync(path.join(pbrDir(outDir), 'index.json'),
        JSON.stringify({ generatedAt: new Date().toISOString(), res: RES, items: index.concat(rec) }, null, 2), 'utf8');
      index.push(rec);
      console.log(`✓ ${(r.bytes / 1048576).toFixed(1)}MB ${Object.keys(maps).length} 张贴图`);
    } catch (e) {
      console.log('✗ ' + (e && e.message));
    }
    await sleep(250);   // 温和一点，别把人家站点打挂
  }

  fs.writeFileSync(path.join(pbrDir(outDir), 'index.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), res: RES, items: index }, null, 2), 'utf8');
  console.log(`\n✓ 存了 ${index.length} 个材质 → ${pbrDir(outDir)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
