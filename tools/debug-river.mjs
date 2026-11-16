#!/usr/bin/env node
/* 精确诊断黄浦江为什么看不见 */
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const e = window.__wb.editor;
  const THREE = await import('three');
  const out = {};
  let w=null, t=null;
  e.envGroup.traverse(o=>{ if(o.name==='osm-waters') w=o; if(o.name==='osm-terrain') t=o; });
  if (w) {
    const pos = w.geometry.attributes.position;
    const col = w.geometry.attributes.color;
    out.water = { verts: pos.count, hasColor: !!col,
      color0: col ? [col.getX(0),col.getY(0),col.getZ(0)].map(v=>+v.toFixed(2)) : null,
      matColor: '#'+w.material.color.getHexString(),
      vertexColors: w.material.vertexColors };
    // 每个三角形的水位（y）
    const ys=[];
    for (let i=0;i<pos.count;i+=Math.max(3,Math.floor(pos.count/300))) ys.push(+pos.getY(i).toFixed(2));
    ys.sort((a,b)=>a-b);
    out.waterY = { min: ys[0], p50: ys[Math.floor(ys.length*0.5)], max: ys[ys.length-1] };
    // 江在 target 的哪个方向？
    w.geometry.computeBoundingBox();
    const b=w.geometry.boundingBox;
    const wc={x:(b.min.x+b.max.x)/2, z:(b.min.z+b.max.z)/2};
    out.waterCenter=[Math.round(wc.x),Math.round(wc.z)];
    out.target=[Math.round(e.target.x),Math.round(e.target.z)];
    out.distToTarget=Math.round(Math.hypot(wc.x-e.target.x, wc.z-e.target.z));
    // 江边最近的楼
    out.waterBox={min:[Math.round(b.min.x),Math.round(b.min.z)],max:[Math.round(b.max.x),Math.round(b.max.z)]};
  }
  if (t) {
    const pos=t.geometry.attributes.position;
    let ys=[];
    for (let i=0;i<pos.count;i+=Math.max(1,Math.floor(pos.count/300))) ys.push(pos.getY(i));
    ys.sort((a,b)=>a-b);
    out.terrainY={min:+ys[0].toFixed(2),p50:+ys[Math.floor(ys.length*0.5)].toFixed(2),max:+ys[ys.length-1].toFixed(2)};
  }
  // 相机
  out.cam=[Math.round(e.camera.position.x),Math.round(e.camera.position.y),Math.round(e.camera.position.z)];
  out.sph={r:Math.round(e.sph.r),phi:+e.sph.phi.toFixed(2),theta:+e.sph.theta.toFixed(2)};

  // ★ 正上方俯视图（看江到底在不在）
  e.sph.r = 3500; e.sph.phi = 0.02; e.sph.theta = 0; e._applyCamera();
  await new Promise(r=>setTimeout(r,700));
  const url = e.captureThumb(1280,720);
  out.top = url ? url.split(',')[1] : null;
  return out;
`);
console.log(JSON.stringify({ ...r, top: r.top ? r.top.length + ' b64' : null }, null, 1));
if (r.top) fs.writeFileSync(`${defaultShotsDir()}\\HUANGPU-top.jpg`, Buffer.from(r.top, 'base64'));
await cdp.close();
