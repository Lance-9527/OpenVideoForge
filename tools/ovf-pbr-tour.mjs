import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SETUP = `
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  window.dispatchEvent(new Event('resize'));
  return true;
`;

await cdp.eval(SETUP);
await wait(3500);

// ① PBR 清单能不能从桥上拿到
const pbr = await cdp.eval(`
  const r = await fetch('http://127.0.0.1:8787/pbr/list');
  const j = await r.json();
  return { count: j.count, byRole: (j.items||[]).reduce((a,i)=>{a[i.role]=(a[i.role]||0)+1;return a;},{}) };
`);
console.log('[① PBR 清单]', JSON.stringify(pbr));

// ② 贴图文件能不能取到
const tex = await cdp.eval(`
  const out = [];
  const j = await (await fetch('http://127.0.0.1:8787/pbr/list')).json();
  for (const it of (j.items||[]).slice(0,3)) {
    for (const [role,file] of Object.entries(it.maps||{})) {
      const u = 'http://127.0.0.1:8787/pbr/file/' + encodeURIComponent(it.id) + '/' + encodeURIComponent(file);
      const r = await fetch(u);
      const b = await r.blob();
      out.push({ id: it.id, role, status: r.status, bytes: b.size, type: b.type });
    }
  }
  return out;
`);
console.log('[② 贴图文件]', JSON.stringify(tex, null, 1));

// ③ 真实感 + PBR 出图
const exp = await cdp.eval(`
  const e = window.__wb.editor;
  for (const id of ['tree','car-sedan','person-stand']) { try { e.addAsset(id); } catch(_){} }
  await new Promise(r=>setTimeout(r,700));
  const RL = window.__ovfRealLook;
  const list = await (await fetch('http://127.0.0.1:8787/pbr/list')).json();
  const pick = (role) => { const h=(list.items||[]).find(i=>i.role===role); return h?h.id:null; };
  const map = { wall: pick('wall'), road: pick('road'), ground: pick('ground'),
               floor: pick('floor'), roof: pick('roof'), building: pick('building'), neutral: pick('neutral') };
  const sets = await RL.preparePbr(map);
  window.__studioPip.setReal(true);
  window.__studioPip.setLook({ pbr: { on: true, map }, proc: { on: false }, hdriBg: false });
  await new Promise(r=>setTimeout(r,1200));
  const url = e.captureThumb(480, 270);
  const probe = window.__ovfLookProbe;
  return { sets: sets ? Object.keys(sets) : null, map, len: url ? url.length : 0, probe, url };
`);
console.log('[③ PBR 贴图组]', JSON.stringify({ sets: exp.sets, map: exp.map, len: exp.len }));
console.log('[③ 探针]', JSON.stringify(exp.probe));
if (exp.url) fs.writeFileSync(`${OUT}\\P1-pbr-export.jpg`, Buffer.from(exp.url.split(',')[1], 'base64'));
console.log('[save] P1-pbr-export.jpg');

// ④ 对照：不带 PBR
const plain = await cdp.eval(`
  const e = window.__wb.editor;
  window.__studioPip.setLook({ pbr: { on: false }, proc: { on: false } });
  await new Promise(r=>setTimeout(r,900));
  const url = e.captureThumb(480, 270);
  const probe = window.__ovfLookProbe;
  return { len: url ? url.length : 0, probe, url };
`);
console.log('[④ 不带 PBR] len', plain.len);
console.log('[④ 探针]', JSON.stringify(plain.probe));
if (plain.url) fs.writeFileSync(`${OUT}\\P2-plain-export.jpg`, Buffer.from(plain.url.split(',')[1], 'base64'));
console.log('[save] P2-plain-export.jpg');
console.log(plain.probe && plain.probe.pbr === 0 && exp.probe && exp.probe.pbr > 0
  ? '✓ PBR 开关真的生效了（开→命中 N 个，关→命中 0 个）'
  : '✗ PBR 开关没生效');

// ⑤ 分件索引
const parts = await cdp.eval(`
  const e = window.__wb.editor;
  const list = await (await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_library_list',args:{kind:'model'}})}).then(r=>r.json()));
  const it = (list.items||[]).find(i=>(i.parts||[]).length) || (list.items||[])[0];
  if (!it) return { error:'资产库没模型' };
  const url = 'http://127.0.0.1:8787/library/file/' + encodeURIComponent(it.id);
  const rec = await e.beginPlaceExternal({ id: it.id, name: it.name, file_url: url });
  await new Promise(r=>setTimeout(r,2500));
  const l2 = await (await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_library_list',args:{kind:'model'}})}).then(r=>r.json()));
  const it2 = (l2.items||[]).find(i=>i.id===it.id);
  return { id: it.id, partCount: (it2.parts||[]).length, parts: (it2.parts||[]).slice(0,6) };
`);
console.log('[⑤ 分件索引]', JSON.stringify(parts, null, 1));

// ⑥ 精准 copy 一个分件
const one = await cdp.eval(`
  const e = window.__wb.editor;
  const list = await (await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_library_list',args:{kind:'model'}})}).then(r=>r.json()));
  const it = (list.items||[]).find(i=>(i.parts||[]).length);
  if (!it) return { error:'没有带分件的模型' };
  const url = 'http://127.0.0.1:8787/library/file/' + encodeURIComponent(it.id);
  const before = e.objects.length;
  const rec = await e.beginPlaceExternalPart({ id: it.id, name: it.name, file_url: url }, 0, {});
  if (!rec) return { error:'取分件失败', id: it.id };
  let meshes = 0;
  rec.group.traverse(n=>{ if(n.isMesh) meshes++; });
  const bb = new (window.THREE ? window.THREE.Box3 : Object)();
  return { before, after: e.objects.length, meshes, id: it.id, partName: (it.parts[0]||{}).name,
           assetId: rec.assetId };
`);
console.log('[⑥ 精准 copy 单个分件]', JSON.stringify(one));

const errs = await cdp.eval(`return (window.__ovfErrors||[]);`);
console.log('[⑦ 报错]', errs && errs.length ? errs : '无');
await cdp.close();
