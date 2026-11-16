/* 决定性测试：把相机架到高空俯瞰真实世界，看几何到底在不在 */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';

const OUT = defaultShotsDir();
fs.mkdirSync(OUT, { recursive: true });
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(n) {
  const f = `${OUT}\\${n}.png`;
  await cdp.screenshot(f);
  console.log('[shot]', n, (fs.statSync(f).size / 1024).toFixed(0) + 'KB');
}

// 1) 先看楼的几何中心在哪
const info = await cdp.eval(`
  const e = window.__wb.editor;
  const st = e._cityState;
  const b = st && st.plan && st.plan.buildings ? st.plan.buildings : [];
  let sx=0, sz=0, n=0, maxA=0, big=null;
  for (const bb of b) {
    if (bb.ring) {
      const xs=bb.ring.map(p=>p.x), zs=bb.ring.map(p=>p.z);
      const w=Math.max(...xs)-Math.min(...xs), d=Math.max(...zs)-Math.min(...zs);
      const a=w*d;
      if (a>maxA){maxA=a; big={x:(Math.min(...xs)+Math.max(...xs))/2, z:(Math.min(...zs)+Math.max(...zs))/2, w, d, h:bb.height};}
    }
    n++;
  }
  return { count:n, biggest: big, envId:e.envId, camPos:e.camera.position.toArray().map(v=>+v.toFixed(1)), target:e.target.toArray().map(v=>+v.toFixed(1)) };
`);
console.log('[info]', JSON.stringify(info));

// 2) 俯瞰：目标对准最大那栋，相机拉高拉远
await cdp.eval(`
  const e = window.__wb.editor;
  const b = ${JSON.stringify(info.biggest)};
  e.target.set(b.x, 5, b.z);
  e.sph.r = 220;
  e.sph.phi = 0.75;
  e.sph.theta = 0.6;
  if (e._applyCamera) e._applyCamera();
  return true;
`);
await wait(1500);
await shot('C1-俯瞰-真实世界');

const after = await cdp.eval(`
  const e = window.__wb.editor;
  return { camPos:e.camera.position.toArray().map(v=>+v.toFixed(1)), target:e.target.toArray().map(v=>+v.toFixed(1)),
           calls:e.renderer.info.render.calls, tris:e.renderer.info.render.triangles,
           canvas: [e.renderer.domElement.width, e.renderer.domElement.height] };
`);
console.log('[after]', JSON.stringify(after));

// 3) 再退到 600m 高空看全城
await cdp.eval(`
  const e = window.__wb.editor;
  const b = ${JSON.stringify(info.biggest)};
  e.target.set(b.x, 5, b.z);
  e.sph.r = 900;
  e.sph.phi = 0.5;
  e.sph.theta = 0.6;
  if (e._applyCamera) e._applyCamera();
  return true;
`);
await wait(1500);
await shot('C2-高空-真实世界');

await cdp.close();
