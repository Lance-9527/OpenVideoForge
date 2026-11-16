/* ============================================================================
 * tools/ovf-undo-tour.mjs —— 撤销/保存（checkpoint）回归
 *
 * 这几轮改了很多（拖拉拽放置 / 外部模型 / 缩略图 / 真实感），
 * undo/redo 一直没重新验过 —— 而这是用户每天都在用的功能。
 * ========================================================================== */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = `
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'room' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  window.dispatchEvent(new Event('resize'));
  return true;
`;

const COUNT = `
  const e = window.__wb.editor;
  return {
    objects: (e.objects||[]).length,
    ids: (e.objects||[]).map(o=>o.assetId),
    ext: (e.objects||[]).filter(o=>o.externalAsset).length,
    inside: !!e._interior,
    floor: e._interior ? e._interior.floor : null,
  };
`;

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};

await cdp.eval(SETUP);
await wait(3500);

// ① 加物体 → 撤销 → 重做
console.log('\n① 内置资产：加 → 撤销 → 重做');
await cdp.eval(`window.__wb.editor.addAsset('tree'); return true;`);
await wait(800);
const a1 = await cdp.eval(COUNT);
await cdp.eval(`await window.__studioTopbar.undo(); return true;`);
await wait(1200);
const a2 = await cdp.eval(COUNT);
await cdp.eval(`await window.__studioTopbar.redo(); return true;`);
await wait(1200);
const a3 = await cdp.eval(COUNT);
ok('加上后有 1 个', a1.objects === 1, a1);
ok('撤销后回到 0', a2.objects === 0, a2);
ok('重做后又是 1', a3.objects === 1, a3);

// ② 拖拉拽放置的物体 → 撤销
console.log('\n② 拖拉拽放置（新增路径）：放下 → 撤销');
const b = await cdp.eval(`
  const e = window.__wb.editor;
  const n0 = e.objects.length;
  const rec = e.beginPlace('car-sedan');
  if (!rec) return { error: 'beginPlace 失败' };
  const el = e.renderer.domElement;
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left+r.width*0.5, clientY: r.top+r.height*0.6, bubbles: true }));
  el.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left+r.width*0.5, clientY: r.top+r.height*0.6, button: 0, bubbles: true }));
  await new Promise(r=>setTimeout(r,600));
  const n1 = e.objects.length;
  await window.__studioTopbar.undo();
  await new Promise(r=>setTimeout(r,1400));
  const n2 = e.objects.length;
  await window.__studioTopbar.redo();
  await new Promise(r=>setTimeout(r,1400));
  const n3 = e.objects.length;
  return { n0, n1, n2, n3, ids: e.objects.map(o=>o.assetId) };
`);
console.log('   ', JSON.stringify(b));
ok('拖放后物体变多', b.n1 === b.n0 + 1, b);
ok('★ 拖放的物体能撤销', b.n2 === b.n0, b);
ok('★ 拖放的物体能重做', b.n3 === b.n0 + 1, b);

// ③ 外部模型（资产库 GLB）→ 撤销 → 重做
console.log('\n③ 外部模型（资产库 GLB）：放下 → 撤销 → 重做');
const c = await cdp.eval(`
  const e = window.__wb.editor;
  const n0 = e.objects.length;
  const list = await (await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_library_list',args:{kind:'model'}})}).then(r=>r.json()));
  const it = (list.items||[]).find(i=>i.thumb) || (list.items||[])[0];
  if (!it) return { error: '资产库里没有模型' };
  const url = 'http://127.0.0.1:8787/library/file/' + encodeURIComponent(it.id);
  const rec = await e.beginPlaceExternal({ id: it.id, name: it.name, file_url: url });
  if (!rec) return { error: 'beginPlaceExternal 失败' };
  const el = e.renderer.domElement;
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent('pointermove', { clientX: r.left+r.width*0.45, clientY: r.top+r.height*0.6, bubbles: true }));
  el.dispatchEvent(new PointerEvent('pointerdown', { clientX: r.left+r.width*0.45, clientY: r.top+r.height*0.6, button: 0, bubbles: true }));
  await new Promise(r=>setTimeout(r,1200));
  const n1 = e.objects.length;
  await window.__studioTopbar.undo();
  await new Promise(r=>setTimeout(r,1600));
  const n2 = e.objects.length;
  await window.__studioTopbar.redo();
  await new Promise(r=>setTimeout(r,2200));
  const n3 = e.objects.length;
  const ext = e.objects.filter(o=>o.externalAsset).length;
  return { n0, n1, n2, n3, ext, id: it.id };
`);
console.log('   ', JSON.stringify(c));
ok('外部模型放下了', c.n1 === c.n0 + 1, c);
ok('★ 外部模型能撤销', c.n2 === c.n0, c);
ok('★ 外部模型能重做', c.n3 === c.n0 + 1, c);
ok('★ 重做后还是外部模型（没退化成内置）', c.ext >= 1, c);

// ④ 删除 → 撤销
console.log('\n④ 删除 → 撤销');
const d = await cdp.eval(`
  const e = window.__wb.editor;
  const n0 = e.objects.length;
  e.select(e.objects[0]);
  e.deleteSelected();
  await new Promise(r=>setTimeout(r,400));
  const n1 = e.objects.length;
  await window.__studioTopbar.undo();
  await new Promise(r=>setTimeout(r,1400));
  const n2 = e.objects.length;
  return { n0, n1, n2 };
`);
console.log('   ', JSON.stringify(d));
ok('删掉了', d.n1 === d.n0 - 1, d);
ok('★ 删除能撤销', d.n2 === d.n0, d);

// ⑤ 保存 → 重新加载 → 内容一致
console.log('\n⑤ 保存 → 重新加载');
const e5 = await cdp.eval(`
  const e = window.__wb.editor;
  const json = JSON.parse(JSON.stringify(e.serialize()));
  const before = { objects: json.objects.length, env: json.env, size: json.size,
                   ext: json.objects.filter(o=>o.externalAsset).length,
                   lights: json.cams.length };
  // 改乱一点
  e.deleteSelected();
  await new Promise(r=>setTimeout(r,300));
  const n1 = e.objects.length;
  // 重新加载
  await e.loadScene(json);
  await new Promise(r=>setTimeout(r,1800));
  const after = { objects: e.objects.length, env: e.envId, size: e.envSize,
                  ext: e.objects.filter(o=>o.externalAsset).length,
                  lights: e.cams.length };
  return { before, after, n1, n2: e.objects.length };
`);
console.log('   ', JSON.stringify(e5));
ok('重载后物体数一致', e5.after.objects === e5.before.objects, e5);
ok('重载后环境一致', e5.after.env === e5.before.env, e5);
ok('重载后场地档位一致', e5.after.size === e5.before.size, e5);
ok('★ 重载后外部模型还在', e5.after.ext === e5.before.ext, e5);

// ⑥ 室内状态：撤销会不会丢（要在有楼的环境里测 —— room 环境没楼）
console.log('\n⑥ 室内（enterBuilding）→ 撤销');
const f = await cdp.eval(`
  const e = window.__wb.editor;
  await window.WB_AGENT.run('world.build', { kind: 'city', size: 'medium', seed: 7 });
  await new Promise(r=>setTimeout(r,2500));
  const r = await window.WB_AGENT.run('building.enter', {});
  await new Promise(r=>setTimeout(r,1500));
  const inside0 = !!e._interior;
  const floors0 = e._interior ? e._interior.building.floors : null;
  await window.__studioTopbar.undo();
  await new Promise(r=>setTimeout(r,1600));
  const inside1 = !!e._interior;
  return { inside0, floors0, inside1, ok: r && r.ok, err: r && r.error };
`);
console.log('   ', JSON.stringify(f));
ok('能进屋', f.inside0 === true, f);
ok('（记录）撤销后室内状态：' + (f.inside1 ? '还在' : '没了'), true, f);

await cdp.screenshot(`${OUT}\\CK1-undo.png`);
console.log('\n[shot] CK1');
console.log(`\n${fail ? '✗' : '✓'} undo/checkpoint: ${pass} passed, ${fail} failed`);

await cdp.close();
process.exit(fail ? 1 : 0);
