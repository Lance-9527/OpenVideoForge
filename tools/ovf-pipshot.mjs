import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 只截 PIP 画布（放大 3 倍，看清真实感）
async function pipShot(name, scale = 3) {
  const dataUrl = await cdp.eval(`
    const c = document.querySelector('#pipCanvas');
    if (!c) return null;
    const t = document.createElement('canvas');
    t.width = c.width * ${scale}; t.height = c.height * ${scale};
    const g = t.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(c, 0, 0, t.width, t.height);
    return t.toDataURL('image/png');
  `);
  if (!dataUrl) { console.log('no pip canvas'); return; }
  const b64 = dataUrl.split(',')[1];
  const f = `${OUT}\\${name}.png`;
  fs.writeFileSync(f, Buffer.from(b64, 'base64'));
  console.log('[pip shot]', name, (fs.statSync(f).size/1024).toFixed(0)+'KB');
}

const preset = process.argv[2] || 'daylight';
await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'room' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  window.dispatchEvent(new Event('resize'));
  return true;
`);
await wait(3000);

await cdp.eval(`
  const e = window.__wb.editor;
  for (const id of ['tree','tree','rock','grass','car-sedan','person-stand','person-sit','bench','table','house','boat','parasol']) {
    try { e.addAsset(id); } catch(_){}
  }
  e.sph.r = 30; e.sph.phi = 1.2; e._applyCamera();
  return e.objects.length;
`);
await wait(2500);

// 白膜
await cdp.eval(`window.__studioPip.setReal(false);`);
await wait(1200);
await pipShot('N0-成片预览-白膜');

// 真实感
await cdp.eval(`
  const p = window.__studioPip;
  p.setPreset(${JSON.stringify(preset)});
  p.setReal(true);
`);
await wait(1800);
await pipShot('N1-成片预览-' + preset);

await cdp.close();
