/**
 * build.mjs — 由 data/*.js 生成 server/cities.json
 * 1) 结构校验（id 唯一 / 命名规范 / 坐标范围 / aliases 非空 / 中文名）
 * 2) 输出 lat、lng 固定 4 位小数（WGS84 / EPSG:4326 城市中心）
 *
 * 用法: node build.mjs [--out <path>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeCities } from './io.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(HERE, 'data');
const OUT = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : path.resolve(HERE, '..', '..', 'server', 'cities.json');

const REGIONS = ['china.js', 'asia.js', 'europe.js', 'americas.js', 'africa-oceania.js'];

const raw = [];
for (const f of REGIONS) {
  const mod = await import(pathToFileURL(path.join(DATA_DIR, f)).href);
  const rows = mod.default;
  if (!Array.isArray(rows)) throw new Error(`${f} 未导出数组`);
  for (const r of rows) raw.push({ region: f, row: r });
}

// ---------------- 校验 ----------------
const errors = [];
const seenId = new Set();
const seenName = new Set();
const CJK = /[\u4e00-\u9fff]/;

for (const { region, row } of raw) {
  const tag = `${region}: ${JSON.stringify(row)}`;
  if (!Array.isArray(row) || row.length !== 7) {
    errors.push(`字段数应为 7 -> ${tag}`);
    continue;
  }
  const [id, name, en, country, lat, lng, aliases] = row;

  if (typeof id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    errors.push(`id 不符合小写短横线规范 -> ${tag}`);
  }
  if (seenId.has(id)) errors.push(`id 重复: ${id}`);
  seenId.add(id);

  if (typeof name !== 'string' || !CJK.test(name)) errors.push(`name 非中文 -> ${tag}`);
  if (seenName.has(name)) errors.push(`name 重复: ${name}`);
  seenName.add(name);

  if (typeof en !== 'string' || !en.trim()) errors.push(`en 为空 -> ${tag}`);
  if (typeof country !== 'string' || !CJK.test(country)) errors.push(`country 非中文 -> ${tag}`);

  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    errors.push(`lat 越界或非法 -> ${tag}`);
  }
  if (typeof lng !== 'number' || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    errors.push(`lng 越界或非法 -> ${tag}`);
  }
  if (lat === 0 && lng === 0) errors.push(`坐标为 0,0（占位数据）-> ${tag}`);
  if (typeof lat === 'number' && Math.abs(lat) > 85) errors.push(`lat 极端值 -> ${tag}`);

  if (!Array.isArray(aliases) || aliases.length < 1) {
    errors.push(`aliases 至少 1 个 -> ${tag}`);
  } else {
    for (const a of aliases) {
      if (typeof a !== 'string' || !a.trim()) errors.push(`alias 非法 -> ${tag}`);
    }
  }
}

if (errors.length) {
  console.error(`校验失败，共 ${errors.length} 项:`);
  errors.forEach((e) => console.error('  - ' + e));
  process.exit(1);
}

// ---------------- 输出 ----------------
const cities = raw.map(({ row }) => {
  const [id, name, en, country, lat, lng, aliases] = row;
  return {
    id,
    name,
    en,
    country,
    lat: Number(lat.toFixed(4)),
    lng: Number(lng.toFixed(4)),
    aliases: aliases.slice(),
  };
});

// 输出（手写序列化，确保 lat/lng 在文件中固定 4 位小数）
writeCities(cities, OUT, 1);

console.log(`已生成: ${OUT}`);
console.log(`城市总数: ${cities.length}`);
console.log(`唯一 id: ${seenId.size} / 唯一中文名: ${seenName.size}`);
