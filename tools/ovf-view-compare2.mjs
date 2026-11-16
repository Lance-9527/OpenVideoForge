import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = `
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'room' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  window.dispatchEvent(new Event('resize'));
  return true;
`;

const SCENE = `
  const e = window.__wb.editor;
  const put = (aid, x, z) => {
    const r = e.addAsset(aid);
    if (r && r.group) { r.group.position.set(x, 0, z); r.group.scale.setScalar(1.6); }
    return r;
  };
  put('tree', -3.5, 0);
  put('car-sedan', 0, 0);
  put('person-stand', 3.5, 0);
  put('rock', -1.6, 2.2);
  e.sph.r = 16; e.sph.phi = 1.18; e.sph.theta = 0.55; e._applyCamera();
  return e.objects.length;
`;

const RECT = `
  const c = document.querySelector('#pipCanvas');
  const r = c.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
`;

const VRECT = `
  const c = window.__wb.editor.renderer.domElement;
  const r = c.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
`;

await cdp.eval(SETUP);
await wait(3500);
const n = await cdp.eval(SCENE);
console.log('[objects]', n);
await wait(2500);

const p = await cdp.eval(RECT);
const v = await cdp.eval(VRECT);
console.log('[pip rect]', JSON.stringify(p), '[vp rect]', JSON.stringify(v));

// PIP 区域（裁剪 + 放大）
await cdp.screenshot(`${OUT}\\T1-pip-region.png`, { clip: { x: p.x, y: p.y, width: p.w, height: p.h, scale: 3 } });
// 主视口**整幅**缩到 PIP 的宽度（同样的水平视野 ⇒ 同样的取景）
await cdp.screenshot(`${OUT}\\T2-vp-region.png`, {
  clip: { x: v.x, y: v.y, width: v.w, height: v.h, scale: p.w / v.w },
});
console.log('[shot] T1/T2  （PIP 与主视口同宽度，便于逐点比）');

await cdp.close();
