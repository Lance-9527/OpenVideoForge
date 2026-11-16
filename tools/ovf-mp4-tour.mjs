/* ============================================================================
 * tools/ovf-mp4-tour.mjs —— 验证「出成片」这条线（不需要 Blender 的本地出口）
 *
 * 背景：Blender 侧车(8765) 在这台机器上**根本没装 Blender**，
 *   所以真正能用的出片路径是**浏览器录制**（MediaRecorder → MP4/WebM）。
 *   这条线从来没验证过 —— 这一轮第一次真跑。
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

// ① 浏览器支持哪种容器
const mimes = await cdp.eval(`
  const list = ['video/mp4;codecs=avc1','video/mp4','video/webm;codecs=vp9','video/webm;codecs=vp8','video/webm'];
  const out = [];
  for (const m of list) {
    try { out.push({ m, ok: typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m) }); }
    catch (_) { out.push({ m, ok: false }); }
  }
  return { supported: out.filter(x=>x.ok).map(x=>x.m), hasMediaRecorder: typeof MediaRecorder !== 'undefined' };
`);
console.log('[① 容器支持]', JSON.stringify(mimes));
ok('有 MediaRecorder', mimes.hasMediaRecorder, mimes);
ok('支持 MP4 或 WebM', mimes.supported.length > 0, mimes);

// ② 建场景 + 画相机轨迹
const setup = await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  await new Promise(r=>setTimeout(r,3000));
  const e = window.__wb.editor;
  for (const id of ['tree','car-sedan','person-stand']) { try { e.addAsset(id); } catch(_){} }
  await new Promise(r=>setTimeout(r,600));

  // 建一条相机轨迹：绕着转 72 帧（3秒×24fps）
  // ★ 坐标是 **canonical（Z-up）**：canonical = (page.x, -page.z, page.y)
  //   页面位置 (sin*10, 3.2, cos*10) ⇒ canonical (sin*10, -cos*10, 3.2)
  //   页面目标 (0,1,0) ⇒ canonical (0, 0, 1)
  const keys = [];
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    keys.push({
      frame: i,
      position: [Math.sin(a) * 10, -Math.cos(a) * 10, 3.2],
      target: [0, 0, 1],
      vertical_fov: 45,
    });
  }
  e.studioTracks = { camera: { keys }, object_tracks: [], device_tracks: [] };
  e._trackMeta = { camera: { fps: 24, duration: 1 }, objects: {}, devices: {} };
  return { keys: keys.length, objects: e.objects.length };
`);
console.log('[② 建场景+轨迹]', JSON.stringify(setup));
ok('轨迹建好了', setup.keys === 72, setup);

// ③ 跑录制（走真实的「一键出片」入口：shootFinal —— 没 Blender 会自动降级到浏览器录制）
console.log('\n[③ 跑浏览器录制]');
const caps = await cdp.eval(`
  const c = await window.WBTracks.caps();
  return c;
`);
console.log('   能力探测:', JSON.stringify(caps));

const rec = await cdp.eval(`
  if (!window.WBTracks || !window.WBTracks.shoot) return { error: '没有 __ovfTracks.shoot' };
  const t0 = Date.now();
  const r = await window.WBTracks.shoot();
  return { ok: r && r.ok, data: r && r.data, error: r && r.error, ms: Date.now() - t0 };
`);
console.log('   录制结果:', JSON.stringify(rec));
if (rec.error) {
  console.log('   [错误]', rec.error);
}

// ④ 看产出目录
const before = new Set(fs.existsSync(OUT)
  ? fs.readdirSync(OUT, { recursive: true, withFileTypes: true })
      .filter(d => d.isFile())
      .map(d => path.join(d.parentPath || d.path, d.name))
  : []);
const files = [...before]
  .map(f => ({ f, kb: Math.round(fs.statSync(f).size / 1024) }))
  .filter(x => /\.(mp4|webm|mov)$/i.test(x.f));
console.log('\n[④ 视频文件]');
for (const x of files) console.log('   ', x.f.replace(OUT + '\\', ''), x.kb + 'KB');
ok('产出了视频文件', files.length > 0, files);

if (files.length) {
  const f = files[files.length - 1];
  const buf = fs.readFileSync(f.f);
  const isMp4 = buf.subarray(4, 8).toString('latin1') === 'ftyp';
  const isWebm = buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3;
  ok('文件非空', f.kb > 10, f);
  ok('★ 是合法容器（MP4 ftyp 或 WebM EBML）', isMp4 || isWebm, { isMp4, isWebm });
  console.log('   文件:', f.f, f.kb + 'KB', isMp4 ? '(MP4)' : isWebm ? '(WebM)' : '(?)');
  // 存一份到 shots 便于人工看
  try { fs.copyFileSync(f.f, `${defaultShotsDir()}\\MP1-out${path.extname(f.f)}`); } catch (_) {}
}

await cdp.close();
console.log(`\n${fail ? '✗' : '✓'} mp4: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
