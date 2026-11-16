/**
 * io.mjs — cities.json 读写（固定 4 位小数的 lat/lng）
 */
import fs from 'node:fs';
import path from 'node:path';

const q = (s) => JSON.stringify(s);

/** 序列化为 JSON 文本，lat/lng 固定 4 位小数 */
export function serialize(cities, version = 1) {
  const lines = [];
  lines.push('{');
  lines.push(`  "version": ${version},`);
  lines.push('  "cities": [');
  cities.forEach((c, i) => {
    const body =
      `{ "id": ${q(c.id)}, "name": ${q(c.name)}, "en": ${q(c.en)}, ` +
      `"country": ${q(c.country)}, "lat": ${Number(c.lat).toFixed(4)}, ` +
      `"lng": ${Number(c.lng).toFixed(4)}, ` +
      `"aliases": [${(c.aliases || []).map(q).join(', ')}] }`;
    lines.push('    ' + body + (i === cities.length - 1 ? '' : ','));
  });
  lines.push('  ]');
  lines.push('}');
  return lines.join('\n') + '\n';
}

/** 写入并回读校验 */
export function writeCities(cities, outPath, version = 1) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, serialize(cities, version), 'utf8');
  const back = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  if (back.version !== version || back.cities.length !== cities.length) {
    throw new Error('回读校验失败');
  }
  return outPath;
}

export function loadCities(inPath) {
  const doc = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  if (doc.version !== 1 || !Array.isArray(doc.cities)) throw new Error('cities.json 结构异常');
  return doc.cities;
}

/** haversine 距离（km） */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371.0088; // WGS84 平均地球半径 (km)
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
