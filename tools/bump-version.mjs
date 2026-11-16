#!/usr/bin/env node
/* ============================================================================
 * tools/bump-version.mjs —— 统一 bump index.html 里的 ?v= 缓存版本号
 *
 * ★ 2026-11-10：踩过的坑 —— 改了 js/studio-bridge.js 但没 bump ?v=，
 *   Chrome 照样加载**旧缓存**，改的代码"像没生效"（实测：改了半天没反应）。
 *   这个项目的 index.html 用 ?v=N 做 cache-busting ⇒ **改了 js 必须 bump**。
 *
 * 用法：node tools/bump-version.mjs [新版本号]   （默认 77）
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const htmlPath = path.join(ROOT, 'index.html');
const V = process.argv[2] || '77';

let html = fs.readFileSync(htmlPath, 'utf8');
const before = (html.match(/\?v=\d+/g) || []).length;

// 只 bump **本项目自己**的 js/css（不动 vendor / three）
const re = /((?:js|css)\/[A-Za-z0-9._-]+\.(?:js|css))\?v=\d+/g;
const touched = new Set();
html = html.replace(re, (m, file) => {
  touched.add(file);
  return `${file}?v=${V}`;
});

fs.writeFileSync(htmlPath, html, 'utf8');
console.log(`index.html: ${touched.size} 个引用改成 ?v=${V}`);
const list = [...touched].sort();
for (const f of list) console.log('  ' + f);
console.log(`（共 ${before} 处 ?v= 引用）`);

// 检查有没有引用了但文件不存在的
let missing = 0;
for (const f of touched) {
  if (!fs.existsSync(path.join(ROOT, f))) { console.log('  ✗ 文件不存在: ' + f); missing++; }
}
if (missing) process.exit(1);
