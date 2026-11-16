import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function save(name, dataUrl) {
  if (!dataUrl) { console.log('no data', name); return; }
  const f = `${OUT}\\${name}.png`;
  fs.writeFileSync(f, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('[save]', name, (fs.statSync(f).size/1024).toFixed(0)+'KB');
}

await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'city' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  window.dispatchEvent(new Event('resize'));
  return true;
`);
await wait(3500);

// ① 正常状态：抓主画布 + PIP
const shotBoth = async (tag) => {
  const r = await cdp.eval(`
    const e = window.__wb.editor;
    const main = e.renderer.domElement.toDataURL('image/png');
    const pip = document.querySelector('#pipCanvas').toDataURL('image/png');
    return { main, pip, r: e.sph.r, camPos: e.camera.position.toArray().map(v=>+v.toFixed(2)) };
  `);
  await save(`R-${tag}-主视口`, r.main);
  await save(`R-${tag}-PIP`, r.pip);
  return r;
};

const a = await shotBoth('A-初始');
console.log('[A]', JSON.stringify({ r: a.r, camPos: a.camPos }));

// ② 拉近主视口（模拟用户滚轮放大）
await cdp.eval(`
  const e = window.__wb.editor;
  e.sph.r = 6; e.sph.phi = 1.25; e._applyCamera();
  return true;
`);
await wait(2000);
const b = await shotBoth('B-拉近后');
console.log('[B]', JSON.stringify({ r: b.r, camPos: b.camPos }));

// ③ 选中一个物体后再抓
await cdp.eval(`
  const e = window.__wb.editor;
  const rec = e.objects[0];
  if (rec) e.select(rec);
  return true;
`);
await wait(2000);
const c = await shotBoth('C-选中后');
console.log('[C]', JSON.stringify({ r: c.r, camPos: c.camPos }));

// ④ PIP 是否在实时更新？改一下相机看 PIP 的像素有没有跟着变
const live = await cdp.eval(`
  const e = window.__wb.editor;
  const pip = document.querySelector('#pipCanvas');
  const g = pip.getContext('2d');
  const sig = () => { const d = g.getImageData(0,0,pip.width,pip.height).data; let s=0; for(let i=0;i<d.length;i+=97) s+=d[i]; return s; };
  const before = sig();
  e.sph.theta += 1.2; e._applyCamera();
  await new Promise(r=>setTimeout(r,1200));
  const after = sig();
  return { before, after, changed: before !== after };
`);
console.log('[PIP 是否实时更新]', JSON.stringify(live));

await cdp.close();
