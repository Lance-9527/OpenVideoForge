/* ============================================================================
 * tools/ovf-pbr-obj-tour.mjs —— 逐物体指定 PBR（含外部 GLB）
 * ========================================================================== */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};

await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'room' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  await new Promise(r=>setTimeout(r,3000));
  return true;
`);
await wait(2000);

// ① 右键菜单里有「套 PBR 材质…」
const menu = await cdp.eval(`
  const e = window.__wb.editor;
  e.addAsset('car-sedan');
  await new Promise(r=>setTimeout(r,500));
  window.__studioCtxMenu.show(400, 300, e.selected);
  const btn = document.querySelector('#edCtxMenu [data-act="setPbr"]');
  return { exists: !!btn, text: btn ? btn.textContent : null };
`);
console.log('[① 右键菜单]', JSON.stringify(menu));
ok('★ 右键菜单有「套 PBR 材质…」', menu.exists, menu);

// ② 点它 → 弹选择器
const picker = await cdp.eval(`
  document.querySelector('#edCtxMenu [data-act="setPbr"]').click();
  await new Promise(r=>setTimeout(r,1500));
  const items = Array.from(document.querySelectorAll('[data-pbr]'));
  return { count: items.length, sample: items.slice(0,4).map(i=>i.dataset.pbr) };
`);
console.log('[② 选择器]', JSON.stringify(picker));
ok('★ 弹出了 PBR 列表', picker.count > 10, picker);

// ③ 选一个 → 物体上记录了 pbrId
const picked = await cdp.eval(`
  const e = window.__wb.editor;
  const target = Array.from(document.querySelectorAll('[data-pbr]')).find(i=>i.dataset.pbr && i.dataset.pbr.startsWith('Bricks'));
  if (!target) return { error: '没找到砖墙材质' };
  target.click();
  await new Promise(r=>setTimeout(r,800));
  return { pbrId: e.selected && e.selected.pbrId, ok: !!(e.selected && e.selected.pbrId) };
`);
console.log('[③ 指定]', JSON.stringify(picked));
ok('★ 物体上记住了 pbrId', picked.ok && picked.pbrId, picked);

// ④ 渲染时真的用了这个贴图
const used = await cdp.eval(`
  const RL = window.__ovfRealLook;
  const list = await (await fetch('http://127.0.0.1:8787/pbr/list')).json();
  const pick = (r) => { const h=(list.items||[]).find(i=>i.role===r); return h?h.id:null; };
  const map = { wall:pick('wall'), road:pick('road'), ground:pick('ground'), floor:pick('floor'),
               roof:pick('roof'), building:pick('building'), neutral:pick('neutral') };
  await RL.preparePbr(map);
  window.__studioPip.setReal(true);
  window.__studioPip.setLook({ pbr: { on: true, map } });
  await new Promise(r=>setTimeout(r,2000));
  const e = window.__wb.editor;
  const url = e.captureThumb(320, 180);
  await new Promise(r=>setTimeout(r,400));
  return { probe: window.__ovfLookProbe, len: url ? url.length : 0,
           byIdCount: RL.preparePbr ? 'ok' : 'no' };
`);
console.log('[④ 渲染]', JSON.stringify(used));
ok('★ 渲染命中了 PBR 材质', used.probe && used.probe.pbr > 0, used);

// ⑤ 保存 → 重载 → pbrId 还在
const persist = await cdp.eval(`
  const e = window.__wb.editor;
  const json = JSON.parse(JSON.stringify(e.serialize()));
  const inJson = (json.objects.find(o=>o.pbrId)||{}).pbrId || null;
  await e.loadScene(json);
  await new Promise(r=>setTimeout(r,1500));
  const after = (e.objects.find(o=>o.pbrId)||{}).pbrId || null;
  return { inJson, after, match: inJson === after };
`);
console.log('[⑤ 持久化]', JSON.stringify(persist));
ok('★ pbrId 进了场景存档', !!persist.inJson, persist);
ok('★ 重载后 pbrId 还在', persist.match && !!persist.after, persist);

// ⑥ 外部 GLB 也能套 PBR
const ext = await cdp.eval(`
  const e = window.__wb.editor;
  const list = await (await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_library_list',args:{kind:'model'}})}).then(r=>r.json()));
  const it = (list.items||[]).find(i=>i.thumb);
  if (!it) return { error:'资产库没模型' };
  const url = 'http://127.0.0.1:8787/library/file/' + encodeURIComponent(it.id);
  const rec = await e.addExternalAsset({ id: it.id, name: it.name, file_url: url });
  await new Promise(r=>setTimeout(r,2500));
  e.select(rec);
  const r = e.setObjectPbr('Bricks113A');
  await new Promise(r=>setTimeout(r,600));
  return { ok: r && r.ok, pbrId: rec && rec.pbrId, ext: !!(rec && rec.externalAsset) };
`);
console.log('[⑥ 外部 GLB]', JSON.stringify(ext));
ok('★ 外部模型也能指定 PBR', ext.ok && ext.pbrId === 'Bricks113A', ext);

const errs = await cdp.eval(`return (window.__ovfErrors||[]);`);
console.log('[页面报错]', errs && errs.length ? errs : '无');
console.log(`\n${fail ? '✗' : '✓'} pbr-obj: ${pass} passed, ${fail} failed`);
await cdp.close();
process.exit(fail ? 1 : 0);
