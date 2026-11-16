import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = `
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'city' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  window.dispatchEvent(new Event('resize'));
  return true;
`;

const PROPS = `
  const e = window.__wb.editor;
  for (const id of ['tree','tree','car-sedan','person-stand','parasol','container','bench']) {
    try { e.addAsset(id); } catch(_){}
  }
  e.sph.r = 26; e.sph.phi = 1.15; e.sph.theta = 0.7; e._applyCamera();
  return true;
`;

const PIP_RECT = `
  const c = document.querySelector('#pipCanvas');
  const r = c.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
`;

const VP_RECT = `
  const c = window.__wb.editor.renderer.domElement;
  const r = c.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
`;

const CAM_INFO = `
  const e = window.__wb.editor;
  const c = document.querySelector('#pipCanvas');
  return {
    mainFov: e.camera.fov,
    mainAspect: +e.camera.aspect.toFixed(3),
    mainPos: e.camera.position.toArray().map(v=>+v.toFixed(2)),
    pipCamSet: !!window.__wb.pipCam,
    pipCamId: window.__wb.pipCamId || null,
    pipSize: [c.width, c.height],
    mainCanvas: [e.renderer.domElement.width, e.renderer.domElement.height]
  };
`;

const DEV_TEST = `
  const before = !!window.__wb.pipCam;
  const e = window.__wb.editor;
  const rec = e.addDeviceCam('drone', { x: 2.6, y: 2.4, z: 2.2, lookX: 0, lookY: 0.6, lookZ: 0 });
  await new Promise(r=>setTimeout(r,1500));
  return { before: before, after: !!window.__wb.pipCam, pipCamId: window.__wb.pipCamId || null, deviceId: rec && rec.id };
`;

await cdp.eval(SETUP);
await wait(3500);
await cdp.eval(PROPS);
await wait(2500);

await cdp.screenshot(`${OUT}\\S1-full.png`);
console.log('[shot] S1 full page');

const clip = await cdp.eval(PIP_RECT);
console.log('[pip rect]', JSON.stringify(clip));
await cdp.screenshot(`${OUT}\\S2-pip.png`, { clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 3 } });
console.log('[shot] S2 pip x3');

const vp = await cdp.eval(VP_RECT);
console.log('[vp rect]', JSON.stringify(vp));
await cdp.screenshot(`${OUT}\\S3-vp-same-size.png`, {
  clip: {
    x: vp.x + Math.round((vp.w - clip.w) / 2),
    y: vp.y + Math.round((vp.h - clip.h) / 2),
    width: clip.w,
    height: clip.h,
    scale: 3,
  },
});
console.log('[shot] S3 viewport same-size region x3');

const cam = await cdp.eval(CAM_INFO);
console.log('[cam]', JSON.stringify(cam));

const dev = await cdp.eval(DEV_TEST);
console.log('[add drone]', JSON.stringify(dev));
await wait(1500);
await cdp.screenshot(`${OUT}\\S4-after-drone.png`);
console.log('[shot] S4');

const cam2 = await cdp.eval(CAM_INFO);
console.log('[cam after drone]', JSON.stringify(cam2));

await cdp.close();
