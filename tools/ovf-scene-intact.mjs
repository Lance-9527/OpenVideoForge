import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const CHECK = `
  const e = window.__wb.editor;
  let visible = 0, meshes = 0;
  const geoms = new Set();
  for (const o of (e.objects || [])) {
    o.group.traverse(n => { if (n.isMesh) { meshes++; if (n.geometry) geoms.add(n.geometry.uuid); } });
    if (o.group.visible && o.group.parent) visible++;
  }
  return {
    objects: (e.objects || []).length,
    visible: visible,
    meshes: meshes,
    uniqueGeometries: geoms.size,
    assetIds: (e.objects || []).map(o => o.assetId)
  };
`;

const SETUP = `
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'room' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  return true;
`;

const ADD = `
  const e = window.__wb.editor;
  for (const id of ['tree','car-sedan','person-stand']) { try { e.addAsset(id); } catch(_){} }
  return true;
`;

const RENDER_THUMBS = `
  const e = window.__wb.editor;
  const out = [];
  for (const o of (e.objects || [])) {
    const u = e.renderThumbOf(o.group, 256);
    out.push({ id: o.assetId, bytes: u ? u.length : 0 });
  }
  return out;
`;

await cdp.eval(SETUP);
await wait(3500);
await cdp.eval(ADD);
await wait(1500);

const before = await cdp.eval(CHECK);
console.log('[渲染缩略图前]', JSON.stringify(before));

const thumbRes = await cdp.eval(RENDER_THUMBS);
console.log('[缩略图]', JSON.stringify(thumbRes));
await wait(1200);

const after = await cdp.eval(CHECK);
console.log('[渲染缩略图后]', JSON.stringify(after));

await cdp.screenshot(`${defaultShotsDir()}\\X1-scene-intact.png`);
console.log('[shot] X1');

const intact = after.objects === before.objects
  && after.visible === before.visible
  && after.meshes === before.meshes
  && after.uniqueGeometries === before.uniqueGeometries;
console.log(intact
  ? '✓ 场景物体完好（clone 渲染缩略图没毁掉原物体）'
  : '✗ 场景物体被弄坏了');

await cdp.close();
process.exit(intact ? 0 : 1);
