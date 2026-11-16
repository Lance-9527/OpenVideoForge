/* ============================================================================
 * tools/ovf-preset-tour.mjs —— 浏览器实测：预设存/调出、批量出图、分享链接
 * ========================================================================== */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';

const OUT = defaultShotsDir();
fs.mkdirSync(OUT, { recursive: true });
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const T = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;

async function shot(n) {
  const f = `${OUT}\\${n}.png`;
  await cdp.screenshot(f);
  console.log(T(), '[shot]', n, (fs.statSync(f).size / 1024).toFixed(0) + 'KB');
}
async function run(name, args = {}, ms = 1500) {
  const r = await cdp.eval(`
    if (!window.WB_AGENT || !window.WB_AGENT.run) return {ok:false, error:'no agent'};
    return await window.WB_AGENT.run(${JSON.stringify(name)}, ${JSON.stringify(args)});
  `);
  console.log(T(), '[run]', name, '=>', JSON.stringify(r).slice(0, 220));
  await wait(ms);
  return r;
}
async function tool(name, args = {}, ms = 2000) {
  const r = await cdp.eval(`
    const res = await fetch('http://127.0.0.1:8787/tool', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name:${JSON.stringify(name)}, args:${JSON.stringify(args)}})
    });
    const j = await res.json();
    return { ok: j.ok, error: j.error, data: j };
  `);
  console.log(T(), '[tool]', name, '=>', JSON.stringify(r).slice(0, 300));
  await wait(ms);
  return r;
}

// 开场景 + 切编辑器
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

// 载入真实世界，摆点东西
await run('world.osm', { url: 'http://127.0.0.1:8787/osm/world/35.65950_139.70050_200.json' }, 4000);
await run('asset.add', { asset: 'car' }, 800);
await shot('E1-真实世界-摆好');

// ① 存预设
const saved = await tool('wb_preset_save', { name: '涩谷鸟瞰_test' }, 2500);
console.log('   保存结果 ok=', saved.ok);

// ② 列预设
const listed = await tool('wb_preset_list', {}, 800);
console.log('   预设数:', listed.data && listed.data.presets ? listed.data.presets.length : 0);

// ③ 改机位，再调出来，看有没有还原
await run('camera.set', { r: 60, phi: 1.1, theta: 2.0 }, 1200);
await shot('E2-故意改机位');
await tool('wb_preset_load', { id: '涩谷鸟瞰_test' }, 4000);
const after = await cdp.eval(`
  const e = window.__wb.editor;
  return { r:+e.sph.r.toFixed(1), phi:+e.sph.phi.toFixed(2), theta:+e.sph.theta.toFixed(2),
           objects:(e.objects||[]).length, env:e.envId };
`);
console.log('   还原后:', JSON.stringify(after));
await shot('E3-调出预设');

// ④ 批量出图（4 个角度）
const batch = await tool('wb_render_batch', {
  shots: [
    { name: '角度1', r: 420, phi: 0.9, theta: 0.0 },
    { name: '角度2', r: 420, phi: 0.9, theta: 1.57 },
    { name: '角度3', r: 420, phi: 0.9, theta: 3.14 },
    { name: '角度4', r: 420, phi: 0.9, theta: 4.71 },
  ], w: 1280, h: 720,
}, 6000);
console.log('   批量结果:', JSON.stringify(batch.data && batch.data.shots || batch.error).slice(0, 400));

// ⑤ 分享链接
const link = await tool('wb_share_link', {}, 1200);
console.log('   链接长度:', link.data && link.data.url ? link.data.url.length : 0);
if (link.data && link.data.url) console.log('   链接前 90 字符:', link.data.url.slice(0, 90));

// ⑥ 删预设
await tool('wb_preset_delete', { id: '涩谷鸟瞰_test' }, 800);

console.log(T(), 'done');
await cdp.close();
