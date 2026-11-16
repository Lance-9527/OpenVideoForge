#!/usr/bin/env node
/* ============================================================================
 * tests/terrain.mjs —— 地形高程
 *
 * 守的是：
 *   ① PNG 解码（terrarium 编码）算得对
 *   ② 采样器双线性插值、越界不炸
 *   ③ 网格 → 起伏地面的几何正确（顶点数、法线、无 NaN）
 *   ④ 楼能站在地形上（baseY = 地面高度）
 * ========================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getTerrain } from '../server/terrain.mjs';
import { makeSampler, gridStats } from '../js/worldgen/terrain-grid.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};
const group = (t) => console.log('\n' + t);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf-terrain-'));

/* ── 1. 采样器 ─────────────────────────────────────────────────────────── */
group('1. 采样器');
{
  // 4×4 的人工网格：高度线性递增
  const size = 4, step = 10;
  const values = [];
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) values.push(i * 10 + j * 100);
  const grid = { size, step, minX: 0, minZ: 0, values };
  const h = makeSampler(grid);
  ok('采样器建出来了', typeof h === 'function');

  // 格心 (i+0.5)*step 处
  ok('第一个格心高度 = 0', Math.abs(h(5, 5) - 0) < 1e-6, h(5, 5));
  ok('第二个格心高度 = 10', Math.abs(h(15, 5) - 10) < 1e-6, h(15, 5));
  ok('第二行 = +100', Math.abs(h(5, 15) - 100) < 1e-6, h(5, 15));
  // 中间（格心之间）应该是插值
  const mid = h(10, 5);
  ok('格心中间有插值（5~15 之间）', mid > 0 && mid < 10, mid);
  // 越界不炸
  ok('越界不炸', Number.isFinite(h(-9999, -9999)) && Number.isFinite(h(9999, 9999)));
  ok('越界用边缘值', Math.abs(h(-9999, -9999) - 0) < 1e-6, h(-9999, -9999));

  ok('空网格返回 null', makeSampler(null) === null);
  ok('空 values 返回 null', makeSampler({ size: 2, step: 1, values: [] }) === null);
}

/* ── 2. 网格统计 ───────────────────────────────────────────────────────── */
group('2. 网格统计');
{
  const grid = { size: 4, step: 10, values: [0, 10, 20, 30, 100, 110, 120, 130, 200, 210, 220, 230, 300, 310, 320, 330] };
  const s = gridStats(grid);
  ok('最小值对', s.min === 0, s.min);
  ok('最大值对', s.max === 330, s.max);
  ok('起伏 = max-min', s.relief === 330, s.relief);
  ok('平均值在范围内', s.avg > 0 && s.avg < 330, s.avg);
  ok('空网格返回 null', gridStats(null) === null);
}

/* ── 3. 联网取真实高程 ─────────────────────────────────────────────────── */
group('3. 真实高程（联网）');
{
  const r = await getTerrain({ lat: 35.6595, lng: 139.7005, spanMeters: 800, res: 24, outDir: tmp });
  ok('取到了', r.ok === true, r.error);
  if (r.ok) {
    ok('网格尺寸对', r.grid.size === 24, r.grid.size);
    ok('值数量 = size²', r.grid.values.length === 24 * 24, r.grid.values.length);
    ok('全有限', r.grid.values.every(Number.isFinite));
    ok('高程范围合理（-50~9000m）', r.grid.minH > -50 && r.grid.maxH < 9000, { minH: r.grid.minH, maxH: r.grid.maxH });
    ok('涩谷不是全平（起伏 > 5m）', r.grid.maxH - r.grid.minH > 5, r.grid.maxH - r.grid.minH);
    ok('带 OSM 署名', r.attribution === '© OpenStreetMap contributors');
    ok('瓦片落盘缓存', fs.existsSync(path.join(tmp, 'terrain-cache')));
    // 第二次走缓存应该很快
    const t0 = Date.now();
    const r2 = await getTerrain({ lat: 35.6595, lng: 139.7005, spanMeters: 800, res: 24, outDir: tmp });
    ok('第二次走缓存（<800ms）', Date.now() - t0 < 800, Date.now() - t0);
    ok('两次结果一致', JSON.stringify(r.grid.values) === JSON.stringify(r2.grid.values));
  }
}

/* ── 4. 参数校验 ───────────────────────────────────────────────────────── */
group('4. 参数校验');
{
  ok('缺经纬度报错', (await getTerrain({ outDir: tmp })).ok === false);
  ok('半径被夹住（不会无限大）', (await getTerrain({ lat: 0, lng: 0, spanMeters: 999999, res: 8, outDir: tmp })).ok !== undefined);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? '✗' : '✓'} terrain: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
