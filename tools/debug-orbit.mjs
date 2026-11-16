#!/usr/bin/env node
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const out = {};
  try { out.orbit1 = await window.WB_AGENT.run('studio.track.orbit', { seconds:1, fps:8, width:320, height:320, turns:1 }); }
  catch(e){ out.orbit1 = { error: String(e && e.message || e) }; }
  try { out.orbit2 = await window.WB_AGENT.run('studio.track.orbit', { seconds:2, fps:12 }); }
  catch(e){ out.orbit2 = { error: String(e && e.message || e) }; }
  const e = window.__wb.editor;
  out.saved = e ? e.studioRender : null;
  out.tracks = e && e.studioTracks ? { keys: (e.studioTracks.camera||{}).keys ? e.studioTracks.camera.keys.length : 0 } : null;
  return out;
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
