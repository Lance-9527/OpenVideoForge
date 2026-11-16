#!/usr/bin/env node
/* ============================================================================
 * tools/fetch-blender.mjs —— 下载 Blender 4.2 LTS 便携版（zip，免安装）
 *
 * ★ 2026-11-09：Blender 侧车（VideoForge 的离线渲染）要真 Blender 才跑得起来。
 *   这台机器上没装（`C:\Program Files\Blender Foundation` 不存在），
 *   所以下载**便携 zip 版**解到工具目录（默认 <用户目录>/Tools）—— 不写注册表、不装到系统盘。
 *
 *   用法：node tools/fetch-blender.mjs [版本号]   默认 4.2.9
 * ========================================================================== */
import { defaultToolsDir } from '../server/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const VERSION = process.argv[2] || '4.2.9';
const DEST_DIR = defaultToolsDir();
const OUT_DIR = path.join(DEST_DIR, 'Blender');
const ZIP = path.join(DEST_DIR, `blender-${VERSION}-windows-x64.zip`);
/* ★ 官方 download.blender.org 对非浏览器 UA 直接 403，用阿里云镜像（更快）。
 *   目录是 **主版本.次版本**（Blender4.2），文件名才带完整版本号。 */
const BRANCH = 'Blender' + VERSION.split('.').slice(0, 2).join('.');
const MIRRORS = [
  (f) => `https://mirrors.aliyun.com/blender/release/${BRANCH}/${f}`,
  (f) => `https://download.blender.org/release/${BRANCH}/${f}`,
];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';
const FILE = `blender-${VERSION}-windows-x64.zip`;

console.log('Blender', VERSION, '（' + BRANCH + '）');
console.log('存到:', ZIP);

if (!fs.existsSync(ZIP)) {
  let ok = false;
  for (const mk of MIRRORS) {
    const url = mk(FILE);
    console.log('下载:', url);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) { console.log('  HTTP ' + res.status + '，换下一个源'); continue; }
      console.log('下载中…（约 300MB）');
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(ZIP, buf);
      console.log('✓ 下载完成', (buf.length / 1048576).toFixed(1), 'MB');
      ok = true;
      break;
    } catch (e) { console.log('  失败:', e.message); }
  }
  if (!ok) { console.error('✗ 所有源都失败'); process.exit(1); }
} else {
  console.log('已存在，跳过下载:', (fs.statSync(ZIP).size / 1048576).toFixed(1), 'MB');
}

// 解压（用 PowerShell 的 Expand-Archive，比自己解 zip 省事）
// ★ 判断依据是 **blender.exe 在不在**，不是目录在不在 ——
//   解压出来的目录名带版本号（如 blender-4.2.9-windows-x64），
//   之前拿 OUT_DIR 判断会误判"已解压"而跳过（实测：下载完了却报找不到 exe）。
const EXE_DIR = path.join(DEST_DIR, `blender-${VERSION}-windows-x64`);
const EXE = path.join(EXE_DIR, 'blender.exe');
if (!fs.existsSync(EXE)) {
  console.log('解压到', DEST_DIR, '…');
  await new Promise((res, rej) => {
    const ps = spawn('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${ZIP}' -DestinationPath '${DEST_DIR}' -Force`],
      { stdio: 'inherit' });
    ps.on('exit', (c) => (c === 0 ? res() : rej(new Error('解压失败 ' + c))));
  });
  console.log('✓ 解压完成');
}

console.log(EXE);
if (!fs.existsSync(EXE)) {
  console.error('✗ 找不到 blender.exe');
  process.exit(1);
}
console.log('✓ blender.exe 就位');
console.log('设置环境变量：VIDEOFORGE_BLENDER=' + EXE);
