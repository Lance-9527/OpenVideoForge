#!/usr/bin/env node
/* 把相机直接对准水体中心，看江到底在不在 */
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const e = window.__wb.editor;
  const out = {};
  let w=null; e.envGroup.traverse(o=>{ if(o.name==='osm-waters') w=o; });
  if (!w) return { error:'no waters' };
  const p = w.geometry.attributes.position;
  // 找**面积最大**的那块水体（江）
  const pts=[];
  for (let i=0;i<p.count;i++) pts.push([p.getX(i), p.getZ(i)]);
  let minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
  for (const [x,z] of pts){ if(x<minX)minX=x; if(x>maxX)maxX=x; if(z<minZ)minZ=z; if(z>maxZ)maxZ=z; }
  // 按 100m 网格找最密集的一块
  const bins = new Map();
  for (const [x,z] of pts){ const k = Math.round(x/100)+'_'+Math.round(z/100); bins.set(k,(bins.get(k)||0)+1); }
  let bestK=null, bestN=0;
  for (const [k,n] of bins) if (n>bestN){bestN=n;bestK=k;}
  const [bx,bz] = bestK.split('_').map(Number);
  out.densestCell = { x: bx*100, z: bz*100, verts: bestN };
  out.waterBox = { min:[Math.round(minX),Math.round(minZ)], max:[Math.round(maxX),Math.round(maxZ)] };
  out.waterVerts = p.count;
  // 相机对准这块
  e.target.set(bx*100, e.target.y, bz*100);
  e.sph.r = 900; e.sph.phi = 1.15; e.sph.theta = 0.6; e._applyCamera();
  await new Promise(r=>setTimeout(r,900));
  const url = e.captureThumb(1280,720);
  out.img = url ? url.split(',')[1] : null;
  return out;
`);
console.log(JSON.stringify({ ...r, img: r.img ? r.img.length + ' b64' : null }, null, 1));
if (r.img) fs.writeFileSync(`${defaultShotsDir()}\\HUANGPU-river.jpg`, Buffer.from(r.img, 'base64'));
await cdp.close();
