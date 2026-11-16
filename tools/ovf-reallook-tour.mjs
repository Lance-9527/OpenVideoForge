/* ============================================================================
 * tools/ovf-reallook-tour.mjs —— 实测：
 *   ① 点「渲染」→ 成片预览变成真实世界效果（主视口不变！）
 *   ② 换外观预设（黄昏金光 / 夜晚霓虹 …）
 *   ③ 右键「添加到资产库」→ 分类正确 + 名字带类别词
 * ========================================================================== */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';

const OUT = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const T = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
async function shot(n) {
  const f = `${OUT}\\${n}.png`;
  await cdp.screenshot(f);
  console.log(T(), '[shot]', n, (fs.statSync(f).size / 1024).toFixed(0) + 'KB');
}
async function ev(expr, ms = 1000) {
  const r = await cdp.eval(expr);
  await wait(ms);
  return r;
}

// 进编辑器 + 摆点东西（有颜色才看得出效果）
await ev(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'room' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  window.dispatchEvent(new Event('resize'));
  return true;
`, 3000);

await ev(`
  const e = window.__wb.editor;
  for (const id of ['tree','rock','grass','car-sedan','person-stand','bench']) {
    try { e.addAsset(id); } catch(_){}
  }
  // 拉远一点，看得见全景
  e.sph.r = 26; e.sph.phi = 1.15; e._applyCamera();
  return e.objects.length;
`, 2500);
console.log(T(), '[摆好场景]');

// 记下主视口的样子（用来证明"主视口没变"）
const mainBefore = await ev(`
  const c = window.__wb.editor.renderer.domElement;
  const t = document.createElement('canvas'); t.width=60; t.height=40;
  const g = t.getContext('2d'); g.drawImage(c, 0,0,60,40);
  return Array.from(g.getImageData(0,0,60,40).data).filter((_,i)=>i%4===0).reduce((a,b)=>a+b,0);
`, 600);
console.log(T(), '[主视口像素和-前]', mainBefore);

// ── ① 点「渲染」
const clicked = await ev(`
  const b = document.querySelector('#pipRender');
  if (!b) return { error:'没有渲染按钮' };
  b.click();
  await new Promise(r=>setTimeout(r,1400));
  const p = window.__studioPip;
  const chip = document.querySelector('#pipReal');
  const panel = document.querySelector('#lookPanel');
  return { real: p.getReal(), chip: chip && chip.textContent, chipOn: chip && chip.classList.contains('on'),
           panelOpen: panel && !panel.hidden,
           presets: Array.from(document.querySelectorAll('#lookPanel [data-preset]')).map(x=>x.textContent) };
`, 2500);
console.log(T(), '[点渲染]', JSON.stringify(clicked));
await shot('M1-成片预览-真实感');

// 主视口应该没变
const mainAfter = await ev(`
  const c = window.__wb.editor.renderer.domElement;
  const t = document.createElement('canvas'); t.width=60; t.height=40;
  const g = t.getContext('2d'); g.drawImage(c, 0,0,60,40);
  return Array.from(g.getImageData(0,0,60,40).data).filter((_,i)=>i%4===0).reduce((a,b)=>a+b,0);
`, 600);
console.log(T(), '[主视口像素和-后]', mainAfter, '| 差值', Math.abs(mainAfter-mainBefore));

// PIP 画布的像素（应该有明显颜色）
const pipPix = await ev(`
  const c = document.querySelector('#pipCanvas');
  const g = c.getContext('2d');
  const d = g.getImageData(0,0,c.width,c.height).data;
  let r=0,gq=0,b=0, n=0, satMax=0;
  for (let i=0;i<d.length;i+=4){ r+=d[i]; gq+=d[i+1]; b+=d[i+2]; n++;
    const mx=Math.max(d[i],d[i+1],d[i+2]), mn=Math.min(d[i],d[i+1],d[i+2]);
    satMax=Math.max(satMax, mx===0?0:(mx-mn)/mx); }
  return { avg:[Math.round(r/n),Math.round(gq/n),Math.round(b/n)], maxSat:+satMax.toFixed(3) };
`, 600);
console.log(T(), '[PIP 平均色/最大饱和度]', JSON.stringify(pipPix));

// ── ② 换预设
for (const pid of ['golden', 'night']) {
  const r = await ev(`
    const b = document.querySelector('#lookPanel [data-preset="${pid}"]');
    if (!b) return { error:'没有 ${pid}' };
    b.click();
    await new Promise(r=>setTimeout(r,1400));
    const c = document.querySelector('#pipCanvas');
    const g = c.getContext('2d');
    const d = g.getImageData(0,0,c.width,c.height).data;
    let r=0,gq=0,bb=0,n=0,satMax=0;
    for (let i=0;i<d.length;i+=4){ r+=d[i]; gq+=d[i+1]; bb+=d[i+2]; n++;
      const mx=Math.max(d[i],d[i+1],d[i+2]), mn=Math.min(d[i],d[i+1],d[i+2]);
      satMax=Math.max(satMax, mx===0?0:(mx-mn)/mx); }
    return { preset:'${pid}', avg:[Math.round(r/n),Math.round(gq/n),Math.round(bb/n)], maxSat:+satMax.toFixed(3) };
  `, 2000);
  console.log(T(), '[预设]', JSON.stringify(r));
  await shot('M2-成片预览-' + pid);
}

// ── ③ 右键入库：分类 + 命名
const add = await ev(`
  const e = window.__wb.editor;
  const rec = e.objects.find(o=>o.assetId==='tree') || e.objects[0];
  e.select(rec);
  window.__studioCtxMenu.show(400, 300, rec);
  const b = document.querySelector('#edCtxMenu [data-act="addToLibrary"]');
  b.click();
  await new Promise(r=>setTimeout(r,4000));
  const rr = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:'wb_library_list',args:{}})});
  const j = await rr.json();
  return { picked: rec.assetId, items: (j.items||[]).map(i=>({name:i.name, kind:i.kind, category:i.category})) };
`, 6000);
console.log(T(), '[右键入库]', JSON.stringify(add));
await shot('M3-右键入库后');

console.log(T(), 'done');
await cdp.close();
