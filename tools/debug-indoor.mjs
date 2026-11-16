#!/usr/bin/env node
/* 确认：进室内后场景里到底有没有可变换的物体 */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const e = window.__wb.editor;
  const S = (l) => ({ l, objects: (e.objects||[]).length, sel: e.selected ? 'yes' : null,
                      indoor: !!e._interior, floor: e._interiorFloor });
  const out = [S('起点')];
  await window.WB_AGENT.run('world.build', { kind:'city' });
  await new Promise(r=>setTimeout(r,2500));
  out.push(S('world.build city'));
  await window.WB_AGENT.run('building.enter', {});
  await new Promise(r=>setTimeout(r,1500));
  out.push(S('building.enter'));
  try { e.addAsset('tree'); } catch(err) { out.push({ addErr: String(err) }); }
  await new Promise(r=>setTimeout(r,1500));
  out.push(S('addAsset 之后'));
  const t = await window.WB_AGENT.run('asset.transform', { x:3, y:0, z:4 });
  out.push({ transform: t });
  // 退出室内再试
  try { await window.WB_AGENT.run('building.exit', {}); } catch(_) {}
  await new Promise(r=>setTimeout(r,800));
  out.push(S('building.exit'));
  try { e.addAsset('tree'); } catch(_) {}
  await new Promise(r=>setTimeout(r,1200));
  const t2 = await window.WB_AGENT.run('asset.transform', { x:3, y:0, z:4 });
  out.push({ transformAfterExit: t2 });
  return out;
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
