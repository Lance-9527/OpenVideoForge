/* ============================================================================
 * tools/ovf-csm-tour.mjs —— CSM（级联阴影）+ 室内多层 + 端口探测
 * ========================================================================== */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};

const SETUP = `
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  await new Promise(r=>setTimeout(r,3000));
  return true;
`;
await cdp.eval(SETUP);
await wait(2500);

// ① 端口探测
console.log('\n① Blender 侧车端口探测');
const caps = await cdp.eval(`
  const r = await fetch('http://127.0.0.1:8787/tool', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_caps', args:{}})});
  const j = await r.json();
  return j.data;
`);
console.log('   ', JSON.stringify(caps));
ok('★ 返回了候选端口', Array.isArray(caps.candidates) && caps.candidates.length >= 2, caps);
ok('★ 分清了「服务在不在」和「Blender 装了没」',
  typeof caps.service_up === 'boolean' && typeof caps.blender === 'boolean', caps);
ok('★ 没 Blender 时给了明确提示', !caps.blender && !!caps.hint, caps);

// ② 室内多层
console.log('\n② 室内多层（上限 8 → 40）');
const interior = await cdp.eval(`
  const e = window.__wb.editor;
  await window.WB_AGENT.run('world.build', { kind:'city', size:'large', seed: 11 });
  await new Promise(r=>setTimeout(r,4000));
  const r = await window.WB_AGENT.run('building.enter', {});
  await new Promise(r=>setTimeout(r,2000));
  const it = e._interior;
  let meshes = 0;
  if (it && it.built) it.built.group.traverse(n=>{ if(n.isMesh) meshes++; });
  return { ok: r && r.ok, err: r && r.error,
           floors: it ? it.building.floors : null, floorH: it ? it.building.floorH : null,
           curFloor: it ? it.floor : null, meshes,
           stackH: it ? (it.building.floors * it.building.floorH).toFixed(1) : null };
`);
console.log('   ', JSON.stringify(interior));
ok('★ 能进屋', interior.ok === true, interior);
ok('★ 层数 > 8（之前上限 8）', (interior.floors || 0) > 8, interior);

// ③ 换层
const fl = await cdp.eval(`
  const e = window.__wb.editor;
  const r = e.changeFloor(3);
  await new Promise(r=>setTimeout(r,1500));
  let meshes = 0;
  if (e._interior && e._interior.built) e._interior.built.group.traverse(n=>{ if(n.isMesh) meshes++; });
  return { ok: r && r.ok, floor: e._interior ? e._interior.floor : null, meshes,
           floors: e._interior ? e._interior.building.floors : null };
`);
console.log('   换到第 4 层:', JSON.stringify(fl));
ok('★ 换层成功', fl.ok && fl.floor === 3, fl);
ok('★ 换层后几何被裁剪了（不是 40 层全建）', fl.meshes > 0 && fl.meshes < 5000, fl);

// ④ CSM
console.log('\n④ CSM 级联阴影');
const csm = await cdp.eval(`
  const e = window.__wb.editor;
  const t0 = performance.now();
  const r = await e.setCsm(true, { cascades: 3, shadowMapSize: 1024 });
  await new Promise(r=>setTimeout(r,2000));
  // 数一下场景里几盏投影灯
  let dirLights = 0, shadowLights = 0;
  e.scene.traverse(o=>{ if (o.isDirectionalLight) { dirLights++; if (o.castShadow) shadowLights++; } });
  // 材质有没有 USE_CSM
  let withCsm = 0, totalMats = 0;
  const seen = new Set();
  e.scene.traverse(o=>{
    if (!o.material) return;
    for (const m of (Array.isArray(o.material)?o.material:[o.material])) {
      if (!m || seen.has(m)) continue;
      seen.add(m); totalMats++;
      if (m.defines && m.defines.USE_CSM) withCsm++;
    }
  });
  return { ok: r && r.ok, err: r && r.error, cascades: r && r.cascades,
           dirLights, shadowLights, withCsm, totalMats, ms: Math.round(performance.now()-t0),
           sunVisible: e.sun.visible, hasCsm: !!e.csm };
`);
console.log('   ', JSON.stringify(csm));
ok('★ CSM 装上了', csm.ok === true && csm.hasCsm, csm);
ok('★ 场景里有 3 盏投影灯', csm.shadowLights >= 3, csm);
ok('★ 材质装了 USE_CSM', csm.withCsm > 0, csm);
ok('★ 原 sun 让位（不可见）', csm.sunVisible === false, csm);

// ⑤ 关掉 CSM 要能还原
const off = await cdp.eval(`
  const e = window.__wb.editor;
  const r = await e.setCsm(false);
  await new Promise(r=>setTimeout(r,1200));
  let shadowLights = 0;
  e.scene.traverse(o=>{ if (o.isDirectionalLight && o.castShadow) shadowLights++; });
  return { ok: r && r.ok, shadowLights, sunVisible: e.sun.visible, hasCsm: !!e.csm };
`);
console.log('   关掉:', JSON.stringify(off));
ok('★ 关掉后回到单光源', off.hasCsm === false && off.shadowLights === 1 && off.sunVisible === true, off);

// ⑥ 页面报错
const errs = await cdp.eval(`return (window.__ovfErrors||[]);`);
console.log('\n[页面报错]', errs && errs.length ? errs : '无');

console.log(`\n${fail ? '✗' : '✓'} csm/interior: ${pass} passed, ${fail} failed`);
await cdp.close();
process.exit(fail ? 1 : 0);
