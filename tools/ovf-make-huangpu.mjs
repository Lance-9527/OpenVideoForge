#!/usr/bin/env node
/* ============================================================================
 * tools/ovf-make-huangpu.mjs —— ★ 做「上海黄浦区」真实场景
 *
 * 完整链路：
 *   地名（"黄浦区"/"黄埔区"/"外滩"）→ 坐标 → Overpass 抓 OSM → 地形高程
 *   → 页面建几何 → 存进「我的场景」→ 出图 → Blender 渲染 MP4
 *
 * 这一条是给用户的**具体交付**：上海黄浦区的真实街区。
 * ========================================================================== */
import { defaultOutDir, defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';

const OUT = defaultOutDir();
const SHOT_DIR = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, e === undefined ? '' : '→ ' + JSON.stringify(e)); }
};

// ★ 页面侧要建场景 ⇒ 编辑器必须先开着（否则 pageCall 找不到 editor）
await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e) {} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  await new Promise(r=>setTimeout(r,3000));
  return true;
`);
await wait(2000);

console.log('\n════ ① 地名解析（黄浦区 / 黄埔区 / 外滩 都要能查到）════');
const geo = await cdp.eval(`
  const B='http://127.0.0.1:8787';
  const call = async (n,a={}) => await (await fetch(B+'/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:n,args:a})})).json();
  const out = {};
  for (const q of ['黄浦区','黄埔区','外滩','黄浦']) {
    const r = await call('wb_world_info', {});   // 占位，下面用 /geocode
    out[q] = null;
  }
  return out;
`);
// 直接用桥的 /geocode 路由（服务端接口）
for (const q of ['黄浦区', '黄埔区', '外滩']) {
  const r = await fetch('http://127.0.0.1:8787/geocode?q=' + encodeURIComponent(q)).then((x) => x.json());
  const c = r.city || (r.data && r.data.city);
  ok(`★ 「${q}」→ 坐标`, !!(c && Number.isFinite(c.lat)), r);
  if (q === '黄浦区') {
    console.log('     ', JSON.stringify(c));
    globalThis.LAT = c.lat; globalThis.LNG = c.lng;
  }
}
const LAT = globalThis.LAT, LNG = globalThis.LNG;

console.log('\n════ ② 抓取真实世界（Overpass + 地形）════');
const t0 = Date.now();
const build = await cdp.eval(`
  const res = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_world_build',args:{ kind:'osm', lat:${LAT}, lng:${LNG}, radius:600 }})});
  const j = await res.json();
  return { ok: j.ok, stats: j.stats, terrain: j.terrain, url: j.url, error: j.error,
           pageRaw: JSON.stringify(j.page).slice(0, 500),
           page: j.page && j.page.data ? { ok:j.page.ok, env:j.page.env, size:j.page.size,
             worldSize:j.page.worldSize, buildings:j.page.buildings, roads:j.page.roads } : j.page };
`);
console.log('  ', JSON.stringify(build).slice(0, 700));
ok('★ 抓取成功', build.ok === true, build.error || build);
ok('★ 抓到建筑', (build.stats && build.stats.buildings) > 100, build.stats);
ok('★ 抓到道路', (build.stats && build.stats.roads) > 20, build.stats);
ok('★ 拿到地形高程', !!(build.terrain && build.terrain.tiles), build.terrain);
console.log(`  耗时 ${Date.now() - t0}ms`);

console.log('\n════ ③ 页面建场景 + 存进「我的场景」════');
const scene = await cdp.eval(`
  const e = window.__wb.editor;
  const out = { objects: e.objects.length, env: e.envId, target: [Math.round(e.target.x), Math.round(e.target.y), Math.round(e.target.z)] };
  // 存进「我的场景」
  try {
    const mod = await import('./js/studio-scene.js?v=77');
    out.save = await mod.saveScene ? await mod.saveScene(e) : 'no-saveScene';
  } catch (err) { out.saveErr = String(err && err.message || err); }
  // 退而求其次：用页面顶栏的保存
  if (!out.save || out.save === 'no-saveScene') {
    try { await window.WB_AGENT.run('scene.save', { name: '上海黄浦区（真实世界）' }); out.save = 'scene.save'; }
    catch (err) { out.saveErr2 = String(err && err.message || err); }
  }
  return out;
`);
console.log('  ', JSON.stringify(scene));
ok('★ 场景建好了', scene.objects > 0 || scene.env === 'osm', scene);
ok('★ 存进我的场景', !!(scene.save && scene.save !== 'no-saveScene'), scene);

console.log('\n════ ④ 出图（主视口 + 真实感预览）════');
const shot = await cdp.eval(`
  const e = window.__wb.editor;
  await new Promise(r=>setTimeout(r,1200));
  const url = e.captureThumb(1280, 720);
  return { len: url ? url.length : 0, data: url ? url.split(',')[1] : null };
`);
ok('★ 主视口出图', shot.len > 5000, { len: shot.len });
if (shot.data) {
  fs.writeFileSync(path.join(SHOT_DIR, 'HUANGPU-main.jpg'), Buffer.from(shot.data, 'base64'));
  console.log('  已存: ovf_shots\\HUANGPU-main.jpg');
}

console.log('\n════ ⑤ Blender 渲染（真实街区 → MP4）════');
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
  const res = await window.WB_AGENT.run('studio.render.submit',{seconds:2,fps:12,width:1280,height:720});
  return { ok: !!(res&&res.ok), job: res&&res.data&&res.data.job_id, error: res&&res.error, rad: Math.round(rad) };
`);
console.log('  提交:', JSON.stringify(job));
ok('★ 提交成功', job.ok === true, job.error || job);
if (job.job) {
  let done = null;
  for (let i = 0; i < 200; i++) {
    await wait(2000);
    const st = await cdp.eval(`
      const r = await window.WB_AGENT.run('studio.render.status',{ job_id: ${JSON.stringify(job.job)} });
      const d = (r&&r.data)||{};
      return { status:d.status, progress:d.progress, blender:d.manifest&&d.manifest.blender_version };`);
    if (st.status === 'succeeded' || st.status === 'failed') { done = st; break; }
  }
  console.log('  渲染:', JSON.stringify(done));
  ok('★ Blender 渲染成功', done && done.status === 'succeeded', done);
  const dl = await cdp.eval(`
    const res = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name:'wb_render_save',args:{ job_id:${JSON.stringify(job.job)}, prefix:'上海黄浦区'}})});
    return await res.json();`);
  const files = (dl.data && dl.data.files) || [];
  console.log('  产物:', files.map((f) => path.basename(f.path || '')).join(', '));
  ok('★ 产物落到本地', files.length > 0, files);
  const png = files.find((f) => /\.png$/i.test(f.path || ''));
  const mp4 = files.find((f) => /\.mp4$/i.test(f.path || ''));
  if (png) { fs.copyFileSync(png.path, path.join(SHOT_DIR, 'HUANGPU-blender.png')); console.log('  已存: ovf_shots\\HUANGPU-blender.png'); }
  if (mp4) {
    const { execSync } = await import('node:child_process');
    try {
      const out = execSync(`ffprobe -v error -show_entries stream=codec_name,width,height -of csv=p=0 "${mp4.path}"`).toString().trim();
      console.log('  ffprobe:', out);
      ok('★ MP4 格式正确（h264）', /h264/.test(out), out);
    } catch (e) { console.log('  ffprobe 失败:', e.message.slice(0, 100)); }
    console.log('  MP4:', mp4.path);
  }
}

const errs = await cdp.eval(`return (window.__ovfErrors||[]).slice(-5);`);
console.log('\n[页面报错]', errs && errs.length ? errs : '无');
console.log(`\n${fail ? '✗' : '✓'} huangpu: ${pass} passed, ${fail} failed`);
await cdp.close();
process.exit(fail ? 1 : 0);
