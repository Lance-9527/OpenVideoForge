#!/usr/bin/env node
/* 量 wb_render_batch / wb_video 到底卡在哪 */
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const e = window.__wb.editor;
  const out = {};
  // 场景规模
  let tris=0, meshes=0, objs=0;
  e.scene.traverse(n=>{ if(n.isMesh){ meshes++; const g=n.geometry;
    if(g&&g.index) tris+=g.index.count/3; else if(g&&g.attributes.position) tris+=g.attributes.position.count/3; } });
  out.scene = { meshes, tris: Math.round(tris), objects: e.objects?e.objects.length:-1, envId: e.envId };
  // 场景里有什么
  const names=[];
  e.scene.traverse(n=>{ if(n.isMesh && n.name) names.push(n.name); });
  out.meshNames = [...new Set(names)].slice(0,12);
  out.envChildren = e.envGroup ? e.envGroup.children.length : -1;
  // 单帧出图要多久
  let t0 = Date.now();
  const url = e.captureThumb(640,360);
  out.thumbMs = Date.now()-t0;
  out.thumbBytes = url ? url.length : 0;
  // 视频模块在不在
  out.hasVideo = !!window.__studioVideo;
  // 渲染器信息
  out.renderInfo = e.renderer ? { calls:e.renderer.info.render.calls, tris:e.renderer.info.render.triangles, programs:e.renderer.info.programs?e.renderer.info.programs.length:-1 } : null;
  return out;
`);
console.log(JSON.stringify(r, null, 1));

const v = await cdp.eval(`
  const t0 = Date.now();
  try {
    const res = await window.WB_AGENT.run('video.export', { w:640, h:360, fps:10, download:false });
    return { ms: Date.now()-t0, ok: !!(res&&res.ok), res: JSON.stringify(res).slice(0,300), err: res&&res.error };
  } catch(e) { return { ms: Date.now()-t0, thrown: String(e).slice(0,200) }; }
`);
console.log('video.export:', JSON.stringify(v));
await cdp.close();
