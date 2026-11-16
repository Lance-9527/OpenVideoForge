#!/usr/bin/env node
/* ============================================================================
 * tools/sync-sharepkg.mjs —— 把**当前源码**同步到 dist 分享包
 *
 * ★ 2026-11-09：分享包里的 openVideoForge 是 2026-10-28 的快照，
 *   和现在的源码差 12 天（15+ 轮工作）—— 用户要的是"dist 新版"，
 *   所以必须把最新代码同步过去。
 *
 * 同步策略：
 *   · 覆盖**代码目录**（js/css/server/bin/tools/tests/assets/plugin/...）
 *   · **保留**分享包特有的文件（tgz / 使用教程 / 免责声明 / 注意事项）
 *   · 同步前先备份旧的
 *
 * ★ 路径不再写死（2026-11-16 开源时整理）：
 *   SRC = 本仓库根目录（默认按脚本位置推导）
 *   PKG = 分享包目录（OVF_SHARE_PKG 环境变量或第一个命令行参数）
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..');
const PKG = process.env.OVF_SHARE_PKG || process.argv[2];
if (!PKG) {
  console.error('用法：node tools/sync-sharepkg.mjs <分享包目录>（或设 OVF_SHARE_PKG）');
  process.exit(1);
}
const DST = path.join(PKG, 'openVideoForge');

// 要同步的目录（代码）
const CODE_DIRS = ['js', 'css', 'server', 'bin', 'tools', 'tests', 'assets', 'plugin', 'agent-side', 'examples', 'spec', 'docs'];
// 要同步的根文件
const CODE_FILES = ['index.html', 'package.json', 'server.js', '.mcp.json', '.gitignore', 'LICENSE',
  'README.md', 'README-快速开始.md', 'THIRD-PARTY-NOTICES.md', 'START.bat', '启动.bat'];

let copied = 0, deleted = 0, skipped = 0;

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name), b = path.join(to, name);
    const st = fs.statSync(a);
    if (st.isDirectory()) {
      // **目标里多出来的文件删掉**（避免留旧版残留）
      if (fs.existsSync(b)) {
        const keep = new Set(fs.readdirSync(a));
        for (const old of fs.readdirSync(b)) {
          if (!keep.has(old)) { fs.rmSync(path.join(b, old), { recursive: true, force: true }); deleted++; }
        }
      }
      copyTree(a, b);
    } else {
      const same = fs.existsSync(b) &&
        fs.statSync(b).size === st.size &&
        fs.readFileSync(b).equals(fs.readFileSync(a));
      if (same) { skipped++; continue; }
      fs.copyFileSync(a, b);
      copied++;
    }
  }
}

console.log('同步:', SRC, '→', DST);
for (const d of CODE_DIRS) {
  const a = path.join(SRC, d);
  if (!fs.existsSync(a)) { console.log('  · 源没有，跳过:', d); continue; }
  copyTree(a, path.join(DST, d));
}
for (const f of CODE_FILES) {
  const a = path.join(SRC, f);
  if (!fs.existsSync(a)) continue;
  const b = path.join(DST, f);
  if (fs.existsSync(b) && fs.readFileSync(b).equals(fs.readFileSync(a))) { skipped++; continue; }
  fs.copyFileSync(a, b);
  copied++;
}
console.log(`✓ 复制 ${copied} 个文件，删掉 ${deleted} 个旧残留，跳过 ${skipped} 个相同`);

// ── 重生成 tgz（npm pack）
console.log('\n重生成 npm 包…');
const { execFileSync } = await import('node:child_process');
let tgzName = null;
try {
  const out = execFileSync('npm', ['pack', '--pack-destination', PKG], {
    cwd: SRC, encoding: 'utf8', timeout: 300000,
  });
  tgzName = out.trim().split('\n').filter((l) => l.endsWith('.tgz')).pop();
  console.log('✓ npm pack →', tgzName);
} catch (e) {
  console.log('✗ npm pack 失败:', (e.stderr || e.message || '').toString().slice(0, 300));
}

// ── 更新 md5.txt
console.log('\n更新 md5.txt…');
const files = [];
(function walk(dir, base = '') {
  for (const n of fs.readdirSync(dir)) {
    const p = path.join(dir, n);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, base ? base + '/' + n : n);
    else files.push({ rel: base ? base + '/' + n : n, size: st.size, m: st.mtimeMs });
  }
})(PKG);
files.sort((a, b) => a.rel.localeCompare(b.rel));
const lines = files.map((f) => {
  const buf = fs.readFileSync(path.join(PKG, f.rel));
  return `${crypto.createHash('md5').update(buf).digest('hex')}  ${f.rel}  ${f.size}`;
});
fs.writeFileSync(path.join(PKG, 'md5.txt'), lines.join('\n') + '\n', 'utf8');
console.log('✓ md5.txt 更新了', lines.length, '条');

// ── 统计
const total = files.reduce((s, f) => s + f.size, 0);
console.log(`\n分享包: ${files.length} 个文件 / ${(total / 1048576).toFixed(1)} MB`);
if (tgzName) console.log('新 tgz:', tgzName);
