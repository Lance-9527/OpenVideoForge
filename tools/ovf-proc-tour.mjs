import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 收集浏览器里的报错（shader 编译失败会走 console.error）
const errors = [];
await cdp.send('Log.enable').catch(() => {});
cdp.on?.('Runtime.consoleAPICalled', (p) => {
  if (p && p.type === 'error') errors.push(JSON.stringify(p.args || []).slice(0, 300));
}).catch?.(() => {});

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
  for (const id of ['tree','tree','rock','grass','car-sedan','person-stand','bench','parasol','container','house']) {
    try { e.addAsset(id); } catch(_){}
  }
  e.sph.r = 30; e.sph.phi = 1.2; e._applyCamera();
`);
await wait(2500);

// ① 开真实感 + 程序化材质（三平面）
const proc = await cdp.eval(`
  const p = window.__studioPip;
  p.setReal(true);
  p.setLook({ proc: { on: true }, hdriBg: false, hdri: null });
  await new Promise(r=>setTimeout(r,2500));
  const c = document.querySelector('#pipCanvas');
  const g = c.getContext('2d');
  const d = g.getImageData(0,0,c.width,c.height).data;
  let r=0,gg=0,b=0,n=0;
  for (let i=0;i<d.length;i+=4){r+=d[i];gg+=d[i+1];b+=d[i+2];n++;}
  // 看看是不是有明显的纹理（相邻像素方差）
  let diff = 0;
  for (let i=0;i<d.length;i+=4*7){ diff += Math.abs(d[i]-d[i+28]); }
  return { avg:[Math.round(r/n),Math.round(gg/n),Math.round(b/n)], textureSignal: Math.round(diff/(d.length/(4*7))) };
`);
console.log('[程序化材质]', JSON.stringify(proc));
await wait(800);
await pipShot('P1-程序化材质-三平面');

// ② 关程序化 → 纯色
const plain = await cdp.eval(`
  window.__studioPip.setLook({ proc: { on: false } });
  await new Promise(r=>setTimeout(r,2000));
  return true;
`);
await wait(600);
await pipShot('P2-关掉程序化材质');

// ③ 换一个环境（街道）看地面/路面
const street = await cdp.eval(`
  const e = window.__wb.editor;
  e.loadEnv('street', { size: 'medium' });
  await new Promise(r=>setTimeout(r,2500));
  window.__studioPip.setLook({ proc: { on: true } });
  await new Promise(r=>setTimeout(r,2000));
  return { env: e.envId, objects: e.objects.length };
`);
console.log('[街道环境]', JSON.stringify(street));
await wait(800);
await pipShot('P3-街道-程序化材质');

// ④ 城市环境
const city = await cdp.eval(`
  const e = window.__wb.editor;
  e.loadEnv('city', { size: 'medium' });
  await new Promise(r=>setTimeout(r,3000));
  window.__studioPip.setLook({ proc: { on: true } });
  await new Promise(r=>setTimeout(r,2000));
  return { env: e.envId };
`);
console.log('[城市环境]', JSON.stringify(city));
await wait(800);
await pipShot('P4-城市-程序化材质');

// ⑤ 主视口有没有被污染 + 有没有 shader 报错
const main = await cdp.eval(`
  const c = window.__wb.editor.renderer.domElement;
  const t = document.createElement('canvas'); t.width=60; t.height=40;
  const g = t.getContext('2d'); g.drawImage(c,0,0,60,40);
  const d = g.getImageData(0,0,60,40).data;
  let r=0,gg=0,b=0,n=0; for(let i=0;i<d.length;i+=4){r+=d[i];gg+=d[i+1];b+=d[i+2];n++;}
  return { avg:[Math.round(r/n),Math.round(gg/n),Math.round(b/n)] };
`);
console.log('[主视口平均色]', JSON.stringify(main));
console.log('[浏览器报错]', errors.length ? errors.slice(0,5) : '无');
await cdp.close();
