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

// 展开资产库 → 道具组 → 点第一个模型
const begin = await cdp.eval(`
  const rail = Array.from(document.querySelectorAll('#edRail button'));
  rail.find(b=>b.title==='资产库').click();
  await new Promise(r=>setTimeout(r,1500));
  const h = document.querySelector('#edAssetGrid [data-lgroup="prop"]');
  if (h) h.click();
  await new Promise(r=>setTimeout(r,400));
  const card = document.querySelector('#edAssetGrid .lib-group[data-group="prop"] [data-lib]');
  if (!card) return { error: '道具组里没有模型' };
  const id = card.dataset.lib;
  const r = await window.WB_AGENT.run('library.place.begin', { id });
  const e = window.__wb.editor;
  return { id, ret: r, placing: !!e._placing, objects: (e.objects||[]).length };
`);
console.log('[资产库 GLB 拖拉拽]', JSON.stringify(begin));
await wait(600);

// 移动 + 放下
const drop = await cdp.eval(`
  const e = window.__wb.editor;
  const el = e.renderer.domElement;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width * 0.42, y = r.top + r.height * 0.55;
  el.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
  await new Promise(r=>setTimeout(r,200));
  const before = e._placing ? e._placing.group.position.toArray().map(v=>+v.toFixed(2)) : null;
  el.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true }));
  await new Promise(r=>setTimeout(r,400));
  return { before, placing: !!e._placing, objects: (e.objects||[]).length,
           pos: (e.objects||[]).map(o=>o.group.position.toArray().map(v=>+v.toFixed(2))) };
`);
console.log('[放下]', JSON.stringify(drop));
await shot('L1-资产库GLB拖放');
await cdp.close();
