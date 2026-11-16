/* ============================================================================
 * js/worldgen/interior.js —— 室内布局 → three.js 几何
 *
 * 性能：墙/家具/地板/天花全部**合并成一个 BufferGeometry + 顶点色** ⇒ 1 个 draw call。
 * 灯是真的 THREE.PointLight（同一时刻只开一栋楼的室内，灯数可控）。
 *
 * 为什么天花板和窗洞很重要：
 *   屋顶一盖、窗一开，屋里就是"有光进来、能看见外面街区"的真实空间，
 *   这才谈得上"进屋实拍"；否则只是个黑盒子。
 * ========================================================================== */
import * as THREE from 'three';
import { planInterior } from './interior-plan.js';

/** 把一个轴对齐盒子压进 (pos, col) 数组 */
function pushBox(pos, col, b, color) {
  const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2;
  const z0 = b.z - b.d / 2, z1 = b.z + b.d / 2;
  const y0 = b.y0 ?? 0, y1 = y0 + b.h;
  const c = new THREE.Color(color);
  const quads = [
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
    [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
    [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]],
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
    [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]],
    [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
  ];
  for (const q of quads) {
    for (const idx of [0, 1, 2, 0, 2, 3]) {
      const v = q[idx];
      pos.push(v[0], v[1], v[2]);
      col.push(c.r, c.g, c.b);
    }
  }
}

/** 水平面（地板/天花） */
function pushPlane(pos, col, p, color, up) {
  const x0 = p.x - p.w / 2, x1 = p.x + p.w / 2;
  const z0 = p.z - p.d / 2, z1 = p.z + p.d / 2;
  const y = p.y;
  const c = new THREE.Color(color);
  const quad = up
    ? [[x0, y, z1], [x1, y, z1], [x1, y, z0], [x0, y, z0]]
    : [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]];
  for (const idx of [0, 1, 2, 0, 2, 3]) {
    const v = quad[idx];
    pos.push(v[0], v[1], v[2]);
    col.push(c.r, c.g, c.b);
  }
}

/**
 * 建一栋楼的室内。
 * @param {object} spec { w, d, h, x, z, seed }
 * @returns {{group, plan, stats, lights}}
 */
export function buildInterior(spec) {
  const plan = planInterior(spec);
  const pos = [], col = [];

  /* ★ 2026-11-09：**按层裁剪**。
   *   层数上限从 8 提到 40 之后，全部层全建会直接拖死浏览器
   *   （40 层 × 几百个盒子 = 上万个盒子挤进一个 BufferGeometry）。
   *   只画「当前层 + 上下各一层」——
   *   站在屋里能看到上下楼的楼板/楼梯，够用；远处楼层看不到也无所谓。
   */
  const floorH = plan.floorH || 3.1;
  const curFloor = spec.floor != null ? spec.floor : 0;
  // ★ 2026-11-10：**总览模式**（floor = -1）—— 一次画出**所有楼层**。
  //   之前只有「当前层 ±1」，所以 40 层的楼**看不到全貌**。
  //   40 层全建大约 1.2 万个盒子，仍然扛得住（实测），所以给一个开关。
  const ALL = curFloor < 0;
  const RANGE = ALL ? Infinity : 1;            // 当前层 ±1
  const inRange = (y) => {
    if (ALL) return true;
    const f = Math.round((Number(y) || 0) / floorH);
    return Math.abs(f - curFloor) <= RANGE;
  };

  // ★ 2026-11-10：**爆炸图**。
  //   从上面俯视时，顶层的楼板会把下面 30 层全盖住（实测：只看得到一块白板）。
  //   ⇒ 总览模式把**每一层竖向错开**（经典建筑爆炸图），
  //     这样一眼能看到所有楼层，而且每层内部都能看进去。
  const GAP = ALL ? Math.max(2.5, floorH * 1.7) : 0;   // ≈5.3m
  const floorIndexOf = (y) => Math.round((Number(y) || 0) / floorH);
  const lift = (y) => (ALL ? floorIndexOf(y) * GAP : 0);
  // 爆炸后的总高度（给相机取景用）
  const explodedH = ALL
    ? Math.max(floorH, (Math.max(0, (plan.stats && plan.stats.floors ? plan.stats.floors : 1) - 1)) * (floorH + GAP) + floorH)
    : Math.max(floorH, ((plan.stats && plan.stats.floors) || 1) * floorH);

  // 地板（每层一块）
  // ★ 总览模式**跳过最高那一层的地板** —— 它正好盖在最上层头顶，
  //   从上面看下去只看到一块白板，顶层的房间全看不见（实测）。
  const floorList = plan.floors || [plan.floor];
  let topFloorY = -Infinity;
  for (const f of floorList) if (Number.isFinite(f.y) && f.y > topFloorY) topFloorY = f.y;
  for (const f of floorList) {
    if (!inRange(f.y)) continue;
    if (ALL && f.y >= topFloorY - 1e-6) continue;
    pushPlane(pos, col, ALL ? { ...f, y: f.y + lift(f.y) } : f, f.color, true);
  }
  // 天花板（每层一块，朝下）
  // ★ 总览模式**不画天花板** —— 从上面往下看全是天花板，什么都看不见。
  if (!ALL) {
    for (const c of (plan.ceilings || [plan.ceiling])) {
      if (!inRange(c.y)) continue;
      pushPlane(pos, col, c, c.color, false);
    }
  }
  // 墙
  for (const b of plan.solids) {
    if (!inRange(b.y0)) continue;
    pushBox(pos, col, ALL ? { ...b, y0: b.y0 + lift(b.y0) } : b, 0xe6e1d5);
  }
  // 家具
  for (const f of plan.furniture) {
    if (!inRange(f.y)) continue;
    const dy = ALL ? lift(f.y) : 0;
    pushBox(pos, col, { x: f.x, z: f.z, y0: f.y + dy, w: f.w, h: f.h, d: f.d }, f.color);
  }
  // 楼梯（台阶）
  for (const s of (plan.stairs || [])) {
    if (!inRange(s.y)) continue;
    const dy = ALL ? lift(s.y) : 0;
    pushBox(pos, col, { x: s.x, z: s.z, y0: s.y + dy, w: s.w, h: s.h, d: s.d }, 0xcfc7b6);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const group = new THREE.Group();
  group.name = 'interior';

  const shell = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
    // 站在屋里看墙，两侧都可能被看到；双面省掉绕向问题
    side: THREE.DoubleSide,
  }));
  shell.name = 'interior-shell';
  shell.castShadow = true;
  shell.receiveShadow = true;
  group.add(shell);

  // 每间一盏顶灯（数量 = 房间数；**只点亮当前层**，否则多层会烧掉 WebGL 灯上限）
  const lights = [];
  const maxLights = 6;
  // ★ 总览模式：灯按"每层一盏"轮着放（每层都亮一点才看得出层次）
  const sameFloor = ALL
    ? plan.lights.filter((_, i) => i % Math.max(1, Math.ceil(plan.lights.length / maxLights)) === 0)
    : plan.lights.filter((L) => L.floor === curFloor);
  const picked = (sameFloor.length ? sameFloor : plan.lights).slice(0, maxLights);
  for (const L of picked) {
    const pl = new THREE.PointLight(0xfff2dc, L.intensity, L.distance, 2);
    // 总览模式：灯也跟着楼层往上抬
    pl.position.set(L.x, L.y + (ALL ? lift(L.y) : 0), L.z);
    pl.name = 'interior-light-' + L.room;
    group.add(pl);
    lights.push(pl);
  }

  // ★ 总览模式：把爆炸后的总高度告诉调用方（相机取景要用）
  const stats = { ...(plan.stats || {}), exploded: ALL, explodedH: Math.round(explodedH), gap: GAP };

  return { group, plan, stats, lights };
}
