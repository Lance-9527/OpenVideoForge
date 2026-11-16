#!/usr/bin/env node
/* ============================================================================
 * tests/geocode.mjs —— 城市名 → 经纬度（地名解析）+ 本地城市表质量
 *
 * 覆盖：
 *   ① server/cities.json 存在且够大（≥180 城市）
 *   ② 每个条目字段齐全、坐标在合法范围、id 唯一
 *   ③ 中文名 / 英文名 / 别名 都能查到（模糊匹配：完全→前缀→包含）
 *   ④ 查不到时给的是**建议**而不是死路
 *   ⑤ Photon 兜底路径可用（网络允许时）
 * ========================================================================== */
import { defaultOutDir } from '../server/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { findLocal, searchLocal, cityTable, geocodeCity } from '../server/geocode.mjs';

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, e === undefined ? '' : '→ ' + JSON.stringify(e)); }
};

// ① 表存在且够大
console.log('\n1. 本地城市表');
const p = path.resolve('server/cities.json');
ok('★ cities.json 存在', fs.existsSync(p), p);
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
const cities = j.cities || [];
ok('★ 城市数 ≥ 180', cities.length >= 180, cities.length);
ok('★ version 字段有', !!j.version, j.version);

// ② 条目质量
console.log('\n2. 条目质量');
const bad = [];
for (const c of cities) {
  const why = [];
  if (!c.id || !/^[a-z0-9-]+$/.test(c.id)) why.push('id');
  if (!c.name) why.push('name');
  if (!c.en) why.push('en');
  if (typeof c.lat !== 'number' || Math.abs(c.lat) > 90) why.push('lat');
  if (typeof c.lng !== 'number' || Math.abs(c.lng) > 180) why.push('lng');
  if (!Array.isArray(c.aliases) || !c.aliases.length) why.push('aliases');
  if (why.length) bad.push({ id: c.id, why });
}
ok('★ 所有条目字段齐全且坐标合法', bad.length === 0, bad.slice(0, 5));
const ids = new Set(cities.map((c) => c.id));
ok('★ id 全局唯一', ids.size === cities.length, cities.length - ids.size);

// ③ 匹配
console.log('\n3. 名称匹配');
const cases = [
  ['北京', 'beijing'], ['上海', 'shanghai'], ['京都', 'kyoto'], ['雷克雅未克', 'reykjavik'],
  ['巴黎', 'paris'], ['纽约', 'new-york'], ['东京', 'tokyo'], ['伦敦', 'london'],
];
for (const [q, expectId] of cases) {
  const hit = findLocal(q);
  ok(`★ 中文「${q}」查到`, !!hit && hit.id === expectId, hit ? hit.id : '没查到');
}
const enCases = [['Kyoto', 'kyoto'], ['Berlin', 'berlin'], ['Reykjavik', 'reykjavik'], ['Paris', 'paris']];
for (const [q, expectId] of enCases) {
  const hit = findLocal(q);
  ok(`★ 英文「${q}」查到`, !!hit && hit.id === expectId, hit ? hit.id : '没查到');
}
ok('★ 别名能查到（北京 → 北平）', (() => { const h = findLocal('北平'); return !!h && h.id === 'beijing'; })(), (findLocal('北平') || {}).id);
ok('★ 搜索建议能出（"京"）', searchLocal('京', 20).length >= 2, searchLocal('京', 20).length);
ok('★ 查不到返回 null（不瞎猜）', findLocal('不存在的城市名xyz') === null, findLocal('不存在的城市名xyz'));

// ④ 端到端 geocodeCity
console.log('\n4. geocodeCity 端到端');
const OUT = defaultOutDir();
for (const q of ['北京', 'Kyoto', '雷克雅未克']) {
  const r = await geocodeCity(q, OUT);
  ok(`★ 「${q}」返回坐标`, r.ok && Number.isFinite(r.city.lat) && Number.isFinite(r.city.lng),
    r.ok ? r.city : r.error);
}
// 乱码/空
const empty = await geocodeCity('', OUT);
ok('★ 空输入报错', empty.ok === false, empty);
const junk = await geocodeCity('zzzz不存在的城市qqqq', OUT);
ok('★ 查不到给的是**建议**不是死路', junk.ok === false && /试试|想找|英文名/.test(junk.error || ''), junk.error);

// ⑤ Photon 兜底（网络允许时）
console.log('\n5. Photon 兜底（网络允许时）');
const online = await geocodeCity('Kyoto', OUT, { forceOnline: true });
if (online.ok) {
  ok('★ Photon 查得到（source=' + online.city.source + '）', Number.isFinite(online.city.lat), online.city);
} else {
  console.log('  · 网络不通，跳过（不影响本地表路径）');
}

console.log(`\n${fail ? '✗' : '✓'} geocode: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
