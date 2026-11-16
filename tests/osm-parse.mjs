#!/usr/bin/env node
/* ============================================================================
 * tests/osm-parse.mjs —— OSM 纯解析层单元测试
 * 用**合成数据**，不联网：抓取通路的失败/超时由 server/osm.mjs 自己兜底，
 * 这里只钉死"经纬度怎么变成米、楼多高、什么颜色、环有没有闭"。
 * ========================================================================== */
import {
  bboxFromLatLng, project, overpassQuery, inferBuildingHeight, buildingColor,
  roadWidth, roadColor, isGreen, isWater, closeRing, signedArea, normalizeOsm,
  OSM_ATTRIBUTION, M_PER_DEG_LAT,
} from '../js/worldgen/osm-parse.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};
const group = (t) => console.log('\n' + t);

/* ── 1. bbox ───────────────────────────────────────────────────────────── */
group('1. bbox 由中心点+半径算');
{
  const b = bboxFromLatLng(31.2304, 121.4737, 500);   // 上海人民广场 500m
  ok('南北对称', Math.abs((b.north - 31.2304) - (31.2304 - b.south)) < 1e-9);
  ok('半径换算正确', Math.abs((b.north - b.south) / 2 * M_PER_DEG_LAT - 500) < 1);
  ok('经度跨度 > 纬度跨度（考虑 cos lat）', (b.east - b.west) > (b.north - b.south));
  const hi = bboxFromLatLng(70, 20, 500);
  const lo = bboxFromLatLng(0, 20, 500);
  ok('高纬度经度跨度更大', (hi.east - hi.west) > (lo.east - lo.west));
}

/* ── 2. 投影 ───────────────────────────────────────────────────────────── */
group('2. 经纬度 → 本地米制（x 东 / z 南）');
{
  const o = { lat: 31, lng: 121 };
  const c = project(31, 121, o);
  ok('原点映射到 (0,0)', c.x === 0 && c.z === 0, c);
  const north = project(31.001, 121, o);
  ok('往北 → z 为负（相机朝 -Z）', north.z < 0, north);
  const east = project(31, 121.001, o);
  ok('往东 → x 为正', east.x > 0, east);
  ok('1e-3 度纬度 ≈ 110.5m', Math.abs(Math.abs(north.z) - 110.54) < 1, north.z);
  ok('1e-3 度经度在 lat31 ≈ 95m', Math.abs(east.x - 95.4) < 2, east.x);
}

/* ── 3. 楼高推断 ───────────────────────────────────────────────────────── */
group('3. 楼高：height > levels×3 > 类型默认 > 兜底');
{
  ok('height 优先', inferBuildingHeight({ height: '42', 'building:levels': '3' }) === 42);
  ok('levels×3', inferBuildingHeight({ 'building:levels': '5' }) === 15);
  ok('类型默认', inferBuildingHeight({ building: 'apartments' }) === 18);
  ok('未知类型兜底 8', inferBuildingHeight({ building: 'zzz_unknown' }) === 8);
  ok('空 tags 兜底 8', inferBuildingHeight({}) === 8);
  ok('负数 height 不采信', inferBuildingHeight({ height: '-5', building: 'house' }) === 6);
  ok('超大 height 被夹到 320', inferBuildingHeight({ height: '9999' }) === 320);
}

/* ── 4. 语义颜色 / 路宽 ────────────────────────────────────────────────── */
group('4. 语义 → 颜色与路宽');
{
  ok('house 与 apartments 不同色', buildingColor({ building: 'house' }) !== buildingColor({ building: 'apartments' }));
  ok('教堂是暖色（红>蓝）', (buildingColor({ building: 'church' }) >> 16 & 255) > (buildingColor({ building: 'church' }) & 255));
  ok('未知类型有兜底色', Number.isFinite(buildingColor({ building: 'zzz' })));
  ok('主干道比步行道宽', roadWidth({ highway: 'primary' }) > roadWidth({ highway: 'footway' }));
  ok('motorway 最宽', roadWidth({ highway: 'motorway' }) === 22);
  ok('未知路型宽 5', roadWidth({ highway: 'zzz' }) === 5);
  ok('步行道颜色比主路亮', roadColor({ highway: 'footway' }) > roadColor({ highway: 'motorway' }));
  ok('绿地判定 park', isGreen({ leisure: 'park' }));
  ok('绿地判定 grass', isGreen({ landuse: 'grass' }));
  ok('建筑不是绿地', !isGreen({ building: 'house' }));
  ok('水面判定', isWater({ natural: 'water' }) && isWater({ waterway: 'riverbank' }));
  ok('道路不是水面', !isWater({ highway: 'primary' }));
}

/* ── 5. 环闭合 / 绕向 ──────────────────────────────────────────────────── */
group('5. 多边形闭合与绕向');
{
  const open = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }];
  const closed = closeRing(open);
  ok('开口环被闭合', closed.length === 4 && closed[3].x === 0 && closed[3].z === 0);
  const already = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 0 }];
  ok('已闭合不再重复加点', closeRing(already).length === 4);
  ok('点数不足返回空', closeRing([{ x: 0, z: 0 }, { x: 1, z: 1 }]).length === 0);
  const ccw = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 }, { x: 0, z: 0 }];
  ok('10×10 正方形面积 = 100（绝对值）', Math.abs(signedArea(ccw)) === 100, signedArea(ccw));
  const cw = ccw.slice().reverse();
  ok('反向绕向面积符号翻转', signedArea(cw) === -signedArea(ccw));
}

/* ── 6. Overpass 查询串 ────────────────────────────────────────────────── */
group('6. Overpass QL');
{
  const b = bboxFromLatLng(31, 121, 300);
  const q = overpassQuery(b, 30);
  ok('带超时', q.includes('[timeout:30]'));
  ok('带 bbox', q.includes('31') && q.includes('121'));
  for (const sel of ['building', 'highway', 'waterway', 'landuse', 'leisure', 'tree']) {
    ok('取 ' + sel, q.includes(`"${sel}"`));
  }
  ok('要求几何内联', /out body geom/.test(q));
}

/* ── 7. 端到端解析（合成 payload） ─────────────────────────────────────── */
group('7. normalizeOsm 端到端（合成数据）');
{
  const origin = { lat: 31, lng: 121 };
  // 造一个 30m 见方的房子，位于原点正东 20m
  const mkRing = (cx, cz, s) => {
    const dLat = -cz / M_PER_DEG_LAT;
    const dLng = (cx) / (111320 * Math.cos(origin.lat * Math.PI / 180));
    const dd = s / 111320;
    return [
      { lat: origin.lat + dLat - dd, lon: origin.lng + dLng - dd },
      { lat: origin.lat + dLat - dd, lon: origin.lng + dLng + dd },
      { lat: origin.lat + dLat + dd, lon: origin.lng + dLng + dd },
      { lat: origin.lat + dLat + dd, lon: origin.lng + dLng - dd },
      { lat: origin.lat + dLat - dd, lon: origin.lng + dLng - dd },
    ];
  };
  const raw = {
    elements: [
      { type: 'way', id: 1, tags: { building: 'house' }, geometry: mkRing(20, 0, 0.000135) },
      { type: 'way', id: 2, tags: { building: 'apartments', 'building:levels': '8' }, geometry: mkRing(-30, 25, 0.0002) },
      { type: 'way', id: 3, tags: { highway: 'residential' }, geometry: [{ lat: 31, lon: 121 }, { lat: 31.002, lon: 121 }] },
      { type: 'way', id: 4, tags: { natural: 'water' }, geometry: mkRing(60, 60, 0.0003) },
      { type: 'way', id: 5, tags: { leisure: 'park' }, geometry: mkRing(-60, -60, 0.0003) },
      { type: 'node', id: 6, lat: 31.0005, lon: 121.0005, tags: { natural: 'tree' } },
      { type: 'way', id: 7, tags: { highway: 'primary' }, geometry: [{ lat: 31.001, lon: 121 }, { lat: 31.001, lon: 121.003 }] },
    ],
  };
  const w = normalizeOsm(raw, origin);

  ok('kind = osm', w.kind === 'osm');
  ok('署名带上', w.attribution === OSM_ATTRIBUTION);
  ok('2 栋楼', w.buildings.length === 2, w.buildings.length);
  ok('2 条路', w.roads.length === 2, w.roads.length);
  ok('1 片水', w.waters.length === 1, w.waters.length);
  ok('1 片绿地', w.greens.length === 1, w.greens.length);
  ok('1 棵树', w.trees.length === 1, w.trees.length);
  ok('house 楼高 6', w.buildings[0].height === 6, w.buildings[0].height);
  ok('levels=8 → 24m', w.buildings[1].height === 24, w.buildings[1].height);
  ok('所有环都闭合', w.buildings.every((b) => {
    const a = b.ring[0], z = b.ring[b.ring.length - 1];
    return Math.abs(a.x - z.x) < 1e-6 && Math.abs(a.z - z.z) < 1e-6;
  }));
  ok('无 NaN', [...w.buildings, ...w.roads].every((o) => {
    const pts = o.ring || o.path;
    return pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.z));
  }));
  ok('房子落在原点正东 20m 附近', Math.abs(
    (w.buildings[0].ring[0].x + w.buildings[0].ring[2].x) / 2 - 20) < 3,
  (w.buildings[0].ring[0].x + w.buildings[0].ring[2].x) / 2);
  ok('主路比住宅路宽', roadWidth({ highway: 'primary' }) > roadWidth({ highway: 'residential' }));
  ok('bounds 覆盖所有东西', w.bounds.maxX >= 20 && w.bounds.minZ <= -25);
  ok('size 为正', w.size > 0, w.size);
  ok('stats 对得上', w.stats.buildings === 2 && w.stats.roads === 2 && w.stats.trees === 1);
  ok('最高楼 = 24', w.stats.tallest === 24, w.stats.tallest);
}

/* ── 8. 预算封顶 ───────────────────────────────────────────────────────── */
group('8. 预算封顶');
{
  const origin = { lat: 31, lng: 121 };
  const els = [];
  for (let i = 0; i < 50; i++) {
    els.push({
      type: 'way', id: i, tags: { building: 'house' },
      geometry: [
        { lat: 31 + i * 1e-5, lon: 121 }, { lat: 31 + i * 1e-5, lon: 121.0001 },
        { lat: 31.0001 + i * 1e-5, lon: 121.0001 }, { lat: 31 + i * 1e-5, lon: 121 },
      ],
    });
  }
  const w = normalizeOsm({ elements: els }, origin, { maxBuildings: 10 });
  ok('楼数被 maxBuildings 夹住', w.buildings.length === 10, w.buildings.length);
  ok('跳过的有记账', w.stats.skipped === 40, w.stats.skipped);
}

/* ── 9. 坏数据不炸 ─────────────────────────────────────────────────────── */
group('9. 坏数据不炸');
{
  const origin = { lat: 31, lng: 121 };
  ok('空 payload', normalizeOsm({}, origin).buildings.length === 0);
  ok('null payload', normalizeOsm(null, origin).buildings.length === 0);
  ok('几何为空的 way 被跳过', normalizeOsm({ elements: [{ type: 'way', id: 1, tags: { building: 'house' }, geometry: [] }] }, origin).buildings.length === 0);
  ok('只有两个点的建筑被跳过', normalizeOsm({
    elements: [{ type: 'way', id: 1, tags: { building: 'house' }, geometry: [{ lat: 31, lon: 121 }, { lat: 31.001, lon: 121.001 }] }],
  }, origin).buildings.length === 0);
}

console.log(`\n${fail ? '✗' : '✓'} osm-parse: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
