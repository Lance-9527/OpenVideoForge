#!/usr/bin/env node
/* ==========================================================================
 * tests/smoke.mjs —— CLI 冒烟测试（不依赖页面/Blender）
 *
 * 1) `wbwb --help` 能打印用法
 * 2) `wbwb serve --static-port 8803 --port 8798` 起得来：
 *    · 页面 /index.html 返回 200 且含「白膜工作台」
 *    · 桥 /health 返回 ok
 *    · package.json / bin/ 不会被静态服务暴露；%2e%2e 穿越被拒
 *    · /tool 通路可用（返回合法 JSON）
 * 跑完自动收进程，不污染正式端口（8802/8787）。
 * ========================================================================== */
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'cli.mjs');

/* ★ 2026-11-09：端口改成**动态找空闲口**。
 *   原来写死 8803/8798 —— 而 8798 已经被 VideoForge 后端（Blender 渲染）占用了，
 *   跑测试就会"桥没起来"（实际是 EADDRINUSE，页面检查还因为旧实例在服务而假通过）。
 *   ⇒ 动态端口，永不冲突，也不用停掉正在跑的服务。 */
async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}
const STATIC_PORT = await freePort();
const BRIDGE_PORT = await freePort();
console.log('临时端口: static=' + STATIC_PORT + ' bridge=' + BRIDGE_PORT);
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwb-smoke-'));

const fail = (m) => { console.error('✗ ' + m); process.exit(1); };
const ok = (m) => console.log('✓ ' + m);

function httpGet(url, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

const wait = async (fn, ms = 12000, step = 250) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const v = await fn(); if (v) return v; } catch (_) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, step));
  }
  return null;
};

// 1) help
await new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [CLI, '--help'], { cwd: ROOT });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('exit', () => {
    if (!/用法/.test(out) || !/ovf open/.test(out)) reject(new Error('help 输出异常: ' + out.slice(0, 200)));
    else { ok('help 输出正常'); resolve(); }
  });
  p.on('error', reject);
});

// 2) serve
const child = spawn(process.execPath, [CLI, 'serve', '--static-port', String(STATIC_PORT), '--port', String(BRIDGE_PORT), '--out', OUT], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (d) => { log += d; });
child.stderr.on('data', (d) => { log += d; });

try {
  const page = await wait(async () => {
    const r = await httpGet(`http://127.0.0.1:${STATIC_PORT}/index.html`);
    return r.status === 200 ? r.body : null;
  });
  if (!page) fail('页面没起来\n' + log.slice(0, 600));
  if (!/OpenVideoForge/.test(page)) fail('页面内容不对（没有「OpenVideoForge」）');
  ok('页面 200 · index.html 正常（' + page.length + ' 字节）');

  const health = await wait(async () => {
    const r = await httpGet(`http://127.0.0.1:${BRIDGE_PORT}/health`);
    return r.status === 200 ? JSON.parse(r.body) : null;
  });
  if (!health) fail('桥没起来\n' + log.slice(0, 600));
  ok('桥 /health · ' + JSON.stringify({ ok: health.ok, service: health.service, protocol: health.protocol }));

  const traversal = await httpGet(`http://127.0.0.1:${STATIC_PORT}/%2e%2e%2fpackage.json`);
  if (traversal.status === 200) fail('目录穿越没防住（%2e%2e 返回 200）');
  const pkgLeak = await httpGet(`http://127.0.0.1:${STATIC_PORT}/package.json`);
  if (pkgLeak.status === 200) fail('package.json 被静态服务暴露');
  const binLeak = await httpGet(`http://127.0.0.1:${STATIC_PORT}/bin/cli.mjs`);
  if (binLeak.status === 200) fail('bin/ 被静态服务暴露');
  ok('敏感路径被拒（穿越 ' + traversal.status + ' / package ' + pkgLeak.status + ' / bin ' + binLeak.status + '）');

  const toolRes = await httpGet(`http://127.0.0.1:${BRIDGE_PORT}/tool`, 'POST', JSON.stringify({ name: 'wb_state', args: {} }));
  const toolJson = JSON.parse(toolRes.body);
  if (typeof toolJson.ok !== 'boolean') fail('/tool 返回不是合法 JSON: ' + toolRes.body.slice(0, 200));
  ok('/tool 通路正常（wb_state ok=' + toolJson.ok + '）');

  console.log('\nCLI 冒烟测试通过');
} finally {
  try { child.kill(); } catch (_) {}
  setTimeout(() => process.exit(0), 200);
}
