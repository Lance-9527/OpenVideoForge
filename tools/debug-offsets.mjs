#!/usr/bin/env node
/* 量 envGroup / built.group / mesh 的位置偏移链 */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const e = window.__wb.editor;
  const V = (x,y,z)=>[+x.toFixed(2),+y.toFixed(2),+z.toFixed(2)];
  const chain = [];
  let o = e.envGroup;
  while (o) {
    chain.push({ name: o.name || o.type, pos: V(o.position.x,o.position.y,o.position.z),
                 scale: V(o.scale.x,o.scale.y,o.scale.z), rotY: +(o.rotation.y*180/Math.PI).toFixed(1) });
    o = o.parent;
  }
  // 找一个 buildings mesh，比较"世界坐标"和"clone 后的局部坐标"
  let b = null;
  e.envGroup.traverse(x => { if (x.name === 'osm-buildings') b = x; });
  const clone = e.envGroup.clone(true);
  let bc = null;
  clone.traverse(x => { if (x.name === 'osm-buildings') bc = x; });
  const wb = new (await import('three')).Box3();
  if (b) { b.geometry.computeBoundingBox(); wb.copy(b.geometry.boundingBox).applyMatrix4(b.matrixWorld); }
  const wbc = new (await import('three')).Box3();
  if (bc) { bc.geometry.computeBoundingBox(); wbc.copy(bc.geometry.boundingBox).applyMatrix4(bc.matrixWorld); }
  return { chain,
    envGroupPos: V(e.envGroup.position.x,e.envGroup.position.y,e.envGroup.position.z),
    builtGroupPos: e._cityState && e._cityState.group ? V(e._cityState.group.position.x,e._cityState.group.position.y,e._cityState.group.position.z) : null,
    worldBox: b ? { min: V(wb.min.x,wb.min.y,wb.min.z), max: V(wb.max.x,wb.max.y,wb.max.z) } : null,
    cloneBox: bc ? { min: V(wbc.min.x,wbc.min.y,wbc.min.z), max: V(wbc.max.x,wbc.max.y,wbc.max.z) } : null,
    target: V(e.target.x,e.target.y,e.target.z), camPos: V(e.camera.position.x,e.camera.position.y,e.camera.position.z) };
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
