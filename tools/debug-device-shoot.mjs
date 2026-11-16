#!/usr/bin/env node
/* 单独诊断 device.shoot 卡在哪 */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
console.log('1. 加机位…');
const r1 = await cdp.eval(`
  const e = window.__wb.editor;
  e.devices = e.devices || [];
  if (!e.devices.length) { try { await window.WB_AGENT.run('device.add',{ kind:'phone', x:5, y:1.7, z:8, lookX:0, lookY:1, lookZ:0 }); } catch(e){ return {err:String(e)}; } }
  await new Promise(r=>setTimeout(r,500));
  const d = (e.devices||[])[0];
  return { id: d && d.id, device: d && d.device, cam: !!(d && d.cam), hasStudioDevice: !!window.__studioDevice,
           fns: window.__studioDevice ? Object.keys(window.__studioDevice) : [] };
`);
console.log('   ', JSON.stringify(r1));

console.log('2. 调 shootImage（单独计时，最多等 240 秒）…');
const t0 = Date.now();
try {
  const r2 = await cdp.eval(`
    const t0 = Date.now();
    const d = (window.__wb.editor.devices||[])[0];
    if (!d) return { error: '没机位' };
    const res = await Promise.race([
      window.__studioDevice.shootImage(d.id, { download:false }),
      new Promise(r=>setTimeout(()=>r({ __timeout:true, ms: 240000 }), 240000))
    ]);
    return { res, ms: Date.now()-t0 };
  `);
  console.log(`    用时 ${Date.now()-t0}ms ⇒`, JSON.stringify(r2).slice(0, 500));
} catch (e) {
  console.log('    抛错:', e.message.slice(0, 300));
}

// 看看页面有没有卡住的痕迹
console.log('3. 页面状态：');
try {
  const st = await cdp.eval(`
    return { errs: (window.__ovfErrors||[]).slice(-5), busy: !!window.__studioDevice && window.__studioDevice.busy,
             devCount: (window.__wb.editor.devices||[]).length };
  `);
  console.log('   ', JSON.stringify(st));
} catch (e) { console.log('    页面也不响应了:', e.message.slice(0,120)); }
await cdp.close();
