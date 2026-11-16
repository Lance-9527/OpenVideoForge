#!/usr/bin/env node
/* 核对：原始 Overpass 的建筑数 → 我们解析出来的数，差在哪 */
import { defaultShotsDir } from '../server/paths.mjs';
import fs from 'node:fs';
import { normalizeOsm } from '../js/worldgen/osm-parse.js';

const dir = defaultShotsDir();
const f = fs.readdirSync(dir).find((x) => x.startsWith('overpass-当前用的'));
const raw = JSON.parse(fs.readFileSync(dir + '\\' + f, 'utf8'));
console.log('原始文件:', f, ' elements:', raw.elements.length);

// 原始里有多少"带 building tag"
const tagged = raw.elements.filter((e) => e.tags && e.tags.building);
console.log('带 building tag 的:', tagged.length);
const byType = {};
for (const e of tagged) byType[e.type] = (byType[e.type] || 0) + 1;
console.log('  按类型:', JSON.stringify(byType));

// 几何不足的
const noGeom = tagged.filter((e) => !Array.isArray(e.geometry) || e.geometry.length < 2);
console.log('  几何不足 2 点的:', noGeom.length);
for (const e of noGeom.slice(0, 8)) {
  console.log('    ', e.type, e.id, JSON.stringify(e.tags).slice(0, 90), 'members=', (e.members || []).length);
}
// relation 的 members
const rels = tagged.filter((e) => e.type === 'relation');
console.log('relation 个数:', rels.length);
for (const r of rels) {
  console.log('   relation', r.id, 'tags=', JSON.stringify(r.tags).slice(0, 70),
    'members=', (r.members || []).length,
    'memberRoles=', (r.members || []).map((m) => m.role).join(','));
}

// 跑我们的 normalize
const out = normalizeOsm(raw, { lat: 31.2336, lng: 121.4799 }, {});
console.log('\nnormalize 后: buildings =', out.buildings.length,
  ' roads =', out.roads.length, ' waters =', out.waters.length,
  ' greens =', out.greens.length, ' trees =', out.trees.length,
  ' skipped =', out.skipped);
console.log('其中 via relation 的:', out.buildings.filter((b) => b.via === 'relation').length);
