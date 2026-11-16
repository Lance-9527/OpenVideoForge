#!/usr/bin/env node
/* ============================================================================
 * tests/interior-plan.mjs —— 室内布局单元测试
 * 守的是："进屋能走、窗是真的洞、家具不出墙、每间有灯"。
 * ========================================================================== */
import {
  wallBoxes, planInterior, pointInFootprint, findBuildingAt,
  WALL_T, DOOR_H, DOOR_W, SILL_Y, HEAD_Y,
} from '../js/worldgen/interior-plan.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};
const group = (t) => console.log('\n' + t);
const boxesValid = (bs) => bs.every((b) =>
  [b.x, b.y0, b.z, b.w, b.h, b.d].every(Number.isFinite) &&
  b.w > 0 && b.h > 0 && b.d > 0);

/* ── 1. 墙：没洞 → 一整块 ─────────────────────────────────────────────── */
group('1. 实墙');
{
  const bs = wallBoxes(0, 0, 10, 0, 0.2, 3, []);
  ok('10m 墙 → 1 个盒子', bs.length === 1, bs.length);
  ok('盒子尺寸 10×3×0.2', Math.abs(bs[0].w - 10) < 1e-6 && Math.abs(bs[0].h - 3) < 1e-6 && Math.abs(bs[0].d - 0.2) < 1e-6, bs[0]);
  ok('盒子居中在 (5,0)', Math.abs(bs[0].x - 5) < 1e-6 && Math.abs(bs[0].z) < 1e-6);
  ok('沿 Z 的墙也成立', wallBoxes(0, 0, 0, 10, 0.2, 3, []).length === 1);
  ok('零长度墙返空', wallBoxes(0, 0, 0, 0, 0.2, 3, []).length === 0);
}

/* ── 2. 门洞：底部断开、上面有过梁 ─────────────────────────────────────── */
group('2. 门洞');
{
  const bs = wallBoxes(0, 0, 10, 0, 0.2, 3, [{ t0: 4, t1: 5, y0: 0, y1: DOOR_H }]);
  ok('门洞把墙切成 3 段（左/右/过梁）', bs.length === 3, bs.length);
  const low = bs.filter((b) => b.y0 < 0.1);
  ok('底部只剩左右两段', low.length === 2, low.length);
  const lintel = bs.find((b) => b.y0 >= DOOR_H - 1e-6);
  ok('门上方有过梁', !!lintel && Math.abs(lintel.y0 - DOOR_H) < 1e-6, lintel);
  ok('过梁是整段长', lintel && Math.abs(lintel.w - 10) < 1e-6, lintel && lintel.w);
  // 门洞处必须是空的：没有任何盒子在 t∈(4,5) 且 y<DOOR_H 覆盖
  const covers = bs.some((b) => {
    if (b.y0 >= DOOR_H) return false;
    const x0 = b.x - b.w / 2, x1 = b.x + b.w / 2;
    return x0 < 4.5 && x1 > 4.5 && x0 < 5 && x1 > 4;
  });
  ok('门洞位置确实没有墙体', !covers);
}

/* ── 3. 窗洞：三层（下墙 / 中间左右 / 上墙） ───────────────────────────── */
group('3. 窗洞（真的能看见外面）');
{
  const bs = wallBoxes(0, 0, 10, 0, 0.2, 3, [{ t0: 4, t1: 5, y0: SILL_Y, y1: HEAD_Y }]);
  ok('窗洞 → 4 个盒子', bs.length === 4, bs.length);
  const below = bs.filter((b) => b.y0 === 0 && b.y0 + b.h <= SILL_Y + 1e-6);
  ok('窗下有墙（窗台）', below.length === 1 && Math.abs(below[0].h - SILL_Y) < 1e-6, below[0]);
  const above = bs.filter((b) => b.y0 >= HEAD_Y - 1e-6);
  ok('窗上有墙（过梁）', above.length === 1, above.length);
  // 窗洞区间里不应有垂直方向的墙
  const winMidY = (SILL_Y + HEAD_Y) / 2;
  const blocking = bs.filter((b) => b.y0 < winMidY && b.y0 + b.h > winMidY)
    .some((b) => (b.x - b.w / 2) < 4.5 && (b.x + b.w / 2) > 4.5);
  ok('窗洞中间是通的', !blocking);
}

/* ── 4. 房间划分 ───────────────────────────────────────────────────────── */
group('4. 房间划分（按尺寸）');
{
  const small = planInterior({ w: 4, d: 4, h: 3 });
  ok('小房间 1 间', small.rooms.length === 1, small.rooms.length);
  ok('小房间也够站人', small.stats.area > 10, small.stats.area);

  const long = planInterior({ w: 12, d: 5, h: 3 });
  ok('长方形分 2 间', long.rooms.length === 2, long.rooms.length);
  const tall = planInterior({ w: 5, d: 12, h: 3 });
  ok('竖长方形也 2 间', tall.rooms.length === 2, tall.rooms.length);

  const big = planInterior({ w: 14, d: 12, h: 3.2 });
  ok('大房间 4 间', big.rooms.length === 4, big.rooms.length);
  ok('房间面积之和 ≈ 内区面积',
    Math.abs(big.rooms.reduce((s, r) => s + r.area, 0) - big.inner.w * big.inner.d) < 0.5);
}

/* ── 5. 结构完整性 ─────────────────────────────────────────────────────── */
group('5. 结构完整性');
{
  for (const cfg of [{ w: 4, d: 4, h: 3 }, { w: 14, d: 12, h: 3.2 }, { w: 30, d: 8, h: 4 }]) {
    const p = planInterior(cfg);
    ok(`${cfg.w}×${cfg.d}×${cfg.h}：盒子全部合法`, boxesValid(p.solids), p.solids.find((b) => !(b.w > 0 && b.h > 0 && b.d > 0)));
    ok(`${cfg.w}×${cfg.d}：有地板/天花`, !!p.floor && !!p.ceiling);
    ok(`${cfg.w}×${cfg.d}：每间有灯`, p.lights.length === p.rooms.length, p.lights.length);
    ok(`${cfg.w}×${cfg.d}：灯在天花下方`, p.lights.every((l) => l.y < p.building.h && l.y > p.building.h * 0.5));
    ok(`${cfg.w}×${cfg.d}：有家具`, p.furniture.length > 0);
    ok(`${cfg.w}×${cfg.d}：所有盒子在楼高之内`, p.solids.every((b) => b.y0 >= -1e-6 && b.y0 + b.h <= p.building.h + 1e-6));
  }
}

/* ── 6. 家具不出墙 ─────────────────────────────────────────────────────── */
group('6. 家具不出房间');
{
  for (const cfg of [{ w: 6, d: 6, h: 3 }, { w: 18, d: 14, h: 3 }, { w: 8, d: 20, h: 3 }]) {
    const p = planInterior(cfg);
    const bad = [];
    for (const f of p.furniture) {
      const r = p.rooms.find((x) => x.id === f.room);
      if (!r) { bad.push([f.kind, 'room-missing']); continue; }
      if (f.x - f.w / 2 < r.x0 - 0.06 || f.x + f.w / 2 > r.x1 + 0.06 ||
          f.z - f.d / 2 < r.z0 - 0.06 || f.z + f.d / 2 > r.z1 + 0.06) {
        bad.push([f.kind, f.x, f.z, f.w, f.d]);
      }
    }
    ok(`${cfg.w}×${cfg.d}：${p.furniture.length} 件家具全在房内`, bad.length === 0, bad.slice(0, 3));
  }
  ok('家具不穿天花板', planInterior({ w: 8, d: 8, h: 2.6 }).furniture.every((f) => f.h < 2.6));
}

/* ── 7. 门洞位置合理（人能走过去） ─────────────────────────────────────── */
group('7. 隔墙门洞');
{
  const p = planInterior({ w: 16, d: 12, h: 3 });
  // 有隔墙 ⇒ 盒子数明显多于纯外墙
  ok('有隔墙', p.solids.length > 8, p.solids.length);
  ok('门洞宽度 = DOOR_W', DOOR_W >= 0.8 && DOOR_W <= 1.0, DOOR_W);
}

/* ── 8. 点选：进哪栋 ───────────────────────────────────────────────────── */
group('8. 点选命中');
{
  const box = { x: 10, z: 5, w: 8, d: 6, rot: 0 };
  ok('点在盒子里', pointInFootprint(10, 5, box));
  ok('点在盒子边缘内', pointInFootprint(13.9, 5, box));
  ok('点在盒子外', !pointInFootprint(20, 5, box));
  const rot = { x: 0, z: 0, w: 8, d: 2, rot: Math.PI / 2 };   // 转 90° → 长边变 Z
  ok('旋转后按旋转后的形状判定', pointInFootprint(0, 3, rot) && !pointInFootprint(3, 0, rot));

  const ring = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }, { x: 0, z: 0 }];
  ok('点在多边形内', pointInFootprint(5, 5, { ring }));
  ok('点在多边形外', !pointInFootprint(15, 5, { ring }));

  const list = [{ x: 0, z: 0, w: 4, d: 4 }, { x: 30, z: 0, w: 4, d: 4 }];
  ok('命中最近的那栋', findBuildingAt(list, 1, 1) === list[0]);
  ok('不在任何楼里也能给最近一栋', findBuildingAt(list, 2.5, 0) === list[0]);
  ok('离太远返回 null', findBuildingAt(list, 500, 500, 30) === null);
  ok('空数组不炸', findBuildingAt([], 0, 0) === null);
}

/* ── 8b. 多层室内 ─────────────────────────────────────────────────────── */
group('8b. 多层室内（层数 / 楼板 / 楼梯）');
{
  // 一层小楼
  const one = planInterior({ w: 8, d: 8, h: 3.1, x: 0, z: 0 });
  ok('矮楼 = 1 层', one.stats.floors === 1, one.stats.floors);
  ok('1 层没有楼梯', one.stairs.length === 0, one.stairs.length);

  // 一栋 20m 的楼 → 按层高 3.1m 推层数
  const multi = planInterior({ w: 14, d: 12, h: 20, x: 0, z: 0 });
  ok('20m 的楼分多层', multi.stats.floors >= 5, multi.stats.floors);
  ok('每层一层楼板', multi.floors.length === multi.stats.floors, { floors: multi.floors.length, stat: multi.stats.floors });
  ok('楼板高度依次递增',
    multi.floors.every((f, i) => Math.abs(f.y - i * multi.stats.floorH) < 1e-6),
    multi.floors.map((f) => +f.y.toFixed(2)));
  ok('天花板每层一块', multi.ceilings.length === multi.stats.floors);
  ok('楼梯有台阶', multi.stairs.length > 0, multi.stairs.length);
  ok('楼梯台阶数 = (层数-1)×10', multi.stairs.length === (multi.stats.floors - 1) * 10, multi.stairs.length);
  ok('有楼梯间', !!multi.stairwell);
  ok('房间分属各层', new Set(multi.rooms.map((r) => r.floor)).size === multi.stats.floors,
    [...new Set(multi.rooms.map((r) => r.floor))]);
  ok('每层都有房间', multi.stats.rooms >= multi.stats.floors);
  ok('家具跟着层高走', multi.furniture.every((f) => Math.abs(f.y - f.floor * multi.stats.floorH) < 1e-6));
  ok('灯在各层天花板下', multi.lights.every((L) => {
    const base = L.floor * multi.stats.floorH;
    return L.y < base + multi.stats.floorH && L.y > base + multi.stats.floorH * 0.5;
  }));
  // ★ 2026-11-09：层数上限 8 → 40（90m 的楼之前只建到 24.8m）
  ok('层数封顶 40', planInterior({ w: 14, d: 12, h: 200, x: 0, z: 0 }).stats.floors === 40);
  ok('★ 90m 的楼能建满（之前只有 8 层 = 24.8m）',
    planInterior({ w: 14, d: 12, h: 90, x: 0, z: 0 }).stats.floors === 29,
    planInterior({ w: 14, d: 12, h: 90, x: 0, z: 0 }).stats);
  ok('★ 显式给的 floors 也封顶 40',
    planInterior({ w: 14, d: 12, h: 500, floors: 999, x: 0, z: 0 }).stats.floors === 40);
  ok('★ plan 里带 floorH（渲染按层裁剪要用）',
    Math.abs(planInterior({ w: 14, d: 12, h: 30, x: 0, z: 0 }).floorH - 3.1) < 0.01);
  ok('可以指定层数', planInterior({ w: 8, d: 8, h: 3.1, floors: 4, x: 0, z: 0 }).stats.floors === 4);
}

console.log(`\n${fail ? '✗' : '✓'} interior-plan: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
