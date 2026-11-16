#!/usr/bin/env node
/* ============================================================================
 * tools/ovf-interior-overview.mjs —— 室内总览模式验收
 *
 * 覆盖（2026-11-10 欠账项）：40 层的楼之前只能逐层看，没有「一眼看全」的办法。
 * ========================================================================== */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, e === undefined ? '' : '→ ' + JSON.stringify(e)); }
};

await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e) {} }
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden=true; }
  const ed=document.querySelector('#view-editor'); if(ed) ed.hidden=false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  await new Promise(r=>setTimeout(r,3000));
  return true;`);
await wait(2000);

console.log('\n════ ① 建世界（上海黄浦区，本地缓存 0.5 秒）════');
const world = await cdp.eval(`
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:8787/tool', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name:'wb_world_build', args:{ kind:'osm',
      lat: 31.2336, lng: 121.4799, radius: 1200 } })});
  const j = await r.json();
  const e = window.__wb.editor;
  let tris = 0, meshes = 0;
  e.scene.traverse(n => { if (n.isMesh) { meshes++; const g=n.geometry;
    if (g&&g.index) tris+=g.index.count/3; else if (g&&g.attributes.position) tris+=g.attributes.position.count/3; } });
  return { ok: j.ok, error: j.error, ms: Date.now()-t0, stats: j.stats || {},
           pageOk: (j.page||{}).ok, meshes, tris: Math.round(tris) };
`);
console.log('  ', JSON.stringify(world).slice(0, 300));
ok('★ 世界建好了', world.ok === true && world.pageOk === true, world.error || world);
ok('★ 有楼可进（≥ 1000 栋）', (world.stats.buildings || 0) >= 1000, world.stats);

console.log('\n════ ② 进屋（找一个高楼）════');
const list = await cdp.eval(`
  const r = await window.WB_AGENT.run('building.list', { limit: 40 });
  const d = (r && r.data) || r;
  return { ok: !!(r && !r.error), err: r && r.error, n: (d.buildings||[]).length,
           top: (d.buildings||[]).slice(0,5).map(b=>({ i:b.index, h:b.height, w:b.w, d:b.d })) };
`);
console.log('  ', JSON.stringify(list));
ok('★ 能列出可进入的楼', list.ok === true && list.n > 0, list);

console.log('\n════ ③ 进屋 + 换层 ════');
const enter = await cdp.eval(`
  const r = await window.WB_AGENT.run('building.enter', { index: 0 });
  const d = (r && r.data) || r;
  return { ok: !!(r && !r.error && d && d.ok !== false), floors: d.floors, floor: d.floor,
           err: r && r.error, stats: d.stats, camera: d.camera };
`);
console.log('  ', JSON.stringify(enter));
ok('★ 进屋成功', enter.ok === true, enter.err || enter);
ok('★ 是多层（≥ 3 层）', (enter.floors || 0) >= 3, enter.floors);

const fl = await cdp.eval(`
  const r = await window.WB_AGENT.run('building.floor', { floor: 1 });
  const d = (r && r.data) || r;
  return { ok: !!(r && !r.error && d.ok !== false), floor: d.floor, floors: d.floors, err: r && r.error };
`);
ok('★ 能换到第 2 层', fl.ok === true && fl.floor === 1, fl);

console.log('\n════ ④ 总览模式（floor = -1）════');
const ov = await cdp.eval(`
  const t0 = Date.now();
  const r = await window.WB_AGENT.run('building.overview', {});
  const d = (r && r.data) || r;
  const e = window.__wb.editor;
  let tris = 0, meshes = 0, yMin = Infinity, yMax = -Infinity;
  if (e._interiorGroup) e._interiorGroup.traverse(o=>{ if(o.isMesh){ meshes++;
    const g=o.geometry; tris += (g.index?g.index.count:g.attributes.position.count)/3;
    const p = g.attributes.position;
    for (let i=0;i<p.count;i++){ const y=p.getY(i); if(y<yMin)yMin=y; if(y>yMax)yMax=y; } } });
  return { ok: !!(r && !r.error && d.ok !== false), err: r && r.error,
           floor: d.floor, floors: d.floors, overview: d.overview,
           ms: Date.now()-t0, meshes, tris: Math.round(tris),
           ySpan: Math.round(yMax - yMin), yMin: Math.round(yMin), yMax: Math.round(yMax),
           cam: { r: Math.round(e.sph.r), phi: +e.sph.phi.toFixed(2),
                  targetY: Math.round(e.target.y),
                  camY: Math.round(e.camera.position.y) },
           rooms: (d.rooms||[]).length };
`);
console.log('  ', JSON.stringify(ov));
ok('★ 总览模式成功', ov.ok === true, ov.err || ov);
ok('★ overview 标记为 true', ov.overview === true, ov);
// ★ 爆炸图：Y 跨度应该 ≈ 层数×(层高+间距)，比真实楼高大得多
ok('★ 楼层是错开的（爆炸图，Y 跨度 > 楼高的 1.5 倍）', ov.ySpan > 150, ov);
ok('★ 相机在堆叠顶之上（能看到里面）', ov.cam.camY > ov.yMax + 20, ov.cam);
// ★ 整个堆叠要装进画面（实测踩过：只按水平楼面算距离 ⇒ 竖直方向溢出画面）
ok('★ 距离够远，整个堆叠装得下', ov.cam.r > 300, ov.cam);
// ★ 俯角要在"能看进每层"的范围（太陡看不出层间分离，实测）
ok('★ 俯角合适（0.5 < φ < 1.0）', ov.cam.phi > 0.5 && ov.cam.phi < 1.0, ov.cam);
ok('★ 不慢（< 8 秒）', ov.ms < 8000, { ms: ov.ms });

// ★ 外壳楼必须被藏起来（否则俯视只看得到楼顶）
const shell = await cdp.eval(`
  const e = window.__wb.editor;
  const st = e._cityState;
  let shellVisible = null, env = null;
  if (st && st.meshes && st.meshes.buildings) shellVisible = st.meshes.buildings.visible;
  if (e._envelope) env = { name: e._envelope.name, y: Math.round(e._envelope.position.y) };
  return { shellVisible, env, hidden: e._exteriorHidden };
`);
console.log('  外壳:', JSON.stringify(shell));
ok('★ 外壳楼被藏起来了', shell.shellVisible === false, shell);
ok('★ 有外轮廓线框标示这栋楼', !!shell.env, shell);
const shot = await cdp.eval(`
  const e = window.__wb.editor;
  const url = e.captureThumb(1280,720);
  return url ? url.split(',')[1] : null;`);
if (shot) {
  fs.writeFileSync(path.join(SHOTS, 'interior-overview.jpg'), Buffer.from(shot, 'base64'));
  console.log('  已存: ovf_shots\\interior-overview.jpg');
}
ok('★ 总览能出图', !!shot);

console.log('\n════ ④ 总览模式下 Blender 渲染 ════');
const job = await cdp.eval(`
  const e = window.__wb.editor;
  const cam = e.captureCam();
  const keys=[]; const N=16;
  for (let i=0;i<N;i++){ const a=cam.theta+(i/N)*Math.PI*2;
    keys.push({ frame:i,
      position:[cam.t[0]+cam.r*Math.sin(cam.phi)*Math.sin(a),
                -(cam.t[2]+cam.r*Math.sin(cam.phi)*Math.cos(a)),
                cam.t[1]+cam.r*Math.cos(cam.phi)],
      target:[cam.t[0],-cam.t[2],cam.t[1]], vertical_fov:cam.fov }); }
  e.studioTracks={camera:{keys,vertical_fov:cam.fov},object_tracks:[],device_tracks:[]};
  e._trackMeta={camera:{fps:10,duration:1.6},objects:{},devices:{}};
  const r = await window.WB_AGENT.run('studio.render.submit',{seconds:1.6,fps:10,width:960,height:540});
  return { ok: !!(r&&r.ok), job: r&&r.data&&r.data.job_id, error: r&&r.error };
`);
ok('★ 提交成功', job.ok === true, job.error || job);
if (job.job) {
  let done = null;
  const t1 = Date.now();
  for (let i = 0; i < 300; i++) {
    await wait(3000);
    const stt = await cdp.eval(`
      const r = await window.WB_AGENT.run('studio.render.status', { job_id: ${JSON.stringify(job.job)} });
      const d = (r&&r.data)||{};
      return { status:d.status };`);
    if (stt.status === 'succeeded' || stt.status === 'failed') { done = stt; break; }
  }
  console.log(`  渲染 ${((Date.now()-t1)/1000).toFixed(0)}s:`, JSON.stringify(done));
  ok('★ Blender 渲染成功', done && done.status === 'succeeded', done);
}

console.log('\n════ ⑤ 回到具体楼层 ════');
const back = await cdp.eval(`
  const r = await window.WB_AGENT.run('building.floor', { floor: 0 });
  const d = (r && r.data) || r;
  const e = window.__wb.editor;
  const st = e._cityState;
  let shellVisible = null;
  if (st && st.meshes && st.meshes.buildings) shellVisible = st.meshes.buildings.visible;
  return { ok: !!(r && !r.error && d.ok !== false), floor: d.floor, overview: d.overview,
           err: r && r.error, shellVisible, envelope: !!e._envelope };`);
ok('★ 能从总览回到第 1 层', back.ok === true && back.floor === 0 && back.overview !== true, back);
ok('★ 外壳楼放回来了', back.shellVisible === true, back);
ok('★ 总览线框清掉了', back.envelope === false, back);

const errs = await cdp.eval(`return (window.__ovfErrors||[]).slice(-5);`);
console.log('\n[页面报错]', errs && errs.length ? errs : '无');
console.log(`\n${fail ? '✗' : '✓'} interior-overview: ${pass} passed, ${fail} failed`);
await cdp.close();
process.exit(fail ? 1 : 0);
