#!/usr/bin/env node
/* 把「上次的地方」设回上海黄浦区，并停在入口页（不关浏览器） */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
const SHOTS = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const r = await cdp.eval(`
  const lw = window.__ovfLastWorld;
  lw.rememberWorld({ lat: 31.2336, lng: 121.4799, radius: 2500, name: '上海黄浦区' });
  const last = lw.lastWorld();
  await window.__wb.openEditor({ env: 'street' });
  await new Promise(r => setTimeout(r, 600));
  const res = await lw.loadWorld(last);
  const e = window.__wb.editor;
  let tris = 0;
  if (e) e.scene.traverse(n => { if (n.isMesh) { const g = n.geometry;
    if (g && g.index) tris += g.index.count/3; else if (g && g.attributes.position) tris += g.attributes.position.count/3; } });
  return { last, ok: res && res.ok, buildings: res && res.stats && res.stats.buildings,
           tris: Math.round(tris), badge: (document.querySelector('#edEnvBadge')||{}).textContent };
`);
console.log(JSON.stringify(r, null, 1));

// 停在入口页，让用户看到「继续上次：上海黄浦区」
await cdp.eval(`if (window.__wb && window.__wb.switchView) window.__wb.switchView('entry'); return 1;`);
await wait(1200);
const shot = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 82 });
if (shot && shot.data) {
  fs.writeFileSync(path.join(SHOTS, 'entry-final.jpg'), Buffer.from(shot.data, 'base64'));
  console.log('已存: ovf_shots\\entry-final.jpg');
}
await cdp.close();
