#!/usr/bin/env node
/* 只刷新页面（**不关浏览器**），让新 js/css 生效 */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Page.reload', { ignoreCache: false });
await new Promise((r) => setTimeout(r, 12000));
const r = await cdp.eval(`
  const e = window.__wb && window.__wb.editor;
  let tris = 0, meshes = 0;
  if (e) e.scene.traverse(n => { if (n.isMesh) { meshes++; const g = n.geometry;
    if (g && g.index) tris += g.index.count/3; else if (g && g.attributes.position) tris += g.attributes.position.count/3; } });
  return { view: window.__wb && window.__wb.view, envId: e ? e.envId : null,
           badge: (document.querySelector('#edEnvBadge')||{}).textContent,
           meshes, tris: Math.round(tris),
           cardTitle: (document.querySelector('#enCardLastTitle')||{}).textContent };
`);
console.log('刷新后:', JSON.stringify(r));
await cdp.close();
