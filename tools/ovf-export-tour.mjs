import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = `
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  window.dispatchEvent(new Event('resize'));
  return true;
`;

const SCENE = `
  const e = window.__wb.editor;
  const put = (aid, x, z) => { const r = e.addAsset(aid); if (r && r.group) { r.group.position.set(x,0,z); r.group.scale.setScalar(1.6); } };
  put('tree', -3, 0); put('car-sedan', 0, 0); put('person-stand', 3, 0);
  e.sph.r = 18; e.sph.phi = 1.2; e.sph.theta = 0.55; e._applyCamera();
  return e.objects.length;
`;

const STATS = `
  const e = window.__wb.editor;
  let meshes = 0; const geoms = new Set();
  for (const o of (e.objects||[])) o.group.traverse(n=>{ if(n.isMesh){meshes++; if(n.geometry) geoms.add(n.geometry.uuid);} });
  return { objects:(e.objects||[]).length, meshes, geoms: geoms.size,
           bg: e.scene.background && e.scene.background.isColor ? e.scene.background.getHexString() : 'not-color',
           env: !!e.scene.environment,
           sunI: e.sun ? e.sun.intensity : null,
           hemiI: e.hemi ? e.hemi.intensity : null };
`;

await cdp.eval(SETUP);
await wait(3500);
await cdp.eval(SCENE);
await wait(2000);

const before = await cdp.eval(STATS);
console.log('[出图前]', JSON.stringify(before));

// ① 白膜出图（真实感关）
const clay = await cdp.eval(`
  window.__studioPip.setReal(false);
  await new Promise(r=>setTimeout(r,600));
  const e = window.__wb.editor;
  const url = e.captureThumb(320, 180);
  return { len: url ? url.length : 0, head: url ? url.slice(0, 30) : null };
`);
console.log('[白膜出图]', JSON.stringify(clay));

// ② 真实感出图
const real = await cdp.eval(`
  const list = await (await fetch('http://127.0.0.1:8787/hdri/list')).json();
  const it = (list.items||[]).find(i=>i.slot==='sunset');
  await window.__studioPip.setHdri(it.id);
  await window.__studioPip.setReal(true);
  window.__studioPip.setLook({ proc: { on: true }, hdriBg: false });
  await new Promise(r=>setTimeout(r,3500));
  const e = window.__wb.editor;
  const url = e.captureThumb(320, 180);
  return { len: url ? url.length : 0, hdri: it.id };
`);
console.log('[真实感出图]', JSON.stringify(real));

// 把出图存下来对比
const shots = await cdp.eval(`
  const e = window.__wb.editor;
  const realUrl = e.captureThumb(320, 180);
  window.__studioPip.setReal(false);
  await new Promise(r=>setTimeout(r,900));
  const clayUrl = e.captureThumb(320, 180);
  window.__studioPip.setReal(true);
  return { real: realUrl, clay: clayUrl };
`);
const saveData = (name, dataUrl) => {
  if (!dataUrl) return;
  const b = Buffer.from(dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(`${OUT}\\${name}.jpg`, b);
  console.log('[save]', name, b.length, 'bytes');
};
saveData('Y1-export-real', shots.real);
saveData('Y2-export-clay', shots.clay);

const after = await cdp.eval(STATS);
console.log('[出图后]', JSON.stringify(after));

const clean = after.objects === before.objects && after.meshes === before.meshes
  && after.geoms === before.geoms && after.bg === before.bg && after.env === before.env
  && after.sunI === before.sunI && after.hemiI === before.hemiI;
console.log(clean ? '✓ 出图后场景完全还原（背景/环境贴图/灯光/物体都没变）' : '✗ 出图后场景被污染了');
console.log('  前:', JSON.stringify(before));
console.log('  后:', JSON.stringify(after));

await cdp.close();
