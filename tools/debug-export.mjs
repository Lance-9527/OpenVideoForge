#!/usr/bin/env node
/* 诊断：OSM 场景为什么进不了 Blender */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const e = window.__wb.editor;
  const out = { envChildren: e.envGroup.children.length, childNames: [] };
  for (const c of e.envGroup.children) {
    out.childNames.push({ name: c.name || '(组)', type: c.type, visible: c.visible, kids: c.children ? c.children.length : 0 });
  }
  // 逐个 mesh 看 visible / 三角形数
  out.meshes = [];
  e.envGroup.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const tris = (g && g.index ? g.index.count : (g && g.attributes.position ? g.attributes.position.count : 0)) / 3;
    out.meshes.push({ name: o.name || '(无名)', visible: o.visible, parentVisible: o.parent ? o.parent.visible : null,
      tris: Math.round(tris), hasColor: !!(g && g.attributes.color), hasNormal: !!(g && g.attributes.normal) });
  });
  // 试着导出
  try {
    const mod = await import('./js/vendor/GLTFExporter.js?v=60');
    const clone = e.envGroup.clone(true);
    const t0 = Date.now();
    const glb = await new mod.GLTFExporter().parseAsync(clone, { binary: true, onlyVisible: true });
    out.export = { ok: glb instanceof ArrayBuffer, bytes: glb instanceof ArrayBuffer ? glb.byteLength : 0, ms: Date.now() - t0 };
  } catch (err) {
    out.export = { ok: false, error: String(err && err.message || err) };
  }
  return out;
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
