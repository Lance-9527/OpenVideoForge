/* 只验真实世界的取景：载入 → 看镜头参数 → 截图 */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';

const OUT = defaultShotsDir();
fs.mkdirSync(OUT, { recursive: true });
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 确保有场景 + 切到编辑器
await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env: 'room' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  window.dispatchEvent(new Event('resize'));
  return true;
`);
await wait(2000);

const r = await cdp.eval(`
  const res = await window.WB_AGENT.run('world.osm', { url: 'http://127.0.0.1:8787/osm/world/35.65950_139.70050_200.json' });
  return res;
`);
console.log('[osm]', JSON.stringify(r).slice(0, 200));
await wait(2500);

const cam = await cdp.eval(`
  const e = window.__wb.editor;
  return { cam: e.camera.position.toArray().map(v=>+v.toFixed(1)),
           tgt: e.target.toArray().map(v=>+v.toFixed(1)),
           r: +e.sph.r.toFixed(1), phi: +e.sph.phi.toFixed(2),
           calls: e.renderer.info.render.calls, tris: e.renderer.info.render.triangles };
`);
console.log('[cam]', JSON.stringify(cam));

const f = `${OUT}\\D1-真实世界-取景.png`;
await cdp.screenshot(f);
console.log('[shot]', f, (fs.statSync(f).size / 1024).toFixed(0) + 'KB');
await cdp.close();
