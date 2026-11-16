/* ============================================================================
 * tools/ovf-blender-ui-tour.mjs —— 真实 UI 路径：点「拍成片」按钮
 * ========================================================================== */
import { defaultOutDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, e === undefined ? '' : '→ ' + JSON.stringify(e)); }
};

// 清掉上次的产物，方便确认这次是新生成的
const OUT = defaultOutDir();
const before = new Set(fs.readdirSync(OUT).filter((f) => /白膜/.test(f)));

await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  await new Promise(r=>setTimeout(r,3000));
  const e = window.__wb.editor;
  for (const id of ['tree','car-sedan','person-stand']) { try { e.addAsset(id); } catch(_){} }
  await new Promise(r=>setTimeout(r,600));
  // 画一圈相机轨迹
  const keys = [];
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    keys.push({ frame:i, position:[Math.sin(a)*10, -Math.cos(a)*10, 2.5], target:[0,0,1], vertical_fov:45 });
  }
  e.studioTracks = { camera:{ keys, vertical_fov:45 }, object_tracks:[], device_tracks:[] };
  e._trackMeta = { camera:{ fps:12, duration:1 }, objects:{}, devices:{} };
  // 轨迹面板是**懒加载**的（build() 在 open() 时才建 DOM）⇒ 必须调 open()
  if (window.WBTracks && window.WBTracks.open) window.WBTracks.open();
  else { const o = window.WBTracks && window.WBTracks.open; }
  return true;
`);
await wait(3000);

// ① 能力显示
const capUi = await cdp.eval(`
  const c = await window.WBTracks.caps(true);
  const el = document.querySelector('#tkCap');
  const shoot = document.querySelector('#tkShoot');
  return { caps: c, ui: el ? el.textContent : null, cls: el ? el.className : null,
           shootExists: !!shoot, shootText: shoot ? shoot.textContent.trim() : null };
`);
console.log('[① 能力]', JSON.stringify(capUi));
ok('★ 页面知道 Blender 在线', capUi.caps && capUi.caps.blender === true, capUi);
ok('★ 轨迹面板里有「拍成片」按钮', capUi.shootExists === true, capUi);
ok('★ 界面上显示「Blender 在线」', /Blender/.test(capUi.ui || ''), capUi);

// ② 点「拍成片」按钮
console.log('\n[② 点拍成片（真实按钮 #tkShoot）]');
const btn = await cdp.eval(`
  const b = document.querySelector('#tkShoot');
  if (!b) return { found:false };
  b.click();
  return { found:true, text: b.textContent.trim() };
`);
console.log('   ', JSON.stringify(btn));
ok('★ 点了拍摄按钮', btn.found, btn);

// ③ 等它跑完
let last = null;
for (let i = 0; i < 90; i++) {
  await wait(2000);
  const st = await cdp.eval(`
    const el = document.querySelector('#tkStatus');
    return { status: el ? el.textContent : null };
  `);
  if (st.status !== last) { console.log('   ', JSON.stringify(st)); last = st.status; }
  if (/✓|拍好了|失败|错误/.test(last || '')) break;
}
ok('★ 状态显示拍好了', /拍好了|✓/.test(last || ''), last);

// ④ 产物落盘
const after = fs.readdirSync(OUT).filter((f) => /白膜/.test(f) && !before.has(f));
console.log('[④ 新产物]', after);
ok('★ 输出了新文件', after.length > 0, after);
for (const f of after) {
  const buf = fs.readFileSync(OUT + '\\' + f);
  const kind = buf.subarray(4, 8).toString('latin1') === 'ftyp' ? 'MP4' : (buf[0] === 0x89 ? 'PNG' : '?');
  console.log('    ', f, Math.round(buf.length / 1024) + 'KB', kind);
  if (kind === 'MP4') {
    const { execFileSync } = await import('node:child_process');
    let p = '';
    try { p = execFileSync('ffprobe', ['-v','error','-show_entries','stream=codec_name,width,height','-of','default=noprint_wrappers=1', OUT+'\\'+f], { encoding:'utf8', timeout:60000 }); }
    catch (e) { p = 'fail ' + e.message; }
    console.log('     ffprobe:', p.replace(/\n/g, ' '));
    ok('★ Blender 出的 MP4 格式正确', /codec_name=h264/.test(p), p.slice(0,150));
    try { fs.copyFileSync(OUT + '\\' + f, `${defaultShotsDir()}\\BL-ui-blender.mp4`); } catch (_) {}
  }
}

const errs = await cdp.eval(`return (window.__ovfErrors||[]);`);
console.log('[页面报错]', errs && errs.length ? errs : '无');
console.log(`\n${fail ? '✗' : '✓'} blender-ui: ${pass} passed, ${fail} failed`);
await cdp.close();
process.exit(fail ? 1 : 0);
