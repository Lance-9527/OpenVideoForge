#!/usr/bin/env node
/* ============================================================================
 * tests/osm-river.mjs —— 真实世界的水体：水平面 + 江床挖低
 *
 * 覆盖（2026-11-10 实测踩到的）：
 *   ① 水面必须是**水平面**（之前按地形逐顶点抬升 ⇒ 江跟着地形起伏、被地形盖住）
 *   ② 地形要在水域下面挖低（造江床），否则水面被地形遮住 ⇒ 整条江看不见
 *   ③ 绿地仍然跟着地形起伏（贴地）
 * ========================================================================== */
import * as THREE from 'three';
import { buildOsm } from '../js/worldgen/osm.js';

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, e === undefined ? '' : '→ ' + JSON.stringify(e)); }
};

// ── 造一个合成世界：一片 1000×1000 的地，中间一条 200m 宽的河 ──────────
const terrainGrid = {
  size: 21, step: 50, minX: -500, minZ: -500,
  values: [],
  minH: 0, maxH: 0,
};
// 地形：中间一条河谷（x ∈ [-100,100] 高度低），两侧高
for (let j = 0; j < terrainGrid.size; j++) {
  for (let i = 0; i < terrainGrid.size; i++) {
    const x = -500 + i * 50, z = -500 + j * 50;
    const h = Math.abs(x) < 100 ? 1 : 12;    // 河谷 1m，两岸 12m
    terrainGrid.values.push(h);
  }
}
terrainGrid.minH = 1; terrainGrid.maxH = 12;

// 一条 200m 宽的河（矩形多边形，z ∈ [-700,-400] 横穿）
const riverRing = [
  { x: -100, z: -700 }, { x: 100, z: -700 }, { x: 100, z: -400 }, { x: -100, z: -400 },
  { x: -100, z: -700 },
];
const world = {
  kind: 'osm',
  origin: { lat: 0, lng: 0 },
  attribution: 'test',
  buildings: [
    { ring: [{ x: 300, z: -600 }, { x: 400, z: -600 }, { x: 400, z: -500 }, { x: 300, z: -500 }, { x: 300, z: -600 }], height: 12, color: 0xd9d6cd, kind: 'yes', name: null, area: 10000 },
  ],
  roads: [],
  waters: [{ ring: riverRing, color: 0x9fb8c8, kind: 'river' }],
  greens: [{ ring: [{ x: -400, z: -600 }, { x: -300, z: -600 }, { x: -300, z: -500 }, { x: -400, z: -500 }, { x: -400, z: -600 }], color: 0xbcc7a8, kind: 'grass' }],
  trees: [],
  bounds: { minX: -500, maxX: 500, minZ: -700, maxZ: -400, maxH: 12 },
  cityBounds: { minX: -500, maxX: 500, minZ: -700, maxZ: -400, maxH: 12 },
  size: 1000, citySize: 1000,
  stats: { buildings: 1, roads: 0, waters: 1, greens: 1, trees: 0, skipped: 0, tallest: 12, elements: 3 },
};

const built = buildOsm(world, { terrain: terrainGrid });
const g = built.group;
const byName = {};
g.traverse((o) => { if (o.isMesh) byName[o.name] = o; });

console.log('1. 水面');
const w = byName['osm-waters'];
ok('★ 有水面网格', !!w);
if (w) {
  const p = w.geometry.attributes.position;
  const ys = new Set();
  for (let i = 0; i < p.count; i++) ys.add(+p.getY(i).toFixed(3));
  ok('★ 水位是**水平面**（所有顶点同高）', ys.size === 1, [...ys]);
  const wY = [...ys][0];
  console.log('     水位 =', wY, 'm');
  ok('★ 水位低于岸上地面（12m）', wY > 6 && wY < 12, wY);

  console.log('2. 江床挖低');
  const t = byName['osm-terrain'];
  ok('★ 有地形网格', !!t);
  if (t) {
    const tp = t.geometry.attributes.position;
    // 找河中央（x≈0）的地形顶点高度，和岸上（x=300）比
    let inRiver = null, onBank = null;
    for (let i = 0; i < tp.count; i++) {
      const x = tp.getX(i), z = tp.getZ(i);
      if (z > -500 && z < -400) continue;
      if (Math.abs(x) < 30 && inRiver === null) inRiver = tp.getY(i);
      if (x > 280 && x < 320 && onBank === null) onBank = tp.getY(i);
    }
    ok('★ 河中央地形被压到水位以下', inRiver !== null && inRiver < wY, { inRiver, wY });
    ok('★ 岸上地形没被动（仍是 12m）', onBank !== null && onBank > 10, { onBank });
  }
}

console.log('3. 绿地仍贴地');
const gr = byName['osm-greens'];
ok('★ 有绿地网格', !!gr);
if (gr) {
  const p = gr.geometry.attributes.position;
  const ys = new Set();
  for (let i = 0; i < p.count; i++) ys.add(+p.getY(i).toFixed(2));
  // 绿地要**跟着地形**（这里是岸上 12m，不是水面 1m）
  ok('★ 绿地贴在地面上（≈12m，不是水位）', [...ys].every((y) => y > 11), [...ys]);
}

console.log('4. 建筑地基');
const b = byName['osm-buildings'];
ok('★ 有建筑网格', !!b);
if (b) {
  const p = b.geometry.attributes.position;
  let minY = Infinity;
  for (let i = 0; i < p.count; i++) minY = Math.min(minY, p.getY(i));
  ok('★ 建筑站在地面上（y≈12，不是 0）', minY > 10, minY);
}

console.log(`\n${fail ? '✗' : '✓'} osm-river: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
