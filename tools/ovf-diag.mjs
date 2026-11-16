/* 诊断：OSM 世界到底有没有几何、在哪、相机在哪 */
import { CDP } from './cdp.mjs';

const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');

const r = await cdp.eval(`
  const e = window.__wb && window.__wb.editor;
  if (!e) return { error: 'no editor' };
  const out = { envId: e.envId, envScale: e.envScale, envSize: e.envSize };
  out.camera = {
    pos: e.camera.position.toArray().map(n => +n.toFixed(1)),
    target: e.target.toArray().map(n => +n.toFixed(1)),
    near: e.camera.near, far: e.camera.far, fov: e.camera.fov,
    sph: { r: +e.sph.r.toFixed(1), phi: +e.sph.phi.toFixed(2), theta: +e.sph.theta.toFixed(2) },
  };
  out.envGroup = {
    children: e.envGroup.children.length,
    visible: e.envGroup.visible,
    kids: e.envGroup.children.map(c => ({
      name: c.name || c.type,
      type: c.type,
      visible: c.visible,
      children: c.children ? c.children.length : 0,
    })),
  };
  const st = e._cityState;
  out.cityState = st ? {
    kind: st.plan && st.plan.kind,
    size: st.plan && st.plan.size,
    groupKids: st.group ? st.group.children.map(c => ({ name: c.name||c.type, type: c.type, visible: c.visible, n: c.children?c.children.length:0 })) : null,
  } : null;
  // OSM 组的包围盒
  const THREEBox = e.envGroup.children[0];
  if (THREEBox && THREEBox.type === 'Group') {
    const bb = { min: [1e9,1e9,1e9], max: [-1e9,-1e9,-1e9] };
    let meshes = 0, verts = 0;
    THREEBox.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh) {
        meshes++;
        const g = o.geometry;
        if (g && g.attributes && g.attributes.position) {
          verts += g.attributes.position.count;
          g.computeBoundingBox();
          const b = g.boundingBox;
          bb.min[0] = Math.min(bb.min[0], b.min.x); bb.max[0] = Math.max(bb.max[0], b.max.x);
          bb.min[1] = Math.min(bb.min[1], b.min.y); bb.max[1] = Math.max(bb.max[1], b.max.y);
          bb.min[2] = Math.min(bb.min[2], b.min.z); bb.max[2] = Math.max(bb.max[2], b.max.z);
        }
      }
    });
    out.osmGroup = { meshes, verts, bbMin: bb.min.map(n=>+n.toFixed(1)), bbMax: bb.max.map(n=>+n.toFixed(1)) };
  }
  out.fog = e.scene.fog ? { near: e.scene.fog.near, far: e.scene.fog.far } : null;
  out.renderInfo = { calls: e.renderer.info.render.calls, tris: e.renderer.info.render.triangles };
  return out;
`);
console.log(JSON.stringify(r, null, 1));
await cdp.close();
