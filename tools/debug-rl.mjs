#!/usr/bin/env node
/* 量 RL.applyCurrent（真实感：HDRI + 三平面）单次耗时 */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');

const step = async (label, code) => {
  const t0 = Date.now();
  try {
    const r = await cdp.eval(code);
    console.log(`  ${label}: ${Date.now() - t0}ms ${JSON.stringify(r).slice(0, 260)}`);
    return r;
  } catch (e) { console.log(`  ${label}: 失败 ${String(e).slice(0, 200)}`); return null; }
};

await step('RL 状态', `
  const RL = window.__ovfRealLook;
  return { has: !!RL, isReal: RL && RL.isReal ? RL.isReal() : null,
           keys: RL ? Object.keys(RL) : [] };
`);

await step('applyCurrent 第一次（新渲染器）', `
  const THREE = await import('three');
  const e = window.__wb.editor;
  const RL = window.__ovfRealLook;
  if (!RL) return { skip: true };
  window.__dbgR2 = new THREE.WebGLRenderer({ antialias:true, alpha:false, preserveDrawingBuffer:true });
  window.__dbgR2.setPixelRatio(1); window.__dbgR2.setSize(640,360,false);
  window.__dbgR2.shadowMap.enabled = true; window.__dbgR2.shadowMap.type = THREE.PCFSoftShadowMap;
  window.__dbgE2 = e;
  const t0 = performance.now();
  const restore = RL.applyCurrent(e.scene, e, window.__dbgR2);
  const ms = Math.round(performance.now()-t0);
  window.__dbgRestore = restore;
  return { applyMs: ms, hasRestore: !!restore };
`);

await step('render（真实感已应用）', `
  const e = window.__dbgE2;
  const cam = new THREE.PerspectiveCamera(45, 640/360, 0.1, Number(e.camera.far)||500);
  cam.position.copy(e.camera.position); cam.quaternion.copy(e.camera.quaternion);
  window.__dbgCam2 = cam;
  const t0 = performance.now();
  window.__dbgR2.render(e.scene, cam);
  return { renderMs: Math.round(performance.now()-t0) };
`);

await step('restore', `
  const t0 = performance.now();
  if (window.__dbgRestore) window.__dbgRestore();
  return { restoreMs: Math.round(performance.now()-t0) };
`);

await step('applyCurrent 第二次（同一渲染器）', `
  const e = window.__dbgE2; const RL = window.__ovfRealLook;
  const t0 = performance.now();
  const restore = RL.applyCurrent(e.scene, e, window.__dbgR2);
  const ms = Math.round(performance.now()-t0);
  if (restore) restore();
  return { applyMs2: ms };
`);

await step('完整一帧（apply + render + restore）', `
  const e = window.__dbgE2; const RL = window.__ovfRealLook;
  const t0 = performance.now();
  const restore = RL.applyCurrent(e.scene, e, window.__dbgR2);
  window.__dbgR2.render(e.scene, window.__dbgCam2);
  if (restore) restore();
  return { frameMs: Math.round(performance.now()-t0) };
`);

await cdp.close();
