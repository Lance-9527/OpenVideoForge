#!/usr/bin/env node
/* 查 raw.json 里到底有没有黄浦江的面 */
import fs from 'node:fs';
const f = `${defaultOutDir()}\\osm-cache\\31.23360_121.47990_2500.raw.json`;
const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
const els = raw.elements || [];
console.log('总 elements:', els.length);
const isWater = (t) => t.waterway || t.natural === 'water' || t.water || t.landuse === 'reservoir' || t.landuse === 'basin';
const w = els.filter((e) => isWater(e.tags || {}));
console.log('水系相关:', w.length);
const byTag = {};
for (const e of w) {
  const t = e.tags || {};
  const k = `${t.waterway ? 'waterway=' + t.waterway : ''} ${t.natural ? 'natural=' + t.natural : ''} ${t.water ? 'water=' + t.water : ''} ${t.landuse ? 'landuse=' + t.landuse : ''} ${e.type}`.trim();
  byTag[k] = (byTag[k] || 0) + 1;
}
console.log(JSON.stringify(byTag, null, 1));
const sizes = w.map((e) => {
  const t = e.tags || {};
  const g = e.geometry || [];
  const closed = g.length > 2 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
  return {
    type: e.type, id: e.id, n: g.length, closed,
    members: e.members ? e.members.length : 0,
    tag: t.waterway || t.natural || t.water || t.landuse,
    name: t.name || null,
  };
}).sort((a, b) => (b.members || 0) - (a.members || 0) || b.n - a.n).slice(0, 10);
console.log('最大的水体要素:'); console.log(JSON.stringify(sizes, null, 1));
