#!/usr/bin/env node
import { CDP } from './cdp.mjs';
const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
const r = await cdp.eval(`
  const e = window.__wb.editor;
  let b=null, t=null;
  e.envGroup.traverse(o=>{ if(o.name==='osm-buildings') b=o; if(o.name==='osm-terrain') t=o; });
  const bb=(m)=>{ if(!m) return null; m.geometry.computeBoundingBox(); const x=m.geometry.boundingBox;
    return { min:x.min.toArray().map(v=>Math.round(v)), max:x.max.toArray().map(v=>Math.round(v)) }; };
  let terrainY=null;
  if (t){ t.geometry.computeBoundingBox(); const x=t.geometry.boundingBox;
    terrainY={ min:Math.round(x.min.y), max:Math.round(x.max.y) }; }
  return { target:[Math.round(e.target.x),Math.round(e.target.y),Math.round(e.target.z)],
           r: Math.round(e.sph.r), phi:+e.sph.phi.toFixed(2), theta:+e.sph.theta.toFixed(2),
           cam:[Math.round(e.camera.position.x),Math.round(e.camera.position.y),Math.round(e.camera.position.z)],
           buildings: bb(b), terrainY, envSize: e.envSize,
           cityState: e._cityState ? { buildings: (e._cityState.plan.buildings||[]).length } : null };
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
