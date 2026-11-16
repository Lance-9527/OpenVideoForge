#!/usr/bin/env node
/* 续探：1) osm.de 简单查询  2) OpenFreeMap 路径  3) Protomaps pmtiles range  4) 其他矢量源 */
const UA = { 'User-Agent': 'OpenVideoForge/1.0' };

console.log('--- 1) osm.de 用最轻的查询（out count）---');
for (let i = 0; i < 3; i++) {
  const t0 = Date.now();
  try {
    const q = '[out:json][timeout:120];way["building"](35.0,135.76,35.02,135.78);out count;';
    const r = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST', headers: { ...UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(q), signal: AbortSignal.timeout(60000),
    });
    const t = await r.text();
    console.log(`  试${i + 1}: HTTP ${r.status} ${Date.now() - t0}ms ${t.slice(0, 160).replace(/\n/g, ' ')}`);
    if (r.ok) break;
  } catch (e) { console.log(`  试${i + 1}: ERR ${(e.cause && e.cause.code) || e.name} ${Date.now() - t0}ms`); }
}

console.log('\n--- 2) OpenFreeMap 各种路径 ---');
const ofm = [
  'https://tiles.openfreemap.org/planet/14/14370/6489.pbf',
  'https://tiles.openfreemap.org/planet/14/14370/6489',
  'https://tiles.openfreemap.org/planet',
  'https://tiles.openfreemap.org/objects/14/14370/6489.pbf',
  'https://api.openfreemap.org/planet/14/14370/6489.pbf',
];
for (const u of ofm) {
  const t0 = Date.now();
  try {
    const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(15000) });
    const b = Buffer.from(await r.arrayBuffer());
    console.log(`  ${u.replace('https://', '').padEnd(46)} HTTP ${r.status} ${String(b.length).padStart(7)}B ${Date.now() - t0}ms ${b.subarray(0, 12).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}`);
  } catch (e) { console.log(`  ${u.replace('https://', '').padEnd(46)} ERR ${(e.cause && e.cause.code) || e.name}`); }
}

console.log('\n--- 3) Protomaps pmtiles（Range 请求，planet 全量）---');
const pm = [
  ['protomaps-demo', 'https://demo-bucket.protomaps.com/v4.pmtiles'],
  ['pmtiles-io', 'https://pmtiles.io/protomaps(vector)ODbL_v4.pmtiles'],
];
for (const [n, u] of pm) {
  const t0 = Date.now();
  try {
    const r = await fetch(u, { headers: { ...UA, Range: 'bytes=0-1023' }, signal: AbortSignal.timeout(20000) });
    const b = Buffer.from(await r.arrayBuffer());
    console.log(`  ${n.padEnd(16)} HTTP ${r.status} ${b.length}B ${Date.now() - t0}ms cr=${r.headers.get('content-range')} magic=${b.subarray(0, 16).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}`);
  } catch (e) { console.log(`  ${n.padEnd(16)} ERR ${(e.cause && e.cause.code) || e.name}`); }
}

console.log('\n--- 4) 其它能通的数据源（瓦片图 = 至少能出真实街区底图）---');
const tiles = [
  ['osm-de-a', 'https://a.tile.openstreetmap.de/14/14370/6489.png'],
  ['osm-de-b', 'https://b.tile.openstreetmap.de/14/14370/6489.png'],
  ['osm-fr', 'https://a.tile.openstreetmap.fr/osmfr/14/14370/6489.png'],
  ['carto-db', 'https://basemaps.cartocdn.com/dark_all/14/14370/6489.png'],
  ['esri-topo', 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/14/6489/14370'],
];
for (const [n, u] of tiles) {
  const t0 = Date.now();
  try {
    const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(15000) });
    const b = Buffer.from(await r.arrayBuffer());
    console.log(`  ${n.padEnd(12)} HTTP ${r.status} ${String(b.length).padStart(7)}B ${Date.now() - t0}ms`);
  } catch (e) { console.log(`  ${n.padEnd(12)} ERR ${(e.cause && e.cause.code) || e.name}`); }
}
