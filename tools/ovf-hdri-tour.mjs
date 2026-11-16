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
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'room' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  return true;
`);
await wait(3000);

await cdp.eval(`
  const e = window.__wb.editor;
  for (const id of ['tree','tree','rock','grass','car-sedan','person-stand','bench','parasol','container']) {
    try { e.addAsset(id); } catch(_){}
  }
  e.sph.r = 30; e.sph.phi = 1.2; e._applyCamera();
`);
await wait(2500);

// 1) 桥的 HDRI 清单
const list = await cdp.eval(`
  const r = await fetch('http://127.0.0.1:8787/hdri/list');
  const j = await r.json();
  return { ok:j.ok, count:j.count, dir:j.dir, slots:(j.items||[]).map(i=>i.slotLabel) };
`);
console.log('[HDRI 清单]', JSON.stringify(list));

// 2) 点「渲染」→ 应该开启真实感 + 打开面板 + 面板里有 HDRI 卡片
const clicked = await cdp.eval(`
  window.__studioPip.setReal(false);
  await new Promise(r=>setTimeout(r,300));
  const b = document.querySelector('#pipRender');
  b.click();
  await new Promise(r=>setTimeout(r,2200));
  const items = Array.from(document.querySelectorAll('#lkHdri [data-hdri]'));
  return { real: window.__studioPip.getReal(),
           panelOpen: !document.querySelector('#lookPanel').hidden,
           n: items.length,
           labels: items.map(i=>i.querySelector('.lk-hdri-name').textContent),
           imgs: items.filter(i=>i.querySelector('img')).length };
`);
console.log('[点渲染]', JSON.stringify(clicked));
await cdp.screenshot(`${OUT}\\O1-外观面板-HDRI.png`);
console.log('[shot] O1');

// 3) 逐个 HDRI 看效果
for (const slot of ['sunset', 'studio', 'night', 'city']) {
  const r = await cdp.eval(`
    const list = await (await fetch('http://127.0.0.1:8787/hdri/list')).json();
    const it = (list.items||[]).find(i=>i.slot==='${slot}');
    if (!it) return { error:'no ${slot}' };
    await window.__studioPip.setReal(true);
    const res = await window.__studioPip.setHdri(it.id);
    await new Promise(r=>setTimeout(r,2600));
    const env = window.__studioPip.getHdriEnv();
    const c = document.querySelector('#pipCanvas');
    const g = c.getContext('2d');
    const d = g.getImageData(0,0,c.width,c.height).data;
    let r=0,gg=0,bb=0,n=0,satMax=0;
    for (let i=0;i<d.length;i+=4){ r+=d[i]; gg+=d[i+1]; bb+=d[i+2]; n++;
      const mx=Math.max(d[i],d[i+1],d[i+2]), mn=Math.min(d[i],d[i+1],d[i+2]);
      satMax=Math.max(satMax, mx===0?0:(mx-mn)/mx); }
    return { id: it.id, ok: res.ok, hasEnv: !!env,
             avg:[Math.round(r/n),Math.round(gg/n),Math.round(bb/n)], maxSat:+satMax.toFixed(3) };
  `);
  console.log('[HDRI ' + slot + ']', JSON.stringify(r));
  await wait(1200);
  await pipShot('O2-HDRI-' + slot);
}

// 4) 主视口有没有被污染
const main = await cdp.eval(`
  const c = window.__wb.editor.renderer.domElement;
  const t = document.createElement('canvas'); t.width=60; t.height=40;
  const g = t.getContext('2d'); g.drawImage(c,0,0,60,40);
  const d = g.getImageData(0,0,60,40).data;
  let r=0,gg=0,b=0,n=0; for(let i=0;i<d.length;i+=4){r+=d[i];gg+=d[i+1];b+=d[i+2];n++;}
  return { avg:[Math.round(r/n),Math.round(gg/n),Math.round(b/n)] };
`);
console.log('[主视口平均色]', JSON.stringify(main));
await cdp.close();
