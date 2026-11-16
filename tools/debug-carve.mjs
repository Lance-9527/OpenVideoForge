#!/usr/bin/env node
/* 精确验证：carveTerrainUnderWater 有没有把江里的地形压下去 */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const e = window.__wb.editor;
  const THREE = await import('three');
  let w=null, t=null;
  e.envGroup.traverse(o=>{ if(o.name==='osm-waters') w=o; if(o.name==='osm-terrain') t=o; });
  const out = {};
  if (!w || !t) return { error: '没有 waters 或 terrain' };
  const wp = w.geometry.attributes.position;
  const tp = t.geometry.attributes.position;
  // 水面所有顶点的 y（应全相同）
  const wy = new Set();
  for (let i=0;i<wp.count;i++) wy.add(+wp.getY(i).toFixed(2));
  out.waterYLevels = [...wy].slice(0,5);
  // 取水面上一个离 target 最近的顶点，找它下面的地形顶点高度
  let best=-1, bd=Infinity;
  for (let i=0;i<wp.count;i++){
    const x=wp.getX(i), z=wp.getZ(i);
    const d=Math.hypot(x-e.target.x, z-e.target.z);
    if (d<bd){bd=d;best=i;}
  }
  const bx=wp.getX(best), bz=wp.getZ(best);
  out.nearestWaterPoint={x:Math.round(bx),z:Math.round(bz),dist:Math.round(bd),y:+wp.getY(best).toFixed(2)};
  // 找最近的地形顶点
  let ti=-1, td=Infinity;
  for (let i=0;i<tp.count;i++){
    const d=Math.hypot(tp.getX(i)-bx, tp.getZ(i)-bz);
    if (d<td){td=d;ti=i;}
  }
  out.nearestTerrain={dist:+td.toFixed(1), y:+tp.getY(ti).toFixed(2)};
  // 地形 Y 分布（看有没有被压低的）
  const ys=[];
  for (let i=0;i<tp.count;i++) ys.push(tp.getY(i));
  ys.sort((a,b)=>a-b);
  out.terrainY={min:+ys[0].toFixed(2),p05:+ys[Math.floor(ys.length*0.05)].toFixed(2),
    p50:+ys[Math.floor(ys.length*0.5)].toFixed(2),max:+ys[ys.length-1].toFixed(2)};
  out.terrainVerts = tp.count;
  // 水面点是不是在"水面之下"（被地形挡）
  out.waterBelowTerrain = tp.getY(ti) > wp.getY(best);
  return out;
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
