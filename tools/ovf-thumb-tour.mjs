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

await cdp.eval(SETUP);
await wait(3500);

// 放三个物体，右键入库（真点）
const add = await cdp.eval(`
  const e = window.__wb.editor;
  for (const id of ['tree','car-sedan','person-stand']) {
    const rec = e.addAsset(id);
    e.select(rec);
    window.__studioCtxMenu.show(400, 300, rec);
    document.querySelector('#edCtxMenu [data-act="addToLibrary"]').click();
    await new Promise(r=>setTimeout(r,3500));
  }
  return true;
`);
console.log('[入库完成]');
await wait(2000);

// 查资产库：哪些有缩略图
const lib = await cdp.eval(`
  const r = await fetch('http://127.0.0.1:8787/tool', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_library_list', args:{}})});
  const j = await r.json();
  return (j.items||[]).filter(i=>i.kind==='model' && !i.builtin)
    .map(i=>({ id:i.id, name:i.name, thumb:i.thumb||null }));
`);
console.log('[资产库模型]', JSON.stringify(lib, null, 1));

// 缩略图能不能取到（HTTP + 有没有图）
const thumbs = await cdp.eval(`
  const list = await (await fetch('http://127.0.0.1:8787/tool', {method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({name:'wb_library_list', args:{}})}).then(r=>r.json()));
  const models = (list.items||[]).filter(i=>i.kind==='model' && !i.builtin && i.thumb);
  const out = [];
  for (const m of models) {
    const u = 'http://127.0.0.1:8787/library/thumb/' + encodeURIComponent(m.id);
    const r = await fetch(u);
    const b = await r.blob();
    // 用 Image 解码，看是不是真图
    const img = new Image();
    const okImg = await new Promise(res=>{ img.onload=()=>res(true); img.onerror=()=>res(false); img.src=u; });
    out.push({ id:m.id, status:r.status, bytes:b.size, type:b.type, decoded:okImg,
               w: img.naturalWidth, h: img.naturalHeight });
  }
  return out;
`);
console.log('[缩略图]', JSON.stringify(thumbs, null, 1));

// 入口页资产库面板有没有显示缩略图
const panel = await cdp.eval(`
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('entry');
  const en = document.querySelector('#view-entry'); if (en) en.hidden = false;
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = true;
  if (window.__initAssetLibrary) window.__initAssetLibrary();
  await new Promise(r=>setTimeout(r,2000));
  const imgs = Array.from(document.querySelectorAll('#assetLibGrid .alb-thumb'));
  return { total: imgs.length, imgs: imgs.filter(i=>i.tagName==='IMG').length,
           srcs: imgs.filter(i=>i.tagName==='IMG').slice(0,4).map(i=>i.getAttribute('src')) };
`);
console.log('[入口页资产库面板]', JSON.stringify(panel));
await cdp.screenshot(`${OUT}\\V1-入口页-资产库缩略图.png`);
console.log('[shot] V1');

await cdp.close();
