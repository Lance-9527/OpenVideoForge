#!/usr/bin/env node
/* ============================================================================
 * tests/parts.mjs —— 模型**分件索引**（"精准 copy 某个地方的某个物体"）
 *
 * 用户的原话：
 *   「我们需要某个地方取景的时候，直接 copy 到咱们场景来就行」
 *   「甚至是需要某个地方的某个物体都可以直接**精准 copy**」
 *
 * 守两件事：
 *   ① 服务端能存/读分件清单，且**只留必要字段**（别把 index 撑爆）
 *   ② 分件清单里每个件都有名字/尺寸/位置 —— 不然 UI 上没法显示、也没法检索
 * ========================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { libraryAdd, librarySaveParts, libraryList } from '../server/library.mjs';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};
const group = (t) => console.log('\n' + t);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf-parts-'));

group('1. 存分件清单');
libraryAdd({ id: '教室', kind: 'model', category: 'prop', name: '教室' }, tmp);
const parts = [
  { i: 0, name: '黑板', size: [2.4, 1.2, 0.08], pos: [0, 1.6, -3.2], color: '#2f3b2c', tris: 24 },
  { i: 1, name: '课桌', size: [0.6, 0.75, 0.45], pos: [1.2, 0.38, 0], color: '#c9a97a', tris: 36 },
  { i: 2, name: '窗', size: [1.2, 1.4, 0.1], pos: [3, 1.8, -3.2], color: '#cfe3ef', tris: 8 },
];
const r = librarySaveParts('教室', parts, tmp);
ok('存成功', r.ok, r);
ok('分件数对', r.partCount === 3, r);

group('2. 读回来');
{
  const list = libraryList(tmp);
  const rec = list.items.find((i) => i.id === '教室');
  ok('条目在', !!rec);
  ok('★ parts 字段在', Array.isArray(rec.parts) && rec.parts.length === 3, rec && rec.parts);
  ok('partCount 在', rec.partCount === 3, rec && rec.partCount);
  const p0 = rec.parts[0];
  ok('★ 每个件有名字', typeof p0.name === 'string' && p0.name.length > 0, p0);
  ok('★ 每个件有尺寸', Array.isArray(p0.size) && p0.size.length === 3, p0);
  ok('★ 每个件有位置', Array.isArray(p0.pos) && p0.pos.length === 3, p0);
  ok('名字没被改坏', rec.parts[0].name === '黑板', rec.parts[0]);
}

group('3. 脏数据要挡掉');
{
  const bad = librarySaveParts('教室', '不是数组', tmp);
  ok('parts 不是数组要报错', bad.ok === false, bad);
  const ghost = librarySaveParts('没有这条', [], tmp);
  ok('给不存在的条目存要报错', ghost.ok === false, ghost);
  // 缺字段的件要补默认值，不能炸
  const partial = librarySaveParts('教室', [{ name: '只有名字' }, { size: [1], pos: ['x'] }], tmp);
  ok('字段缺失不炸（有默认值）', partial.ok, partial);
  const list2 = libraryList(tmp);
  const rec2 = list2.items.find((i) => i.id === '教室');
  ok('★ 缺的字段补上了默认值', rec2.parts[0].size.length === 3 && rec2.parts[0].pos.length === 3, rec2.parts[0]);
}

group('4. 上限保护');
{
  const many = Array.from({ length: 5000 }, (_, i) => ({ i, name: '件' + i, size: [1, 1, 1], pos: [0, 0, 0] }));
  const r2 = librarySaveParts('教室', many, tmp);
  ok('超量截断而不是全存', r2.partCount <= 2000, r2.partCount);
}

group('5. 名字不能撑爆索引');
{
  const long = librarySaveParts('教室', [{ name: 'x'.repeat(5000) }], tmp);
  ok('超长名字被截断', long.ok, long);
  const list3 = libraryList(tmp);
  const rec3 = list3.items.find((i) => i.id === '教室');
  ok('★ 名字长度 ≤ 80', rec3.parts[0].name.length <= 80, rec3.parts[0].name.length);
}

console.log(`\n${fail ? '✗' : '✓'} parts: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
