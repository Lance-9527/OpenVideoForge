/* ============================================================================
 * js/worldgen/plan.js —— 大世界布局的**纯数学**
 *
 * 为什么单独拆出来：
 *   1) 不 import three ⇒ node 里能直接跑单元测试（浏览器的 import map 在 node 里没有）；
 *   2) 布局/密度/分块/LOD 这些规则是最容易错的地方，必须可断言；
 *   3) city.js 只负责"把 plan 变成 InstancedMesh"，职责单一。
 *
 * ★ 核心设计（2026-11-08 用户原话：「我希望我们 openvideoforge 的世界更大」）：
 *   **世界放大 ≠ 东西放大。**
 *   旧实现在 scenes.js 的 finish() 里把物件位置和缩放一起乘 factor，
 *   结果 large 档 = 几栋 140m 高的巨楼 + 一大片空地，那不是"更大的世界"，
 *   那是"同样的世界被吹大了"。
 *
 *   这里的规则：
 *     · 街区间距（LOT_PITCH）恒定在人的尺度上，**不随 factor 变**；
 *     · 变大的是**数量**（街区数 ∝ 面积），直到块数封顶；
 *     · 封顶之后继续变大，则是**街区本身变大**（从"街区"退成"城区"），
 *       这是物理上诚实的取舍：18km 见方不可能还保留 5m 的房子。
 *     · 楼高不随 factor 放大，而是按**离市中心的距离**分布：
 *       中心是高楼、外围是民房 —— 这才是城市。
 * ========================================================================== */

/** 确定性随机（同一 seed 永远同一座城） */
export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
const range = (rng, a, b) => lerp(a, b, rng());

/* ── 尺度常量 ──────────────────────────────────────────────────────────── */

/** small 档的地面边长（与 scenes.js 里 ground(120) 对齐，保证向后兼容） */
export const CITY_BASE_SIZE = 120;
/** 街区目标间距（米）。恒定 —— 这是"人的尺度"，绝不跟 factor 一起放大。 */
export const LOT_PITCH = 90;
/** 每边街区数上限。超过就靠"街区变大"消化面积。 */
export const MAX_LOTS_PER_SIDE = 100;
/** 每边分块数上限（用于视距裁剪）。2026-11-08：8→20，块更细才裁得动。 */
export const MAX_CHUNKS_PER_SIDE = 20;
/** 目标分块边长（米）。块越细，裁剪越省；但块数 × 构件种类 = draw call 上限。 */
export const CHUNK_TARGET_M = 250;
/** 实例预算（防止一次加载把显存吃穿） */
export const MAX_BUILDINGS = 24000;
export const MAX_PROPS = 6000;

/** 楼型：宽度/进深/高度区间 + 语义颜色。高度是**人的尺度**，不乘 factor。 */
export const BUILDING_KINDS = [
  { kind: 'house', w: [8, 16], d: [8, 16], h: [4, 9], color: 0xe8e1d2, weight: 5 },
  { kind: 'shop', w: [10, 22], d: [10, 20], h: [5, 13], color: 0xdedad1, weight: 3 },
  { kind: 'apartment', w: [14, 28], d: [14, 26], h: [12, 34], color: 0xd7d9dd, weight: 2 },
  { kind: 'tower', w: [18, 34], d: [18, 34], h: [36, 120], color: 0xd0d4da, weight: 1 },
];

/** 道具：路灯 / 行道树 / 长椅 / 灌木 */
export const PROP_KINDS = {
  lamp: { color: 0xb5b2a6, h: 3.2 },
  tree: { color: 0xc7cdb0, h: 2.0 },
  bench: { color: 0xcfc9bb, h: 0.8 },
  bush: { color: 0xd2d6bd, h: 0.9 },
};

/** 按权重挑楼型（tallness 越大越可能出高楼） */
function pickBuilding(rng, tallness) {
  const w = BUILDING_KINDS.map((k) => {
    if (k.kind === 'tower') return k.weight * Math.pow(tallness, 2.2) * 6;
    if (k.kind === 'apartment') return k.weight * (0.25 + tallness);
    if (k.kind === 'shop') return k.weight * (0.6 + 0.8 * tallness);
    return k.weight * (1 - 0.55 * tallness);           // house 在中心区变少
  });
  const total = w.reduce((s, v) => s + v, 0);
  let r = rng() * total;
  for (let i = 0; i < BUILDING_KINDS.length; i++) {
    r -= w[i];
    if (r <= 0) return BUILDING_KINDS[i];
  }
  return BUILDING_KINDS[0];
}

/**
 * 生成一座城市。
 * @param {object} opts
 * @param {number} opts.factor   场地档位系数（1/4/20/60/150）
 * @param {number} opts.seed     随机种子
 * @param {number} opts.density  密度倍率（1 = 标准）
 * @returns {object} { size, factor, seed, lots, buildings, roads, props, chunks, stats }
 */
export function planCity(opts = {}) {
  const factor = Number.isFinite(opts.factor) && opts.factor > 0 ? opts.factor : 1;
  const seed = Number.isFinite(opts.seed) ? (opts.seed | 0) : 1;
  const density = Number.isFinite(opts.density) && opts.density > 0 ? opts.density : 1;
  const rng = mulberry32(seed);

  // 世界边长：与旧行为一致（120 × factor）
  const size = CITY_BASE_SIZE * factor;
  const half = size / 2;

  // 街区数：按目标间距算，但封顶
  const lotsPerSide = clamp(Math.round(size / LOT_PITCH), 3, MAX_LOTS_PER_SIDE);
  const pitch = size / lotsPerSide;            // 实际街区间距（封顶后会变大）

  // 分块：按 ~250m 一档，封顶 20×20。
  // ★ 2026-11-08：原来按 400m 且封顶 8×8 ⇒ xxl 只剩 64 块，裁剪窗口 7×7 就盖住大半，
  //   等于没裁。改成 250m/20×20 后，xxl 有 400 块，7×7 窗口只留 ~12%，
  //   分块裁剪才真的省（见 tests/worldgen-plan.mjs 第 8 组）。
  const chunksPerSide = clamp(Math.round(size / CHUNK_TARGET_M), 4, MAX_CHUNKS_PER_SIDE);
  const chunkSize = size / chunksPerSide;

  const chunkIndex = (x, z) => {
    const cx = clamp(Math.floor((x + half) / chunkSize), 0, chunksPerSide - 1);
    const cz = clamp(Math.floor((z + half) / chunkSize), 0, chunksPerSide - 1);
    return cz * chunksPerSide + cx;
  };

  const lots = [];
  const buildings = [];
  const roads = [];
  const props = [];
  const chunkCounts = new Array(chunksPerSide * chunksPerSide).fill(0);

  // 道路：沿街区边界铺双向网格（贴地薄板，city.js 用 InstancedMesh 画）
  const roadW = clamp(pitch * 0.16, 4, 26);
  for (let i = 0; i <= lotsPerSide; i++) {
    const p = -half + i * pitch;
    roads.push({ x: 0, z: p, w: size, d: roadW, axis: 'x', major: i % 4 === 0 });
    roads.push({ x: p, z: 0, w: roadW, d: size, axis: 'z', major: i % 4 === 0 });
  }

  // 逐块铺建筑
  for (let iz = 0; iz < lotsPerSide; iz++) {
    for (let ix = 0; ix < lotsPerSide; ix++) {
      const cx = -half + (ix + 0.5) * pitch;
      const cz = -half + (iz + 0.5) * pitch;
      // 归一化到中心：0 = 市中心，1 = 最外圈
      const nd = Math.min(1, Math.hypot(cx, cz) / half);
      const tallness = Math.pow(1 - nd, 1.35);           // 中心 = 1，外围 = 0

      // 留出绿地/空地的比例：中心更密，外围更松 + 少量随机空地
      const vacant = rng() < (0.10 + nd * 0.30) / density;
      lots.push({ ix, iz, x: cx, z: cz, pitch, vacant, tallness, chunk: chunkIndex(cx, cz) });

      if (vacant) {
        // 空地里放树/灌木
        const n = Math.floor(range(rng, 1, 4) * density);
        for (let k = 0; k < n && props.length < MAX_PROPS; k++) {
          props.push({
            kind: rng() < 0.65 ? 'tree' : 'bush',
            x: cx + range(rng, -pitch * 0.35, pitch * 0.35),
            z: cz + range(rng, -pitch * 0.35, pitch * 0.35),
            s: range(rng, 0.8, 1.35),
            rot: rng() * Math.PI * 2,
            chunk: chunkIndex(cx, cz),
          });
        }
        continue;
      }

      // 一格里放 3–6 栋（中心多、外围少），受预算封顶
      // ★ 2026-11-08：原来是 1–3 栋。实测 factor 50 时 4489 块只放 8106 栋 →
      //   225 栋/km²，俯瞰像撒钉子。改成 3–6 栋 + 单体随栋数缩小，
      //   密度上到 ~390 栋/km²（与涩谷实测同量级），街区也还是像街区。
      const maxN = buildings.length >= MAX_BUILDINGS ? 0 : Math.max(1, Math.round(lerp(3, 6, tallness) * density));
      for (let b = 0; b < maxN && buildings.length < MAX_BUILDINGS; b++) {
        const kind = pickBuilding(rng, tallness);
        // 楼不能超过街区可用宽度；同一格楼越多，单体越小（免得叠在一起）
        const maxW = pitch * 0.62 / Math.sqrt(maxN);
        const w = Math.min(range(rng, kind.w[0], kind.w[1]), maxW);
        const d = Math.min(range(rng, kind.d[0], kind.d[1]), maxW);
        const h = range(rng, kind.h[0], kind.h[1]);
        const off = pitch * 0.20;
        buildings.push({
          kind: kind.kind,
          color: kind.color,
          x: cx + range(rng, -off, off),
          z: cz + range(rng, -off, off),
          w, d, h,
          rot: rng() < 0.12 ? Math.round(rng() * 3) * (Math.PI / 2) : 0,
          chunk: chunkIndex(cx, cz),
        });
      }

      // 沿街路灯（只在非空地块，且不过密）
      if (rng() < 0.55 && props.length < MAX_PROPS) {
        props.push({
          kind: 'lamp',
          x: cx + (rng() < 0.5 ? -1 : 1) * pitch * 0.46,
          z: cz + range(rng, -pitch * 0.3, pitch * 0.3),
          s: 1, rot: 0, chunk: chunkIndex(cx, cz),
        });
      }
    }
  }

  // 分块统计（city.js 据此决定哪些块要建、要不要道具）
  const chunks = [];
  for (let cz = 0; cz < chunksPerSide; cz++) {
    for (let cx = 0; cx < chunksPerSide; cx++) {
      const id = cz * chunksPerSide + cx;
      const nB = buildings.filter((b) => b.chunk === id).length;
      const nP = props.filter((p) => p.chunk === id).length;
      chunkCounts[id] = nB;
      chunks.push({
        id, cx, cz,
        x: -half + (cx + 0.5) * chunkSize,
        z: -half + (cz + 0.5) * chunkSize,
        size: chunkSize,
        buildings: nB,
        props: nP,
      });
    }
  }

  return {
    kind: 'city',
    factor, seed, density, size, half,
    lotsPerSide, pitch, roadW,
    chunksPerSide, chunkSize,
    lots, buildings, roads, props, chunks,
    stats: {
      lots: lots.length,
      vacant: lots.filter((l) => l.vacant).length,
      buildings: buildings.length,
      roads: roads.length,
      props: props.length,
      chunks: chunks.length,
      activeChunks: chunks.filter((c) => c.buildings + c.props > 0).length,
      tallest: buildings.reduce((m, b) => Math.max(m, b.h), 0),
    },
  };
}

/**
 * 视距裁剪：给定相机位置，返回应该显示的 chunk id 集合。
 * 规则：显示相机所在块 + 半径 range 内的块（切比雪夫距离，块级不抖动）。
 */
export function visibleChunks(plan, cam, range = 2) {
  const out = new Set();
  if (!plan || !plan.chunks || !plan.chunks.length) return out;
  const half = plan.half;
  const cs = plan.chunkSize;
  const cx = clamp(Math.floor((cam.x + half) / cs), 0, plan.chunksPerSide - 1);
  const cz = clamp(Math.floor((cam.z + half) / cs), 0, plan.chunksPerSide - 1);
  for (let dz = -range; dz <= range; dz++) {
    for (let dx = -range; dx <= range; dx++) {
      const x = cx + dx, z = cz + dz;
      if (x < 0 || z < 0 || x >= plan.chunksPerSide || z >= plan.chunksPerSide) continue;
      out.add(z * plan.chunksPerSide + x);
    }
  }
  // 相机在场地外时（远景机位），退回全显示，避免"空屏"
  if (Math.abs(cam.x) > half || Math.abs(cam.z) > half) {
    for (const c of plan.chunks) out.add(c.id);
  }
  return out;
}

/** 给某块分配 LOD 档：近块 full，远块 simple（city.js 用） */
export function chunkLod(plan, chunkId, cam, fullRange = 1) {
  const c = plan.chunks[chunkId];
  if (!c) return 'simple';
  const cs = plan.chunkSize;
  const cx = clamp(Math.floor((cam.x + plan.half) / cs), 0, plan.chunksPerSide - 1);
  const cz = clamp(Math.floor((cam.z + plan.half) / cs), 0, plan.chunksPerSide - 1);
  const d = Math.max(Math.abs(c.cx - cx), Math.abs(c.cz - cz));
  return d <= fullRange ? 'full' : 'simple';
}
