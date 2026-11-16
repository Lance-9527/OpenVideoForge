#!/usr/bin/env node
/* ==========================================================================
 * tests/imports.mjs —— 模块导入静态校验
 *
 * 防止「批量改 ?v= 版本号」这类操作把 `from './x.js?v=59'` 改坏成 `from '=59'`：
 *   1) 每个 from './...' 的文件必须存在
 *   2) 不允许出现 `from '=数字'` 这种残缺说明符
 *   3) 命名导入的符号必须在目标文件里有导出（vendor/ 跳过）
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve('js');

/** 递归收集 .js（排除 vendor/）—— 2026-11-08：加了 js/worldgen/ 子目录，
 *  原来只扫 js/ 顶层，worldgen 里的导入错误会漏检。 */
function walkJs(root, acc = [], skipVendor = true) {
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (skipVendor && ent.name === 'vendor') continue;
      walkJs(abs, acc, skipVendor);
    } else if (ent.name.endsWith('.js')) {
      acc.push(abs);
    }
  }
  return acc;
}
const files = walkJs(dir).map((p) => path.relative(dir, p).split(path.sep).join('/'));
const vendorDir = path.join(dir, 'vendor');
const vendorFiles = fs.existsSync(vendorDir)
  ? fs.readdirSync(vendorDir).filter(f => f.endsWith('.js')) : [];

const exportsOf = (p) => {
  const src = fs.readFileSync(p, 'utf8');
  const set = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) set.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(',').forEach(x => { const n = x.trim().split(/\s+as\s+/).pop().trim(); if (n) set.add(n); });
  if (/export\s+default/.test(src)) set.add('default');
  return set;
};

let problems = 0;
for (const f of files) {
  const fp = path.join(dir, f);
  const src = fs.readFileSync(fp, 'utf8');
  if (/from\s*'=\d+'/.test(src)) { console.log('✗ 残缺说明符:', f); problems++; }
  for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?\{([^}]*)\}\s*from\s*'(.+?)'/g)) {
    const names = m[2].split(',').map(x => x.trim()).filter(Boolean).map(x => x.split(/\s+as\s+/)[0].trim());
    const target = m[3].split('?')[0];
    if (!target.startsWith('.')) continue;
    const abs = path.resolve(path.dirname(fp), target);
    if (!fs.existsSync(abs)) { console.log('✗ 文件不存在:', f, '→', target); problems++; continue; }
    if (target.includes('/vendor/')) continue;
    const ex = exportsOf(abs);
    for (const n of names) if (!ex.has(n)) { console.log('✗ 导出缺失:', f, '需要', n, '←', target); problems++; }
  }
}
if (problems) { console.error('\n导入校验失败：' + problems + ' 处'); process.exit(1); }
console.log('✓ 导入校验通过：' + files.length + ' 个模块，' + vendorFiles.length + ' 个 vendor 文件');