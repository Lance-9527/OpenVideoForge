#!/usr/bin/env node
/* ============================================================================
 * tests/worldgen-render.mjs —— **渲染层**测试（不是只测数学）
 *
 * 用项目自带的 three r160 在 node 里真建几何：
 *   · 城市按块分 InstancedMesh → 实例数、分块裁剪、LOD 都是真的在切 visible
 *   · OSM 的合并几何 → 顶点数、无 NaN、楼层色有区分
 *   · 室内壳 → 一个 mesh、灯数对、包围盒落在楼里
 *
 * 跑法（需要解析器，否则 import 'three' 找不到）：
 *   node --import ./tests/three-resolver.mjs tests/worldgen-render.mjs
 * ========================================================================== */
import * as THREE from 'three';
import { planCity } from '../js/worldgen/plan.js';
import { buildCity, applyChunkCulling, updateCityLod } from '../js/worldgen/city.js';
import { normalizeOsm } from '../js/worldgen/osm-parse.js';
import { buildOsm } from '../js/worldgen/osm.js';
import { buildInterior } from '../js/worldgen/interior.js';
import { planInterior } from '../js/worldgen/interior-plan.js';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};
const group = (t) => console.log('\n' + t);

const finiteAttr = (mesh) => {
  const p = mesh.geometry && mesh.geometry.attributes && mesh.geometry.attributes.position;
  if (!p) return false;
  const a = p.array;
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
};
const allInstancesFinite = (im) => {
  const m = im.instanceMatrix && im.instanceMatrix.array;
  if (!m) return false;
  for (let i = 0; i < m.length; i++) if (!Number.isFinite(m[i])) return false;
  return true;
};

/* ── 1. 城市：按块实例化 ───────────────────────────────────────────────── */
group('1. 城市：按块 InstancedMesh');
let cityState = null;
{
  const plan = planCity({ factor: 20, seed: 5 });
  cityState = buildCity(plan);
  ok('返回了 group', !!cityState.group && cityState.group.isGroup);
  ok('有地面', cityState.group.children.some((c) => c.name === 'floor-city'));
  ok('有道路 InstancedMesh', !!cityState.meshes.roads && cityState.meshes.roads.isInstancedMesh);
  ok('楼是按块的多份 InstancedMesh', cityState.meshes.buildings.length > 1, cityState.meshes.buildings.length);
  ok('块数 == 有楼的块数',
    cityState.chunkMeshes.buildings.size === plan.chunks.filter((c) => c.buildings > 0).length,
    { meshes: cityState.chunkMeshes.buildings.size, expect: plan.chunks.filter((c) => c.buildings > 0).length });

  // 所有块加起来 == 楼总数（一栋不丢、一栋不重）
  let total = 0;
  for (const im of cityState.chunkMeshes.buildings.values()) total += im.count;
  ok('实例总数 == 楼总数', total === plan.buildings.length, { total, expect: plan.buildings.length });

  ok('所有实例矩阵无 NaN',
    [...cityState.chunkMeshes.buildings.values()].every(allInstancesFinite));
  ok('楼都投/收阴影',
    [...cityState.chunkMeshes.buildings.values()].every((im) => im.castShadow && im.receiveShadow));
  ok('楼有实例色', [...cityState.chunkMeshes.buildings.values()].every((im) => !!im.instanceColor));

  // 几何/材质共享：多出来的只是实例缓冲，不涨显存
  const geos = new Set([...cityState.chunkMeshes.buildings.values()].map((im) => im.geometry.uuid));
  const mats = new Set([...cityState.chunkMeshes.buildings.values()].map((im) => im.material.uuid));
  ok('几何在全城共享一份', geos.size === 1, geos.size);
  ok('材质在全城共享一份', mats.size === 1, mats.size);
}

/* ── 2. 分块裁剪真的在切 visible ───────────────────────────────────────── */
group('2. 分块裁剪（切的是 visible，不只是算集合）');
{
  const plan = cityState.plan;
  const focus = { x: 0, z: 0 };
  const shown = applyChunkCulling(cityState, focus, 1);
  const visibleCount = [...cityState.chunkMeshes.buildings.values()].filter((m) => m.visible).length;
  ok('裁剪返回数 == 实际 visible 数', shown === visibleCount, { shown, visibleCount });
  ok('range 1 只留 ≤9 块', shown <= 9, shown);
  ok('确实有关掉的块', visibleCount < cityState.chunkMeshes.buildings.size,
    { on: visibleCount, all: cityState.chunkMeshes.buildings.size });

  // 放大窗口 → 回来的块变多
  const wider = applyChunkCulling(cityState, focus, 3);
  ok('放大窗口后显示更多', wider > shown, { narrow: shown, wide: wider });

  // 场地外看 → 全开（不空屏）
  applyChunkCulling(cityState, { x: 1e9, z: 0 }, 1);
  const allOn = [...cityState.chunkMeshes.buildings.values()].filter((m) => m.visible).length;
  ok('场地外退回全显示', allOn === cityState.chunkMeshes.buildings.size, allOn);
}

/* ── 3. 道具 LOD ───────────────────────────────────────────────────────── */
group('3. 道具 LOD（远近换档）');
{
  const size = cityState.plan.size;
  updateCityLod(cityState, new THREE.Vector3(0, 5, 0), size);
  const nearOn = cityState.propsGroup.children.filter((c) => c.visible).length;
  ok('近处道具可见', nearOn > 0, nearOn);

  updateCityLod(cityState, new THREE.Vector3(size * 2, 5, size * 2), size);
  const farOn = cityState.propsGroup.children.filter((c) => c.visible).length;
  ok('远处道具全关', farOn === 0, farOn);

  updateCityLod(cityState, new THREE.Vector3(0, 5, 0), size);
  ok('回到近处又打开',
    cityState.propsGroup.children.filter((c) => c.visible).length === nearOn);
}

/* ── 4. OSM 合并几何 ───────────────────────────────────────────────────── */
group('4. OSM：合并几何');
{
  const origin = { lat: 31, lng: 121 };
  const mkRing = (cx, cz, s) => {
    const dLat = -cz / 110540;
    const dLng = cx / (111320 * Math.cos((31 * Math.PI) / 180));
    const dd = s / 111320;
    return [
      { lat: 31 + dLat - dd, lon: 121 + dLng - dd },
      { lat: 31 + dLat - dd, lon: 121 + dLng + dd },
      { lat: 31 + dLat + dd, lon: 121 + dLng + dd },
      { lat: 31 + dLat + dd, lon: 121 + dLng - dd },
      { lat: 31 + dLat - dd, lon: 121 + dLng - dd },
    ];
  };
  const raw = {
    elements: [
      { type: 'way', id: 1, tags: { building: 'house' }, geometry: mkRing(20, 0, 0.00014) },
      { type: 'way', id: 2, tags: { building: 'apartments', 'building:levels': '6' }, geometry: mkRing(-30, 25, 0.0002) },
      { type: 'way', id: 3, tags: { building: 'church' }, geometry: mkRing(40, -30, 0.00016) },
      { type: 'way', id: 4, tags: { highway: 'primary' }, geometry: [{ lat: 31, lon: 121 }, { lat: 31.0015, lon: 121 }, { lat: 31.0015, lon: 121.002 }] },
      { type: 'way', id: 5, tags: { natural: 'water' }, geometry: mkRing(70, 70, 0.0003) },
      { type: 'way', id: 6, tags: { leisure: 'park' }, geometry: mkRing(-70, -70, 0.0003) },
      { type: 'node', id: 7, lat: 31.0006, lon: 121.0006, tags: { natural: 'tree' } },
    ],
  };
  const world = normalizeOsm(raw, origin);
  const built = buildOsm(world);

  ok('返回 group', !!built.group && built.group.isGroup);
  ok('有地面', built.group.children.some((c) => c.name === 'floor-osm'));
  ok('楼是**一个**合并 mesh（不是一栋一个）',
    built.meshes.buildings && built.meshes.buildings.isMesh && !built.meshes.buildings.isInstancedMesh);
  ok('楼顶点数 > 0', built.meshes.buildings.geometry.attributes.position.count > 0,
    built.meshes.buildings.geometry.attributes.position.count);
  ok('楼顶点无 NaN', finiteAttr(built.meshes.buildings));
  ok('路是一个合并 mesh', !!built.meshes.roads && finiteAttr(built.meshes.roads));
  ok('水/绿各一个 mesh', !!built.meshes.waters && !!built.meshes.greens);
  ok('树是实例化的', !!built.meshes.treeTrunk && built.meshes.treeTrunk.isInstancedMesh);
  ok('plan.stats 对得上',
    built.plan.stats.buildings === 3 && built.plan.stats.roads === 1 &&
    built.plan.stats.trees === 1 && built.plan.stats.waters === 1 && built.plan.stats.greens === 1,
    built.plan.stats);
  ok('带 ODbL 署名', built.plan.attribution === '© OpenStreetMap contributors');
  // draw call：地面/楼/路/水/绿/树干/树冠 = 7（无地形时地形不占一份）
  ok('draw call 很少（≤7）', Object.keys(built.meshes).length <= 7,
    Object.keys(built.meshes).length);
  ok('地面是平面的（没给地形时）', !!built.meshes.floor && !built.meshes.terrain);
  // 语义上色：教堂(暖) 与 公寓(冷) 的顶点色应该不同
  const colorAt = (mesh, i) => {
    const c = mesh.geometry.attributes.color.array;
    return [c[i * 3], c[i * 3 + 1], c[i * 3 + 2]];
  };
  const c0 = colorAt(built.meshes.buildings, 0);
  const cLast = colorAt(built.meshes.buildings, built.meshes.buildings.geometry.attributes.color.count - 1);
  ok('不同用途的楼颜色不同', c0.join(',') !== cLast.join(','), { c0, cLast });
}

/* ── 5b. 地形接入 ──────────────────────────────────────────────────────── */
group('5b. 地形：地面起伏 + 楼站在地上');
{
  const origin = { lat: 31, lng: 121 };
  const dLat = -20 / 110540;
  const dLng = 20 / (111320 * Math.cos((31 * Math.PI) / 180));
  const dd = 0.0002;
  const raw = {
    elements: [
      { type: 'way', id: 1, tags: { building: 'house' }, geometry: [
        { lat: 31 + dLat - dd, lon: 121 + dLng - dd },
        { lat: 31 + dLat - dd, lon: 121 + dLng + dd },
        { lat: 31 + dLat + dd, lon: 121 + dLng + dd },
        { lat: 31 + dLat + dd, lon: 121 + dLng - dd },
        { lat: 31 + dLat - dd, lon: 121 + dLng - dd },
      ] },
      { type: 'way', id: 4, tags: { highway: 'primary' }, geometry: [{ lat: 31, lon: 121 }, { lat: 31.0015, lon: 121 }] },
    ],
  };
  const world = normalizeOsm(raw, origin);

  // 人工地形：4×4，高度线性抬升（西北高、东南低）
  const size = 4, step = 40;
  const values = [];
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) values.push(i * 5 + j * 10);
  const grid = { size, step, minX: -80, minZ: -80, values };

  const built = buildOsm(world, { terrain: grid });
  ok('地形网格生成了 mesh', !!built.meshes.terrain, Object.keys(built.meshes));
  ok('有地形时不再有平面地面', !built.meshes.floor);
  ok('地形 mesh 有起伏', (() => {
    const pos = built.meshes.terrain.geometry.attributes.position;
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); mn = Math.min(mn, y); mx = Math.max(mx, y); }
    return mx - mn > 1;
  })());
  // 楼要站在地形上：楼底面 y 应该 ≈ 该处地面高度，而不是 0
  const pos = built.meshes.buildings.geometry.attributes.position;
  let minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pos.count; i++) { const y = pos.getY(i); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  ok('楼底面跟着地形抬起来了（不是 y=0）', minY > 0.5, { minY, maxY });
  ok('楼顶比楼底高（仍然是立着的）', maxY - minY > 1, { minY, maxY });
}

/* ── 6. 室内壳 ─────────────────────────────────────────────────────────── */
group('5. 室内：一个壳 + 灯');
{
  for (const cfg of [{ w: 6, d: 6, h: 3 }, { w: 16, d: 12, h: 3.2 }]) {
    const built = buildInterior({ ...cfg, x: 100, z: 50, seed: 3 });
    const shell = built.group.children.find((c) => c.name === 'interior-shell');
    ok(`${cfg.w}×${cfg.d}：有一个室内壳`, !!shell && shell.isMesh);
    ok(`${cfg.w}×${cfg.d}：顶点无 NaN`, finiteAttr(shell));
    ok(`${cfg.w}×${cfg.d}：顶点数 > 0`, shell.geometry.attributes.position.count > 0);
    const lights = built.group.children.filter((c) => c.isPointLight);
    ok(`${cfg.w}×${cfg.d}：灯数 == 房间数`, lights.length === built.plan.rooms.length,
      { lights: lights.length, rooms: built.plan.rooms.length });
    ok(`${cfg.w}×${cfg.d}：灯在天花下`, lights.every((l) => l.position.y < cfg.h && l.position.y > cfg.h * 0.5));
    ok(`${cfg.w}×${cfg.d}：壳在楼的位置上`, Math.abs(built.plan.building.x - 100) < 1e-6);
    // 包围盒要落在楼里（不穿到外面）
    shell.geometry.computeBoundingBox();
    const bb = shell.geometry.boundingBox;
    ok(`${cfg.w}×${cfg.d}：包围盒不超出楼`,
      bb.min.x >= 100 - cfg.w / 2 - 1e-6 && bb.max.x <= 100 + cfg.w / 2 + 1e-6 &&
      bb.min.y >= -1e-6 && bb.max.y <= cfg.h + 1e-6,
      { min: bb.min.toArray(), max: bb.max.toArray() });
  }
  // 纯数学层与渲染层用的是同一份 plan
  const p1 = planInterior({ w: 9, d: 7, h: 3, x: 0, z: 0, seed: 1 });
  const b1 = buildInterior({ w: 9, d: 7, h: 3, x: 0, z: 0, seed: 1 });
  ok('同参数下 plan 可复现', JSON.stringify(p1.stats) === JSON.stringify(b1.plan.stats));
}

console.log(`\n${fail ? '✗' : '✓'} worldgen-render: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
