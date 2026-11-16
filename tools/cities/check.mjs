/** check.mjs — 交付文件终检 */
import fs from 'node:fs';

const p = 'D:/KnowledgeVault/projects/openvideoforge/server/cities.json';
const raw = fs.readFileSync(p, 'utf8');
const d = JSON.parse(raw);
const c = d.cities;

console.log(`JSON 合法 ✓  version=${d.version}  cities=${c.length}`);

// lat/lng 是否固定 4 位小数（逐行检查文本）
const lines = raw.split('\n');
let bad = [];
for (const x of c) {
  const line = lines.find((l) => l.includes(`"id": "${x.id}"`));
  if (!line || !/"lat": -?\d+\.\d{4}, "lng": -?\d+\.\d{4},/.test(line)) bad.push(x.id);
}
console.log(`lat/lng 固定 4 位小数: ${bad.length === 0 ? '✓ 全部合规' : '✗ ' + bad.slice(0, 5).join(',')}`);

console.log(`字段完整: ${c.every((x) => x.id && x.name && x.en && x.country && typeof x.lat === 'number' && typeof x.lng === 'number' && Array.isArray(x.aliases) && x.aliases.length >= 1) ? '✓' : '✗'}`);
console.log(`lat ∈ [-90,90]: ${c.every((x) => x.lat >= -90 && x.lat <= 90) ? '✓' : '✗'}   lng ∈ [-180,180]: ${c.every((x) => x.lng >= -180 && x.lng <= 180) ? '✓' : '✗'}`);
console.log(`id 唯一: ${new Set(c.map((x) => x.id)).size === c.length ? '✓' : '✗'}   name 唯一: ${new Set(c.map((x) => x.name)).size === c.length ? '✓' : '✗'}`);
console.log(`id 小写短横线: ${c.every((x) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(x.id)) ? '✓' : '✗'}`);
console.log(`name/country 为中文: ${c.every((x) => /[\u4e00-\u9fff]/.test(x.name) && /[\u4e00-\u9fff]/.test(x.country)) ? '✓' : '✗'}`);
console.log(`aliases ≥1: ${c.every((x) => x.aliases.length >= 1) ? '✓' : '✗'}  (平均 ${(c.reduce((a, x) => a + x.aliases.length, 0) / c.length).toFixed(1)} 个)`);

const byCountry = {};
for (const x of c) byCountry[x.country] = (byCountry[x.country] || 0) + 1;
console.log(`国家覆盖 ${Object.keys(byCountry).length} 个: ${Object.entries(byCountry).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', ')}`);
console.log(`文件大小: ${fs.statSync(p).size} bytes`);

const rep = JSON.parse(fs.readFileSync('D:/KnowledgeVault/projects/openvideoforge/tools/cities/report.json', 'utf8'));
console.log('\n--- report.json ---');
console.log(JSON.stringify({ counts: rep.counts, deviation: rep.deviation, sources: rep.sources, confirmed: rep.confirmed, corrected: rep.corrected, unverified: rep.unverified }, null, 1));

console.log('\n--- 前 5 个城市 ---');
for (const x of c.slice(0, 5)) console.log(JSON.stringify(x));
