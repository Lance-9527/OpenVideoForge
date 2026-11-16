#!/usr/bin/env node
/* 找能拿到**全球建筑轮廓**的数据源 */
const lat = 35.0116, lng = 135.7681;   // 京都
const z = 14;
const n = 2 ** z;
const x = Math.floor((lng + 180) / 360 * n);
const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
console.log(`京都 z${z} 瓦片: ${x}/${y}`);

const EPS = [
  ['openfreemap', `https://tiles.openfreemap.org/planet/${z}/${x}/${y}.pbf`],
  ['osm-tile-png', `https://tile.openstreetmap.org/${z}/${x}/${y}.png`],
  ['osm-de-tile', `https://a.tile.openstreetmap.de/${z}/${x}/${y}.png`],
  ['carto', `https://basemaps.cartocdn.com/light_all/${z}/${x}/${y}.png`],
  ['esri', `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`],
  ['protomaps', `https://demo-bucket.protomaps.com/v4.pmtiles`],
  ['maplibre-demo', `https://demotiles.maplibre.org/tiles/${z}/${x}/${y}.pbf`],
];

for (const [name, u] of EPS) {
  const t0 = Date.now();
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'OpenVideoForge/1.0' }, signal: AbortSignal.timeout(20000) });
    const b = Buffer.from(await r.arrayBuffer());
    const magic = b.subarray(0, 4).toString('hex');
    console.log(`${name.padEnd(16)} HTTP ${r.status} ${String(b.length).padStart(8)}B ${Date.now() - t0}ms magic=${magic} ${b.subarray(0, 24).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}`);
  } catch (e) {
    console.log(`${name.padEnd(16)} ERR ${(e.cause && e.cause.code) || e.name} ${Date.now() - t0}ms`);
  }
}

// mail.ru 到底返回了什么
console.log('\n--- mail.ru 返回内容前 300 字节 ---');
try {
  const q = '[out:json][timeout:60];way["building"](35.0,135.76,35.02,135.78);out geom;';
  const r = await fetch('https://overpass.mail.ru/api/interpreter', {
    method: 'POST', headers: { 'User-Agent': 'OpenVideoForge/1.0', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(25000),
  });
  const t = await r.text();
  console.log('status', r.status, 'ctype', r.headers.get('content-type'));
  console.log(t.slice(0, 300));
} catch (e) { console.log('ERR', (e.cause && e.cause.code) || e.message); }
