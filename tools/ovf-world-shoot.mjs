/* ============================================================================
 * tools/ovf-world-shoot.mjs —— ★ 真实城市场景「调出来之后能不能拍」
 *
 * 上一次验收：功能全通，但画面是黑的 —— 相机在地形下面。
 * 原因：OSM 真实场景的实际尺度是 **7248m**（真实街区被放大约 12 倍，
 *       和程序化城市的街区尺度对齐），而测试随手给的相机半径只有 14m。
 *
 * 这一版：**按场景实际尺度**算相机（半径 = size/5，高度 = 地形高 + 相对高度），
 *          再看渲染出来是不是一个"能用的真实街区"。
 * ========================================================================== */
import { defaultOutDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
const OUT = defaultOutDir();
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
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  await new Promise(r=>setTimeout(r,3000));
  return true;
`);
await wait(2500);

// ① 装真实城市
console.log('\n① 装真实城市（京都 300m）');
const city = await cdp.eval(`
  const r = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_world_build',args:{kind:'osm',lat:35.0116,lng:135.7681,radius:300}})});
  const j = await r.json();
  const e = window.__wb.editor;
  const info = j.page && j.page.data ? j.page.data : {};
  return { ok: j.ok, stats: j.stats, terrain: j.terrain,
           worldSize: info.worldSize, factor: info.factor, size: info.size,
           tallest: info.world && info.world.tallest };
`);
console.log('  ', JSON.stringify(city));
ok('★ 真实城市装好了', city.ok === true && city.stats.buildings > 0, city);
const SIZE = city.worldSize || 3000;
const H = city.terrain ? (city.terrain.maxH + city.terrain.minH) / 2 : 0;
console.log(`  场景尺度: ${Math.round(SIZE)}m   地形高: ${city.terrain ? city.terrain.minH + '~' + city.terrain.maxH + 'm' : '无'}`);

// ② 用编辑器自己的取景（这就是产品行为）+ 按地面高度放参照物
console.log('\n② 相机自动取景 + 按地面高度放参照物');
const scene = await cdp.eval(`
  const e = window.__wb.editor;
  // ★ 不手设相机 —— 用 loadOsmWorld 自己的取景（_osmFraming）
  //   这才是用户点「调出真实城市」之后看到的画面
  const t = { x: e.target.x, y: e.target.y, z: e.target.z };
  // 摆 5 个人当尺度参照（y 用地面高度）
  for (let i = 0; i < 5; i++) { try { e.addAsset('person-stand'); } catch(_) {} }
  await new Promise(r=>setTimeout(r,900));
  const people = e.objects.slice(-5);
  const gy = e.groundHeightAt ? e.groundHeightAt(t.x, t.z) : 0;
  const spread = 6;
  people.forEach((p,i)=>{ p.group.position.set(t.x - spread + i*spread/2, gy, t.z + 4); });
  await new Promise(r=>setTimeout(r,700));
  const thumb = e.captureThumb(960, 540);
  return { target: { x: Math.round(t.x), y: Math.round(t.y), z: Math.round(t.z) },
           groundY: Math.round(gy), people: people.length, objects: e.objects.length,
           r: Math.round(e.sph.r), phi: e.sph.phi, thumbLen: thumb ? thumb.length : 0 };
`);
console.log('  ', JSON.stringify(scene));
ok('★ 相机自动落在楼群上', scene.target.y > 5, scene);
ok('★ 参照物站在地面上', scene.groundY > 5, scene);
ok('★ 主视口能出图', scene.thumbLen > 3000, scene);

// ③ 主视口出图（看画面对不对）
const shot = await cdp.eval(`
  const e = window.__wb.editor;
  const url = e.captureThumb(960, 540);
  return { len: url ? url.length : 0, data: url ? url.split(',')[1] : null };
`);
console.log('  主视口出图:', shot.len, '字节');
if (shot.data) {
  fs.writeFileSync(`${defaultShotsDir()}\\WORLD-mainview.jpg`,
    Buffer.from(shot.data, 'base64'));
  console.log('  已存: ovf_shots\\WORLD-mainview.jpg');
}

// ④ Blender 渲染（用编辑器自己的相机轨迹 —— 从主相机轨迹推）
console.log('\n④ Blender 渲染（用编辑器自己的机位状态换算）');
const job = await cdp.eval(`
  const e = window.__wb.editor;
  // ★ **别手算相机**：用 editor 的 captureCam() 拿真实机位，
  //   再按"绕 target 转一圈"生成 canonical 轨迹。
  //   （之前手写 [t.x+sin*R, -(t.z+cos*R), ...] 漏了 phi/theta ⇒ 相机在场景外 ⇒ 灰）
  const cam = e.captureCam();
  // ★ captureCam().t 是**数组** [x,y,z]，不是 Vector3
  const tx = cam.t[0], ty = cam.t[1], tz = cam.t[2];
  const phi = cam.phi, rad = cam.r;
  const keys = [];
  const N = 24;
  for (let i = 0; i < N; i++) {
    const a = cam.theta + (i / N) * Math.PI * 2;
    const px = tx + rad * Math.sin(phi) * Math.sin(a);
    const py = ty + rad * Math.cos(phi);
    const pz = tz + rad * Math.sin(phi) * Math.cos(a);
    // canonical = (page.x, -page.z, page.y)
    keys.push({ frame:i, position:[px, -pz, py], target:[tx, -tz, ty], vertical_fov: cam.fov });
  }
  e.studioTracks = { camera:{ keys, vertical_fov: cam.fov }, object_tracks:[], device_tracks:[] };
  e._trackMeta = { camera:{ fps:12, duration:2 }, objects:{}, devices:{} };
  const res = await window.WB_AGENT.run('studio.render.submit', { seconds: 2, fps: 12, width: 960, height: 540 });
  return { ok: !!(res && res.ok), job: res && res.data && res.data.job_id, error: res && res.error,
           cam: { rad: Math.round(rad), phi: +phi.toFixed(2), theta: +cam.theta.toFixed(2),
                  t: [Math.round(tx), Math.round(ty), Math.round(tz)] } };
`);
console.log('  提交:', JSON.stringify(job));
ok('★ 提交成功', job.ok === true, job);
if (job.job) {
  let done = null;
  for (let i = 0; i < 180; i++) {
    await wait(2000);
    const st = await cdp.eval(`
      const r = await window.WB_AGENT.run('studio.render.status', { job_id: ${JSON.stringify(job.job)} });
      const d = (r && r.data) || {};
      return { status: d.status, progress: d.progress, blender: d.manifest && d.manifest.blender_version,
               frames: d.manifest && d.manifest.render && d.manifest.render.frame_count };
    `);
    if (st.status === 'succeeded' || st.status === 'failed') { done = st; break; }
  }
  console.log('  渲染:', JSON.stringify(done));
  ok('★ Blender 渲染成功', done && done.status === 'succeeded', done);

  const dl = await cdp.eval(`
    const r = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name:'wb_render_save',args:{job_id:${JSON.stringify(job.job)},prefix:'京都街区'}})});
    return await r.json();
  `);
  const files = (dl.data && dl.data.files) || [];
  console.log('  产物:', files.map(f => path.basename(f.path || '')).join(', '));
  ok('★ 产物落到本地', files.length > 0 && files.every(f => f.path && fs.existsSync(f.path)), files);
  const png = files.find(f => /\.png$/i.test(f.path || ''));
  if (png) {
    fs.copyFileSync(png.path, `${defaultShotsDir()}\\WORLD-blender.png`);
    console.log('  已存: ovf_shots\\WORLD-blender.png');
  }
}

const errs = await cdp.eval(`return (window.__ovfErrors||[]);`);
console.log('\n[页面报错]', errs && errs.length ? errs : '无');
console.log(`\n${fail ? '✗' : '✓'} world-shoot: ${pass} passed, ${fail} failed`);
await cdp.close();
process.exit(fail ? 1 : 0);
