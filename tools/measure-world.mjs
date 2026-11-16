#!/usr/bin/env node
/* 量真实城市场景的实际包围盒（决定相机该怎么摆） */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const e = window.__wb.editor;
  const THREE = await import('three');
  const box = new THREE.Box3();
  const parts = [];
  e.scene.traverse(o => {
    if (!o.isMesh) return;
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
    const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    box.union(b);
    parts.push({ name: o.name || '(无名)', tris: (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3,
      min: b.min.toArray().map(v=>Math.round(v)), max: b.max.toArray().map(v=>Math.round(v)) });
  });
  const size = box.getSize(new THREE.Vector3());
  const ctr = box.getCenter(new THREE.Vector3());
  return { parts,
    min: box.min.toArray().map(v=>Math.round(v)),
    max: box.max.toArray().map(v=>Math.round(v)),
    size: size.toArray().map(v=>Math.round(v)),
    center: ctr.toArray().map(v=>Math.round(v)),
    envSize: e.envSize, envScale: e.envScale,
    worldSpec: e._worldSpec, envId: e.envId };
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
