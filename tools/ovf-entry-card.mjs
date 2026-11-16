#!/usr/bin/env node
/* 刷新（不关浏览器）→ 验证入口页「继续上次」卡片 + 自动恢复 */
import { defaultShotsDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
const SHOTS = defaultShotsDir();
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, e === undefined ? '' : '→ ' + JSON.stringify(e)); }
};

// ★ 只刷新页面，**不关浏览器**
// 先把"上次的地方"设成上海黄浦区（模拟用户载入过）
await cdp.eval(`
  window.__ovfLastWorld.rememberWorld({ lat: 31.2336, lng: 121.4799, radius: 2500, name: '上海黄浦区' });
  return 1;`);
await wait(500);
await cdp.send('Page.reload', { ignoreCache: false });
await wait(14000);

const r = await cdp.eval(`
  const card = document.querySelector('#enCardLast');
  const title = document.querySelector('#enCardLastTitle');
  const sub = document.querySelector('#enCardLastSub');
  const e = window.__wb && window.__wb.editor;
  let tris = 0, meshes = 0;
  if (e) e.scene.traverse(n => { if (n.isMesh) { meshes++; const g = n.geometry;
    if (g && g.index) tris += g.index.count/3; else if (g && g.attributes.position) tris += g.attributes.position.count/3; } });
  return {
    view: window.__wb && window.__wb.view,
    cardHidden: card ? card.hidden : null,
    title: title ? title.textContent : null,
    sub: sub ? sub.textContent : null,
    envId: e ? e.envId : null,
    badge: (document.querySelector('#edEnvBadge')||{}).textContent,
    meshes, tris: Math.round(tris),
    last: window.__ovfLastWorld ? window.__ovfLastWorld.lastWorld() : null,
  };
`);
console.log(JSON.stringify(r, null, 1));
ok('★ 「继续上次」卡片可见', r.cardHidden === false, r);
ok('★ 标题带城市名', /上海黄浦区/.test(r.title || ''), r.title);
ok('★ 自动恢复进了编辑器', r.view === 'editor', r.view);
ok('★ 环境是真实世界', r.envId === 'osm' && r.badge === '真实世界', r);
ok('★ 场景有真实几何（≥ 20 万三角形）', r.tris > 200000, r);

// 截入口页 + 编辑器页
await cdp.eval(`if (window.__wb && window.__wb.switchView) window.__wb.switchView('entry'); return 1;`);
await wait(900);
const shot1 = await cdp.eval(`return document.querySelector('#view-entry') ? 'ok' : 'no';`);
console.log('  入口页:', shot1);

await cdp.close();
console.log(`\n${fail ? '✗' : '✓'} entry-card: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
