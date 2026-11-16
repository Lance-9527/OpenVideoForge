/* ============================================================================
 * js/worldgen/osm.js —— 真实世界（OSM）→ three.js 几何
 *
 * 性能策略：**合并几何 + 顶点色**，不按楼一栋 Mesh。
 *   涩谷 200m 就有 284 栋楼 + 543 段路；一栋一个 Mesh 就是 800+ draw call。
 *   这里把整片街区压成 4 个 BufferGeometry（楼 / 路 / 水 / 绿），共 4 个 draw call。
 *
 * 颜色：直接用 OSM 的**语义标签**上色（building=church 暖色、highway=footway 浅色…），
 *   这是纯几何启发式做不到的 —— 语义是数据自带的，不是猜的。
 *
 * 版权：数据 © OpenStreetMap contributors（ODbL）。attribution 会随 world 一起带出，
 *   出片时必须写进片尾/字幕。本文件只处理数据，不涉及任何第三方工具。
 * ========================================================================== */
import * as THREE from 'three';
import { buildTerrain, makeSampler } from './terrain.js?v=76';

/**
 * 把若干个多边形挤出成**一个**合并几何（顶点色）。
 * items: [{ ring:[{x,z}...]（已闭合）, height, color }]
 */
function extrudePolygons(items) {
  const pos = [];
  const col = [];
  const c = new THREE.Color();

  for (const it of items) {
    const ring = it.ring;
    if (!ring || ring.length < 4) continue;
    const h = Math.max(0.2, it.height || 1);
    // ★ 2026-11-08：有地形时，楼要**站在地形上**（baseY = 地面高度），
    //   否则山坡上的楼会一半埋进土里 / 一半浮空。
    const baseY = Number.isFinite(it.baseY) ? it.baseY : 0;
    c.setHex(it.color || 0xcccccc);
    // 楼顶轻微提亮，侧面固定，让体块有层次（不依赖光照也读得清）
    const topC = c.clone().multiplyScalar(1.06);
    const sideC = c.clone().multiplyScalar(0.94);

    // ── 顶面：三角化（three 自带 ear clipping）
    const contour = ring.slice(0, ring.length - 1).map((p) => new THREE.Vector2(p.x, p.z));
    let faces = [];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch (e) {
      faces = [];
    }
    for (const f of faces) {
      for (const idx of f) {
        const p = contour[idx];
        pos.push(p.x, baseY + h, p.y);
        col.push(topC.r, topC.g, topC.b);
      }
    }

    // ── 侧墙：每条边一个四边形（两个三角形）
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i];
      const b = contour[(i + 1) % contour.length];
      // 退化边跳过
      if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) continue;
      const quad = [
        [a.x, baseY, a.y], [b.x, baseY, b.y], [b.x, baseY + h, b.y],
        [a.x, baseY, a.y], [b.x, baseY + h, b.y], [a.x, baseY + h, a.y],
      ];
      for (const v of quad) {
        pos.push(v[0], v[1], v[2]);
        col.push(sideC.r, sideC.g, sideC.b);
      }
    }
  }

  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** 道路：沿折线生成带宽度的带状面（每段一个四边形） */
function ribbonGeometry(roads, sampler) {
  const pos = [];
  const col = [];
  const c = new THREE.Color();
  const Y = 0.04;
  // 有地形时，路面跟着地形起伏（否则坡地上的路会一半埋土里）
  const h = (p) => (sampler ? sampler(p.x, p.z) + Y : Y);

  for (const rd of roads) {
    const pts = rd.path;
    if (!pts || pts.length < 2) continue;
    c.setHex(rd.color || 0xbbbbbb);
    const hw = Math.max(0.6, (rd.width || 5) / 2);
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      let dx = b.x - a.x, dz = b.z - a.z;
      const L = Math.hypot(dx, dz);
      if (L < 1e-4) continue;
      dx /= L; dz /= L;
      // 法线（在 XZ 平面里转 90°）
      const nx = -dz * hw, nz = dx * hw;
      const p1 = [a.x + nx, h(a), a.z + nz];
      const p2 = [b.x + nx, h(b), b.z + nz];
      const p3 = [b.x - nx, h(b), b.z - nz];
      const p4 = [a.x - nx, h(a), a.z - nz];
      for (const v of [p1, p2, p3, p1, p3, p4]) {
        pos.push(v[0], v[1], v[2]);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/** 点是否在多边形内（射线法；poly 是 [{x,z}]） */
function pointInPolygon(poly, x, z) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * ★ 2026-11-10：把地形在**水域下面**挖低（造出江床/河床）。
 *
 * 为什么需要：真实世界里水低于岸。如果水面和地形用同一个高度，
 *   水面就会跟地形 z-fighting，或者干脆被地形挡住 ⇒ **整条江看不见**
 *   （实测上海黄浦区：waters=50，但画面里找不到黄浦江）。
 *
 * 做法：地形顶点如果落在某个水体多边形内 ⇒ 压到该水体的水位 − depth。
 *   ★ 每个水体用自己的水位（分段）—— 江有坡降，一段一个水位。
 *
 * @param {THREE.Mesh} terrainMesh 地形网格
 * @param {Array} waters 水体列表（每个有 ring，可能自带 y）
 * @param {number} depth 江床深度（米）
 */
function carveTerrainUnderWater(terrainMesh, waters, depth = 2.5) {
  if (!terrainMesh || !waters.length) return 0;
  const pos = terrainMesh.geometry.attributes.position;
  // 先算每个水体的 bbox（快速排除）
  const boxes = waters.map((w) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of w.ring) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    }
    return { ring: w.ring, minX, maxX, minZ, maxZ, y: Number.isFinite(w.y) ? w.y : 0 };
  }).filter((b) => Number.isFinite(b.minX));
  if (!boxes.length) return 0;

  let carved = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    for (const b of boxes) {
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (!pointInPolygon(b.ring, x, z)) continue;
      const floor = b.y - depth;
      if (pos.getY(i) > floor) { pos.setY(i, floor); carved++; }
      break;
    }
  }
  if (carved) {
    pos.needsUpdate = true;
    terrainMesh.geometry.computeVertexNormals();
    terrainMesh.geometry.computeBoundingSphere();
  }
  return carved;
}

/** 平面多边形（水 / 绿地）：三角化后贴在某个 y 上（每个 item 可用自己的 y） */
function flatPolygons(items, y) {
  const pos = [];
  const col = [];
  const c = new THREE.Color();
  for (const it of items) {
    const ring = it.ring;
    if (!ring || ring.length < 4) continue;
    c.setHex(it.color || 0xbbbbbb);
    const contour = ring.slice(0, ring.length - 1).map((p) => new THREE.Vector2(p.x, p.z));
    let faces = [];
    try { faces = THREE.ShapeUtils.triangulateShape(contour, []); } catch (e) { faces = []; }
    // ★ 有地形时 ring 上带 y（逐点高程）→ 用它，而不是统一的 y
    // ★ 每个 item 也能自带 y（分段水位用）—— it.y 优先
    const iy = Number.isFinite(it.y) ? it.y : y;
    const ys = ring.slice(0, ring.length - 1).map((p) => (Number.isFinite(p.y) ? p.y : iy));
    for (const f of faces) {
      for (const idx of f) {
        const p = contour[idx];
        pos.push(p.x, ys[idx], p.y);
        col.push(c.r, c.g, c.b);
      }
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * 建真实世界。
 * @param {object} world normalizeOsm() 的产物
 * @param {object} opts  { terrain } 地形高程网格（有就起伏，没有就平地面）
 * @returns {{group, meshes, propsGroup, plan}} plan 与 city 的 plan 结构对齐，方便 editor 复用
 */
export function buildOsm(world, opts = {}) {
  const group = new THREE.Group();
  group.name = 'osm-world';
  const meshes = {};
  const b = world.bounds || { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };
  const spanX = Math.max(20, b.maxX - b.minX);
  const spanZ = Math.max(20, b.maxZ - b.minZ);
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;

  /* ── 地形高程（可选；没有就平地面） ─────────────────────────────────── */
  let sampler = null;
  let terrainMesh = null;
  const tGrid = opts.terrain && opts.terrain.values ? opts.terrain : null;
  if (tGrid) {
    // ★ 2026-11-10：地形范围按**城市本体**（cityBounds）来定，
    //   不用含远郊道路的全范围 —— 否则地形网格会被撑到 15km 见方，
    //   边缘全是"用边缘值延伸出来的假平地"（实测上海黄浦区）。
    const cb = world.cityBounds || b;
    const tSpanX = Math.max(20, cb.maxX - cb.minX);
    const tSpanZ = Math.max(20, cb.maxZ - cb.minZ);
    const tcx = (cb.minX + cb.maxX) / 2;
    const tcz = (cb.minZ + cb.maxZ) / 2;
    // ★ 地形要比城市本体**大一圈**（留 12% 余量）——
    //   否则地形边缘正好切在建筑边上，画面里出现一条生硬的斜切白边（实测上海）。
    const pad = Math.max(tSpanX, tSpanZ) * 0.12;
    const t = buildTerrain(tGrid, {
      minX: tcx - tSpanX / 2 - tGrid.step - pad,
      minZ: tcz - tSpanZ / 2 - tGrid.step - pad,
      width: tSpanX + tGrid.step * 2 + pad * 2,
      depth: tSpanZ + tGrid.step * 2 + pad * 2,
      seg: Math.max(32, Math.min(192, tGrid.size * 2)),
      color: 0xc4c0b0,
    });
    if (t) {
      sampler = t.sampler;
      terrainMesh = t.mesh;
      group.add(terrainMesh);
      meshes.terrain = terrainMesh;
    }
  }

  /* ── 地面 ───────────────────────────────────────────────────────────── */
  const pad = Math.max(spanX, spanZ) * 0.08;
  if (!terrainMesh) {
    const gm = new THREE.Mesh(
      new THREE.PlaneGeometry(spanX + pad * 2, spanZ + pad * 2),
      new THREE.MeshStandardMaterial({ color: 0xd0cfc7, roughness: 0.97 }),
    );
    gm.rotation.x = -Math.PI / 2;
    gm.position.set(cx, 0, cz);
    gm.receiveShadow = true;
    gm.name = 'floor-osm';
    gm.userData.pickable = false;
    gm.userData.role = 'floor';
    group.add(gm);
    meshes.floor = gm;
  }

  /* ── 绿地 / 水面（贴地两层；有地形时跟着地形起伏） ────────────────────── */
  // 地形下绿地/水面如果还是平的，会跟坡地打架 → 按地形高程逐顶点抬升。
  const lift = (items, dy) => {
    if (!sampler) return items;
    return items.map((it) => {
      const ring = it.ring.map((p) => ({ x: p.x, z: p.z, y: sampler(p.x, p.z) + dy }));
      return { ...it, ring };
    });
  };
  const greenGeo = flatPolygons(lift(world.greens || [], 0.015), 0.015);

  // ★ 2026-11-10：**水面必须是水平面，而且分段定水位**。
  //   之前水面按地形逐顶点抬升 ⇒ 长江/黄浦江跟着地形起伏、被地形盖住，
  //   画面上**整条江都看不见**（实测上海黄浦区 waters=50 但画面里没有江）。
  //
  //   水位怎么定？
  //   · DEM 瓦片在水面上给的是**岸高**（OSM 的 riverbank 沿着岸线描）
  //     ⇒ 直接采样会取到岸高 ⇒ 水面跟岸一样高 ⇒ 又看不见。
  //   · 全城一个水位也不行：江有坡降，一段一个水位才自然。
  //   ⇒ **每个水体自己算**：水位 = 该水体的岸高中位数 − 水深。
  //     （江的各段在 normalizeOsm 里就是不同的 item ⇒ 天然分段）
  const waterItems = (world.waters || []).map((it) => {
    if (!sampler) return { ...it, y: 0.02 };
    const hs = [];
    for (const p of it.ring) {
      const h = sampler(p.x, p.z);
      if (Number.isFinite(h)) hs.push(h);
    }
    if (!hs.length) return { ...it, y: 0.02 };
    hs.sort((a, b) => a - b);
    const bank = hs[Math.floor(hs.length * 0.5)];
    // 水深：按这个水体的规模（面积大的更深），0.5~3m
    let a2 = 0;
    for (let i = 0; i < it.ring.length - 1; i++) {
      a2 += Math.abs(it.ring[i].x * it.ring[i + 1].z - it.ring[i + 1].x * it.ring[i].z);
    }
    const area = a2 / 2;
    const depth = Math.max(0.5, Math.min(3, area / 20000));
    return { ...it, y: bank - depth };
  });
  const waterY = waterItems.length ? waterItems[0].y : 0.02;
  // 不带 y ⇒ flatPolygons 用每个 item 自己的 y ⇒ **分段水平面**
  const flatWater = waterItems.map((it) => ({
    ...it, ring: it.ring.map((p) => ({ x: p.x, z: p.z })),
  }));
  const waterGeo = flatPolygons(flatWater, waterY);
  if (greenGeo) {
    const m = new THREE.Mesh(greenGeo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.98, metalness: 0,
    }));
    m.receiveShadow = true;
    m.name = 'osm-greens';
    m.userData.pickable = false;
    group.add(m);
    meshes.greens = m;
  }
  if (waterGeo) {
    const m = new THREE.Mesh(waterGeo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.35, metalness: 0.05,
    }));
    m.receiveShadow = true;
    m.name = 'osm-waters';
    m.userData.pickable = false;
    group.add(m);
    meshes.waters = m;
    // ★ 2026-11-10：**地形在水域下面挖低**（江床）。
    //   否则水面正好贴在原地形高度上 ⇒ z-fighting + 被地形遮住 ⇒ 江看不见。
    //   ★ 每个水体用自己的水位（分段）⇒ 江床也跟着分段。
    if (terrainMesh) carveTerrainUnderWater(terrainMesh, waterItems);
  }

  /* ── 道路（单几何） ──────────────────────────────────────────────────── */
  const roadGeo = ribbonGeometry(world.roads || [], sampler);
  if (roadGeo) {
    const m = new THREE.Mesh(roadGeo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.92, metalness: 0,
    }));
    m.receiveShadow = true;
    m.name = 'osm-roads';
    m.userData.pickable = false;
    group.add(m);
    meshes.roads = m;
  }

  /* ── 建筑（单几何，顶点色） ─────────────────────────────────────────── */
  // 有地形时，每栋楼的底面抬到它所在位置的地面高度
  const bItems = world.buildings || [];
  const bForGeo = sampler
    ? bItems.map((it) => {
      let sx = 0, sz = 0;
      for (const p of it.ring) { sx += p.x; sz += p.z; }
      const n = it.ring.length || 1;
      const baseY = sampler(sx / n, sz / n);
      // ★ 2026-11-10：**把楼基高度写回原对象**。
      //   之前只存在于 bForGeo 的副本里 ⇒ 取景（_osmFraming）和落地高度
      //   （groundHeightAt）都拿不到 ⇒ 相机落在地形下面，画面一片灰。
      it.baseY = baseY;
      return { ...it, baseY };
    })
    : bItems;
  const bGeo = extrudePolygons(bForGeo);
  if (bGeo) {
    const m = new THREE.Mesh(bGeo, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.88, metalness: 0,
      // 三角化 + 侧墙的绕向在不同数据里不一定统一；双面渲染保证不漏面。
      // 代价是建筑不剔除背面（对预演足够，真要省就按绕向统一后再改回 FrontSide）。
      side: THREE.DoubleSide,
    }));
    m.castShadow = true;
    m.receiveShadow = true;
    m.name = 'osm-buildings';
    group.add(m);
    meshes.buildings = m;
  }

  /* ── 树（实例化） ───────────────────────────────────────────────────── */
  const propsGroup = new THREE.Group();
  propsGroup.name = 'osm-props';
  group.add(propsGroup);
  const trees = world.trees || [];
  if (trees.length) {
    const trunk = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(0.16, 0.26, 1, 6),
      new THREE.MeshStandardMaterial({ color: 0xb0ac96, roughness: 0.95 }),
      trees.length,
    );
    const canopy = new THREE.InstancedMesh(
      new THREE.SphereGeometry(1, 9, 6),
      new THREE.MeshStandardMaterial({ color: 0xc7cdb0, roughness: 0.95 }),
      trees.length,
    );
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    trees.forEach((t, i) => {
      const H = t.height || 4;
      const R = t.radius || 1.6;
      const gy = sampler ? sampler(t.point.x, t.point.z) : 0;   // ★ 树站在地形上
      p.set(t.point.x, gy + H / 2, t.point.z); s.set(1, H, 1); q.identity();
      trunk.setMatrixAt(i, m4.compose(p, q, s));
      p.set(t.point.x, gy + H + R * 0.7, t.point.z); s.set(R, R * 0.9, R);
      canopy.setMatrixAt(i, m4.compose(p, q, s));
    });
    trunk.instanceMatrix.needsUpdate = true;
    canopy.instanceMatrix.needsUpdate = true;
    trunk.name = 'osm-treeTrunk';
    canopy.name = 'osm-treeCanopy';
    canopy.castShadow = true;
    propsGroup.add(trunk, canopy);
    meshes.treeTrunk = trunk;
    meshes.treeCanopy = canopy;
  }

  // 与 city 的 plan 结构对齐（editor.worldInfo / updateCityLod 直接复用）
  const size = Math.max(spanX, spanZ);
  const plan = {
    kind: 'osm',
    size,
    half: size / 2,
    origin: world.origin,
    attribution: world.attribution,
    bounds: world.bounds,
    cityBounds: world.cityBounds,
    buildings: world.buildings || [],
    // ★ 2026-11-10：把水体/绿地也放进 plan ——
    //   取景（_osmFraming）要用水系的位置把相机摆到江那一侧（实测：之前背对江）。
    waters: world.waters || [],
    greens: world.greens || [],
    stats: {
      lots: 0,
      buildings: (world.buildings || []).length,
      roads: (world.roads || []).length,
      props: trees.length,
      chunks: 0,
      tallest: (world.stats && world.stats.tallest) || 0,
      pitch: null,
      waters: (world.waters || []).length,
      greens: (world.greens || []).length,
      trees: trees.length,
    },
  };

  return { group, meshes, propsGroup, plan };
}
