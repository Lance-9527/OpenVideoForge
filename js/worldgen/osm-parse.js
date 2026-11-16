/* ============================================================================
 * js/worldgen/osm-parse.js —— OpenStreetMap → 本地米制世界的**纯解析层**
 *
 * 为什么纯：
 *   · 不 import three ⇒ node 里能直接单元测试；
 *   · 服务端（server/osm.mjs 抓取+缓存）和客户端（worldgen/osm.js 建几何）
 *     共用同一份规范，避免"抓的时候一套、建的时候另一套"。
 *
 * ★ 版权口径（重要，别再问一遍）：
 *   这里用的是 **OpenStreetMap 原始数据**（ODbL），不是任何第三方工具的产物。
 *   ODbL 的要求只有一条：**对外发布作品时署名**「© OpenStreetMap contributors」。
 *   所以 `worldInfo()` 会带上 attribution 字段，出片/导出时要把它写进去。
 *
 * 坐标系（和 editor.js 的约定一致）：
 *   · 世界：右手 Y-up，米制；地面在 XZ 平面。
 *   · 本文件的输出：x = 东，z = 南（所以"北"是 -z，和 three 相机朝 -Z 对得上）。
 * ========================================================================== */

/** 纬度 1 度 ≈ 110540 m；经度 1 度 ≈ 111320·cos(lat) m —— 工程精度足够（deviation < 0.5%） */
export const M_PER_DEG_LAT = 110540;
export const M_PER_DEG_LNG = 111320;

export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** 由中心点 + 半径（米）算 bbox */
export function bboxFromLatLng(lat, lng, radius) {
  const dLat = radius / M_PER_DEG_LAT;
  const dLng = radius / (M_PER_DEG_LNG * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return {
    south: lat - dLat,
    west: lng - dLng,
    north: lat + dLat,
    east: lng + dLng,
    lat, lng, radius,
  };
}

/** 经纬度 → 本地米制（x 东 / z 南） */
export function project(lat, lng, origin) {
  return {
    x: (lng - origin.lng) * M_PER_DEG_LNG * Math.cos((origin.lat * Math.PI) / 180),
    z: -(lat - origin.lat) * M_PER_DEG_LAT,
  };
}

/** Overpass QL：取建筑/道路/水系/绿地/树。out body geom 会把几何直接带回来，省一次解析。 */
export function overpassQuery(bbox, timeout = 60) {
  const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  // ★ 2026-11-10：**要全** —— 用户："真实里面楼栋数是多少给多少，有哪些就给哪些"。
  //   之前漏掉的形态（实测上海黄浦区）：
  //     · relation["building"]      → 多边形建筑（带内院/异形）
  //     · relation["waterway"]      → **黄浦江**是 relation，漏了就整条江没有
  //     · way["natural"="tree_row"] → 行道树（node tree 在国内几乎没有）
  //     · relation["landuse"]       → 大块绿地
  return `[out:json][timeout:${timeout}];
(
  way["building"](${b});
  relation["building"](${b});
  way["building:part"](${b});
  way["highway"](${b});
  way["waterway"](${b});
  relation["waterway"](${b});
  way["natural"="water"](${b});
  relation["natural"="water"](${b});
  way["landuse"](${b});
  relation["landuse"](${b});
  way["leisure"](${b});
  way["natural"="tree_row"](${b});
  node["natural"="tree"](${b});
);
out body geom;`;
}

/* ── 语义 → 高度 / 颜色 ────────────────────────────────────────────────────
 * 这是 OSM 相对"几何启发式"的最大优势：数据自带语义，不用猜。
 * （对比：11-01 那次 .max 场景 3244 个物体材质 99.2% 纯白，只能按尺寸瞎猜） */

const BUILDING_HEIGHT = {
  house: 6, detached: 7, residential: 12, apartments: 18, terrace: 9,
  commercial: 14, retail: 9, office: 24, industrial: 11, warehouse: 9,
  church: 16, cathedral: 30, chapel: 10, temple: 14, mosque: 16, shrine: 8,
  school: 11, university: 15, hospital: 18, hotel: 26,
  garage: 3, garages: 3, shed: 3, hut: 3, roof: 4, carport: 3,
  bridge: 8, train_station: 14, stadium: 20, hangar: 14,
};

const BUILDING_COLOR = {
  house: 0xe8e1d2, detached: 0xe6dfd0, residential: 0xdedad1, terrace: 0xe2dccd,
  apartments: 0xd7d9dd, commercial: 0xd2d6dc, retail: 0xd4d7da, office: 0xcdd2da,
  industrial: 0xcfd0c8, warehouse: 0xd2d3cb, garage: 0xd8d5cc, garages: 0xd8d5cc,
  shed: 0xd9d6cd, hut: 0xd9d6cd, roof: 0xd6d3ca, carport: 0xd6d3ca,
  church: 0xe3d9c4, cathedral: 0xe3d9c4, chapel: 0xe3d9c4, temple: 0xe0d6c2,
  mosque: 0xe2d8c6, shrine: 0xe4dbc9,
  school: 0xdadbc9, university: 0xd6d8c6, hospital: 0xdcdfe2, hotel: 0xd3d7dd,
  bridge: 0xcdd0d4, train_station: 0xd5d7d2, stadium: 0xd0d4d8, hangar: 0xd2d4cd,
};
const BUILDING_FALLBACK_COLOR = 0xd9d6cd;

const ROAD_WIDTH = {
  motorway: 22, motorway_link: 8, trunk: 18, trunk_link: 8,
  primary: 14, primary_link: 6, secondary: 12, secondary_link: 6,
  tertiary: 10, tertiary_link: 5, residential: 7, unclassified: 6,
  living_street: 6, service: 4, pedestrian: 6, footway: 2.5, path: 2,
  cycleway: 2.5, steps: 2.5, track: 3, bridleway: 2,
};
const ROAD_COLOR = {
  motorway: 0xa8a8ac, trunk: 0xacacb0, primary: 0xb0b0b4,
  secondary: 0xb6b6ba, tertiary: 0xbababe, residential: 0xc0c0c4,
  unclassified: 0xc2c2c6, service: 0xc6c6c8, living_street: 0xc4c2bc,
  pedestrian: 0xd0cec8, footway: 0xd2d0ca, path: 0xd0cec6, cycleway: 0xccd2cc,
  steps: 0xd0cec8, track: 0xc8c4b8, bridleway: 0xcac6ba,
};
const WATER_COLOR = 0x9fb8c8;
const GREEN_COLOR = 0xbcc7a8;

/** ★ 2026-11-10：线状水体的**宽度**（米）。
 *   黄浦江在黄浦区段实测宽约 300~400m，运河 20~40m，小溪 5~10m。 */
const WATER_WIDTH = {
  river: 260, riverbank: 0, canal: 30, stream: 8, ditch: 4, drain: 4, lock_gate: 0,
};

/**
 * ★ 2026-11-10：把一条**折线**加宽成一个闭合的带状多边形。
 *
 * 用法：线状水体（`waterway=river` 的黄浦江）在 OSM 里没有面，
 *   要显示成江面就得自己给它宽度。
 *
 * @param {Array<{x,z}>} pts 折线
 * @param {number} width 宽度（米）
 * @returns {Array<{x,z}>} 闭合多边形
 */
export function ribbonRing(pts, width) {
  if (!pts || pts.length < 2 || !(width > 0)) return [];
  const half = width / 2;
  const left = [], right = [];
  let prev = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    // ★ 2026-11-10：**长线要断开**。
    //   OSM 的 relation 成员可能包含很远的点（实测黄浦江的 relation 成员
    //   一口气跨了几十公里）⇒ 一条带子横跨全场 ⇒ 水面几何跑到 -80km。
    //   遇到跳跃（> 2km）就断开，另起一条带。
    if (prev && Math.hypot(p.x - prev.x, p.z - prev.z) > 2000) {
      const seg = finishBand(left, right);
      if (seg.length >= 4) return seg;      // 只取第一段（其余段各自成面）
      left.length = 0; right.length = 0;
    }
    // 切线方向（前后邻点）
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    // 法向
    const nx = -dz, nz = dx;
    left.push({ x: p.x + nx * half, z: p.z + nz * half });
    right.push({ x: p.x - nx * half, z: p.z - nz * half });
    prev = p;
  }
  return finishBand(left, right);
}

/** 把左右两条边合成一个闭合多边形 */
function finishBand(left, right) {
  if (left.length < 2) return [];
  const ring = [...left, ...right.slice().reverse()];
  ring.push({ x: ring[0].x, z: ring[0].z });
  return ring;
}

/** 楼高：height > building:levels×3 > 类型默认 */
export function inferBuildingHeight(tags = {}) {
  const h = parseFloat(tags.height);
  if (Number.isFinite(h) && h > 0) return Math.min(320, h);
  const lv = parseFloat(tags['building:levels'] || tags.levels);
  if (Number.isFinite(lv) && lv > 0) return Math.min(320, lv * 3.0);
  const t = tags.building;
  if (t && t !== 'yes' && BUILDING_HEIGHT[t]) return BUILDING_HEIGHT[t];
  return 8;
}

/**
 * ★ 2026-11-10：**按占地面积**推层数（当 OSM 没给高度/层数时）。
 *
 * 为什么需要（用户："按真实的来"）：
 *   上海/国内绝大多数建筑在 OSM 里只有 `building=yes`，没有 height / levels
 *   ⇒ 全部落到默认 8m ⇒ 一片**平房盒子**，跟真实的密集多层完全不像。
 *
 * 经验规律（国内城市）：
 *   < 150 m²   → 里弄 / 附属房      2~3 层  → 7~11m
 *   < 400 m²   → 多层住宅          4~6 层  → 13~20m
 *   < 1200 m²  → 板楼 / 小区楼栋    6~12 层 → 20~36m
 *   < 4000 m²  → 写字楼 / 商业楼    10~24 层→ 30~72m
 *   ≥ 4000 m²  → 超高层 / 塔楼      20~60 层→ 60~180m
 *
 * @param {number} area 占地面积（m²）
 * @param {object} tags OSM tags（有明确类型时优先用类型表）
 * @returns {number} 建筑高度（米）
 */
export function inferHeightByArea(area, tags = {}) {
  const h = parseFloat(tags.height);
  if (Number.isFinite(h) && h > 0) return Math.min(320, h);
  const lv = parseFloat(tags['building:levels'] || tags.levels);
  if (Number.isFinite(lv) && lv > 0) return Math.min(320, lv * 3.0);
  const t = tags.building;
  if (t && t !== 'yes' && BUILDING_HEIGHT[t]) return BUILDING_HEIGHT[t];
  const a = Math.max(0, Number(area) || 0);
  if (a < 150) return 7 + (a % 5);              // 7~11
  if (a < 400) return 13 + (a % 8);             // 13~20
  if (a < 1200) return 20 + (a % 17);           // 20~36
  if (a < 4000) return 30 + (a % 43);           // 30~72
  return 60 + Math.min(120, Math.floor((a - 4000) / 120));  // 60~180
}

export function buildingColor(tags = {}) {
  const t = tags.building;
  if (t && BUILDING_COLOR[t]) return BUILDING_COLOR[t];
  if (tags.amenity === 'school' || tags.amenity === 'university') return 0xdadbc9;
  if (tags.amenity === 'hospital') return 0xdcdfe2;
  if (tags.tourism) return 0xd5d7dd;
  return BUILDING_FALLBACK_COLOR;
}

export function roadWidth(tags = {}) {
  const t = tags.highway;
  if (t && ROAD_WIDTH[t]) return ROAD_WIDTH[t];
  return 5;
}

export function roadColor(tags = {}) {
  const t = tags.highway;
  if (t && ROAD_COLOR[t]) return ROAD_COLOR[t];
  return 0xbcbcc0;
}

/** 这个 way 算不算绿地 */
export function isGreen(tags = {}) {
  const lu = tags.landuse;
  const le = tags.leisure;
  const nat = tags.natural;
  if (lu === 'grass' || lu === 'forest' || lu === 'meadow' || lu === 'orchard' ||
      lu === 'village_green' || lu === 'recreation_ground' || lu === 'cemetery' ||
      lu === 'farmland' || lu === 'allotments') return true;
  if (le === 'park' || le === 'garden' || le === 'pitch' || le === 'golf_course' ||
      le === 'nature_reserve' || le === 'playground') return true;
  if (nat === 'wood' || nat === 'scrub' || nat === 'grassland' || nat === 'heath') return true;
  return false;
}

/** 这个 way 算不算水面 */
export function isWater(tags = {}) {
  // ★ 2026-11-10：**线状水体也要算水**。
  //   黄浦江在 OSM 里是 `waterway=river` 的线（不是 `riverbank` 的面），
  //   之前不认 ⇒ 整条江被跳过（实测：画面里找不到黄浦江）。
  //   这些线会在下面被**加宽成带状面**（见 WATER_WIDTH / ribbonRing）。
  return tags.natural === 'water' || tags.waterway === 'riverbank' ||
    tags.waterway === 'river' || tags.waterway === 'canal' ||
    tags.waterway === 'stream' || tags.waterway === 'ditch' || tags.waterway === 'drain' ||
    tags.water === 'lake' || tags.water === 'pond' || tags.water === 'river' ||
    tags.water === 'reservoir' || tags.water === 'canal' || tags.water === 'stream' ||
    tags.landuse === 'reservoir' || tags.landuse === 'basin';
}

/** 多边形去重并闭合（Overpass 的 geom 首尾通常已闭合，但别假设） */
export function closeRing(pts) {
  if (!pts || pts.length < 3) return [];
  const out = pts.map((p) => ({ x: p.x, z: p.z }));
  const a = out[0], b = out[out.length - 1];
  if (Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.z - b.z) > 1e-6) out.push({ x: a.x, z: a.z });
  return out;
}

/** 多边形有向面积（判断绕向；挤出侧墙要靠它保证法线朝外） */
export function signedArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    s += ring[i].x * ring[i + 1].z - ring[i + 1].x * ring[i].z;
  }
  return s / 2;
}

/** 包围盒（给相机取景 / 体量统计用） */
export function boundsOf(items) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxH = 0;
  const take = (x, z) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  };
  for (const it of items) {
    if (it.ring) for (const p of it.ring) take(p.x, p.z);
    if (it.path) for (const p of it.path) take(p.x, p.z);
    if (it.point) take(it.point.x, it.point.z);
    if (it.height > maxH) maxH = it.height;
  }
  if (!Number.isFinite(minX)) return { minX: -1, maxX: 1, minZ: -1, maxZ: 1, maxH: 0 };
  return { minX, maxX, minZ, maxZ, maxH };
}

/**
 * Overpass 原始 JSON → 本地米制世界。
 * @param {object} raw   Overpass 的 { elements: [...] }
 * @param {object} origin {lat, lng}
 * @param {object} opts  { maxBuildings, maxRoads, simplify }
 */
export function normalizeOsm(raw, origin, opts = {}) {
  // ★ 2026-11-10：上限**大幅提高** —— 用户要"真实里面楼栋数是多少给多少"。
  //   之前 4000 栋 / 2500 条路的上限，在 R=2500m 的上海黄浦区会**截断**
  //   （实测原始 Overpass 返回 7992 栋，我们只留 4000 ⇒ 丢了一半）。
  const maxBuildings = opts.maxBuildings ?? 30000;
  const maxRoads = opts.maxRoads ?? 30000;
  const maxTrees = opts.maxTrees ?? 8000;

  const buildings = [];
  const roads = [];
  const waters = [];
  const greens = [];
  const trees = [];
  let skipped = 0;

  const els = (raw && raw.elements) || [];

  // ★ 2026-11-10：**按查询 bbox 裁剪**（不能用 raw 里数据自己的范围！
  //   Overpass 对 relation 会返回**完整的成员几何**（哪怕远超 bbox）：
  //   实测黄浦江 relation（19289628）的成员从 -80km 一直延伸到 +30km。
  //   ⇒ 越界的点不参与几何，否则生成的江面横跨全场、把场景带偏。
  const bbox = opts.bbox;
  const inGeo = bbox
    ? (lat, lon) => !(lat < bbox.south || lat > bbox.north || lon < bbox.west || lon > bbox.east)
    : () => true;

  for (const el of els) {
    const tags = el.tags || {};

    // ── 树（node）
    if (el.type === 'node') {
      if (tags.natural === 'tree' && el.lat != null && trees.length < maxTrees) {
        const p = project(el.lat, el.lon, origin);
        trees.push({ point: p, height: 3 + ((el.id % 7) * 0.4), radius: 1.6 + (el.id % 5) * 0.25 });
      }
      continue;
    }

    if (el.type === 'relation') {
      // ★ 2026-11-10：**多边形建筑**（relation）。
      //   超密集城区（上海/北京/香港）大量建筑是 `relation` + `type=multipolygon`
      //   （带内院、异形轮廓），只查 way 会漏掉一大半。
      //   ★ 多个 outer = 多个独立建筑（实测上海有 outer+outer 的 relation），
      //     必须**拆开**建，不能连成一个怪形状。
      if (!Array.isArray(el.members)) continue;
      const outerGroups = [];
      const lineGroups = [];
      let cur = null;
      for (const m of el.members) {
        if (!m || !Array.isArray(m.geometry) || m.geometry.length < 2) continue;
        if (m.role === 'outer' || !m.role) {
          cur = [];
          outerGroups.push(cur);
        } else {
          // ★ 线状成员（黄浦江 relation 的 role 通常是 '' 或 'riverbank' 的 way 线）
          if (m.role === 'riverbank' || m.role === 'water' || m.role === 'river') {
            cur = [];
            lineGroups.push(cur);
          } else {
            continue;
          }
        }
        for (const g of m.geometry) {
          // ★ 越界的点直接丢掉（relation 成员可能横跨几十公里）
          if (!inGeo(g.lat, g.lon)) continue;
          const p = project(g.lat, g.lon, origin);
          const last = cur[cur.length - 1];
          if (!last || Math.abs(last.x - p.x) > 1e-6 || Math.abs(last.z - p.z) > 1e-6) cur.push(p);
        }
      }
      // ★ 线状水体成员 ⇒ 加宽成带（黄浦江在 OSM 里是 relation + 线）
      if (lineGroups.length && isWater(tags)) {
        const width = WATER_WIDTH[tags.waterway] || 200;
        for (const grp of lineGroups) {
          const band = ribbonRing(grp, width);
          if (band.length >= 4) {
            waters.push({ ring: band, color: WATER_COLOR, kind: tags.water || tags.waterway || 'water', via: 'relation-line' });
          }
        }
      }
      if (!outerGroups.length) continue;
      const rings = [];
      for (const grp of outerGroups) {
        if (grp.length < 3) continue;
        const mring = closeRing(grp);
        if (mring.length >= 4) rings.push(mring);
      }
      if (!rings.length) continue;

      // ── 建筑
      if (tags.building) {
        for (const mring of rings) {
          if (buildings.length >= maxBuildings) { skipped++; continue; }
          const area = Math.abs(signedArea(mring));
          buildings.push({
            ring: mring,
            // ★ 按占地面积推高度（没有 height/levels 时）—— 真实还原度
            height: inferHeightByArea(area, tags),
            color: buildingColor(tags),
            kind: tags.building,
            name: tags.name || null,
            area,
            via: 'relation',
          });
        }
        continue;
      }
      // ── 水面（**黄浦江就是 relation waterway** —— 之前整条江都没有）
      if (isWater(tags)) {
        for (const mring of rings) {
          waters.push({ ring: mring, color: WATER_COLOR, kind: tags.water || tags.waterway || tags.natural || 'water', via: 'relation' });
        }
        continue;
      }
      // ── 绿地
      if (isGreen(tags)) {
        for (const mring of rings) {
          greens.push({ ring: mring, color: GREEN_COLOR, kind: tags.landuse || tags.leisure || tags.natural, via: 'relation' });
        }
        continue;
      }
      // ── 道路（relation highway：环路/高架的整段）
      if (tags.highway) {
        for (const grp of outerGroups) {
          if (grp.length < 2) continue;
          if (roads.length >= maxRoads) { skipped++; continue; }
          roads.push({
            path: grp, width: roadWidth(tags), color: roadColor(tags),
            kind: tags.highway, name: tags.name || null, via: 'relation',
          });
        }
        continue;
      }
      continue;
    }

    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    // ★ 越界的点丢掉（way 也可能超出 bbox 很多）
    const pts = el.geometry.filter((g) => inGeo(g.lat, g.lon)).map((g) => project(g.lat, g.lon, origin));

    // ── 建筑
    if (tags.building) {
      if (buildings.length >= maxBuildings) { skipped++; continue; }
      const ring = closeRing(pts);
      if (ring.length < 4) { skipped++; continue; }
      const area = Math.abs(signedArea(ring));
      buildings.push({
        ring,
        // ★ 按占地面积推高度（没有 height/levels 时）—— 真实还原度
        height: inferHeightByArea(area, tags),
        color: buildingColor(tags),
        kind: tags.building,
        name: tags.name || null,
        area,
      });
      continue;
    }

    // ── 水面
    if (isWater(tags)) {
      // ★ 2026-11-10：**线状水体要加宽成面**。
      //   黄浦江在 OSM 里是 `waterway=river` 的**线**（实测 relation 19289628
      //   和 way 47088277 都是线），不是面 ⇒ 直接三角化会被丢掉 ⇒
      //   整条江在画面里消失（实测：waters=50 却看不到黄浦江）。
      //   真实江面是有宽度的 ⇒ 按水系等级加宽成带状多边形。
      const width = WATER_WIDTH[tags.waterway] || (tags.natural === 'water' ? 0 : 40);
      const closed = pts.length > 2
        && Math.abs(pts[0].x - pts[pts.length - 1].x) < 1e-6
        && Math.abs(pts[0].z - pts[pts.length - 1].z) < 1e-6;
      if (!closed && width > 0) {
        const band = ribbonRing(pts, width);
        if (band.length >= 4) {
          waters.push({ ring: band, color: WATER_COLOR, kind: tags.water || tags.waterway || 'water', via: 'line' });
        }
        continue;
      }
      const ring = closeRing(pts);
      if (ring.length >= 4) waters.push({ ring, color: WATER_COLOR, kind: tags.water || tags.waterway || 'water' });
      continue;
    }

    // ── 行道树（node tree 在国内几乎没有，tree_row 才是行道树）
    if (tags.natural === 'tree_row') {
      // 沿路径按 12 米一棵撒点
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const seg = Math.hypot(b.x - a.x, b.z - a.z);
        if (seg < 0.01) continue;
        const n = Math.max(1, Math.round(seg / 12));
        for (let k = 0; k < n; k++) {
          if (trees.length >= maxTrees) break;
          const t = (k + 0.5) / n;
          trees.push({
            point: { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t },
            height: 4.2 + ((i + k) % 5) * 0.3,
            radius: 1.5 + ((i + k) % 4) * 0.2,
          });
        }
        acc += seg;
      }
      continue;
    }

    // ── 绿地
    if (isGreen(tags)) {
      const ring = closeRing(pts);
      if (ring.length >= 4) {
        greens.push({ ring, color: GREEN_COLOR, kind: tags.landuse || tags.leisure || tags.natural });
      }
      continue;
    }

    // ── 道路
    if (tags.highway) {
      if (roads.length >= maxRoads) { skipped++; continue; }
      roads.push({
        path: pts,
        width: roadWidth(tags),
        color: roadColor(tags),
        kind: tags.highway,
        name: tags.name || null,
      });
    }
  }

  const all = [...buildings, ...roads, ...waters, ...greens, ...trees];
  const b = boundsOf(all);
  // ★ 2026-11-10：**地块范围**（不含远郊道路）。
  //   bounds 会把通向远方的快速路/高速也算进去 ⇒ 上海黄浦区实测 ±7950m，
  //   而建筑群只有 ±2700m ⇒ 地形网格被撑到 15km 见方，
  //   边缘全是"用边缘值延伸出来的假平地"（实测画面边缘一大片空白）。
  //   地形应该按**城市本体**（建筑+水+绿地）来定。
  const cityAll = [...buildings, ...waters, ...greens];
  const cb = cityAll.length ? boundsOf(cityAll) : b;

  return {
    kind: 'osm',
    origin: { lat: origin.lat, lng: origin.lng },
    attribution: OSM_ATTRIBUTION,
    buildings, roads, waters, greens, trees,
    bounds: b,
    cityBounds: cb,
    size: Math.max(b.maxX - b.minX, b.maxZ - b.minZ, 1),
    citySize: Math.max(cb.maxX - cb.minX, cb.maxZ - cb.minZ, 1),
    stats: {
      buildings: buildings.length,
      roads: roads.length,
      waters: waters.length,
      greens: greens.length,
      trees: trees.length,
      skipped,
      tallest: +b.maxH.toFixed(1),
      elements: els.length,
    },
  };
}
