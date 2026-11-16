/* ============================================================================
 * tools/ovf-rail-tour.mjs —— 实测：左轨第 10 格「资产库」+ 带地形的真实世界
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
  console.log(T(), '[tool]', name, '=>', JSON.stringify(r).slice(0, 260));
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

// ── ① 左轨：数一下有几个、第 10 个是什么
const rail = await ev(`
  const btns = Array.from(document.querySelectorAll('#edRail button'));
  return { count: btns.length,
           titles: btns.map(b=>b.title),
           last: btns.length ? btns[btns.length-1].title : null };
`, 800);
console.log(T(), '[左轨]', JSON.stringify(rail));
await shot('H1-左轨10格');

// ── ② 点第 10 格 → 抽屉里显示资产库
const drawer = await ev(`
  const btns = Array.from(document.querySelectorAll('#edRail button'));
  const lib = btns.find(b=>b.title==='资产库');
  if (!lib) return { error: '没有资产库这一格' };
  lib.click();
  return { clicked: true };
`, 2500);
console.log(T(), '[点资产库]', JSON.stringify(drawer));
const drawerContent = await ev(`
  const g = document.querySelector('#edAssetGrid');
  const btns = g ? Array.from(g.querySelectorAll('[data-lib]')) : [];
  return { visible: g ? !!g.offsetParent : false,
           items: btns.length,
           names: btns.slice(0,8).map(b=>b.querySelector('.ed-asset-name').textContent),
           emptyText: g ? (g.textContent||'').trim().slice(0,90) : null };
`, 800);
console.log(T(), '[抽屉内容]', JSON.stringify(drawerContent));
await shot('H2-资产库抽屉');

// ── ③ 带地形的真实世界（走 wb_world_build —— 真实用户路径，地形在这里面）
const osm = await tool('wb_world_build', { kind: 'osm', lat: 35.6595, lng: 139.7005, radius: 300 }, 25000);
console.log('   terrain =', JSON.stringify(osm.terrain));
console.log('   size =', osm.size, '| buildings =', osm.stats && osm.stats.buildings);
const tinfo = await ev(`
  const e = window.__wb.editor;
  const st = e._cityState;
  let terrainMesh = null, minY=1e9, maxY=-1e9;
  st.group.traverse(o=>{ if(o.name==='osm-terrain'){terrainMesh=o;} });
  if (terrainMesh) { const p=terrainMesh.geometry.attributes.position; for(let i=0;i<p.count;i++){const y=p.getY(i);minY=Math.min(minY,y);maxY=Math.max(maxY,y);} }
  // 楼底面最低点（应该跟着地形抬起来）
  let bMinY = 1e9;
  const bm = st.meshes && st.meshes.buildings;
  if (bm) { const p=bm.geometry.attributes.position; for(let i=0;i<p.count;i++) bMinY=Math.min(bMinY,p.getY(i)); }
  return { terrain: !!terrainMesh, minY:+minY.toFixed(1), maxY:+maxY.toFixed(1),
           buildingBaseY:+bMinY.toFixed(1),
           buildings: st.plan.stats.buildings, roads: st.plan.stats.roads };
`, 1000);
console.log(T(), '[地形世界]', JSON.stringify(tinfo));
await shot('H3-真实世界-带地形');

console.log(T(), 'done');
await cdp.close();
