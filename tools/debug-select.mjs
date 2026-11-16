#!/usr/bin/env node
/* 诊断：asset.add 之后 asset.transform 为什么说"没有选中的对象" */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');

const r = await cdp.eval(`
  const e = window.__wb.editor;
  const out = { steps: [] };
  const S = (label) => out.steps.push({ label,
    objects: (e.objects||[]).length,
    sel: e.selected ? (e.selected.instanceId || e.selected.assetId || 'yes') : null,
    selKids: e.selected && e.selected.group ? e.selected.group.children.length : -1 });

  S('起点');
  const a = await window.WB_AGENT.run('asset.add', { asset:'tree' });
  out.add = a; S('asset.add 之后');
  const t = await window.WB_AGENT.run('asset.transform', { x:3, y:0, z:4 });
  out.transform = t; S('asset.transform 之后');
  // 再试一次带 instanceId 的
  const t2 = await window.WB_AGENT.run('asset.transform', { instanceId: (e.objects||[]).slice(-1)[0]?.instanceId, x:3, y:0, z:4 });
  out.transformById = t2; S('带 instanceId 之后');
  return out;
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
