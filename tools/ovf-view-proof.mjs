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
    if (r && r.group) { r.group.position.set(x, 0, z); r.group.scale.setScalar(1.7); }
  };
  put('tree', -3.5, 0);
  put('car-sedan', 0, 0);
  put('person-stand', 3.5, 0);
  put('rock', -1.6, 2.2);
  e.sph.r = 15; e.sph.phi = 1.18; e.sph.theta = 0.55; e._applyCamera();
  return e.objects.length;
`;

// ★ 数值验证：同一个世界坐标点，投影到主相机 和 PIP 相机，比较 NDC
const PROJECT = `
  const e = window.__wb.editor;
  const c = document.querySelector('#pipCanvas');
  const W = c.width, H = c.height;
  const mainAspect = e.camera.aspect || (W/H);
  const hFov = 2 * Math.atan(Math.tan(e.camera.fov * Math.PI/360) * mainAspect);
  const pipFov = 2 * Math.atan(Math.tan(hFov/2) / (W/H)) * 180 / Math.PI;
  const mk = (fov, aspect) => { const k = e.camera.clone(); k.fov=fov; k.aspect=aspect; k.updateProjectionMatrix(); k.updateMatrixWorld(); return k; };
  const mainCam = mk(e.camera.fov, e.camera.aspect);
  const pipCam = mk(pipFov, W/H);
  // 取几个场景里的点
  const pts = [];
  for (const o of e.objects) {
    const v = o.group.position.clone(); v.y += 1.2;
    pts.push({ name: o.assetId, p: v });
  }
  pts.push({ name: '中心+右5米', p: e.target.clone().set(e.target.x + 5, e.target.y, e.target.z) });
  const rows = pts.map(({name,p}) => {
    const a = p.clone().project(mainCam);
    const b = p.clone().project(pipCam);
    return { name, mainX:+a.x.toFixed(4), pipX:+b.x.toFixed(4), dx:+(b.x-a.x).toFixed(4),
             mainY:+a.y.toFixed(4), pipY:+b.y.toFixed(4), dy:+(b.y-a.y).toFixed(4) };
  });
  return {
    mainCanvas: [e.renderer.domElement.width, e.renderer.domElement.height],
    mainAspect: +e.camera.aspect.toFixed(4),
    pipBuffer: [W, H], pipAspect: +(W/H).toFixed(4),
    pipDisplay: (()=>{ const r=c.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
    mainFov: e.camera.fov, pipFov: +pipFov.toFixed(3),
    hFovMain: +(hFov*180/Math.PI).toFixed(3),
    hFovPip: +(2*Math.atan(Math.tan(pipFov*Math.PI/360)*(W/H))*180/Math.PI).toFixed(3),
    rows,
  };
`;

await cdp.eval(SETUP);
await wait(3500);
await cdp.eval(SCENE);
await wait(2500);

const p = await cdp.eval(PROJECT);
console.log('[投影对照]');
console.log('  主视口画布 ', p.mainCanvas, ' aspect', p.mainAspect, ' vFov', p.mainFov, ' hFov', p.hFovMain);
console.log('  PIP 缓冲   ', p.pipBuffer, ' aspect', p.pipAspect, ' 显示', p.pipDisplay);
console.log('  PIP vFov   ', p.pipFov, ' hFov', p.hFovPip);
console.log('  逐点投影（mainX vs pipX，dx 越小越一致）：');
for (const r of p.rows) {
  console.log('   ', r.name.padEnd(16), 'mainX', String(r.mainX).padStart(8), 'pipX', String(r.pipX).padStart(8), 'dx', String(r.dx).padStart(8), ' dy', String(r.dy).padStart(8));
}

// 视觉对照：关掉真实感 + 取消选中，让 PIP 和主视口都画白膜
const VIS = `
  window.__studioPip.setReal(false);
  const e = window.__wb.editor;
  e.select(null);
  return true;
`;
await cdp.eval(VIS);
await wait(2000);

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
const pp = await cdp.eval(RECT);
const vv = await cdp.eval(VRECT);
await cdp.screenshot(`${OUT}\\U1-pip.png`, { clip: { x: pp.x, y: pp.y, width: pp.w, height: pp.h, scale: 3 } });
await cdp.screenshot(`${OUT}\\U2-vp.png`, { clip: { x: vv.x, y: vv.y, width: vv.w, height: vv.h, scale: pp.w / vv.w } });
console.log('[shot] U1(pip x3) / U2(vp 缩到同宽)');

await cdp.close();
