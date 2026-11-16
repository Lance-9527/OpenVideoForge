#!/usr/bin/env node
/* 探 Overpass 端点：全球覆盖 + 连通性（用京都 / 上海 / 柏林 三个非瑞士城市测） */
const q = (lat, lng) =>
  `[out:json][timeout:60];(way["building"](${lat - 0.01},${lng - 0.01},${lat + 0.01},${lng + 0.01});` +
  `way["highway"](${lat - 0.01},${lng - 0.01},${lat + 0.01},${lng + 0.01}););out geom;`;

const EPS = [
  ['osm.de', 'https://overpass-api.de/api/interpreter'],
  ['osm.ch', 'https://overpass.osm.ch/api/interpreter'],
  ['kumi', 'https://overpass.kumi.systems/api/interpreter'],
  ['osm.ru', 'https://overpass.openstreetmap.ru/api/interpreter'],
  ['osm.jp', 'https://overpass.osm.jp/api/interpreter'],
  ['coffee', 'https://overpass.private.coffee/api/interpreter'],
  ['lchc', 'https://overpass.osm.lchc.net/api/interpreter'],
  ['blackmap', 'https://overpass.blackmap.nl/api/interpreter'],
  ['mailru', 'https://overpass.mail.ru/api/interpreter'],
];

const CITIES = [['京都', 35.0116, 135.7681], ['上海', 31.2304, 121.4737], ['柏林', 52.52, 13.405]];

for (const [name, url] of EPS) {
  const line = [];
  let anyOk = false;
  for (const [city, lat, lng] of CITIES) {
    const t0 = Date.now();
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'User-Agent': 'OpenVideoForge/1.0', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q(lat, lng)),
        signal: AbortSignal.timeout(25000),
      });
      const t = await r.text();
      let n = -1;
      try { n = (JSON.parse(t).elements || []).length; } catch (_) { }
      anyOk = true;
      line.push(`${city}:${r.status}/${n}元素/${Date.now() - t0}ms`);
    } catch (e) {
      line.push(`${city}:ERR(${(e.cause && e.cause.code) || e.name})`);
    }
  }
  console.log(name.padEnd(11), line.join('  '), anyOk ? '' : '  ← 全不通');
}
