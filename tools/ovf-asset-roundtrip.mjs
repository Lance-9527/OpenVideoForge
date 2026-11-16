/* 资产往返：摆东西 → 存预设 → 清空 → 调出来 → 东西回来且位置一致 */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';

const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(name, args = {}, ms = 1200) {
  const r = await cdp.eval(`
    if (!window.WB_AGENT || !window.WB_AGENT.run) return {ok:false, error:'no agent'};
    return await window.WB_AGENT.run(${JSON.stringify(name)}, ${JSON.stringify(args)});
  `);
  console.log('[run]', name, '=>', JSON.stringify(r).slice(0, 200));
  await wait(ms);
  return r;
}
async function tool(name, args = {}, ms = 2000) {
  const r = await cdp.eval(`
    const res = await fetch('http://127.0.0.1:8787/tool', {method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name:${JSON.stringify(name)}, args:${JSON.stringify(args)}})});
    return await res.json();
  `);
  console.log('[tool]', name, '=>', JSON.stringify(r).slice(0, 240));
  await wait(ms);
  return r;
}

await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'room' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  window.dispatchEvent(new Event('resize'));
  return true;
`);
await wait(2500);

// 摆 3 个真资产（用真 id）
await run('asset.add', { asset: 'tree', x: 5, y: 0, z: 5 }, 600);
await run('asset.add', { asset: 'bike', x: -3, y: 0, z: 2 }, 600);
await run('asset.add', { asset: 'rock', x: 8, y: 0, z: -4 }, 600);
const before = await cdp.eval(`
  const e = window.__wb.editor;
  return (e.objects||[]).map(o=>({id:o.assetId, x:+o.group.position.x.toFixed(2), z:+o.group.position.z.toFixed(2)}));
`);
console.log('[摆之前]', JSON.stringify(before));

await tool('wb_preset_save', { name: '资产往返_test' }, 2500);

// 清空资产
await cdp.eval(`
  const e = window.__wb.editor;
  while ((e.objects||[]).length) { const o = e.objects[0]; e.deleteSelected && e.select(o) && e.deleteSelected(); e.objects.shift(); }
  return (e.objects||[]).length;
`);
await wait(800);
const cleared = await cdp.eval(`return (window.__wb.editor.objects||[]).length;`);
console.log('[清空后]', cleared);

// 调出来
await tool('wb_preset_load', { id: '资产往返_test' }, 4000);
const after = await cdp.eval(`
  const e = window.__wb.editor;
  return (e.objects||[]).map(o=>({id:o.assetId, x:+o.group.position.x.toFixed(2), z:+o.group.position.z.toFixed(2)}));
`);
console.log('[调出后]', JSON.stringify(after));

const f = `${OUT}\\F1-资产往返.png`;
await cdp.screenshot(f);
console.log('[shot]', f);
await tool('wb_preset_delete', { id: '资产往返_test' }, 800);
await cdp.close();
