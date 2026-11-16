import { despike, clipOutliers } from '../js/worldgen/terrain-grid.js';
let pass = 0, fail = 0;
const ok = (n, c, e) => { if (c) { pass++; console.log('  ✓', n); } else { fail++; console.log('  ✗', n, e === undefined ? '' : '→ ' + JSON.stringify(e)); } };

const n = 8;
const v = new Array(n * n).fill(8);
for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) v[j * n + i] = 59;
const c1 = clipOutliers({ size: n, step: 10, minX: 0, minZ: 0, values: v }, {});
ok('★ 区域性噪声被裁到 p95', c1.values[0] === 8, c1.values[0]);
ok('★ 记了裁了几个', c1.clipped === 4, c1.clipped);

const v2 = new Array(n * n).fill(8);
for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) v2[j * n + i] = 800;
const c2 = clipOutliers({ size: n, step: 10, minX: 0, minZ: 0, values: v2 }, {});
ok('★ 真山不被裁', c2.values[0] === 800, { a:c2.values[0], clipped:c2.clipped });

const v3 = new Array(n * n).fill(8);
for (let i = 0; i < 12; i++) v3[i] = 200;
const c3 = clipOutliers({ size: n, step: 10, minX: 0, minZ: 0, values: v3 }, {});
ok('★ 占比大就不裁', c3.values[0] === 200, c3.values[0]);

const v4 = new Array(n * n).fill(8); v4[3*n+3] = 59;
const d4 = despike({ size: n, step: 10, minX: 0, minZ: 0, values: v4 }, 12);
ok('★ despike 削孤立点', d4.values[3*n+3] === 8, d4.values[3*n+3]);

console.log(`\n${fail ? '✗' : '✓'} terrain-clean: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);