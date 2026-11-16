import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = `
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  window.dispatchEvent(new Event('resize'));
  return true;
`;

await cdp.eval(SETUP);
await wait(3500);

const errs = [];
await cdp.eval(`
  window.__ovfErrors = [];
  window.addEventListener('error', e => window.__ovfErrors.push(String(e.message)));
  window.addEventListener('unhandledrejection', e => window.__ovfErrors.push('rej:' + String(e.reason)));
  return true;
`);

// ① 成片预览视角一致性（回归）
const view = await cdp.eval(`
  const e = window.__wb.editor;
  const c = document.querySelector('#pipCanvas');
  const W=c.width, H=c.height;
  const mainAspect = e.camera.aspect;
  const hFov = 2*Math.atan(Math.tan(e.camera.fov*Math.PI/360)*mainAspect);
  const pipFov = 2*Math.atan(Math.tan(hFov/2)/(W/H))*180/Math.PI;
  const pipH = 2*Math.atan(Math.tan(pipFov*Math.PI/360)*(W/H))*180/Math.PI;
  const mainH = 2*Math.atan(Math.tan(e.camera.fov*Math.PI/360)*mainAspect)*180/Math.PI;
  return { mainH:+mainH.toFixed(3), pipH:+pipH.toFixed(3), pipCamSet: !!window.__wb.pipCam };
`);
console.log('[① 视角一致] hFov 主', view.mainH, ' PIP', view.pipH, ' 差', Math.abs(view.mainH-view.pipH).toFixed(4), '| 设备接管:', view.pipCamSet);

// ② 出图带真实感
const exp = await cdp.eval(`
  const e = window.__wb.editor;
  for (const id of ['tree','car-sedan']) { try { e.addAsset(id); } catch(_){} }
  await new Promise(r=>setTimeout(r,600));
  window.__studioPip.setReal(false);
  await new Promise(r=>setTimeout(r,700));
  const clay = e.captureThumb(320,180);
  window.__studioPip.setReal(true);
  window.__studioPip.setLook({ proc:{on:true} });
  await new Promise(r=>setTimeout(r,2500));
  const real = e.captureThumb(320,180);
  // 颜色差异（真实感下饱和度应该更高）
  const sat = (u) => {
    const img = new Image();
    return new Promise(res => {
      img.onload = () => {
        const cv = document.createElement('canvas'); cv.width=img.width; cv.height=img.height;
        const g = cv.getContext('2d'); g.drawImage(img,0,0);
        const d = g.getImageData(0,0,cv.width,cv.height).data;
        let s = 0, n = 0;
        for (let i=0;i<d.length;i+=4*13){ const mx=Math.max(d[i],d[i+1],d[i+2]), mn=Math.min(d[i],d[i+1],d[i+2]);
          s += mx===0?0:(mx-mn)/mx; n++; }
        res(+(s/n).toFixed(3));
      };
      img.onerror = () => res(-1);
      img.src = u;
    });
  };
  return { claySat: await sat(clay), realSat: await sat(real), clayLen: clay.length, realLen: real.length };
`);
console.log('[② 出图] 白膜饱和度', exp.claySat, ' 真实感饱和度', exp.realSat, ' 字节', exp.clayLen, '→', exp.realLen);

// ③ 场景还原
const st = await cdp.eval(`
  const e = window.__wb.editor;
  let meshes=0; const g=new Set();
  for (const o of (e.objects||[])) o.group.traverse(n=>{if(n.isMesh){meshes++; if(n.geometry) g.add(n.geometry.uuid);} });
  return { objects:(e.objects||[]).length, meshes, geoms:g.size,
           bg: e.scene.background && e.scene.background.isColor ? e.scene.background.getHexString() : 'x',
           env: !!e.scene.environment, sunI: e.sun ? e.sun.intensity : null };
`);
console.log('[③ 场景]', JSON.stringify(st));

// ④ 批量出图（走 captureThumb）
const batch = await cdp.eval(`
  const r = await window.WB_AGENT.run('render.batch', { shots: [
    { name:'t1', r:16, phi:1.2, theta:0.4, target:[0,1,0] },
    { name:'t2', r:16, phi:1.2, theta:2.0, target:[0,1,0] },
  ], w: 320, h: 180, save: false });
  return { ok: r && r.ok, count: r && r.data && r.data.count,
           sizes: (r && r.data && r.data.shots || []).map(s=>s.base64?s.base64.length:0) };
`);
console.log('[④ 批量出图]', JSON.stringify(batch));

const errs2 = await cdp.eval(`return window.__ovfErrors || [];`);
console.log('[⑤ 页面报错]', errs2.length ? errs2 : '无');

await cdp.screenshot(`${OUT}\\Z1-regress.png`);
console.log('[shot] Z1');
await cdp.close();
