/* ============================================================================
 * js/worldgen/city.js —— 把 plan.js 的布局变成 InstancedMesh
 *
 * 性能要点（"性能更强"）：
 *   · 每种构件只用一个 InstancedMesh ⇒ 整座城 ~8 个 draw call；
 *     9000 栋楼如果每栋一个 Mesh，就是 9000 次 draw call，必卡。
 *   · 颜色走 instanceColor（每个实例一个色调），不增加 draw call。
 *   · 道具（树/灯/椅）是"近景细节"，相机离远时整组隐藏 —— 最省的一档 LOD。
 *   · 阴影只让楼和路面参与，道具不投影（省掉最大的一块 shadow 开销）。
 * ========================================================================== */
import * as THREE from 'three';
import { planCity, PROP_KINDS, visibleChunks } from './plan.js?v=76';

const MAT = (color, rough = 0.92) =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0 });

/** 实例矩阵：T(x, y, z) · R(y, rot) · S(w, h, d)，底面贴地 */
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Euler();
function compose(x, y, z, w, h, d, rot) {
  _e.set(0, rot || 0, 0);
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(w, h, d);
  return _m.compose(_p, _q, _s);
}

/**
 * 建一座城。
 * @param {object} plan  planCity() 的产物
 * @returns {{group:THREE.Group, meshes:object, stats:object}}
 */
export function buildCity(plan) {
  const group = new THREE.Group();
  group.name = 'city-world';
  const meshes = {};

  const half = plan.half;

  /* ── 地面 ───────────────────────────────────────────────────────────── */
  const groundGeo = new THREE.PlaneGeometry(plan.size, plan.size);
  const groundMat = MAT(0xc4c8bc, 0.96);
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  // 地面不允许被鼠标点选（沿用 scenes.js 的规则：点到地板会"接管"成物体）
  ground.name = 'floor-city';
  ground.userData.pickable = false;
  ground.userData.role = 'floor';
  group.add(ground);

  /* ── 道路（一个 InstancedMesh 画完所有路） ───────────────────────────── */
  if (plan.roads.length) {
    const roadGeo = new THREE.BoxGeometry(1, 1, 1);
    const roadMat = MAT(0xb9bdc0, 0.9);
    const roads = new THREE.InstancedMesh(roadGeo, roadMat, plan.roads.length);
    roads.receiveShadow = true;
    roads.castShadow = false;
    plan.roads.forEach((r, i) => {
      const th = r.major ? 0.10 : 0.07;
      roads.setMatrixAt(i, compose(r.x, th / 2, r.z, r.w, th, r.d, 0));
      roads.setColorAt(i, new THREE.Color(r.major ? 0xb2b6ba : 0xc0c4c7));
    });
    roads.instanceMatrix.needsUpdate = true;
    if (roads.instanceColor) roads.instanceColor.needsUpdate = true;
    roads.name = 'city-roads';
    roads.userData.pickable = false;
    group.add(roads);
    meshes.roads = roads;
  }

  /* ── 楼（**按块**分 InstancedMesh ⇒ 分块裁剪才成立） ─────────────────────
   * 为什么按块而不是整城一个：
   *   整城一个 InstancedMesh 时，块的 boundingSphere 覆盖全世界，
   *   任何距离都在画，`visibleChunks` 就只能是摆设。
   *   按块拆之后：一块 = 1 次 draw call；看不见的块整个 `.visible=false`，
   *   GPU 完全不碰。块数封顶 20×20=400（实测 7×7 窗口只留 ~12%）。
   *   几何与材质**共享同一份**（unit box + 一个材质），所以多出来的只是实例缓冲，不涨显存。 */
  const chunkMeshes = { buildings: new Map() };
  if (plan.buildings.length) {
    const bGeo = new THREE.BoxGeometry(1, 1, 1);
    const bMat = MAT(0xffffff, 0.9);
    const col = new THREE.Color();
    const byChunk = new Map();
    for (const b of plan.buildings) {
      if (!byChunk.has(b.chunk)) byChunk.set(b.chunk, []);
      byChunk.get(b.chunk).push(b);
    }
    for (const [chunkId, list] of byChunk) {
      const im = new THREE.InstancedMesh(bGeo, bMat, list.length);
      im.castShadow = true;
      im.receiveShadow = true;
      list.forEach((b, i) => {
        im.setMatrixAt(i, compose(b.x, b.h / 2, b.z, b.w, b.h, b.d, b.rot));
        col.setHex(b.color);
        // 轻微明暗抖动，避免整片颜色一模一样
        col.multiplyScalar(0.94 + ((i * 37) % 13) / 100);
        im.setColorAt(i, col);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.name = 'city-buildings-chunk-' + chunkId;
      im.userData.chunk = chunkId;
      group.add(im);
      chunkMeshes.buildings.set(chunkId, im);
    }
    meshes.buildings = [...chunkMeshes.buildings.values()];
  }

  /* ── 道具（近景细节，可整组隐藏） ─────────────────────────────────────── */
  const propsGroup = new THREE.Group();
  propsGroup.name = 'city-props';
  group.add(propsGroup);

  const byKind = {};
  for (const p of plan.props) (byKind[p.kind] = byKind[p.kind] || []).push(p);

  const addInstanced = (name, geo, mat, items, place, castShadow) => {
    if (!items.length) return null;
    const im = new THREE.InstancedMesh(geo, mat, items.length);
    im.castShadow = !!castShadow;
    im.receiveShadow = false;
    items.forEach((it, i) => place(im, i, it));
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.name = 'city-' + name;
    propsGroup.add(im);
    meshes[name] = im;
    return im;
  };

  // 路灯：杆 + 灯头
  if (byKind.lamp) {
    addInstanced('lampPole',
      new THREE.CylinderGeometry(0.08, 0.10, 1, 6), MAT(PROP_KINDS.lamp.color, 0.9),
      byKind.lamp, (im, i, it) => {
        const h = PROP_KINDS.lamp.h * it.s;
        im.setMatrixAt(i, compose(it.x, h / 2, it.z, 1, h, 1, 0));
      }, true);
    addInstanced('lampHead',
      new THREE.BoxGeometry(0.34, 0.14, 0.34), MAT(0xefe9d8, 0.85),
      byKind.lamp, (im, i, it) => {
        const h = PROP_KINDS.lamp.h * it.s;
        im.setMatrixAt(i, compose(it.x + 0.3, h, it.z, 1, 1, 1, 0));
      }, false);
  }
  // 树：树干 + 树冠
  if (byKind.tree) {
    addInstanced('treeTrunk',
      new THREE.CylinderGeometry(0.16, 0.26, 1, 6), MAT(0xb0ac96, 0.95),
      byKind.tree, (im, i, it) => {
        const h = 1.6 * it.s;
        im.setMatrixAt(i, compose(it.x, h / 2, it.z, 1, h, 1, 0));
      }, false);
    addInstanced('treeCanopy',
      new THREE.SphereGeometry(1, 10, 7), MAT(0xc7cdb0, 0.95),
      byKind.tree, (im, i, it) => {
        const h = 1.6 * it.s;
        const r = 1.15 * it.s;
        im.setMatrixAt(i, compose(it.x, h + r * 0.75, it.z, r, r * 0.92, r, it.rot));
      }, true);
  }
  // 灌木
  if (byKind.bush) {
    addInstanced('bush',
      new THREE.SphereGeometry(1, 8, 6), MAT(PROP_KINDS.bush.color, 0.95),
      byKind.bush, (im, i, it) => {
        const r = 0.7 * it.s;
        im.setMatrixAt(i, compose(it.x, r * 0.6, it.z, r * 1.1, r * 0.8, r, it.rot));
      }, false);
  }
  // 长椅
  if (byKind.bench) {
    addInstanced('bench',
      new THREE.BoxGeometry(1.8, 0.09, 0.5), MAT(PROP_KINDS.bench.color, 0.9),
      byKind.bench, (im, i, it) => {
        im.setMatrixAt(i, compose(it.x, 0.46, it.z, it.s, 1, it.s, it.rot));
      }, true);
  }

  // ★ 2026-11-08：plan 必须跟着 state 一起返回。
  //   之前只有 makeCity() 补了 built.plan，直接调 buildCity() 的路径
  //   （测试 / 未来的插件分块加载）拿到的是 undefined，
  //   applyChunkCulling() 会因为读不到 plan 而静默返回 0、一块都不裁。
  return { group, meshes, propsGroup, chunkMeshes, plan, stats: plan.stats };
}

/**
 * 分块裁剪：只显示"观察点附近 range 圈内"的块，其余整块关掉。
 * 用 target（不是相机）作观察点 —— 阴影相机跟着 target 走，
 * 所以被裁掉的必然也不在阴影里，不会出现"影子没了"的破绽。
 * @returns {number} 实际显示的块数
 */
export function applyChunkCulling(state, focus, range = 3) {
  if (!state || !state.chunkMeshes || !state.plan) return 0;
  const vis = visibleChunks(state.plan, focus, range);
  let shown = 0;
  for (const [id, im] of state.chunkMeshes.buildings) {
    const v = vis.has(id);
    if (im.visible !== v) im.visible = v;
    if (v) shown++;
  }
  state._visibleChunks = shown;
  state._cullRange = range;
  return shown;
}

/**
 * 运行时 LOD：相机离世界越远，越裁道具（最贵的一块是树冠的三角面）。
 * @param {object} state buildCity() 的返回
 * @param {THREE.Vector3} camPos
 * @param {number} size 世界边长
 */
export function updateCityLod(state, camPos, size) {
  if (!state || !state.propsGroup) return;
  const d = Math.hypot(camPos.x, camPos.z);
  // 距中心 < 0.6×边长：全显示；< 1.2×：只留树和灯；更远：全隐藏
  const ratio = d / Math.max(1, size);
  const want = ratio < 0.6 ? 'full' : ratio < 1.2 ? 'mid' : 'none';
  if (state._lod === want) return;
  state._lod = want;
  for (const child of state.propsGroup.children) {
    if (want === 'full') child.visible = true;
    else if (want === 'mid') child.visible = /tree|lamp/.test(child.name);
    else child.visible = false;
  }
}

/**
 * 世界尺寸档位 → 直接拿到一个可用的城市（scenes.js 的 envCity 调它）。
 */
export function makeCity(factor, opts = {}) {
  const plan = planCity({ factor, seed: opts.seed ?? 20261008, density: opts.density ?? 1 });
  const built = buildCity(plan);
  built.plan = plan;
  return built;
}
