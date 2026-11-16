#!/usr/bin/env node
/* 测不同半径的真实数据量与耗时（黄浦区全境约 4.5km × 4.5km） */
const LAT = 31.2336, LNG = 121.4799;
const mPerDegLat = 111320;
const mPerDegLng = 111320 * Math.cos((LAT * Math.PI) / 180);

for (const R of [600, 1200, 1800, 2500]) {
  const dLat = R / mPerDegLat, dLng = R / mPerDegLng;
  const b = `${LAT - dLat},${LNG - dLng},${LAT + dLat},${LNG + dLng}`;
  const q = `[out:json][timeout:300];
(
  way["building"](${b});
  relation["building"](${b});
  way["highway"](${b});
  way["waterway"](${b});
  relation["waterway"](${b});
  way["natural"="water"](${b});
  way["landuse"](${b});
  way["leisure"](${b});
  node["natural"="tree"](${b});
);
out body geom;`;
  const t0 = Date.now();
  let n = 0, types = {}, bytes = 0, water = 0, tree = 0;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 300000);
    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'OpenVideoForge/1.0' },
      body: 'data=' + encodeURIComponent(q),
      signal: ctl.signal,
    });
    clearTimeout(t);
    const j = await r.json();
    bytes = JSON.stringify(j).length;
    for (const el of (j.elements || [])) {
      types[el.type] = (types[el.type] || 0) + 1;
      const tg = el.tags || {};
      if (tg.building) n++;
      if (tg.waterway || tg.natural === 'water' || tg.water) water++;
      if (tg.natural === 'tree') tree++;
    }
    console.log(`R=${R}m  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s  建筑 ${n}  水 ${water} 树 ${tree}  elements ${(j.elements || []).length}  ${(bytes / 1048576).toFixed(1)}MB  ${JSON.stringify(types)}`);
  } catch (e) {
    console.log(`R=${R}m  ✗ ${String(e.message).slice(0, 80)}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
}
