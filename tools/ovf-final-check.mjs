import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'room' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  return true;
`);
await wait(3000);

// 分别入库：树 / 人 / 车
const res = await cdp.eval(`
  const e = window.__wb.editor;
  const out = [];
  for (const aid of ['tree','person-stand','car-sedan']) {
    const rec = e.addAsset(aid);
    e.select(rec);
    window.__studioCtxMenu.show(400, 300, rec);
    document.querySelector('#edCtxMenu [data-act="addToLibrary"]').click();
    await new Promise(r=>setTimeout(r,2600));
  }
  const rr = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:'wb_library_list',args:{}})});
  const j = await rr.json();
  const mine = (j.items||[]).filter(i=>i.source==='scene-export');
  return { added: mine.map(i=>({ name:i.name, category:i.category, kind:i.kind })) };
`);
console.log('[入库分类]', JSON.stringify(res, null, 1));

// 分组显示
const groups = await cdp.eval(`
  const rail = Array.from(document.querySelectorAll('#edRail button'));
  rail.find(b=>b.title==='资产库').click();
  await new Promise(r=>setTimeout(r,1500));
  const gs = Array.from(document.querySelectorAll('#edAssetGrid .lib-group'));
  return gs.map(g=>({ label:g.querySelector('.lib-group-head b').textContent,
                      n:g.querySelector('.lg-count').textContent }));
`);
console.log('[分组]', JSON.stringify(groups));
await cdp.close();
