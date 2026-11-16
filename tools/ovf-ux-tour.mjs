/* ============================================================================
 * tools/ovf-ux-tour.mjs —— 实测四件事：
 *   ① 拖拉拽放置（点资产 → 物体跟鼠标 → 左键放下）
 *   ② 右键「添加到资产库」
 *   ③ 「渲染」按钮 → 外观面板（材质/色泽/光线）
 *   ④ 资产库分组（道具/人物/材质/场景，点击展开）
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
async function ev(expr, ms = 1000) {
  const r = await cdp.eval(expr);
  await wait(ms);
  return r;
}
async function run(name, args = {}, ms = 1200) {
  const r = await cdp.eval(`
    if (!window.WB_AGENT || !window.WB_AGENT.run) return {ok:false, error:'no agent'};
    return await window.WB_AGENT.run(${JSON.stringify(name)}, ${JSON.stringify(args)});
  `);
  console.log(T(), '[run]', name, '=>', JSON.stringify(r).slice(0, 200));
  await wait(ms);
  return r;
}

// 进编辑器
await ev(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'room' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  window.dispatchEvent(new Event('resize'));
  return true;
`, 3000);

// ── ① 拖拉拽放置
console.log(T(), '--- ① 拖拉拽放置 ---');
const place = await ev(`
  const e = window.__wb.editor;
  // 点第 5 格（自然）打开抽屉
  const rail = Array.from(document.querySelectorAll('#edRail button'));
  rail[3] && rail[3].click();
  return { railCount: rail.length, opened: !document.querySelector('#edDrawer').hidden };
`, 1500);
console.log(T(), '[开抽屉]', JSON.stringify(place));

const clicked = await ev(`
  const btn = document.querySelector('#edAssetGrid [data-a]');
  if (!btn) return { error: '抽屉里没有资产' };
  const id = btn.dataset.a;
  btn.click();
  const e = window.__wb.editor;
  return { clicked: id, placing: !!e._placing, objects: (e.objects||[]).length };
`, 1500);
console.log(T(), '[点资产]', JSON.stringify(clicked));

// 移动鼠标（模拟 pointermove 到画布某处）
const moved = await ev(`
  const e = window.__wb.editor;
  const el = e.renderer.domElement;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width * 0.55, y = r.top + r.height * 0.62;
  el.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
  const rec = e._placing;
  return { placing: !!rec, pos: rec ? rec.group.position.toArray().map(v=>+v.toFixed(2)) : null };
`, 1000);
console.log(T(), '[鼠标移动]', JSON.stringify(moved));
await shot('J1-拖拉拽-物体跟鼠标');

// 左键放下
const dropped = await ev(`
  const e = window.__wb.editor;
  const el = e.renderer.domElement;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width * 0.55, y = r.top + r.height * 0.62;
  el.dispatchEvent(new PointerEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true }));
  const rec = (e.objects||[]).find(o=>o.placing===false);
  return { placing: !!e._placing, objects: (e.objects||[]).length,
           placed: rec ? rec.group.position.toArray().map(v=>+v.toFixed(2)) : null };
`, 1500);
console.log(T(), '[左键放下]', JSON.stringify(dropped));
await shot('J2-拖拉拽-放下');

// ── ② 右键「添加到资产库」
console.log(T(), '--- ② 右键添加到资产库 ---');
const ctx = await ev(`
  const e = window.__wb.editor;
  const rec = (e.objects||[])[0];
  if (!rec) return { error: '没有物体' };
  e.select(rec);
  // 直接调右键菜单的 show（比模拟右键稳）
  if (window.__studioCtxMenu) {
    window.__studioCtxMenu.show(400, 300, rec);
    const items = Array.from(document.querySelectorAll('#edCtxMenu [data-act]')).map(b=>b.textContent);
    return { items, hasAdd: items.includes('添加到资产库') };
  }
  return { error: 'ctxmenu 没就绪' };
`, 1200);
console.log(T(), '[右键菜单]', JSON.stringify(ctx));
await shot('J3-右键菜单');

// 点「添加到资产库」
const added = await ev(`
  const b = document.querySelector('#edCtxMenu [data-act="addToLibrary"]');
  if (!b) return { error: '没有这一项' };
  b.click();
  await new Promise(r=>setTimeout(r, 3500));
  const r = await fetch('http://127.0.0.1:8787/tool', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_library_list', args:{kind:'model'}})});
  const j = await r.json();
  return { models: (j.items||[]).map(i=>i.name) };
`, 5000);
console.log(T(), '[添加结果]', JSON.stringify(added));

// ── ③ 「渲染」按钮 → 外观面板
console.log(T(), '--- ③ 渲染按钮 ---');
const look = await ev(`
  const b = document.querySelector('#pipRender');
  if (!b) return { error: '没有渲染按钮' };
  const oldTitle = b.title;
  b.click();
  const p = document.querySelector('#lookPanel');
  return { oldTitle, opened: p ? !p.hidden : false,
           presets: p ? Array.from(p.querySelectorAll('[data-preset]')).map(x=>x.textContent) : [],
           groups: p ? Array.from(p.querySelectorAll('.lk-label')).map(x=>x.textContent.trim()) : [] };
`, 1200);
console.log(T(), '[外观面板]', JSON.stringify(look));
await shot('J4-渲染外观面板');

// 套一个预设（金属）看是否生效
const applied = await ev(`
  const p = document.querySelector('#lookPanel');
  const b = p && p.querySelector('[data-preset="metal"]');
  if (!b) return { error: '没有金属预设' };
  b.click();
  await new Promise(r=>setTimeout(r, 800));
  const e = window.__wb.editor;
  let rough = null, metal = null;
  const rec = (e.objects||[])[0];
  if (rec) rec.group.traverse(n=>{ if(n.isMesh&&n.material&&rough===null){ const m=Array.isArray(n.material)?n.material[0]:n.material; rough=m.roughness; metal=m.metalness; } });
  return { rough, metal, light: e.lightOpts && e.lightOpts.intensity };
`, 2000);
console.log(T(), '[套用金属]', JSON.stringify(applied));
await shot('J5-套用金属外观');

// ── ④ 资产库分组
console.log(T(), '--- ④ 资产库分组 ---');
const groups = await ev(`
  const rail = Array.from(document.querySelectorAll('#edRail button'));
  const lib = rail.find(b=>b.title==='资产库');
  if (!lib) return { error: '没有资产库这一格' };
  lib.click();
  await new Promise(r=>setTimeout(r, 1500));
  const gs = Array.from(document.querySelectorAll('#edAssetGrid .lib-group'));
  return { count: gs.length,
           groups: gs.map(g=>({ id: g.dataset.group,
             label: g.querySelector('.lib-group-head b').textContent,
             n: g.querySelector('.lg-count').textContent,
             open: g.classList.contains('open'),
             hidden: g.querySelector('.lib-group-body').hidden })) };
`, 2500);
console.log(T(), '[分组]', JSON.stringify(groups));
await shot('J6-资产库分组');

console.log(T(), 'done');
await cdp.close();
