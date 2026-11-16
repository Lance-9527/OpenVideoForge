#!/usr/bin/env node
/* 量：① 缩放有没有破坏真实比例 ② 黄浦江（水面）在哪 */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const e = window.__wb.editor;
  const THREE = await import('three');
  const out = {};
  const bb = (m) => { if(!m) return null; m.geometry.computeBoundingBox(); const x=m.geometry.boundingBox;
    return { min:x.min.toArray().map(v=>Math.round(v)), max:x.max.toArray().map(v=>Math.round(v)) }; };
  for (const name of ['osm-buildings','osm-roads','osm-waters','osm-terrain','osm-greens']) {
    let m=null; e.envGroup.traverse(o=>{ if(o.name===name) m=o; });
    out[name] = bb(m);
  }
  // envGroup / built.group 的 scale
  out.envGroupScale = [e.envGroup.scale.x, e.envGroup.scale.y, e.envGroup.scale.z];
  out.envGroupPos = [e.envGroup.position.x, e.envGroup.position.y, e.envGroup.position.z];
  out.sceneScale = e.sceneScale || null;
  out.worldSize = e._citySize;
  out.planSize = e._cityState && e._cityState.plan ? e._cityState.plan.size : null;
  out.planBounds = e._cityState && e._cityState.plan ? e._cityState.plan.bounds : null;
  // 水面中心（黄浦江应该是一条带）
  let waters=null; e.envGroup.traverse(o=>{ if(o.name==='osm-waters') waters=o; });
  if (waters) {
    const pos = waters.geometry.attributes.position;
    const xs=[], zs=[];
    for (let i=0;i<pos.count;i+=Math.max(1,Math.floor(pos.count/200))) { xs.push(pos.getX(i)); zs.push(pos.getZ(i)); }
    out.waterSamples = { n: xs.length, xMin:Math.round(Math.min(...xs)), xMax:Math.round(Math.max(...xs)),
      zMin:Math.round(Math.min(...zs)), zMax:Math.round(Math.max(...zs)) };
    out.waterTris = (waters.geometry.index?waters.geometry.index.count:pos.count)/3;
    out.waterVisible = waters.visible;
    out.waterMatColor = waters.material && waters.material.color ? '#'+waters.material.color.getHexString() : null;
  }
  out.target = [Math.round(e.target.x), Math.round(e.target.y), Math.round(e.target.z)];
  out.r = Math.round(e.sph.r);
  return out;
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
