import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ① 外观面板：PBR 分区
const r1 = await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  await new Promise(r=>setTimeout(r,2500));
  window.__openLookPanel();
  await new Promise(r=>setTimeout(r,2500));
  const p = document.querySelector('.look-panel');
  const roles = Array.from(document.querySelectorAll('[data-pbr-role]')).map(s=>({
    role: s.dataset.pbrRole, options: s.options.length, value: s.value }));
  return { open: p && !p.hidden, hasPbrBox: !!document.querySelector('#lkPbrRoles'),
           pbrChecked: !!document.querySelector('#lkPbr') && document.querySelector('#lkPbr').checked,
           roles };
`);
console.log('[① 外观面板]', JSON.stringify(r1, null, 1));
await cdp.screenshot(`${OUT}\\R1-look-panel-pbr.png`);
console.log('[shot] R1-look-panel-pbr.png');

// ② 选一个 PBR 材质 + 打开真实感，看预览
const r2 = await cdp.eval(`
  const RL = window.__ovfRealLook;
  const list = await (await fetch('http://127.0.0.1:8787/pbr/list')).json();
  const pick = (r) => { const h=(list.items||[]).find(i=>i.role===r); return h?h.id:null; };
  const map = { wall:pick('wall'), road:pick('road'), ground:pick('ground'), floor:pick('floor'),
               roof:pick('roof'), building:pick('building'), neutral:pick('neutral') };
  const sets = await RL.preparePbr(map);
  const setsInfo = sets ? Object.keys(sets).map(k => k+':'+(sets[k]&&sets[k].map?'hasMap':'noMap')).join(',') : null;
  const cb = document.querySelector('#lkPbr'); if (cb) { cb.checked = true; cb.dispatchEvent(new Event('change',{bubbles:true})); }
  window.__studioPip.setReal(true);
  await new Promise(r=>setTimeout(r,3000));
  const lookNow = RL.getLook();
  return {
    setsInfo,
    lookPbr: lookNow.pbr ? { on: lookNow.pbr.on, mapKeys: Object.keys(lookNow.pbr.map||{}) } : null,
    real: window.__studioPip.getReal(),
    probe: window.__ovfLookProbe,
  };
`);
console.log('[② 选 PBR + 真实感]', JSON.stringify(r2, null, 1));
await wait(1200);
await cdp.screenshot(`${OUT}\\R2-pip-real-pbr.png`);
console.log('[shot] R2-pip-real-pbr.png');

// ②b 强制渲染一次，看 probe
const r2b = await cdp.eval(`
  const e = window.__wb.editor;
  const url = e.captureThumb(480, 270);
  await new Promise(r=>setTimeout(r,400));
  return { probe: window.__ovfLookProbe, len: url ? url.length : 0 };
`);
console.log('[②b 渲染后 probe]', JSON.stringify(r2b));

// ③ 资产库：分件展开
const r3 = await cdp.eval(`
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('entry');
  const en = document.querySelector('#view-entry'); if (en) en.hidden = false;
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = true;
  if (window.__initAssetLibrary) window.__initAssetLibrary();
  await new Promise(r=>setTimeout(r,3000));
  const btn = document.querySelector('#assetLibGrid [data-act="toggleparts"]');
  if (!btn) return { error: '没找到「分件」按钮', cards: document.querySelectorAll('#assetLibGrid .alb-card').length };
  const id = btn.dataset.id;
  btn.click();
  await new Promise(r=>setTimeout(r,600));
  const list = document.querySelector('#assetLibGrid .part-list:not([hidden])');
  return { id, rows: list ? list.querySelectorAll('.part-row').length : 0,
           firstRow: list && list.querySelector('.part-row') ? list.querySelector('.part-row').textContent.trim() : null };
`);
console.log('[③ 资产库分件展开]', JSON.stringify(r3));
await cdp.screenshot(`${OUT}\\R3-assetlib-parts.png`);
console.log('[shot] R3-assetlib-parts.png');

const errs = await cdp.eval(`return (window.__ovfErrors||[]);`);
console.log('[④ 报错]', errs && errs.length ? errs : '无');
await cdp.close();
