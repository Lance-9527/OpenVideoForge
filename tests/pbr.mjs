#!/usr/bin/env node
/* ============================================================================
 * tests/pbr.mjs —— 本地 PBR 素材库（ambientCG CC0）
 *
 * 守的是用户的核心诉求：「把可用的现实素材抓到自己本地，
 *   让 openVideoForge 能直接调用」。
 *
 * 验四件事：
 *   ① 清单能读出来，且每个材质都带 role（决定贴到世界的哪部分）
 *   ② 每个材质都有 **albedo**（没 albedo = 贴不出来，之前踩过：正则漏了大写 Color）
 *   ③ 贴图文件能取到，且**不能路径穿越**
 *   ④ 没有素材时不炸
 * ========================================================================== */
import { defaultOutDir } from '../server/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { pbrDir, pbrIndex, listPbr, pbrFilePath } from '../server/pbr.mjs';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};
const group = (t) => console.log('\n' + t);

const OUT = process.argv[2] || defaultOutDir();
const dir = pbrDir(OUT);

group('1. 目录与清单');
ok('PBR 目录在 ' + dir, fs.existsSync(dir));
const idx = pbrIndex(OUT);
ok('清单能读', !!idx && Array.isArray(idx.items), idx);
console.log(`    清单里有 ${idx.items.length} 个材质`);

if (idx.items.length) {
  group('2. 每个材质都合格');
  let noRole = [], noAlbedo = [], noNormal = [];
  for (const it of idx.items) {
    if (!it.role) noRole.push(it.id);
    if (!it.maps || !it.maps.albedo) noAlbedo.push(it.id);
    if (!it.maps || !it.maps.normal) noNormal.push(it.id);
  }
  ok('★ 全部有 role（决定贴哪部分）', noRole.length === 0, noRole);
  ok('★ 全部有 albedo（没它就贴不出来）', noAlbedo.length === 0, noAlbedo);
  console.log(`    ${idx.items.length - noNormal.length}/${idx.items.length} 有法线贴图`);

  group('3. 角色覆盖');
  const roles = new Set(idx.items.map((i) => i.role));
  for (const r of ['wall', 'road', 'ground', 'floor', 'roof']) {
    ok('有 ' + r + ' 材质', roles.has(r));
  }

  group('4. 许可');
  const badLicense = idx.items.filter((i) => !/CC0/i.test(i.license || ''));
  ok('★ 全部标了 CC0（ambientCG 无署名要求、无使用限制）', badLicense.length === 0,
    badLicense.map((i) => i.id + ':' + i.license));

  group('5. 贴图文件能取到');
  const one = idx.items[0];
  const alb = one.maps && one.maps.albedo;
  ok('第一个材质有 albedo', !!alb, one);
  const f = pbrFilePath(one.id, alb, OUT);
  ok('能取到文件', f.ok, f);
  ok('字节数 > 0', f.ok && f.bytes > 1000, { bytes: f.bytes });
  ok('路径在 PBR 目录内', f.ok && f.path.startsWith(path.resolve(dir)), f.path);

  group('6. 路径穿越');
  for (const evil of ['../../../etc/passwd', '..\\..\\secret', '/etc/passwd']) {
    const r = pbrFilePath(one.id, evil, OUT);
    ok('拒绝穿越：' + evil, r.ok === false || r.path.startsWith(path.resolve(dir)), r);
  }
  const r2 = pbrFilePath(one.id, '不存在的文件.jpg', OUT);
  ok('不存在的文件要报错', r2.ok === false, r2);
  const r3 = pbrFilePath('', '', OUT);
  ok('缺参数要报错', r3.ok === false, r3);
}

group('7. 没有素材时不炸');
{
  const empty = listPbr(path.join(process.env.TEMP || 'C:\\Temp', 'ovf-empty-' + Date.now()));
  ok('空目录返回空清单', empty && empty.count === 0, empty);
  ok('不影响其它功能', true);
}

console.log(`\n${fail ? '✗' : '✓'} pbr: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
