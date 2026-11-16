#!/usr/bin/env node
/* ==========================================================================
 * bin/cli.mjs —— whitebox-workbench 命令行入口（零第三方依赖）
 *
 *   ovf open    起静态服务 + 桥，并打开浏览器（人用）
 *   ovf serve   只起静态服务 + 桥（无 GUI / 远程）
 *   ovf mcp     只以 MCP stdio 服务（Agent 用；同时仍会监听 HTTP 端口）
 *
 * 参数：
 *   --port <n>         桥端口（默认 8787，环境变量 WBWB_PORT）
 *   --static-port <n>  页面端口（默认 8802，环境变量 WBWB_STATIC_PORT）
 *   --out <dir>        产物目录（默认 <用户目录>/Downloads/OpenVideoForge，环境变量 WBWB_OUT_DIR）
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import fsSync from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { defaultOutDir } from '../server/paths.mjs';

const fsAccess = (p) => { try { fsSync.accessSync(p); return true; } catch (_) { return false; } };
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
// 兼容两种布局：包根就是站点（本仓库）或站点在 product/ 子目录（旧布局）
const STATIC_ROOT = (() => {
  const direct = ROOT;
  const nested = path.join(ROOT, 'product');
  try { return fsAccess(nested) && fsAccess(path.join(nested, 'index.html')) ? nested : direct; } catch (_) { return direct; }
})();
const BRIDGE = path.join(ROOT, 'server', 'agent-bridge.mjs');

const argv = process.argv.slice(2);
const cmd = (argv[0] || 'help').toLowerCase();
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BRIDGE_PORT = Number(flag('--port', process.env.WBWB_PORT || 8787));
const STATIC_PORT = Number(flag('--static-port', process.env.WBWB_STATIC_PORT || 8802));
const OUT_DIR = flag('--out', process.env.WBWB_OUT_DIR || '') || defaultOutDir();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
  '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

const BLOCKED = [/^\/package(-lock)?\.json$/i, /^\/bin\//i, /^\/server\//i, /^\/tests\//i, /^\.git/i];

function log(...a) { console.error('[wbwb]', ...a); }

async function startStatic() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let p = decodeURIComponent(url.pathname);
      if (p === '/' ) p = '/index.html';
      if (BLOCKED.some(re => re.test(p))) { res.writeHead(403).end('forbidden'); return; }
      const file = path.join(STATIC_ROOT, p);
      // 目录穿越防护
      if (!file.startsWith(STATIC_ROOT)) { res.writeHead(403).end('forbidden'); return; }
      const st = await fsp.stat(file).catch(() => null);
      if (!st || !st.isFile()) { res.writeHead(404).end('not found'); return; }
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

      // ★ Range 支持（2026-11-17）：视频必须能分段拉，否则 Chrome 会把 mp4
      //   当成「下载」而不是内联播放（实测：成品示例里的 mp4 直接落到下载目录）。
      //   解析 Range: bytes=start-end，回 206 + Content-Range。
      const range = req.headers.range;
      const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m) {
        const size = st.size;
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null && end !== null) {          // bytes=-N → 最后 N 字节
          start = Math.max(0, size - end);
          end = size - 1;
        } else {
          if (start === null) start = 0;
          if (end === null || end >= size) end = size - 1;
        }
        if (start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
          return;
        }
        const chunk = await fsp.readFile(file);
        const slice = chunk.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Length': slice.length,
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        });
        res.end(slice);
        return;
      }

      const buf = await fsp.readFile(file);
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': buf.length,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(500).end(String(e && e.message));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(STATIC_PORT, '127.0.0.1', resolve);
  });
  log(`页面: http://127.0.0.1:${STATIC_PORT}/index.html`);
  return server;
}

function startBridge({ mcp = false } = {}) {
  const args = [BRIDGE, '--port', String(BRIDGE_PORT), '--out', OUT_DIR];
  if (mcp) args.push('--mcp');
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: mcp ? 'inherit' : ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, WBWB_OUT_DIR: OUT_DIR },
  });
  child.on('exit', (code) => { if (!mcp) log('桥退出', code); });
  return child;
}

async function waitHealth(timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`);
      if (r.ok) return await r.json();
    } catch (_) { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  return null;
}

function openBrowser(url) {
  const cmdline = process.platform === 'win32'
    ? ['cmd.exe', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmdline[0], cmdline[1], { detached: true, stdio: 'ignore' }).unref(); } catch (_) {}
}

async function main() {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(`openvideoforge  ${'\n'}
  用法：
    ovf open                 起页面 + 桥，并打开浏览器
    ovf serve                只起页面 + 桥
    ovf mcp                  以 MCP stdio 服务（给 Agent 接入）
    ovf help                 显示本帮助

  参数：
    --port <n>        桥端口（默认 ${BRIDGE_PORT}）
    --static-port <n> 页面端口（默认 ${STATIC_PORT}）
    --out <dir>       产物目录（默认 ${OUT_DIR}）

  产物目录：${OUT_DIR}
  MCP 接入示例见 .mcp.json 或 docs/packaging-and-plugin.md`);
    return;
  }

  if (cmd === 'mcp') {
    const child = startBridge({ mcp: true });
    const onExit = () => { try { child.kill(); } catch (_) {} process.exit(0); };
    process.on('SIGINT', onExit);
    process.on('SIGTERM', onExit);
    return;   // stdio 交给子进程
  }

  if (cmd === 'serve' || cmd === 'open') {
    let staticServer = null;
    try { staticServer = await startStatic(); }
    catch (e) { log(`页面端口 ${STATIC_PORT} 起不来（可能已被占用）：${e.message}`); }
    const health = await waitHealth(1200);
    let bridge = null;
    if (!health) {
      bridge = startBridge();
      const h2 = await waitHealth(8000);
      if (!h2) log('警告：桥没有响应，检查 server/agent-bridge.mjs');
      else log(`桥已就绪: http://127.0.0.1:${BRIDGE_PORT}/health`);
    } else {
      log(`复用已在运行的桥: http://127.0.0.1:${BRIDGE_PORT}`);
    }
    if (cmd === 'open') openBrowser(`http://127.0.0.1:${STATIC_PORT}/index.html?wbwb=${Date.now()}`);
    const stop = () => { try { staticServer && staticServer.close(); } catch (_) {} try { bridge && bridge.kill(); } catch (_) {} process.exit(0); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    return;
  }

  log(`未知命令：${cmd}（用 ovf help 看用法）`);
  process.exitCode = 1;
}

main().catch((e) => { log('启动失败', e && e.message); process.exit(1); });
