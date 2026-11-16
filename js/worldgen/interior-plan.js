/* ============================================================================
 * js/worldgen/interior-plan.js —— "进到楼里"的室内布局（纯数学，可单测）
 *
 * 目标（用户原话：「可以深入到建筑物里面，进行操作+实拍」）：
 *   给定一栋楼的底面与高度，生成一套**能走进去、能开灯、能拍**的室内空间：
 *   地板 / 天花板 / 四面外墙（带窗洞）/ 隔墙（带门洞）/ 若干家具 / 每间一盏顶灯。
 *
 * 为什么输出"一堆轴对齐盒子"：
 *   几何侧（interior.js）只负责把盒子变 InstancedMesh/BufferGeometry，
 *   不用做任何三角化、不用处理任意多边形 —— 反过来这里的规则能被 node 断言死。
 *
 * 窗户是真的开洞（不是贴图）：外墙按 y 分层、按 x 切段，窗洞处留空，
 * 站在屋里能看到外面的街区 —— 这是"实拍"能不能成立的前提。
 * ========================================================================== */

export const WALL_T = 0.20;        // 墙厚
export const DOOR_H = 2.10;        // 门洞高
export const DOOR_W = 0.90;        // 门洞宽
export const SILL_Y = 0.95;        // 窗台高
export const HEAD_Y = 2.15;        // 窗上沿
export const WIN_W = 1.10;         // 窗宽
export const CEIL_T = 0.12;        // 天花厚度

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 沿一段轴对齐墙，按开洞生成盒子。
 * @param {number} ax,az 起点  @param {number} bx,bz 终点
 * @param {number} t 墙厚     @param {number} h 墙高
 * @param {Array<{t0:number,t1:number,y0:number,y1:number}>} openings 沿墙距离区间 + 高度区间
 * @returns {Array<{x:number,y0:number,z:number,w:number,h:number,d:number}>}
 */
export function wallBoxes(ax, az, bx, bz, t, h, openings = []) {
  const dx = bx - ax, dz = bz - az;
  const L = Math.hypot(dx, dz);
  if (L < 1e-6 || h <= 0) return [];
  const ux = dx / L, uz = dz / L;
  const alongX = Math.abs(ux) > Math.abs(uz);   // 主要沿 X 还是 Z

  // 墙体在 XZ 上的尺寸：沿墙方向是长度，垂直方向是厚度
  const thickW = alongX ? t : t;                 // 两个方向都要在"垂直方向"给 t
  const seg = (d0, d1) => {
    // 沿墙 [d0,d1] 的一段 → 盒子
    const cx = ax + ux * (d0 + d1) / 2;
    const cz = az + uz * (d0 + d1) / 2;
    const len = d1 - d0;
    if (len <= 1e-6) return null;
    return {
      x: cx, z: cz,
      w: alongX ? len : thickW,
      d: alongX ? thickW : len,
      len,
    };
  };

  const out = [];
  // y 方向先分层：所有开洞的上下沿
  const ys = Array.from(new Set([0, h, ...openings.flatMap((o) => [clamp(o.y0, 0, h), clamp(o.y1, 0, h)])]))
    .filter((v) => v >= 0 && v <= h)
    .sort((a, b) => a - b);

  for (let i = 0; i < ys.length - 1; i++) {
    const y0 = ys[i], y1 = ys[i + 1];
    if (y1 - y0 < 1e-6) continue;
    const mid = (y0 + y1) / 2;
    // 这一层里，哪些洞口是贯穿的
    const holes = openings
      .filter((o) => mid > o.y0 + 1e-9 && mid < o.y1 - 1e-9)
      .map((o) => [clamp(o.t0, 0, L), clamp(o.t1, 0, L)])
      .filter(([a, b]) => b - a > 1e-6)
      .sort((a, b) => a[0] - b[0]);

    // 洞口在 [0,L] 里取补集 → 实墙段
    let cursor = 0;
    const solid = [];
    for (const [a, b] of holes) {
      if (a > cursor) solid.push([cursor, a]);
      cursor = Math.max(cursor, b);
    }
    if (cursor < L) solid.push([cursor, L]);

    for (const [a, b] of solid) {
      const s = seg(a, b);
      if (!s) continue;
      out.push({ x: s.x, y0, z: s.z, w: s.w, h: y1 - y0, d: s.d });
    }
  }
  return out;
}

/** 房间用途（按序分配，够用就行） */
const ROOM_KINDS = ['living', 'bedroom', 'kitchen', 'office'];

/** 每类房间的家具模板：[kind, 相对房间中心的偏移比, 尺寸] */
const FURNITURE = {
  living: [
    ['sofa', 0.0, -0.28, 2.1, 0.85, 0.75],
    ['coffee', 0.0, 0.02, 1.1, 0.42, 0.6],
    ['tv', 0.0, 0.32, 1.4, 0.7, 0.1],
  ],
  bedroom: [
    ['bed', 0.0, 0.0, 1.5, 0.5, 2.0],
    ['wardrobe', -0.3, 0.3, 0.7, 2.0, 0.6],
  ],
  kitchen: [
    ['counter', 0.0, 0.3, 2.4, 0.9, 0.6],
    ['fridge', 0.3, -0.25, 0.7, 1.8, 0.7],
  ],
  office: [
    ['desk', 0.0, 0.0, 1.6, 0.75, 0.8],
    ['chair', 0.0, 0.22, 0.5, 0.9, 0.5],
    ['shelf', -0.34, 0.25, 0.4, 1.9, 1.2],
  ],
};

/**
 * 生成一栋楼的室内。
 * @param {object} o
 *   w,d,h   楼底面尺寸与总高（米）
 *   x,z     楼中心（世界坐标）
 *   seed    随机种子（家具摆放的确定性抖动）
 *   floors  层数（不给就按 h 推）
 * @returns {object} { inner, rooms, solids, floor, ceiling, furniture, lights, stats }
 */
export function planInterior(o = {}) {
  const w = Math.max(2.4, Number(o.w) || 6);
  const d = Math.max(2.4, Number(o.d) || 6);
  const h = Math.max(2.4, Number(o.h) || 3.0);
  const cx = Number(o.x) || 0;
  const cz = Number(o.z) || 0;
  const seed = Number.isFinite(o.seed) ? (o.seed | 0) : 1;

  // ★ 2026-11-08：**多层**。一栋 20m 的楼不该只有一层。
  //   每层一个 floorH（2.6~3.3m），层数按总高推。
  // ★ 2026-11-09：上限 8 → **40 层**。
  //   之前 8 层意味着 90m 高的楼只建到 24.8m（用户明确提过）。
  //   层数上限放开后，**渲染要按层裁剪**（interior.js 只画当前层和上下相邻层），
  //   否则 40 层 × 几百个几何会直接把浏览器拖死。
  const floorH = Math.max(2.6, Math.min(3.3, h > 5 ? 3.1 : h));
  const MAX_FLOORS = 40;
  let floors = Number.isInteger(o.floors) && o.floors > 0
    ? Math.min(MAX_FLOORS, o.floors)
    : Math.max(1, Math.min(MAX_FLOORS, Math.round(h / floorH)));
  const stackH = floors * floorH;

  // 内区：外墙内退一个墙厚
  const iw = Math.max(1.2, w - 2 * WALL_T);
  const id = Math.max(1.2, d - 2 * WALL_T);
  const x0 = cx - iw / 2, x1 = cx + iw / 2;
  const z0 = cz - id / 2, z1 = cz + id / 2;

  // ── 分房间：小房间一间，长方形分两间，大房间 2×2
  const longSide = Math.max(iw, id), shortSide = Math.min(iw, id);
  let nx = 1, ny = 1;
  if (longSide >= 9 && shortSide >= 5.5) { nx = 2; ny = 2; }
  else if (longSide >= 5.5) { if (iw >= id) nx = 2; else ny = 2; }

  const rooms = [];
  const colW = iw / nx, rowD = id / ny;
  let ri = 0;
  for (let f = 0; f < floors; f++) {
    const baseY = f * floorH;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const rx0 = x0 + i * colW, rx1 = x0 + (i + 1) * colW;
        const rz0 = z0 + j * rowD, rz1 = z0 + (j + 1) * rowD;
        rooms.push({
          id: 'r' + (ri + 1),
          floor: f,                       // ★ 第几层（0 起）
          baseY,                          // ★ 这层地板高度
          kind: ROOM_KINDS[ri % ROOM_KINDS.length],
          x0: rx0, z0: rz0, x1: rx1, z1: rz1,
          cx: (rx0 + rx1) / 2, cz: (rz0 + rz1) / 2,
          w: rx1 - rx0, d: rz1 - rz0,
          area: (rx1 - rx0) * (rz1 - rz0),
        });
        ri++;
      }
    }
  }

  const solids = [];

  // ── 每层的地面/天花板/外墙/隔墙
  const floorsList = [];
  const ceilings = [];
  // ── 楼梯间：放在一个角，占 1 个小格子（多层才有意义）
  const stairW = Math.min(2.4, iw * 0.28);
  const stairD = Math.min(2.4, id * 0.28);
  const stair = floors > 1
    ? { x0: x1 - stairW, z0: z0, x1: x1, z1: z0 + stairD }
    : null;

  for (let f = 0; f < floors; f++) {
    const baseY = f * floorH;
    const wallH = floorH;
    const winY0 = Math.min(SILL_Y, wallH * 0.45);
    const winY1 = Math.min(HEAD_Y, wallH - 0.25);
    const hasWindows = winY1 - winY0 > 0.4;

    const addOuter = (ax, az, bx, bz, len) => {
      const openings = [];
      if (hasWindows && len > 2.6) {
        const n = len > 7 ? 2 : 1;
        for (let k = 0; k < n; k++) {
          const centre = len * (n === 1 ? 0.5 : (k === 0 ? 0.3 : 0.7));
          const t0 = clamp(centre - WIN_W / 2, 0.4, len - 0.4 - WIN_W);
          openings.push({ t0, t1: t0 + WIN_W, y0: winY0, y1: winY1 });
        }
      }
      const boxes = wallBoxes(ax, az, bx, bz, WALL_T, wallH, openings)
        .map((b) => ({ ...b, y0: b.y0 + baseY }));
      solids.push(...boxes);
    };
    addOuter(x0, z0, x1, z0, iw);   // 北
    addOuter(x1, z0, x1, z1, id);   // 东
    addOuter(x1, z1, x0, z1, iw);   // 南
    addOuter(x0, z1, x0, z0, id);   // 西

    // 竖直隔墙（沿 Z 方向，在 x = 各列边界）
    for (let i = 1; i < nx; i++) {
      const x = x0 + i * colW;
      const len = id;
      const t0 = clamp(len * 0.5 - DOOR_W / 2, 0.3, len - 0.3 - DOOR_W);
      solids.push(...wallBoxes(x, z0, x, z1, WALL_T, wallH, [{ t0, t1: t0 + DOOR_W, y0: 0, y1: DOOR_H }])
        .map((b) => ({ ...b, y0: b.y0 + baseY })));
    }
    // 水平隔墙（沿 X 方向，在 z = 各行边界），门洞错开避免对着
    for (let j = 1; j < ny; j++) {
      const z = z0 + j * rowD;
      const len = iw;
      const t0 = clamp(len * (j % 2 ? 0.3 : 0.65) - DOOR_W / 2, 0.3, len - 0.3 - DOOR_W);
      solids.push(...wallBoxes(x0, z, x1, z, WALL_T, wallH, [{ t0, t1: t0 + DOOR_W, y0: 0, y1: DOOR_H }])
        .map((b) => ({ ...b, y0: b.y0 + baseY })));
    }

    // 楼板（这层地板）与天花板
    floorsList.push({ x: cx, z: cz, w: iw, d: id, y: baseY, color: 0xd8d2c4 });
    ceilings.push({ x: cx, z: cz, w: iw, d: id, y: baseY + floorH - CEIL_T, t: CEIL_T, color: 0xefece4 });
  }

  // ── 楼梯：一段段台阶（每层 10 级）+ 中间休息平台
  const stairs = [];
  if (stair) {
    const steps = 10;
    for (let f = 0; f < floors - 1; f++) {
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        const y = f * floorH + (s + 1) * (floorH / steps);
        stairs.push({
          x: (stair.x0 + stair.x1) / 2,
          z: stair.z0 + (s + 0.5) * (stairD / steps),
          w: stairW * 0.8, d: stairD / steps, h: floorH / steps, y: y - floorH / steps,
          from: f, to: f + 1,
        });
      }
    }
  }

  // ── 家具（按房间用途 + 确定性抖动）
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const furniture = [];
  for (const r of rooms) {
    const tpl = FURNITURE[r.kind] || FURNITURE.living;
    for (const [kind, ox, oz, fw, fh, fd] of tpl) {
      // 家具不能超出房间（留 0.25m 走道）
      const maxW = Math.max(0.3, r.w - 0.5), maxD = Math.max(0.3, r.d - 0.5);
      const W = Math.min(fw, maxW), D = Math.min(fd, maxD);
      const px = clamp(r.cx + ox * r.w + (rnd() - 0.5) * 0.25, r.x0 + W / 2 + 0.2, r.x1 - W / 2 - 0.2);
      const pz = clamp(r.cz + oz * r.d + (rnd() - 0.5) * 0.25, r.z0 + D / 2 + 0.2, r.z1 - D / 2 - 0.2);
      furniture.push({ kind, x: px, z: pz, y: r.baseY, w: W, h: fh, d: D, room: r.id, floor: r.floor, color: 0xcfc9bb });
    }
  }

  // ── 每间一盏顶灯
  const lights = rooms.map((r) => ({
    x: r.cx, y: r.baseY + floorH - CEIL_T - 0.12, z: r.cz,
    intensity: Math.min(1.6, 0.35 + r.area * 0.045),
    distance: Math.max(6, Math.hypot(r.w, r.d) * 1.6),
    room: r.id,
    floor: r.floor,
  }));

  return {
    kind: 'interior',
    building: { x: cx, z: cz, w, d, h },
    inner: { x0, x1, z0, z1, w: iw, d: id },
    floors: floorsList,
    ceilings,
    stairs,
    stairwell: stair,
    rooms, solids, floor: floorsList[0], ceiling: ceilings[ceilings.length - 1],
    furniture, lights,
    // ★ 2026-11-09：层高要单独给出去 —— 渲染层按它裁剪（只画当前层 ±1）。
    floorH,
    maxFloors: MAX_FLOORS,
    stats: {
      rooms: rooms.length,
      floors,
      floorH: +floorH.toFixed(2),
      stackH: +stackH.toFixed(2),
      solids: solids.length,
      furniture: furniture.length,
      lights: lights.length,
      stairs: stairs.length,
      area: +(iw * id).toFixed(1),
      height: h,
    },
  };
}

/** 点是否在某栋楼底面内（用于"点哪栋进哪栋"） */
export function pointInFootprint(px, pz, b) {
  if (!b) return false;
  if (b.ring) {
    // 射线法
    const ring = b.ring;
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].x, zi = ring[i].z, xj = ring[j].x, zj = ring[j].z;
      if (((zi > pz) !== (zj > pz)) && (px < (xj - xi) * (pz - zi) / (zj - zi || 1e-9) + xi)) inside = !inside;
    }
    return inside;
  }
  // 轴对齐盒子 + 旋转
  const dx = px - b.x, dz = pz - b.z;
  const rot = -(b.rot || 0);
  const lx = dx * Math.cos(rot) - dz * Math.sin(rot);
  const lz = dx * Math.sin(rot) + dz * Math.cos(rot);
  return Math.abs(lx) <= (b.w || 0) / 2 && Math.abs(lz) <= (b.d || 0) / 2;
}

/** 在一组楼里找包含该点的（没有就找最近的） */
export function findBuildingAt(buildings, px, pz, maxDist = 30) {
  if (!Array.isArray(buildings) || !buildings.length) return null;
  let best = null, bestD = Infinity;
  for (const b of buildings) {
    if (pointInFootprint(px, pz, b)) return b;
    const bx = b.x ?? (b.ring ? b.ring.reduce((s, p) => s + p.x, 0) / b.ring.length : 0);
    const bz = b.z ?? (b.ring ? b.ring.reduce((s, p) => s + p.z, 0) / b.ring.length : 0);
    const dd = Math.hypot(px - bx, pz - bz);
    if (dd < bestD) { bestD = dd; best = b; }
  }
  return bestD <= maxDist ? best : null;
}
