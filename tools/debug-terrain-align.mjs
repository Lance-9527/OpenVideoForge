#!/usr/bin/env node
/* 诊断：地形高程和建筑地基是不是同一个基准（上海应该是平原 ~3m，不该有 75m 的山） */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const e = window.__wb.editor;
  const THREE = await import('three');
  const out = { env: e.envId, envSize: e.envSize };
  // 地形网格
  let terrain = null;
  e.envGroup.traverse(o => { if (o.name === 'osm-terrain') terrain = o; });
  if (terrain) {
    terrain.geometry.computeBoundingBox();
    const b = terrain.geometry.boundingBox;
    out.terrain = { min: b.min.toArray().map(v=>Math.round(v)), max: b.max.toArray().map(v=>Math.round(v)) };
    // 采样地形网格的 Y 分布
    const pos = terrain.geometry.attributes.position;
    let ys = [];
    for (let i = 0; i < pos.count; i += Math.max(1, Math.floor(pos.count/400))) ys.push(pos.getY(i));
    ys.sort((a,b)=>a-b);
    out.terrainY = { min: Math.round(ys[0]), p25: Math.round(ys[Math.floor(ys.length*0.25)]),
      median: Math.round(ys[Math.floor(ys.length*0.5)]), p75: Math.round(ys[Math.floor(ys.length*0.75)]),
      max: Math.round(ys[ys.length-1]) };
  }
  // 建筑底部
  let buildings = null;
  e.envGroup.traverse(o => { if (o.name === 'osm-buildings') buildings = o; });
  if (buildings) {
    buildings.geometry.computeBoundingBox();
    const b = buildings.geometry.boundingBox;
    out.buildings = { min: b.min.toArray().map(v=>Math.round(v)), max: b.max.toArray().map(v=>Math.round(v)) };
  }
  // 楼群中心处的地形高度（用采样器）
  const sampler = e._cityState && e._cityState.sampler;
  if (sampler) {
    const cx = e.target.x, cz = e.target.z;
    out.sampleAtTarget = Math.round(sampler(cx, cz));
    out.sampleRing = [];
    for (const d of [0, 200, 400, 600, 900]) {
      out.sampleRing.push([d, Math.round(sampler(cx + d, cz)), Math.round(sampler(cx, cz + d))]);
    }
  }
  out.terrainStats = e.terrainStats;
  out.target = [Math.round(e.target.x), Math.round(e.target.y), Math.round(e.target.z)];
  return out;
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
