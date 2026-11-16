#!/usr/bin/env node
/* 逐段复刻 exportVideo 的流程，找出 337 秒花在哪 */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const THREE = await import('three');
  const e = window.__wb.editor;
  const T = [];
  const t0 = performance.now();
  const mark = (s) => T.push(s + ' = ' + Math.round(performance.now() - t0) + 'ms');

  // ① 离屏渲染器
  const renderer = new THREE.WebGLRenderer({ antialias:true, alpha:false, preserveDrawingBuffer:true });
  renderer.setPixelRatio(1); renderer.setSize(640,360,false);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  mark('①建渲染器');
  const cam = new THREE.PerspectiveCamera(45, 640/360, 0.1, Number(e.camera.far)||500);
  cam.position.copy(e.camera.position); cam.quaternion.copy(e.camera.quaternion);

  // ② 2D 输出面 + captureStream
  const out = document.createElement('canvas'); out.width=640; out.height=360;
  const ctx = out.getContext('2d');
  mark('②建2D画布');
  const stream = out.captureStream(12);
  mark('③captureStream');

  // ④ MediaRecorder
  const chunks = [];
  let mime = null;
  for (const m of ['video/mp4;codecs=avc1.42E01E','video/webm;codecs=vp9','video/webm']) {
    if (MediaRecorder.isTypeSupported(m)) { mime = m; break; }
  }
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(640*360*12*0.12) });
  rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
  const done = new Promise(res => { rec.onstop = res; });
  rec.start(250);
  mark('④rec.start mime=' + mime);

  // ⑤ 12 帧：render + drawImage
  for (let i=0;i<12;i++) {
    renderer.render(e.scene, cam);
    ctx.drawImage(renderer.domElement, 0, 0, 640, 360);
    if (i===0) mark('⑤第1帧 render+drawImage');
    if (i===11) mark('⑤第12帧 render+drawImage');
  }
  // ⑥ stop
  rec.stop();
  await done;
  mark('⑥rec.onstop');
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  mark('⑦Blob ' + blob.size + ' bytes');

  try { stream.getTracks().forEach(tr=>tr.stop()); } catch(_){}
  renderer.dispose();
  return { steps: T, total: Math.round(performance.now()-t0) };
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
