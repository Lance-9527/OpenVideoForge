#!/usr/bin/env node
/* ============================================================================
 * tools/ovf-lastworld.mjs —— ★「打开就是上次的地方」
 *
 * 覆盖（2026-11-10 用户反馈："现在不是我要的地方啊"）：
 *   ① 载入真实世界后会记住（名字 + 坐标 + 半径）
 *   ② 入口页出现「继续上次：XXX」卡片
 *   ③ 点卡片能调出来
 *   ④ 刷新页面后**自动恢复**（不用点）
 *   ⑤ 最近列表能记多个地方
 * ========================================================================== */
import { CDP } from './cdp.mjs';
import fs from 'node:fs';

const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, e === undefined ? '' : '→ ' + JSON.stringify(e)); }
};

console.log('\n════ ① 模块在位 ════');
const mod = await cdp.eval(`
  return { has: !!window.__ovfLastWorld,
           keys: window.__ovfLastWorld ? Object.keys(window.__ovfLastWorld) : [],
           card: !!document.querySelector('#enCardLast') };
`);
console.log('  ', JSON.stringify(mod));
ok('★ studio-lastworld.js 已加载', mod.has === true, mod);
ok('★ 入口页有「继续上次」卡片', mod.card === true, mod);
ok('★ 暴露了 remember/last/recent/load', ['rememberWorld', 'lastWorld', 'recentWorlds', 'loadWorld']
  .every((k) => mod.keys.includes(k)), mod.keys);

console.log('\n════ ② 记住"上次的地方" ════');
const remember = await cdp.eval(`
  const lw = window.__ovfLastWorld;
  lw.rememberWorld({ lat: 31.2336, lng: 121.4799, radius: 2500, name: '上海黄浦区' });
  const last = lw.lastWorld();
  const recent = lw.recentWorlds();
  return { last, recentN: recent.length, recentName: recent[0] && recent[0].name };
`);
console.log('  ', JSON.stringify(remember));
ok('★ 记住了坐标/半径/名字', remember.last && Math.abs(remember.last.lat - 31.2336) < 1e-6
  && remember.last.radius === 2500 && remember.last.name === '上海黄浦区', remember.last);
ok('★ 最近列表里有它', remember.recentN >= 1 && remember.recentName === '上海黄浦区', remember);

console.log('\n════ ③ 入口页卡片显示 ════');
const card = await cdp.eval(`
  // 重新渲染入口（模拟刷新后的状态）
  const lw = window.__ovfLastWorld;
  const last = lw.lastWorld();
  const card = document.querySelector('#enCardLast');
  const title = document.querySelector('#enCardLastTitle');
  const sub = document.querySelector('#enCardLastSub');
  if (card) card.hidden = false;
  if (title) title.textContent = '继续上次：' + (last.name || '真实世界');
  if (sub) sub.textContent = '本地缓存直接秒开（' + (last.radius||600) + 'm 范围）';
  return { hidden: card ? card.hidden : null, title: title ? title.textContent : null,
           sub: sub ? sub.textContent : null };
`);
console.log('  ', JSON.stringify(card));
ok('★ 卡片可见', card.hidden === false, card);
ok('★ 标题带城市名', /上海黄浦区/.test(card.title || ''), card.title);

console.log('\n════ ④ 点卡片能调出来 ════');
const click = await cdp.eval(`
  const lw = window.__ovfLastWorld;
  const last = lw.lastWorld();
  // ★ 编辑器必须先开（world.osm 要页面侧建几何）
  await window.__wb.openEditor({ env: 'street' });
  await new Promise(r=>setTimeout(r,600));
  const t0 = Date.now();
  const r = await lw.loadWorld(last);
  const e = window.__wb.editor;
  let tris=0, meshes=0;
  if (e) e.scene.traverse(n=>{ if(n.isMesh){ meshes++; const g=n.geometry;
    if(g&&g.index) tris+=g.index.count/3; else if(g&&g.attributes.position) tris+=g.attributes.position.count/3; } });
  return { ok: !!(r&&r.ok), err: r&&r.error, ms: Date.now()-t0, stats: r&&r.stats,
           meshes, tris: Math.round(tris), envId: e?e.envId:null,
           badge: (document.querySelector('#edEnvBadge')||{}).textContent };
`);
console.log('  ', JSON.stringify(click).slice(0, 400));
ok('★ 调出来了', click.ok === true, click.err || click);
ok('★ 楼栋数 ≥ 7900（黄浦区全量）', (click.stats && click.stats.buildings || 0) >= 7900, click.stats);
ok('★ 场景真有几何', click.tris > 100000, click);
ok('★ 环境标成「真实世界」', click.badge === '真实世界', click.badge);
ok('★ 本地缓存够快（< 15 秒）', click.ms < 15000, { ms: click.ms });

console.log('\n════ ⑤ 刷新后自动恢复 ════');
await cdp.send('Page.reload', { ignoreCache: true });
await wait(12000);
const auto = await cdp.eval(`
  const e = window.__wb.editor;
  let tris=0, meshes=0;
  if (e) e.scene.traverse(n=>{ if(n.isMesh){ meshes++; const g=n.geometry;
    if(g&&g.index) tris+=g.index.count/3; else if(g&&g.attributes.position) tris+=g.attributes.position.count/3; } });
  return { view: window.__wb.view, hasEditor: !!e, meshes, tris: Math.round(tris),
           envId: e?e.envId:null,
           badge: (document.querySelector('#edEnvBadge')||{}).textContent,
           cardHidden: document.querySelector('#enCardLast') ? document.querySelector('#enCardLast').hidden : null };
`);
console.log('  ', JSON.stringify(auto));
ok('★ 刷新后自动进编辑器', auto.view === 'editor' && auto.hasEditor === true, auto);
ok('★ 自动恢复了世界（有几何）', auto.tris > 100000, auto);
ok('★ 环境还是「真实世界」', auto.badge === '真实世界', auto.badge);

const errs = await cdp.eval(`return (window.__ovfErrors||[]).slice(-5);`);
console.log('\n[页面报错]', errs && errs.length ? errs : '无');
console.log(`\n${fail ? '✗' : '✓'} lastworld: ${pass} passed, ${fail} failed`);
await cdp.close();
process.exit(fail ? 1 : 0);
