#!/usr/bin/env node
/* 分段计时：离屏导出慢在哪一步 */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const THREE = await import('three');
  const e = window.__wb.editor;
  const out = {};
  const t = window.__ovfTimeline || (window.__wb && window.__wb.timeline);
  // ① 建离屏渲染器
  let t0 = performance.now();
  const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false, preserveDrawingBuffer:true });
  renderer.setPixelRatio(1);
  renderer.setSize(640,360,false);
  out.t_makeRenderer = Math.round(performance.now()-t0);
  // ② 第一次 render（编译 shader）
  const cam = new THREE.PerspectiveCamera(45, 640/360, 0.1, Number(e.camera.far)||500);
  cam.position.copy(e.camera.position); cam.quaternion.copy(e.camera.quaternion);
  t0 = performance.now();
  renderer.render(e.scene, cam);
  out.t_render1_noShadow = Math.round(performance.now()-t0);
  // ③ 再来一次（shader 已编译）
  t0 = performance.now();
  renderer.render(e.scene, cam);
  out.t_render2_noShadow = Math.round(performance.now()-t0);
  // ④ 开阴影
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  t0 = performance.now();
  renderer.render(e.scene, cam);
  out.t_render3_shadow = Math.round(performance.now()-t0);
  // ⑤ 再来一次
  t0 = performance.now();
  renderer.render(e.scene, cam);
  out.t_render4_shadow = Math.round(performance.now()-t0);
  // ⑥ 真实感（HDRI + 三平面）
  const RL = window.__ovfRealLook;
  out.hasRL = !!RL;
  if (RL && RL.isReal && RL.isReal()) {
    t0 = performance.now();
    const restore = RL.applyCurrent(e.scene, e, renderer);
    out.t_rl_apply = Math.round(performance.now()-t0);
    t0 = performance.now();
    renderer.render(e.scene, cam);
    out.t_render5_rl = Math.round(performance.now()-t0);
    if (restore) restore();
  }
  // ⑦ 灯光/阴影相机范围
  const lights=[];
  e.scene.traverse(n=>{ if(n.isLight) lights.push({ type:n.type, castShadow:!!n.castShadow,
    cam: n.shadow && n.shadow.camera ? { l:n.shadow.camera.left, r:n.shadow.camera.right,
      t:n.shadow.camera.top, b:n.shadow.camera.bottom, near:n.shadow.camera.near, far:n.shadow.camera.far } : null,
    mapSize: n.shadow ? n.shadow.mapSize.width : null }); });
  out.lights = lights;
  out.csm = !!(e.csm || e._csm);
  out.camFar = e.camera.far;
  out.camNear = e.camera.near;
  out.shadowMapEnabled = e.renderer ? e.renderer.shadowMap.enabled : null;
  out.envId = e.envId;
  renderer.dispose();
  return out;
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
