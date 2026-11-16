#!/usr/bin/env node
/* 直接测 server/geocode.mjs */
import { defaultOutDir } from '../server/paths.mjs';
import { geocodeCity, searchLocal, cityTable, geocodeNominatim } from '../server/geocode.mjs';
const OUT = defaultOutDir();
console.log('本地表城市数:', cityTable().length);
for (const q of ['Kyoto', 'Berlin', '雷克雅未克', '北京', 'Paris', 'Reykjavik']) {
  const t0 = Date.now();
  try {
    const r = await geocodeCity(q, OUT);
    console.log(`  ${q.padEnd(12)} ${Date.now() - t0}ms  ok=${r.ok}  ${r.ok ? JSON.stringify(r.city) : r.error}`);
  } catch (e) {
    console.log(`  ${q.padEnd(12)} ${Date.now() - t0}ms  THROW ${e.name}: ${e.message}`);
  }
}
console.log('\n--- 直接调 geocodeNominatim（看 Photon 细节）---');
const h = await geocodeNominatim('Kyoto', OUT);
console.log('  ', JSON.stringify(h));
