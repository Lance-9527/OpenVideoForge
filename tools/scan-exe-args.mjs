#!/usr/bin/env node
/* 从 VideoForgeService.exe 里扫出它支持的命令行参数 */
import fs from 'node:fs';
const exe = process.argv[2];
const buf = fs.readFileSync(exe);
const s = buf.toString('latin1');
const found = new Set();
for (const m of s.matchAll(/--[a-z][a-z0-9-]{2,24}/gi)) found.add(m[0]);
const arr = [...found].sort();
console.log('共', arr.length, '个候选参数：');
for (const a of arr) console.log('  ' + a);

// 顺便找 no-window / headless / serve 之类的关键词上下文
console.log('\n=== 关键上下文 ===');
for (const kw of ['no-window', 'nowindow', 'headless', 'no-ui', 'noui', 'serve', 'silent', 'background', 'tray']) {
  const idxs = [];
  let i = 0;
  while ((i = s.toLowerCase().indexOf(kw, i)) !== -1 && idxs.length < 3) { idxs.push(i); i += kw.length; }
  if (idxs.length) {
    console.log(`\n--- ${kw} (${idxs.length}+ 处) ---`);
    for (const i of idxs) {
      const ctx = s.slice(Math.max(0, i - 60), i + 60).replace(/[^\x20-\x7e]/g, '.');
      console.log('  ...' + ctx + '...');
    }
  }
}
