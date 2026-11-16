import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (n) => { const f = `${OUT}\\${n}.png`; await cdp.screenshot(f); console.log('[shot]', n, (fs.statSync(f).size/1024).toFixed(0)+'KB'); };

await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'room' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  return true;
`);
await wait(3000);

const before = await cdp.eval(`
  const rail = Array.from(document.querySelectorAll('#edRail button'));
  const lib = rail.find(b=>b.title==='资产库');
  lib.click();
  await new Promise(r=>setTimeout(r,1500));
  const g = document.querySelector('#edAssetGrid .lib-group[data-group="prop"]');
  return { open: g.classList.contains('open'), hidden: g.querySelector('.lib-group-body').hidden };
`);
console.log('[展开前]', JSON.stringify(before));

const after = await cdp.eval(`
  const h = document.querySelector('#edAssetGrid [data-lgroup="prop"]');
  h.click();
  await new Promise(r=>setTimeout(r,400));
  const g = document.querySelector('#edAssetGrid .lib-group[data-group="prop"]');
  const body = g.querySelector('.lib-group-body');
  return { open: g.classList.contains('open'), hidden: body.hidden,
           caret: g.querySelector('.lg-caret').textContent,
           cards: body.querySelectorAll('[data-lib]').length };
`);
console.log('[点击后]', JSON.stringify(after));
await shot('K1-资产库分组展开');

// 顺便展开全部
const all = await cdp.eval(`
  for (const h of document.querySelectorAll('#edAssetGrid [data-lgroup]')) h.click();
  await new Promise(r=>setTimeout(r,400));
  const gs = Array.from(document.querySelectorAll('#edAssetGrid .lib-group'));
  return gs.map(g=>({ label:g.querySelector('.lib-group-head b').textContent,
                      n:g.querySelector('.lg-count').textContent,
                      open:g.classList.contains('open'),
                      cards:g.querySelectorAll('[data-lib]').length }));
`);
console.log('[全展开]', JSON.stringify(all));
await shot('K2-资产库全展开');
await cdp.close();
