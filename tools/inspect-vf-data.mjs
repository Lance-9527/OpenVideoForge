#!/usr/bin/env node
/* 查 VideoForge data/ 里的大头 + db 的表和行数 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const D = 'C:\\Users\\Administrator\\AppData\\Local\\VideoForge\\data';

console.log('=== 目录占用（前 12）===');
const rows = [];
for (const n of fs.readdirSync(D)) {
  const p = path.join(D, n);
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    let sum = 0, cnt = 0;
    (function walk(d) {
      for (const m of fs.readdirSync(d)) {
        const q = path.join(d, m); const s = fs.statSync(q);
        if (s.isDirectory()) walk(q); else { sum += s.size; cnt++; }
      }
    })(p);
    rows.push({ name: n, mb: sum / 1048576, files: cnt });
  } else rows.push({ name: n, mb: st.size / 1048576, files: 1 });
}
rows.sort((a, b) => b.mb - a.mb);
for (const r of rows) console.log(`  ${r.name.padEnd(22)} ${r.mb.toFixed(2).padStart(8)} MB  ${r.files} 文件`);

console.log('\n=== db 的表和行数 ===');
let Database;
try { Database = require('node:sqlite').DatabaseSync; }
catch (e) { console.log('（node:sqlite 不可用）'); process.exit(0); }
try {
  const db = new Database(path.join(D, 'videoforge.db'), { readOnly: true });
  const tables = db.prepare("select name from sqlite_master where type='table' order by name").all();
  for (const t of tables) {
    try {
      const n = db.prepare(`select count(*) c from "${t.name}"`).get().c;
      if (n) console.log(`  ${t.name.padEnd(28)} ${n} 行`);
    } catch (_) {}
  }
  db.close();
} catch (e) { console.log('打开失败:', e.message); }
