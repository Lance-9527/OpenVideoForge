#!/usr/bin/env node
/* 单独诊断页面指令 device.shoot */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');

const step = async (label, expr) => {
  const t = Date.now();
  try {
    const r = await cdp.eval(expr);
    console.log(`  ${label}: ${Date.now() - t}ms  ${JSON.stringify(r).slice(0, 220)}`);
    return r;
  } catch (e) {
    console.log(`  ${label}: ${Date.now() - t}ms  ✗ ${e.message.slice(0, 160)}`);
    return null;
  }
};

await step('① device.add', `
  const e = window.__wb.editor;
  e.devices = e.devices || [];
  if (!e.devices.length) { try { await window.WB_AGENT.run('device.add',{ kind:'phone', x:5, y:1.7, z:8, lookX:0, lookY:1, lookZ:0 }); } catch(e){} }
  await new Promise(r=>setTimeout(r,400));
  const d=(e.devices||[])[0];
  return { id: d&&d.id, n: (e.devices||[]).length };
`);

await step('② device.shoot（type=image）', `
  const t0=Date.now();
  const r = await window.WB_AGENT.run('device.shoot', { type:'image' });
  return { r, ms: Date.now()-t0 };
`);

await step('③ device.shoot（不给 type ⇒ 走视频）', `
  const t0=Date.now();
  const r = await window.WB_AGENT.run('device.shoot', { seconds:1 });
  return { r: (r && r.error) ? r : { ok:true, keys:Object.keys(r||{}) }, ms: Date.now()-t0 };
`);

await step('④ device.list', `
  const r = await window.WB_AGENT.run('device.list', {});
  return r;
`);

await cdp.close();
