#!/usr/bin/env node
/* ============================================================================
 * tools/ovf-recheck-fails.mjs —— 把综合验收里剩下的失败项，用**真实输入**单独重跑
 *
 * 目的：分清"产品坏了"和"我喂参不对"。
 * ========================================================================== */
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, e === undefined ? '' : '→ ' + JSON.stringify(e)); }
};

const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  await new Promise(r=>setTimeout(r,3000));
  return true;`);

const call = async (name, args = {}) => {
  const r = await cdp.eval(`
    const res = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
      body: JSON.stringify({name:${JSON.stringify(name)},args:${JSON.stringify(args)}})});
    return await res.json();`);
  return r;
};

/* ── 真实素材 ─────────────────────────────────────────────────────── */
const IBOX = `${defaultOutDir()}\\外部素材收件箱`;
const inboxFile = fs.existsSync(IBOX) ? fs.readdirSync(IBOX).find((f) => /\.(glb|gltf|png|jpe?g)$/i.test(f)) : null;
const VF_ASSETS = `${path.join(defaultDataDir(), 'studio_bridge', 'assets')}`;
let glb = null, vfAssetId = null;
if (fs.existsSync(VF_ASSETS)) {
  const d = fs.readdirSync(VF_ASSETS)[0];
  const p = path.join(VF_ASSETS, d, 'model.glb');
  if (fs.existsSync(p)) { glb = p; vfAssetId = d; }
}
console.log('真实素材: 收件箱文件 =', inboxFile, ' GLB =', glb, ' VF asset =', vfAssetId);

console.log('\n1. wb_inbox_import / wb_library_import_model');
if (inboxFile) {
  const a = await call('wb_inbox_import', { file: inboxFile, name: '验收导入' });
  ok('★ wb_inbox_import 导入收件箱文件', a.ok === true, a.error || a);
  const b = await call('wb_library_import_model', { file: inboxFile, name: '验收模型' });
  ok('★ wb_library_import_model 导入收件箱文件', b.ok === true, b.error || b);
} else { ok('★ 收件箱里有文件', false, IBOX); }

console.log('\n2. wb_asset_upload（磁盘 GLB → VideoForge 受管资产）');
if (glb) {
  const r = await call('wb_asset_upload', { path: glb, name: '验收上传' });
  ok('★ wb_asset_upload 上传 GLB', r.ok === true, r.error || r);
  if (r.ok) {
    const id = r.data && r.data.id;
    console.log('   新资产 id:', id);
    // ③ wb_studio_render 用这个 id
    const s = await call('wb_studio_render', { asset_id: id, w: 320, h: 320, frames: 2, samples: 32 });
    ok('★ wb_studio_render 用刚上传的资产出图', s.ok === true, s.error || s);
    // ④ wb_handoff 用这个 id 跑整条流水线
    const h = await call('wb_handoff', { asset_id: id, seconds: 1, fps: 8, width: 320, height: 320 });
    ok('★ wb_handoff 整条流水线', h.ok === true, h.error || (h.steps || []));
    if (!h.ok && h.steps) for (const s2 of h.steps) console.log('     步骤', s2.step, s2.ok ? '✓' : '✗', s2.error || '');
  }
} else { ok('★ 有真实 GLB', false, VF_ASSETS); }

console.log('\n3. wb_preset_rename（用真实存在的预设 id）');
await call('wb_preset_save', { name: '验收改名目标' });
const list = await call('wb_preset_list', {});
const presets = (list.presets || (list.data && list.data.presets) || []);
const target = presets.find((p) => p.id !== '验收改名目标');
console.log('   可用预设:', presets.map((p) => p.id).join(', '));
if (target) {
  const r = await call('wb_preset_rename', { id: target.id, name: '验收改名后', note: '验收' });
  ok('★ wb_preset_rename 改名', r.ok === true, r.error || r);
} else ok('★ 有可用预设', false, presets.length);

console.log('\n4. wb_previz_import_model / wb_previz_import_scene');
if (glb) {
  const m = await call('wb_previz_import_model', { file: glb, path: glb, name: '验收白膜' });
  ok('★ wb_previz_import_model', m.ok === true, m.error || m);
}
const sc = await call('wb_scene_list', {});
const scenes = sc.scenes || (sc.data && sc.data.scenes) || [];
console.log('   场景数:', scenes.length);
if (scenes[0]) {
  const r = await call('wb_previz_import_scene', { scene_id: scenes[0].id || scenes[0].scene_id, id: scenes[0].id || scenes[0].scene_id });
  ok('★ wb_previz_import_scene', r.ok === true, r.error || r);
} else ok('★ 有场景可导入', false, scenes.length);

console.log('\n5. cmd asset.transform（页面指令路径）');
const t = await cdp.eval(`
  const e = window.__wb.editor;
  try { e.addAsset('tree'); } catch(_) {}
  await new Promise(r=>setTimeout(r,1200));
  const ready = (e.objects||[]).filter(o=>o.group && o.group.children.length);
  if (ready.length) e.select(ready[ready.length-1]);
  const r = await window.WB_AGENT.run('asset.transform', { x:3, y:0, z:4 });
  return { sel: !!e.selected, r };`);
ok('★ 页面指令 asset.transform（选好后）', !!(t.r && t.r.ok !== false), t.r || t);

console.log(`\n${fail ? '✗' : '✓'} recheck: ${pass} passed, ${fail} failed`);
await cdp.close();
process.exit(fail ? 1 : 0);
