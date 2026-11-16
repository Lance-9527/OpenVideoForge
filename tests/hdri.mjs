#!/usr/bin/env node
/* ==========================================================================
 * tests/hdri.mjs —— 本地 HDRI 素材库（server/hdri.mjs）
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { listHdri, hdriFilePath, hdriThumbPath, hdriDir, hdriIndex } from '../server/hdri.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
function group(t) { console.log('\n' + t); }

/* ── 造一个临时素材库 ─────────────────────────────────────────────────── */
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf-hdri-'));
const DIR = path.join(OUT, '素材库', 'HDRI');
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'sunny_1k.hdr'), Buffer.alloc(1024, 7));
fs.writeFileSync(path.join(DIR, 'sunny_1k.png'), Buffer.alloc(64, 9));
fs.writeFileSync(path.join(DIR, 'night_1k.hdr'), Buffer.alloc(2048, 3));
fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify({
  version: 1,
  source: 'Poly Haven (CC0)',
  items: [
    { id: 'sunny', slot: 'day-clear', slotLabel: '晴天正午', name: 'Sunny', file: 'sunny_1k.hdr', thumb: 'sunny_1k.png', bytes: 1024, authors: ['Tester'], license: 'CC0' },
    { id: 'night', slot: 'night', slotLabel: '夜晚', name: 'Night', file: 'night_1k.hdr', bytes: 2048, license: 'CC0' },
    { id: 'ghost', slot: 'x', name: '不存在', file: 'missing_1k.hdr', bytes: 0 },
  ],
}));

group('1. 目录与清单');
ok('目录在 素材库/HDRI 下', hdriDir(OUT).endsWith(path.join('素材库', 'HDRI')), hdriDir(OUT));
ok('索引能读', hdriIndex(OUT).items.length === 3);
ok('读不到索引时返回空壳', (() => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf-hdri-x-'));
  return hdriIndex(empty).items.length === 0;
})());

group('2. 列出');
const list = listHdri(OUT);
ok('只列存在的（ghost 被过滤）', list.length === 2, list.map((i) => i.id));
ok('带槽位标签', list[0].slotLabel === '晴天正午', list[0]);
ok('带作者与许可证', list[0].authors[0] === 'Tester' && list[0].license === 'CC0');
ok('带字节数', list[0].bytes === 1024 && list[1].bytes === 2048, list.map((i) => i.bytes));
ok('目录字段在', hdriDir(OUT).includes('HDRI'));

group('3. 取文件');
const f = hdriFilePath('sunny', OUT);
ok('能取到 .hdr', f.ok && f.path.endsWith('sunny_1k.hdr'), f);
ok('字节数对', f.bytes === 1024, f.bytes);
ok('带 .hdr 后缀也能取', hdriFilePath('sunny.hdr', OUT).ok);
ok('不存在的取不到', hdriFilePath('ghost', OUT).ok === false);
ok('空 id 被拒', hdriFilePath('', OUT).ok === false);

group('4. 路径安全');
for (const evil of ['../../etc/passwd', '..\\..\\windows\\system32', '/abs/path', 'a/../../b']) {
  const r = hdriFilePath(evil, OUT);
  ok('拒绝穿越：' + evil, r.ok === false || r.path.startsWith(path.resolve(DIR)), r);
}
ok('缩略图能取到', hdriThumbPath('sunny', OUT).ok);
ok('没有缩略图时报错', hdriThumbPath('night', OUT).ok === false);
const t2 = hdriThumbPath('../../secret', OUT);
ok('缩略图也防穿越', t2.ok === false || t2.path.startsWith(path.resolve(DIR)), t2);

group('5. 清理');
fs.rmSync(OUT, { recursive: true, force: true });
ok('临时目录已删', !fs.existsSync(OUT));

console.log(`\n${fail ? '✗' : '✓'} hdri: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
