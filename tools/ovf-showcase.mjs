import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function pipShot(name, scale = 3) {
  const dataUrl = await cdp.eval(`
    const c = document.querySelector('#pipCanvas');
    if (!c) return null;
    const t = document.createElement('canvas');
    t.width = c.width * ${scale}; t.height = c.height * ${scale};
    const g = t.getContext('2d'); g.imageSmoothingQuality='high';
    g.drawImage(c, 0, 0, t.width, t.height);
    return t.toDataURL('image/png');
  `);
  if (!dataUrl) { console.log('no pip'); return; }
  const f = `${OUT}\\${name}.png`;
  fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('[pip]', name, (fs.statSync(f).size/1024).toFixed(0)+'KB');
}

await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  return true;
`);
await wait(3500);

await cdp.eval(`
  const e = window.__wb.editor;
  for (const id of ['tree','tree','rock','car-sedan','person-stand','bench','hydrant','container','mailbox','parasol']) {
    try { e.addAsset(id); } catch(_){}
  }
  window.__studioPip.setReal(true);
  window.__studioPip.setLook({ proc: { on: true }, hdriBg: false });
  await new Promise(r=>setTimeout(r,2000));
`);
await wait(2000);

// ① 近景：看三平面纹理细节
const close = await cdp.eval(`
  const e = window.__wb.editor;
  e.sph.r = 9; e.sph.phi = 1.44; e.sph.theta = 0.6; e._applyCamera();
  await new Promise(r=>setTimeout(r,1500));
  return { r: e.sph.r, phi: e.sph.phi };
`);
console.log('[近景]', JSON.stringify(close));
await wait(1200);
await pipShot('Q1-三平面近景');

// ② 中景
const mid = await cdp.eval(`
  const e = window.__wb.editor;
  e.sph.r = 20; e.sph.phi = 1.3; e.sph.theta = 0.6; e._applyCamera();
  await new Promise(r=>setTimeout(r,1500));
  return true;
`);
await wait(1200);
await pipShot('Q2-三平面中景');

// ③ 加上 HDRI（黄昏）做成品图
const hdri = await cdp.eval(`
  const list = await (await fetch('http://127.0.0.1:8787/hdri/list')).json();
  const it = (list.items||[]).find(i=>i.slot==='sunset');
  await window.__studioPip.setHdri(it.id);
  await new Promise(r=>setTimeout(r,3000));
  const e = window.__wb.editor;
  e.sph.r = 26; e.sph.phi = 1.25; e._applyCamera();
  await new Promise(r=>setTimeout(r,1500));
  return { hdri: it.id, name: it.name };
`);
console.log('[加 HDRI]', JSON.stringify(hdri));
await wait(1500);
await pipShot('Q3-HDRI黄昏+程序化材质');

// ④ 城市全景
const city = await cdp.eval(`
  const e = window.__wb.editor;
  e.loadEnv('city', { size: 'medium' });
  await new Promise(r=>setTimeout(r,3000));
  window.__studioPip.setLook({ proc: { on: true }, hdriBg: false });
  await new Promise(r=>setTimeout(r,2000));
  e.sph.r = 40; e.sph.phi = 1.15; e._applyCamera();
  await new Promise(r=>setTimeout(r,1500));
  return { env: e.envId };
`);
console.log('[城市]', JSON.stringify(city));
await wait(1200);
await pipShot('Q4-城市-程序化材质');

await cdp.close();
