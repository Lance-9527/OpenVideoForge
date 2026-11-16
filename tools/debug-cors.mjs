#!/usr/bin/env node
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const out = {};
  try { const resp = await fetch('http://127.0.0.1:8798/api/studio/assets'); out.direct8798 = { ok: resp.ok, status: resp.status }; }
  catch(e){ out.direct8798 = { error: String(e && e.message || e) }; }
  try { const resp = await fetch('http://127.0.0.1:8765/api/studio/assets'); out.direct8765 = { ok: resp.ok, status: resp.status }; }
  catch(e){ out.direct8765 = { error: String(e && e.message || e) }; }
  try {
    const rr = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'wb_caps',args:{}})});
    const j = await rr.json(); out.caps = j.data || j;
  } catch(e){ out.caps = { error: String(e.message) }; }
  out.pageOrigin = location.origin;
  return out;
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
