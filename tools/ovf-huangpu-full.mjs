#!/usr/bin/env node
/* ============================================================================
 * tools/ovf-huangpu-full.mjs —— ★ 上海黄浦区全境（2.5km）端到端压测
 *
 * 用户要求："真实里面楼栋数是多少给多少，有哪些就给哪些，按真实的来"
 *   8096 栋楼 / 5682 条路 / 50 水面 / 357 绿地 / 750 棵树
 *   ⇒ 要看页面建场景多久、Blender 渲多久、能不能出片
 * ========================================================================== */
import { defaultOutDir, defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = defaultOutDir();
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
  const m=document.querySelector('#modal'); if(m) m.hidden=true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden=true; }
  const ed=document.querySelector('#view-editor'); if(ed) ed.hidden=false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  await new Promise(r=>setTimeout(r,3000));
  return true;`);
await wait(2000);

console.log('\n════ ① 载入全境数据（8096 栋）════');
const t0 = Date.now();
const build = await cdp.eval(`
  const t0 = Date.now();
  const res = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_world_build',args:{kind:'osm',lat:31.2336,lng:121.4799,radius:2500}})});
  const j = await res.json();
  return { ms: Date.now()-t0, ok:j.ok, stats:j.stats, terrain:j.terrain, url:j.url,
           pageOk: j.page && j.page.ok, pageErr: j.page && j.page.error,
           pageData: j.page && j.page.data ? { buildings:j.page.data.buildings, roads:j.page.data.roads,
             worldSize:j.page.data.worldSize, size:j.page.data.size, drawCalls:j.page.data.drawCalls } : null };
`);
console.log('  ', JSON.stringify(build).slice(0, 600));
ok('★ 服务端缓存命中（不重新抓）', build.ms < 5000, { ms: build.ms });
// ★ 按 bbox 裁剪后，越界要素会被剔除（实测上海 2.5km：8096 → 7990，skipped 101）
ok('★ 楼栋数 ≥ 7900（真实黄浦区全量）', build.stats.buildings >= 7900, build.stats);
ok('★ 跳过的都是越界要素（< 300）', build.stats.skipped < 300, build.stats);
ok('★ 道路 ≥ 5000', build.stats.roads >= 5000, build.stats);
ok('★ 有水（黄浦江）', build.stats.waters > 40, build.stats);
ok('★ 有树', build.stats.trees > 300, build.stats);
ok('★ 页面侧建场景成功', build.pageOk === true, build.pageErr || build);

console.log('\n════ ② 场景状态 + 出图 ════');
const st = await cdp.eval(`
  const e = window.__wb.editor;
  await new Promise(r=>setTimeout(r,1500));
  let tris=0, meshes=0;
  e.envGroup.traverse(o=>{ if(o.isMesh){ meshes++; const g=o.geometry;
    tris += (g.index?g.index.count:g.attributes.position.count)/3; } });
  const url = e.captureThumb(1280,720);
  return { meshes, tris: Math.round(tris),
           target:[Math.round(e.target.x),Math.round(e.target.y),Math.round(e.target.z)],
           r: Math.round(e.sph.r),
           thumb: url ? url.length : 0, data: url ? url.split(',')[1] : null };
`);
console.log('  ', JSON.stringify({ ...st, data: st.data ? st.data.length + ' b64' : null }));
ok('★ 场景有几何', st.tris > 100000, st);
ok('★ 相机在楼群上', st.target[1] > 0, st);
ok('★ 主视口出图', st.thumb > 10000, { len: st.thumb });
if (st.data) {
  fs.writeFileSync(path.join(SHOTS, 'HUANGPU-full-main.jpg'), Buffer.from(st.data, 'base64'));
  console.log('  已存: ovf_shots\\HUANGPU-full-main.jpg');
}

console.log('\n════ ③ Blender 渲染（8096 栋）════');
const job = await cdp.eval(`
  const e = window.__wb.editor;
  const cam = e.captureCam();
  const tx=cam.t[0], ty=cam.t[1], tz=cam.t[2], phi=cam.phi, rad=cam.r;
  const keys=[]; const N=24;
  for (let i=0;i<N;i++){
    const a=cam.theta+(i/N)*Math.PI*2;
    keys.push({ frame:i,
      position:[tx+rad*Math.sin(phi)*Math.sin(a), -(tz+rad*Math.sin(phi)*Math.cos(a)), ty+rad*Math.cos(phi)],
      target:[tx,-tz,ty], vertical_fov:cam.fov });
  }
  e.studioTracks={camera:{keys,vertical_fov:cam.fov},object_tracks:[],device_tracks:[]};
  e._trackMeta={camera:{fps:12,duration:2},objects:{},devices:{}};
  const t=Date.now();
  const res = await window.WB_AGENT.run('studio.render.submit',{seconds:2,fps:12,width:1280,height:720});
  return { ok: !!(res&&res.ok), job: res&&res.data&&res.data.job_id, error: res&&res.error, ms: Date.now()-t };
`);
console.log('  提交:', JSON.stringify(job));
ok('★ 提交成功', job.ok === true, job.error || job);
if (job.job) {
  let done = null;
  const t1 = Date.now();
  for (let i = 0; i < 400; i++) {
    await wait(3000);
    const stt = await cdp.eval(`
      const r = await window.WB_AGENT.run('studio.render.status',{ job_id: ${JSON.stringify(job.job)} });
      const d = (r&&r.data)||{};
      return { status:d.status, progress:d.progress, blender:d.manifest&&d.manifest.blender_version,
               outputs: d.manifest && d.manifest.outputs ? d.manifest.outputs.length : 0 };`);
    if (stt.status === 'succeeded' || stt.status === 'failed') { done = stt; break; }
  }
  console.log(`  渲染用时 ${((Date.now()-t1)/1000).toFixed(0)}s:`, JSON.stringify(done));
  ok('★ Blender 渲染成功', done && done.status === 'succeeded', done);
  const dl = await cdp.eval(`
    const res = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name:'wb_render_save',args:{ job_id:${JSON.stringify(job.job)}, prefix:'上海黄浦区全境'}})});
    return await res.json();`);
  const files = (dl.data && dl.data.files) || [];
  console.log('  产物:', files.map((f) => path.basename(f.path || '')).join(', '));
  ok('★ 产物落到本地', files.length > 0, files);
  const png = files.find((f) => /\.png$/i.test(f.path || ''));
  const mp4 = files.find((f) => /\.mp4$/i.test(f.path || ''));
  if (png) { fs.copyFileSync(png.path, path.join(SHOTS, 'HUANGPU-full-blender.png')); console.log('  已存: ovf_shots\\HUANGPU-full-blender.png'); }
  if (mp4) console.log('  MP4:', mp4.path, (mp4.bytes/1048576).toFixed(1)+'MB');
}

const errs = await cdp.eval(`return (window.__ovfErrors||[]).slice(-5);`);
console.log('\n[页面报错]', errs && errs.length ? errs : '无');
console.log(`\n${fail ? '✗' : '✓'} huangpu-full: ${pass} passed, ${fail} failed`);
await cdp.close();
process.exit(fail ? 1 : 0);
