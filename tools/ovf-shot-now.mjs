#!/usr/bin/env node
/* 截图：用户打开 openVideoForge 现在看到什么 */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
const SHOTS = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const e = window.__wb.editor;
  let tris = 0, meshes = 0;
  if (e) e.scene.traverse(n => { if (n.isMesh) { meshes++; const g = n.geometry;
    if (g && g.index) tris += g.index.count/3; else if (g && g.attributes.position) tris += g.attributes.position.count/3; } });
  return { view: window.__wb.view, envId: e ? e.envId : null, meshes, tris: Math.round(tris),
           badge: (document.querySelector('#edEnvBadge')||{}).textContent,
           name: (document.querySelector('#edName')||{}).value,
           thumb: e ? e.captureThumb(1600, 900) : null };
`);
console.log(JSON.stringify({ ...r, thumb: r.thumb ? r.thumb.length + ' b64' : null }, null, 1));
if (r.thumb) {
  fs.writeFileSync(path.join(SHOTS, 'app-opened.jpg'), Buffer.from(r.thumb.split(',')[1], 'base64'));
  console.log('已存: ovf_shots\\app-opened.jpg');
}
await cdp.close();
