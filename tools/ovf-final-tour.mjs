/* ============================================================================
 * tools/ovf-final-tour.mjs —— 最后一轮实测：
 *   ① 收件箱「导入」按钮（真点）
 *   ② 资产库持久化（刷新后还在）
 *   ③ 多层室内 + 换层
 *   ④ 材质/灯光应用
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
async function ev(expr, ms = 1200) {
  const r = await cdp.eval(expr);
  await wait(ms);
  return r;
}
async function tool(name, args = {}, ms = 2000) {
  const r = await cdp.eval(`
    const res = await fetch('http://127.0.0.1:8787/tool', {method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name:${JSON.stringify(name)}, args:${JSON.stringify(args)}})});
    return await res.json();
  `);
  console.log(T(), '[tool]', name, '=>', JSON.stringify(r).slice(0, 200));
  await wait(ms);
  return r;
}

// ── ① 收件箱：放一个真 GLB（用项目自带的 icon.png 改名不行，得是 glb）
//    造一个最小合法 GLB（JSON 版的 glTF）
const gltf = { asset: { version: '2.0', generators: ['test'] }, scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [], buffers: [] };
const glbPath = 'D:/下载/OpenVideoForge/外部素材收件箱/我的道具.glb';
fs.mkdirSync('D:/下载/OpenVideoForge/外部素材收件箱', { recursive: true });
fs.writeFileSync(glbPath, Buffer.from(JSON.stringify(gltf)));

// 回入口页
await ev(`
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('entry');
  const en = document.querySelector('#view-entry'); if (en) en.hidden = false;
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = true;
  document.querySelector('#srcRefresh').click();
  return true;
`, 2500);

const inbox = await ev(`
  const rows = document.querySelectorAll('#srcInbox .src-file');
  const btn = document.querySelector('#srcInbox button[data-act="import"]');
  return { rows: rows.length, hasBtn: !!btn, file: rows.length ? rows[0].querySelector('.sf-name').textContent : null };
`, 800);
console.log(T(), '[收件箱]', JSON.stringify(inbox));

// 点「导入」
const clicked = await ev(`
  const btn = document.querySelector('#srcInbox button[data-act="import"]');
  if (!btn) return { error: '没有导入按钮' };
  btn.click();
  return { clicked: true };
`, 3000);
console.log(T(), '[点导入]', JSON.stringify(clicked));
await shot('I1-收件箱导入后');

// 导入后资产库里应该有它
const lib = await ev(`
  const cards = Array.from(document.querySelectorAll('#assetLibGrid .alb-card')).map(c=>c.querySelector('.alb-name').textContent);
  return { count: cards.length, has: cards.some(n=>n.includes('我的道具')), sample: cards.slice(0,4) };
`, 1200);
console.log(T(), '[资产库]', JSON.stringify(lib));

// ── ② 刷新页面 → 持久化
await cdp.send('Page.reload', { ignoreCache: true });
await wait(6000);
const after = await ev(`
  const cards = Array.from(document.querySelectorAll('#assetLibGrid .alb-card')).map(c=>c.querySelector('.alb-name').textContent);
  return { count: cards.length, has: cards.some(n=>n.includes('我的道具')) };
`, 1500);
console.log(T(), '[刷新后]', JSON.stringify(after));

// ── ③ 多层室内（先造一座城，才有楼可进）
await ev(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'room' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  window.dispatchEvent(new Event('resize'));
  return true;
`, 3000);

await tool('wb_world_build', { kind: 'city', size: 'medium', seed: 7 }, 4000);

const entered = await ev(`
  const r = await window.WB_AGENT.run('building.enter', {});
  return r;
`, 3000);
console.log(T(), '[进屋]', JSON.stringify(entered).slice(0, 300));
await shot('I2-室内一层');

const fl = await ev(`
  const r = await window.WB_AGENT.run('building.floor', { floor: 2 });
  const e = window.__wb.editor;
  return { ok: r && r.ok, floor: r && r.data && r.data.floor, floors: r && r.data && r.data.floors,
           eyeY: e ? +e.target.y.toFixed(2) : null, stats: r && r.data && r.data.stats };
`, 2500);
console.log(T(), '[换到第3层]', JSON.stringify(fl));
await shot('I3-室内三层');

// ── ④ 材质 / 灯光
const mat = await ev(`
  // 先放个对象
  await window.WB_AGENT.run('asset.add', { asset: 'tree' });
  const r = await window.WB_AGENT.run('material.apply', { material: { color:'#c0503a', roughness:0.4, metalness:0.6 }, all: true });
  const l = await window.WB_AGENT.run('light.apply', { light: { azimuth: 45, elevation: 20, kelvin: 3200, intensity: 1.2 } });
  return { mat: r, light: l };
`, 2500);
console.log(T(), '[材质+灯光]', JSON.stringify(mat).slice(0, 300));
await shot('I4-材质灯光');

console.log(T(), 'done');
await cdp.close();
