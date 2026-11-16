#!/usr/bin/env node
/* ① WebGL 是不是软件渲染 ② 干净页面 + 程序化城市 的离屏渲染耗时 */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');

// ① GL 厂商/渲染器
const gl = await cdp.eval(`
  const c = document.createElement('canvas');
  const g = c.getContext('webgl2') || c.getContext('webgl');
  if (!g) return { webgl: false };
  const ext = g.getExtension('WEBGL_debug_renderer_info');
  return {
    webgl: true,
    vendor: ext ? g.getParameter(ext.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR),
    renderer: ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER),
    version: g.getParameter(g.VERSION),
    maxTex: g.getParameter(g.MAX_TEXTURE_SIZE),
    cores: navigator.hardwareConcurrency,
  };
`);
console.log('GL:', JSON.stringify(gl));

// ② 分步计时（每步单独一次 eval，避免一次 eval 卡太久）
const step = async (label, code) => {
  const t0 = Date.now();
  try {
    const r = await cdp.eval(code);
    console.log(`  ${label}: ${Date.now() - t0}ms`, JSON.stringify(r).slice(0, 220));
    return r;
  } catch (e) {
    console.log(`  ${label}: ${Date.now() - t0}ms 失败`, String(e).slice(0, 160));
    return null;
  }
};

await step('建离屏渲染器', `
  const THREE = await import('three');
  window.__dbgR = new THREE.WebGLRenderer({ antialias:true, alpha:false, preserveDrawingBuffer:true });
  window.__dbgR.setPixelRatio(1); window.__dbgR.setSize(640,360,false);
  const e = window.__wb.editor;
  window.__dbgCam = new THREE.PerspectiveCamera(45, 640/360, 0.1, Number(e.camera.far)||500);
  window.__dbgCam.position.copy(e.camera.position); window.__dbgCam.quaternion.copy(e.camera.quaternion);
  window.__dbgE = e;
  return { ok:true, camFar:e.camera.far, envId:e.envId };
`);

await step('离屏 render（无阴影）', `
  const t0=performance.now();
  window.__dbgR.render(window.__dbgE.scene, window.__dbgCam);
  return { ms: Math.round(performance.now()-t0) };
`);

await step('离屏 render（第二次）', `
  const t0=performance.now();
  window.__dbgR.render(window.__dbgE.scene, window.__dbgCam);
  return { ms: Math.round(performance.now()-t0) };
`);

await step('开阴影后 render', `
  const THREE = await import('three');
  window.__dbgR.shadowMap.enabled = true;
  window.__dbgR.shadowMap.type = THREE.PCFSoftShadowMap;
  const t0=performance.now();
  window.__dbgR.render(window.__dbgE.scene, window.__dbgCam);
  return { ms: Math.round(performance.now()-t0) };
`);

await step('场景灯光/阴影范围', `
  const e = window.__dbgE; const lights=[];
  e.scene.traverse(n=>{ if(n.isLight) lights.push({ t:n.type, cs:!!n.castShadow,
    cam: n.shadow&&n.shadow.camera ? [n.shadow.camera.left,n.shadow.camera.right,n.shadow.camera.top,n.shadow.camera.bottom,n.shadow.camera.far] : null,
    ms: n.shadow?n.shadow.mapSize.width:null }); });
  let tris=0,meshes=0; e.scene.traverse(n=>{ if(n.isMesh){meshes++; const g=n.geometry;
    if(g&&g.index)tris+=g.index.count/3; else if(g&&g.attributes.position)tris+=g.attributes.position.count/3;} });
  return { lights, meshes, tris:Math.round(tris), envId:e.envId, csm: !!(e.csm||e._csm),
           smOn: e.renderer?e.renderer.shadowMap.enabled:null };
`);

await cdp.close();
