/* ============================================================================
 * tools/ovf-accept-tour.mjs —— ★ 用户三条需求的端到端验收
 *
 *   ① 任意选一个城市 → 调出来并在场景中复刻
 *   ② 要一个模型 → 借鉴并放进现有场景
 *   ③ 之前的操作都还能做（拍照、轨迹视频）
 *
 * 用的是**没抓过的城市**（缓存里只有上海/东京）⇒ 走真实网络抓取。
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

// ═══════════ ① 任意城市 → 复刻 ═══════════
console.log('\n════ ① 任意选城市 → 调出来复刻 ════');
const CITY = process.argv[2] || '雷克雅未克';

// ★ 先开编辑器 —— wb_world_build 服务端会调页面侧的 world.osm 来建几何，
//   编辑器没开的话页面侧直接报错（实测踩到）。
await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  await new Promise(r=>setTimeout(r,3500));
  return true;
`);
await wait(2500);
const edOpen = await cdp.eval(`return { open: !!(window.__wb && window.__wb.editor), objects: (window.__wb.editor||{}).objects ? window.__wb.editor.objects.length : -1 };`);
console.log('  编辑器:', JSON.stringify(edOpen));
ok('★ 编辑器开着', edOpen.open === true, edOpen);

const geo = await cdp.eval(`
  const r = await fetch('http://127.0.0.1:8787/geocode?q=' + encodeURIComponent(${JSON.stringify(CITY)}));
  const j = await r.json();
  return j;
`);
console.log('  地名解析:', JSON.stringify(geo.city || geo.error));
ok('★ 城市名能解析出坐标', !!(geo.city && geo.city.lat), geo);

const grab = await cdp.eval(`
  const t0 = Date.now();
  const r = await fetch('http://127.0.0.1:8787/tool', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name:'wb_world_build', args:{ kind:'osm',
      lat: ${geo.city.lat}, lng: ${geo.city.lng}, radius: 300 } })});
  const j = await r.json();
  const e = window.__wb.editor;
  let meshes = 0, tris = 0;
  e.scene.traverse(n => { if (n.isMesh) { meshes++; const g=n.geometry; if (g&&g.index) tris+=g.index.count/3; else if (g&&g.attributes.position) tris+=g.attributes.position.count/3; } });
  // ★ wb_world_build 的返回是**顶层** {ok, key, url, stats, page, terrain}
  //   —— 不是包在 data 里（之前写成 j.data ⇒ stats 永远读到空，实测踩到）
  const d = j;
  const pg = d.page || {};
  const st = d.stats || {};
  return { ok: j.ok, error: j.error, ms: Date.now()-t0,
           url: d.url, stats: st, buildings: st.buildings || st.buildingsTotal || st.building_count || 0,
           terrain: !!d.terrain,
           pageOk: pg.ok === true, pageErr: pg.error,
           meshes, tris: Math.round(tris), env: e.envId, badge: (document.querySelector('#edEnvBadge')||{}).textContent };
`);
console.log('  抓取:', JSON.stringify(grab).slice(0, 460));
ok('★ OSM 抓取成功', grab.ok === true, grab);
ok('★ 抓到建筑数据', (grab.buildings || 0) > 0, grab);
ok('★ 页面侧建场景成功', grab.pageOk === true, grab);
ok('★ 场景里真的有几何', grab.meshes > 0 && grab.tris > 100, grab);
ok('★ 环境标成「真实世界」', grab.env === 'osm' || grab.env === 'real' || /真实/.test(String(grab.badge)), grab);
console.log('  地形高程:', grab.terrain ? '✓ 拿到' : '✗ 没拿到（会降级成平地）');

// ═══════════ ② 要一个模型 → 放进现有场景 ═══════════
console.log('\n════ ② 要模型 → 借鉴并放进现有场景 ════');
const model = await cdp.eval(`
  const e = window.__wb.editor;
  const before = e.objects.length;
  // 从**资产库**拿一个模型（不是内置资产）——这才是"借鉴一个模型"
  const list = await (await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_library_list',args:{kind:'model'}})}).then(r=>r.json()));
  // ★ 要挑**有真实几何**的模型：库里可能有验收器留下的空壳 GLB（119 字节），
  //   拿它当"借鉴一个模型"的样本会导出一个没有几何的空模型（实测踩到）。
  const items = (list.items||[]).filter(i => i.thumb && (i.bytes||0) > 5000);
  const it = items[0];
  if (!it) return { error:'资产库没有像样的模型（>5KB）' };
  const url = 'http://127.0.0.1:8787/library/file/' + encodeURIComponent(it.id);
  const rec = await e.addExternalAsset({ id: it.id, name: it.name, file_url: url });
  await new Promise(r=>setTimeout(r,2500));
  const r2 = e.setObjectPbr ? e.setObjectPbr('Bricks113A') : {ok:false};
  e.select(rec);
  // 摆到场景里一个具体位置
  rec.group.position.set(12, 0, -8);
  rec.group.rotation.y = 0.6;
  await new Promise(r=>setTimeout(r,600));
  let meshes = 0;
  rec.group.traverse(n => { if (n.isMesh) meshes++; });
  return { ok: !!(rec && rec.group), name: it.name, id: it.id,
           before, after: e.objects.length, meshes,
           pos: rec.group.position.toArray().map(v=>+v.toFixed(1)),
           pbrId: rec.pbrId, external: !!rec.externalAsset };
`);
console.log('  放模型:', JSON.stringify(model));
ok('★ 模型放进了场景', model.ok && model.after === model.before + 1, model);
ok('★ 模型有实际几何', model.meshes > 0, model);
ok('★ 位置/朝向生效', model.pos && model.pos[0] === 12, model);
ok('★ 还能给它指定 PBR 贴图', model.pbrId === 'Bricks113A', model);

// ═══════════ ③ 拍照 + 轨迹视频 ═══════════
console.log('\n════ ③ 拍照 / 轨迹视频 ════');
const shot = await cdp.eval(`
  const e = window.__wb.editor;
  const t0 = Date.now();
  const url = e.captureThumb(960, 540);
  return { ok: !!url, len: url ? url.length : 0, ms: Date.now()-t0, head: url ? url.slice(0,30) : null };
`);
console.log('  拍照:', JSON.stringify(shot));
ok('★ 能出图（缩略图/拍照）', shot.ok && shot.len > 3000, shot);

// 轨迹视频（Blender）
const track = await cdp.eval(`
  const e = window.__wb.editor;
  const keys = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    keys.push({ frame:i, position:[Math.sin(a)*14, -Math.cos(a)*14, 4.0], target:[0,0,2], vertical_fov:45 });
  }
  e.studioTracks = { camera:{ keys, vertical_fov:45 }, object_tracks:[], device_tracks:[] };
  e._trackMeta = { camera:{ fps:12, duration:1 }, objects:{}, devices:{} };
  return { keys: keys.length };
`);
console.log('  轨迹:', JSON.stringify(track));

const before = new Set(fs.readdirSync(OUT).filter(f => /白膜/.test(f)));
const job = await cdp.eval(`
  const r = await window.WB_AGENT.run('studio.render.submit', { seconds: 1, fps: 12, width: 960, height: 540 });
  return { ok: !!(r && r.ok), job: r && r.data && r.data.job_id, error: r && r.error };
`);
console.log('  提交:', JSON.stringify(job));
ok('★ 轨迹视频提交成功', job.ok === true, job);

if (job.job) {
  let done = null;
  for (let i = 0; i < 120; i++) {
    await wait(2000);
    const st = await cdp.eval(`
      const r = await window.WB_AGENT.run('studio.render.status', { job_id: ${JSON.stringify(job.job)} });
      const d = (r && r.data) || {};
      return { status: d.status, progress: d.progress, blender: d.manifest && d.manifest.blender_version,
               outputs: d.manifest && d.manifest.outputs ? d.manifest.outputs.length : 0 };
    `);
    if (st.status === 'succeeded') { done = st; break; }
    if (st.status === 'failed' || st.status === 'error') { done = st; break; }
  }
  console.log('  渲染:', JSON.stringify(done));
  ok('★ Blender 视频渲染成功', done && done.status === 'succeeded', done);
  ok('★ 用的是真 Blender', done && /4\.2/.test(String(done.blender)), done);

  const dl = await cdp.eval(`
    const r = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name:'wb_render_save',args:{job_id:${JSON.stringify(job.job)},prefix:'验收白膜'}})});
    return await r.json();
  `);
  const files = (dl.data && dl.data.files) || [];
  console.log('  产物:', files.map(f => path.basename(f.path || '')).join(', '));
  ok('★ 产物落到本地', files.length > 0 && files.every(f => f.path && fs.existsSync(f.path)), files);
  const mp4 = files.find(f => /\.mp4$/i.test(f.path || ''));
  if (mp4) {
    const { execFileSync } = await import('node:child_process');
    let p = '';
    try { p = execFileSync('ffprobe', ['-v','error','-show_entries','stream=codec_name,width,height','-of','default=noprint_wrappers=1', mp4.path], { encoding:'utf8', timeout:60000 }); }
    catch (e) { p = 'fail'; }
    console.log('  ffprobe:', p.replace(/\n/g,' '));
    ok('★ MP4 格式正确（h264）', /codec_name=h264/.test(p), p.slice(0,120));
    try { fs.copyFileSync(mp4.path, `${defaultShotsDir()}\\ACCEPT-blender.mp4`); } catch (_) {}
  }
}

const errs = await cdp.eval(`return (window.__ovfErrors||[]);`);
console.log('\n[页面报错]', errs && errs.length ? errs : '无');
console.log(`\n${fail ? '✗' : '✓'} accept: ${pass} passed, ${fail} failed`);
await cdp.close();
process.exit(fail ? 1 : 0);
