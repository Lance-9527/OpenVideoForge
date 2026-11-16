import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

const info = await cdp.eval(`
  const e = window.__wb.editor;
  const vp = document.querySelector('#edViewport');
  const cam = e.camera;
  const mainRect = e.renderer.domElement.getBoundingClientRect();
  const pipCanvas = document.querySelector('#pipCanvas');
  return {
    camPos: cam.position.toArray().map(v=>+v.toFixed(2)),
    target: e.target.toArray().map(v=>+v.toFixed(2)),
    sph: { r:+e.sph.r.toFixed(2), phi:+e.sph.phi.toFixed(2), theta:+e.sph.theta.toFixed(2) },
    fov: cam.fov,
    camAspect: +cam.aspect.toFixed(3),
    mainCanvasSize: [e.renderer.domElement.width, e.renderer.domElement.height],
    mainRect: [Math.round(mainRect.width), Math.round(mainRect.height)],
    mainAspect: +(mainRect.width/mainRect.height).toFixed(3),
    pipSize: pipCanvas ? [pipCanvas.width, pipCanvas.height] : null,
    pipAspect: pipCanvas ? +(pipCanvas.width/pipCanvas.height).toFixed(3) : null,
    pipCam: window.__wb.pipCam ? {
      pos: window.__wb.pipCam.position.toArray().map(v=>+v.toFixed(2)),
      fov: window.__wb.pipCam.fov, aspect: +window.__wb.pipCam.aspect.toFixed(3),
    } : null,
    pipCamId: window.__wb.pipCamId || null,
    envId: e.envId,
    envScale: e.envScale,
  };
`);
console.log('[相机对照]', JSON.stringify(info, null, 1));

// 主视口画布尺寸 vs renderer 实际尺寸
const sizes = await cdp.eval(`
  const e = window.__wb.editor;
  const c = e.renderer.domElement;
  const r = c.getBoundingClientRect();
  return {
    drawingBuffer: [c.width, c.height],
    cssSize: [Math.round(r.width), Math.round(r.height)],
    pixelRatio: e.renderer.getPixelRatio(),
    containerSize: [e.container.clientWidth, e.container.clientHeight],
  };
`);
console.log('[画布尺寸]', JSON.stringify(sizes));

await cdp.close();
