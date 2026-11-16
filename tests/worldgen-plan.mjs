#!/usr/bin/env node
/* ============================================================================
 * tests/worldgen-plan.mjs —— 大世界布局的单元测试
 *
 * 这些断言守的是三条设计规则：
 *   ① 世界变大 ⇒ 变的是**数量**，不是尺度；
 *   ② 密度要像一座城（不能是"撒钉子"）；
 *   ③ 分块裁剪真的能省东西。
 * ========================================================================== */
import {
  planCity, visibleChunks, chunkLod, mulberry32,
  CITY_BASE_SIZE, MAX_BUILDINGS, MAX_PROPS, MAX_LOTS_PER_SIDE,
  BUILDING_KINDS,
} from '../js/worldgen/plan.js';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};
const group = (t) => console.log('\n' + t);

/* ── 1. 确定性 ─────────────────────────────────────────────────────────── */
group('1. 确定性（同一 seed 永远同一座城）');
{
  const a = planCity({ factor: 20, seed: 42 });
  const b = planCity({ factor: 20, seed: 42 });
  const c = planCity({ factor: 20, seed: 43 });
  ok('同 seed 完全相同', JSON.stringify(a.buildings) === JSON.stringify(b.buildings));
  ok('不同 seed 不同', JSON.stringify(a.buildings) !== JSON.stringify(c.buildings));
  const r1 = mulberry32(7), r2 = mulberry32(7);
  const seq1 = [r1(), r1(), r1()], seq2 = [r2(), r2(), r2()];
  ok('mulberry32 可复现', JSON.stringify(seq1) === JSON.stringify(seq2));
  ok('mulberry32 落在 [0,1)', seq1.every((v) => v >= 0 && v < 1), seq1);
}

/* ── 2. 世界边长与旧行为对齐 ───────────────────────────────────────────── */
group('2. 世界边长 = 120 × factor（向后兼容）');
{
  for (const f of [1, 4, 20, 30, 50]) {
    const p = planCity({ factor: f, seed: 1 });
    ok(`factor ${f} → size ${CITY_BASE_SIZE * f}`, p.size === CITY_BASE_SIZE * f, p.size);
  }
}

/* ── 3. 人的尺度（最关键的一条） ───────────────────────────────────────── */
group('3. 楼高不随 factor 放大（人的尺度）');
{
  const maxH = Math.max(...BUILDING_KINDS.map((k) => k.h[1]));
  const minH = Math.min(...BUILDING_KINDS.map((k) => k.h[0]));
  for (const f of [1, 20, 50]) {
    const p = planCity({ factor: f, seed: 7 });
    const hs = p.buildings.map((b) => b.h);
    ok(`factor ${f} 楼高在 [${minH}, ${maxH}]`, hs.every((h) => h >= minH && h <= maxH),
      { min: Math.min(...hs), max: Math.max(...hs) });
    ok(`factor ${f} 楼宽 ≤ 街区宽`, p.buildings.every((b) => b.w <= p.pitch * 0.63), { pitch: p.pitch });
  }
}

/* ── 4. 内容随世界变大（数量，不是尺度） ───────────────────────────────── */
group('4. 世界越大 → 内容越多');
{
  const counts = [1, 4, 20, 30, 50].map((f) => planCity({ factor: f, seed: 3 }).buildings.length);
  const increasing = counts.every((v, i) => i === 0 || v >= counts[i - 1]);
  ok('楼数单调不减', increasing, counts);
  ok('xxl 比 small 多至少 20 倍', counts[4] >= counts[0] * 20, counts);
  ok('xxl 不是"同样几栋巨楼"', counts[4] > 100, counts[4]);
}

/* ── 4b. 密度要像一座城（不能是"撒钉子"） ──────────────────────────────── */
group('4b. 密度：每平方公里 ≥ 300 栋（与涩谷实测同量级）');
{
  for (const f of [20, 50]) {
    const p = planCity({ factor: f, seed: 3 });
    const km2 = (p.size / 1000) ** 2;
    const perKm2 = p.buildings.length / km2;
    ok(`factor ${f}：${perKm2.toFixed(0)} 栋/km²`, perKm2 >= 300, perKm2.toFixed(0));
    ok(`factor ${f}：街区间距 ≤ 200m（当前 ${p.pitch.toFixed(0)}m）`, p.pitch <= 200, p.pitch.toFixed(1));
  }
}

/* ── 5. 预算封顶 ───────────────────────────────────────────────────────── */
group('5. 预算封顶（不会把显存吃穿）');
{
  const p = planCity({ factor: 50, seed: 9, density: 4 });
  ok(`楼数 ≤ ${MAX_BUILDINGS}`, p.buildings.length <= MAX_BUILDINGS, p.buildings.length);
  ok(`道具数 ≤ ${MAX_PROPS}`, p.props.length <= MAX_PROPS, p.props.length);
  ok(`每边街区 ≤ ${MAX_LOTS_PER_SIDE}`, p.lotsPerSide <= MAX_LOTS_PER_SIDE, p.lotsPerSide);
}

/* ── 6. 几何合法 ───────────────────────────────────────────────────────── */
group('6. 几何合法（不出界、不反向、不 NaN）');
{
  for (const f of [1, 20, 50]) {
    const p = planCity({ factor: f, seed: 11 });
    const all = [...p.buildings, ...p.props];
    ok(`factor ${f} 全部在场地内`,
      all.every((o) => Math.abs(o.x) <= p.half + 1 && Math.abs(o.z) <= p.half + 1));
    ok(`factor ${f} 无 NaN`,
      all.every((o) => [o.x, o.z, o.s ?? 1].every(Number.isFinite)));
    ok(`factor ${f} 楼尺寸为正`,
      p.buildings.every((b) => b.w > 0 && b.d > 0 && b.h > 0));
  }
}

/* ── 7. 分块自洽 ───────────────────────────────────────────────────────── */
group('7. 分块与统计自洽');
{
  const p = planCity({ factor: 20, seed: 13 });
  ok('chunk 数 = 每边²', p.chunks.length === p.chunksPerSide ** 2, p.chunks.length);
  ok('每栋楼 chunk 合法', p.buildings.every((b) => b.chunk >= 0 && b.chunk < p.chunks.length));
  // 块内计数 == 实际落进该块的栋数
  const manual = new Map();
  for (const b of p.buildings) manual.set(b.chunk, (manual.get(b.chunk) || 0) + 1);
  const bad = p.chunks.filter((c) => (manual.get(c.id) || 0) !== c.buildings);
  ok('块统计 == 实际', bad.length === 0, bad.slice(0, 3));
  ok('统计总数一致', p.stats.buildings === p.buildings.length);
}

/* ── 8. 视距裁剪 ───────────────────────────────────────────────────────── */
group('8. 视距裁剪');
{
  const p = planCity({ factor: 60, seed: 17 });
  const center = visibleChunks(p, { x: 0, z: 0 }, 1);
  ok('中心只显示 3×3 块', center.size === Math.min(9, p.chunks.length), center.size);
  const outside = visibleChunks(p, { x: 1e9, z: 0 }, 1);
  ok('场地外退回全显示', outside.size === p.chunks.length, outside.size);
  const near = chunkLod(p, (Math.floor(p.chunksPerSide / 2)) * p.chunksPerSide + Math.floor(p.chunksPerSide / 2), { x: 0, z: 0 }, 0);
  ok('相机所在块 = full', near === 'full', near);

  // 裁剪必须真的能省东西：远处块不在集合里
  const far = visibleChunks(p, { x: 0, z: 0 }, 1);
  const corner = p.chunksPerSide - 1;
  ok('角落块被裁掉', !far.has(corner * p.chunksPerSide + corner));
}

/* ── 9. 城市形态：中心高楼、外围民房 ───────────────────────────────────── */
group('9. 城市形态：中心高楼、外围民房');
{
  const p = planCity({ factor: 30, seed: 19 });
  const hs = p.buildings.map((b) => b.h);
  const mid = p.half;
  const center = p.buildings.filter((b) => Math.hypot(b.x, b.z) < mid * 0.25).map((b) => b.h);
  const outer = p.buildings.filter((b) => Math.hypot(b.x, b.z) > mid * 0.6).map((b) => b.h);
  ok('中心有楼', center.length > 0, center.length);
  ok('外围有楼', outer.length > 0, outer.length);
  if (center.length && outer.length) {
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    ok('中心平均楼高 > 外围', avg(center) > avg(outer), { c: avg(center).toFixed(1), o: avg(outer).toFixed(1) });
  }
  ok('楼高都在合理范围', Math.min(...hs) >= 4 && Math.max(...hs) <= 120, { min: Math.min(...hs), max: Math.max(...hs) });
}

/* ── 10. 道路网格 ──────────────────────────────────────────────────────── */
group('10. 道路网格');
{
  const p = planCity({ factor: 20, seed: 23 });
  ok('道路数 = (每边+1)×2', p.roads.length === (p.lotsPerSide + 1) * 2, p.roads.length);
  ok('道路贴地不超界', p.roads.every((r) => Math.abs(r.x) <= p.half + 1 && Math.abs(r.z) <= p.half + 1));
  // 宽度在"垂直于路"的那个轴上：axis=x 的路宽度是 d，axis=z 的是 w
  ok('路宽合理', p.roads.every((r) => {
    const w = r.axis === 'x' ? r.d : r.w;
    return w > 0 && w < 60;
  }), p.roads.map((r) => (r.axis === 'x' ? r.d : r.w)).slice(0, 5));
}

/* ── 11. 分块裁剪真的省 ────────────────────────────────────────────────── */
group('11. 分块裁剪（xxl 裁掉八成以上）');
{
  const p = planCity({ factor: 50, seed: 31 });
  ok('xxl 块数 = 20×20', p.chunksPerSide === 20 && p.chunks.length === 400,
    { per: p.chunksPerSide, n: p.chunks.length });
  ok('块边长够细（≥200m）', p.chunkSize >= 200, p.chunkSize);
  const vis = visibleChunks(p, { x: 0, z: 0 }, 3);
  ok('range 3 → 7×7 = 49 块', vis.size === 49, vis.size);
  ok('只留不到 15%', vis.size / p.chunks.length < 0.15, +(vis.size / p.chunks.length).toFixed(3));
  const c0 = Math.floor(p.chunksPerSide / 2);
  ok('中心块 full', chunkLod(p, c0 * p.chunksPerSide + c0, { x: 0, z: 0 }, 0) === 'full');
  ok('角落块 simple', chunkLod(p, 0, { x: 0, z: 0 }, 0) === 'simple');
  // 小世界不能被"细分成 400 块"（否则 draw call 白白变多）
  const s = planCity({ factor: 1, seed: 31 });
  ok('small 只有 4×4', s.chunksPerSide === 4 && s.chunks.length === 16, { per: s.chunksPerSide });
}

console.log(`\n${fail ? '✗' : '✓'} worldgen-plan: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
