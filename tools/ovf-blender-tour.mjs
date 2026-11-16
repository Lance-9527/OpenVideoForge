/* ============================================================================
 * tools/ovf-blender-tour.mjs —— ★ Blender 离线渲染真跑
 *
 * 前十一轮这条线**一次都没跑过**（本机没装 Blender）。
 * 这一轮装了 Blender 4.2.9 LTS（便携版，在工具目录里），起 VideoForge sidecar，
 * 让 openVideoForge 走真正的 Blender 渲染路径。
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
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};

// ① 能力探测
const caps = await cdp.eval(`
  const r = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_caps',args:{}})});
  const j = await r.json();
  return j.data;
`);
console.log('[① 能力探测]', JSON.stringify(caps));
ok('★ VideoForge 服务在线', caps.service_up === true, caps);
ok('★ Blender 可用', caps.blender === true, caps);
ok('★ 端口是动态探测的（候选多个）',
  Array.isArray(caps.candidates) && caps.candidates.length >= 2, caps);

// ② 建场景 + 轨迹
const setup = await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  await new Promise(r=>setTimeout(r,3000));
  const e = window.__wb.editor;
  for (const id of ['tree','car-sedan']) { try { e.addAsset(id); } catch(_){} }
  await new Promise(r=>setTimeout(r,600));
  // 相机轨迹（canonical Z-up）
  const keys = [];
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    keys.push({ frame:i, position:[Math.sin(a)*9, -Math.cos(a)*9, 3.0], target:[0,0,1], vertical_fov:45 });
  }
  e.studioTracks = { camera:{ keys, vertical_fov:45 }, object_tracks:[], device_tracks:[] };
  e._trackMeta = { camera:{ fps:12, duration:1 }, objects:{}, devices:{} };
  return { objects:e.objects.length, keys:keys.length };
`);
console.log('[② 场景]', JSON.stringify(setup));
ok('场景和轨迹建好了', setup.keys === 12, setup);

// ③ 提交 Blender 渲染
console.log('\n[③ 提交 Blender 渲染（可能几分钟）]');
const t0 = Date.now();
const sub = await cdp.eval(`
  const r = await window.WB_AGENT.run('studio.render.submit', { seconds: 1, fps: 12, width: 640, height: 360 });
  return { ok: !!(r && r.ok), data: r && r.data, error: r && r.error };
`);
console.log('   提交:', JSON.stringify(sub));
ok('★ 提交成功', sub.ok === true, sub);
const jobId = sub.data && (sub.data.job_id || sub.data.id);

if (jobId) {
  // ④ 盯进度
  let last = null;
  for (let i = 0; i < 150; i++) {
    await wait(2000);
    const st = await cdp.eval(`
      const r = await window.WB_AGENT.run('studio.render.status', { job_id: ${JSON.stringify(jobId)} });
      const d = (r && r.data) || {};
      return { status: d.status, progress: d.progress, error: r && r.error,
               outputs: d.manifest && d.manifest.outputs ? d.manifest.outputs.length : 0,
               blender: d.manifest && d.manifest.blender_version };
    `);
    if (JSON.stringify(st) !== JSON.stringify(last)) {
      console.log('   ', JSON.stringify(st), `(${Math.round((Date.now()-t0)/1000)}s)`);
      last = st;
    }
    if (st.status === 'succeeded' || st.status === 'failed' || st.status === 'error') break;
  }
  ok('★ Blender 任务成功', last && last.status === 'succeeded', last);
  ok('★ 用的是真 Blender', last && !!last.blender, last);
  ok('★ 有输出产物', last && last.outputs > 0, last);

  // ⑤ 下载产物（走**桥**的 wb_render_save —— 它是 MCP 工具，不是页面指令）
  const dl = await cdp.eval(`
    const r = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name:'wb_render_save', args:{ job_id: ${JSON.stringify(jobId)}, prefix:'Blender白膜' }})});
    const j = await r.json();
    return j;
  `);
  console.log('[⑤ 下载产物]', JSON.stringify(dl).slice(0, 700));
  const files = (dl && dl.data && dl.data.files) || [];
  ok('★ 产物下载到本地', files.length > 0 && files.some((f) => f.path && fs.existsSync(f.path)), files);
  let mp4 = null;
  for (const f of files) {
    if (!f.path || !fs.existsSync(f.path)) continue;
    const buf = fs.readFileSync(f.path);
    const isMp4 = buf.subarray(4, 8).toString('latin1') === 'ftyp';
    const isPng = buf[0] === 0x89 && buf[1] === 0x50;
    console.log('    ', path.basename(f.path), Math.round(buf.length / 1024) + 'KB',
      isMp4 ? '(MP4)' : isPng ? '(PNG)' : '(?)');
    if (isMp4) mp4 = f.path;
  }
  ok('★ 出了 MP4', !!mp4, files.map((f) => f.path));

  // ⑥ 用 ffmpeg 验证 MP4 真能解码
  if (mp4) {
    const { execFileSync } = await import('node:child_process');
    let probe = '';
    try {
      probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
        'stream=codec_name,width,height,duration', '-of', 'default=noprint_wrappers=1', mp4],
        { encoding: 'utf8', timeout: 60000 });
    } catch (e) { probe = 'ffprobe 失败: ' + e.message; }
    console.log('[⑥ ffprobe]\n' + probe.trim());
    ok('★ Blender 出的 MP4 能被 ffmpeg 识别', /codec_name=h264/.test(probe), probe.slice(0, 200));
    try { fs.copyFileSync(mp4, `${defaultShotsDir()}\\BL1-blender.mp4`); } catch (_) {}
  }
}

const errs = await cdp.eval(`return (window.__ovfErrors||[]);`);
console.log('[页面报错]', errs && errs.length ? errs : '无');
console.log(`\n${fail ? '✗' : '✓'} blender: ${pass} passed, ${fail} failed`);
await cdp.close();
process.exit(fail ? 1 : 0);
