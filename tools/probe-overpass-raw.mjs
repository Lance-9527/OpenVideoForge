#!/usr/bin/env node
/* ============================================================================
 * tools/probe-overpass-raw.mjs —— ★ 直接问 Overpass 要原始数据，对比我们的解析结果
 *
 * 目的（2026-11-10，用户："真实里面楼栋数是多少给多少，有哪些就给哪些"）：
 *   ① 我们抓到 805 栋 / waters=0 / trees=0 —— 是**查询不全**还是**被上限截断**？
 *   ② 逐类统计原始 elements，找出我们丢掉的东西
 * ========================================================================== */
import fs from 'node:fs';

const LAT = 31.2336, LNG = 121.4799, R = 600;
const mPerDegLat = 111320;
const mPerDegLng = 111320 * Math.cos((LAT * Math.PI) / 180);
const dLat = R / mPerDegLat, dLng = R / mPerDegLng;
const bbox = { south: LAT - dLat, west: LNG - dLng, north: LAT + dLat, east: LNG + dLng };
const b = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;

const QUERIES = {
  '当前用的（way+relation building / highway / waterway / natural=water / landuse / leisure / tree）': `
  (
    way["building"](${b});
    relation["building"](${b});
    way["highway"](${b});
    way["waterway"](${b});
    way["natural"="water"](${b});
    way["landuse"](${b});
    way["leisure"](${b});
    node["natural"="tree"](${b});
  );
  out body geom;`,
  'A: 只看 building 的所有形态': `
  (
    way["building"](${b});
    relation["building"](${b});
    way["building:part"](${b});
    relation["building:part"](${b});
  );
  out body geom;`,
  'B: 水系全部形态': `
  (
    way["waterway"](${b});
    relation["waterway"](${b});
    way["natural"="water"](${b});
    relation["natural"="water"](${b});
    way["water"="river"](${b});
    relation["water"="river"](${b});
  );
  out body geom;`,
  'C: 树 + 绿地': `
  (
    node["natural"="tree"](${b});
    way["natural"="tree_row"](${b});
    way["landuse"~"forest|grass|meadow|village_green|recreation_ground"](${b});
    relation["landuse"](${b});
    way["leisure"~"park|garden|pitch"](${b});
  );
  out body geom;`,
};

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.osm.ch/api/interpreter'];

for (const [name, q] of Object.entries(QUERIES)) {
  console.log('\n════ ' + name + ' ════');
  let got = null;
  for (const ep of ENDPOINTS) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 180000);
      const r = await fetch(ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'OpenVideoForge/1.0 (local test)' },
        body: 'data=' + encodeURIComponent(`[out:json][timeout:180];${q}`),
        signal: ctl.signal,
      });
      clearTimeout(t);
      if (!r.ok) { console.log('  ', ep, '→ HTTP', r.status); continue; }
      const j = await r.json();
      got = { ep, j };
      console.log('  端点:', ep, ' 用时正常');
      break;
    } catch (e) { console.log('  ', ep, '→ ', String(e.message).slice(0, 70)); }
  }
  if (!got) { console.log('  全部端点失败'); continue; }
  const els = got.j.elements || [];
  const byType = {};
  const byTag = {};
  for (const el of els) {
    byType[el.type] = (byType[el.type] || 0) + 1;
    const t = el.tags || {};
    const key = t.building ? 'building=' + (t.building === 'yes' ? 'yes' : String(t.building).slice(0, 12))
      : t.waterway ? 'waterway=' + String(t.waterway).slice(0, 14)
        : t.natural ? 'natural=' + t.natural
          : t.landuse ? 'landuse=' + t.landuse
            : t.leisure ? 'leisure=' + t.leisure
              : t.highway ? 'highway=' + String(t.highway).slice(0, 12)
                : Object.keys(t).slice(0, 2).join(',') || '(无 tag)';
    byTag[key] = (byTag[key] || 0) + 1;
  }
  console.log('  总 elements:', els.length);
  console.log('  按类型:', JSON.stringify(byType));
  const top = Object.entries(byTag).sort((a, b) => b[1] - a[1]).slice(0, 14);
  console.log('  按 tag（前14）:');
  for (const [k, v] of top) console.log('    ', String(v).padStart(6), k);
  fs.writeFileSync(`${defaultShotsDir()}\\overpass-` + name.slice(0, 12).replace(/[^\w一-龥]/g, '_') + '.json',
    JSON.stringify(got.j), 'utf8');
}
