#!/usr/bin/env node
/* 查 world.json 里哪个水体跑到 -80km */
import fs from 'node:fs';
const f = `${defaultOutDir()}\\osm-cache\\31.23360_121.47990_2500.world.json`;
const w = JSON.parse(fs.readFileSync(f, 'utf8'));
console.log('waters:', w.waters.length);
const list = w.waters.map((it, i) => {
  const xs = it.ring.map((p) => p.x), zs = it.ring.map((p) => p.z);
  return {
    i, via: it.via || 'area', kind: it.kind, n: it.ring.length,
    minX: Math.round(Math.min(...xs)), maxX: Math.round(Math.max(...xs)),
    minZ: Math.round(Math.min(...zs)), maxZ: Math.round(Math.max(...zs)),
    spanX: Math.round(Math.max(...xs) - Math.min(...xs)),
    y: it.y != null ? +it.y.toFixed(2) : null,
  };
}).sort((a, b) => b.spanX - a.spanX);
console.log('最大的 8 个水体:');
console.log(JSON.stringify(list.slice(0, 8), null, 1));
const far = list.filter((x) => x.minX < -20000 || x.maxX > 20000);
console.log('跑飞的:', JSON.stringify(far, null, 1));
