#!/usr/bin/env node
/* ============================================================================
 * tests/osm-fetch.mjs —— 真实世界链路的**联网 + 离线缓存**测试
 *
 * 两条硬要求：
 *   1) 第一次抓取能落盘；
 *   2) 第二次必须走缓存（不再联网）。
 * 没网时不判失败，打成 SKIP —— 但只要有缓存，就必须能离线重放。
 * ========================================================================== */
import { getOsmWorld, listCachedWorlds, worldKey, cacheDir, defaultOutDir } from '../server/osm.mjs';

const LAT = Number(process.env.OSM_LAT || 35.6595);
const LNG = Number(process.env.OSM_LNG || 139.7005);
const RADIUS = Number(process.env.OSM_RADIUS || 200);

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};

console.log('缓存目录：' + cacheDir());
console.log(`测试点位：${LAT}, ${LNG}  半径 ${RADIUS}m  key=${worldKey(LAT, LNG, RADIUS)}\n`);

const t0 = Date.now();
const r1 = await getOsmWorld({ lat: LAT, lng: LNG, radius: RADIUS });
const ms1 = Date.now() - t0;

if (!r1.ok) {
  console.log('  … 抓取失败（可能没网/被限流）：' + r1.error);
  const cached = listCachedWorlds();
  console.log('  … 本机已缓存的世界数：' + cached.length);
  if (cached.length === 0) {
    console.log('\n· osm-fetch: SKIP（无网且无缓存）');
    process.exit(0);
  }
  // 有缓存就验证离线重放
  const c = cached[0];
  const r2 = await getOsmWorld({ lat: c.lat, lng: c.lng, radius: c.radius });
  ok('离线重放旧缓存', r2.ok && r2.meta && r2.meta.cached, r2.error);
  console.log(`\n${fail ? '✗' : '✓'} osm-fetch: ${pass} passed, ${fail} failed (offline)`);
  process.exit(fail ? 1 : 0);
}

console.log(`  第一次：${ms1}ms  cached=${r1.meta.cached}`);
console.log('  stats: ' + JSON.stringify(r1.stats));
console.log('  world: 楼 ' + r1.world.buildings.length +
  ' / 路 ' + r1.world.roads.length +
  ' / 水 ' + r1.world.waters.length +
  ' / 绿 ' + r1.world.greens.length +
  ' / 树 ' + r1.world.trees.length +
  ' / 最高 ' + r1.stats.tallest + 'm');

ok('第一次抓取成功', r1.ok);
ok('抓到了建筑', r1.world.buildings.length > 0, r1.stats);
ok('抓到了道路', r1.world.roads.length > 0, r1.stats);
ok('带 ODbL 署名', r1.world.attribution === '© OpenStreetMap contributors', r1.world.attribution);
ok('落盘了', !!(r1.meta && (r1.meta.bytes > 0 || r1.meta.cached)), r1.meta);

// 第二次必须命中缓存（这是"本地可掌握"的核心）
const t1 = Date.now();
const r2 = await getOsmWorld({ lat: LAT, lng: LNG, radius: RADIUS });
const ms2 = Date.now() - t1;
console.log(`  第二次：${ms2}ms  cached=${r2.meta.cached}`);
ok('第二次走缓存（不再联网）', r2.meta.cached === true, r2.meta);
ok('缓存读回的建筑数一致', r2.world.buildings.length === r1.world.buildings.length,
  { first: r1.world.buildings.length, second: r2.world.buildings.length });
ok('缓存读回明显更快', ms2 < ms1, { ms1, ms2 });

// 清单一
const list = listCachedWorlds();
ok('离线清单里有这一条', list.some((x) => x.key === r1.key), list.length);
ok('清单带署名', list.every((x) => x.attribution === '© OpenStreetMap contributors'));

// 坏参数必须被挡住
const bad1 = await getOsmWorld({ lat: 'x', lng: 1, radius: 200 });
const bad2 = await getOsmWorld({ lat: 10, lng: 10, radius: 5 });
ok('缺 lat/lng 被拒', !bad1.ok && /lat/.test(bad1.error), bad1.error);
ok('半径过小被拒', !bad2.ok, bad2.error);

console.log(`\n${fail ? '✗' : '✓'} osm-fetch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
