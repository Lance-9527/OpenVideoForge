/* ============================================================================
 * server/vf-autostart.mjs —— ★ 自动拉起 VideoForge 后端（Blender 白膜渲染）
 *
 * 为什么要这个（2026-11-10）：
 *   openVideoForge 是**插件**，VideoForge 是**宿主**。
 *   之前 Blender 后端要人手动跑 `tools/start-ovf-full.ps1`，
 *   不跑的话「拍成片」直接报"Blender服务不可用" ⇒ 用户得先开 PowerShell。
 *
 * 做法：桥启动后**顺手**把后端拉起来（如果没在跑）。
 *   · 已经在跑 ⇒ 什么都不做（复用）
 *   · 没在跑 ⇒ 找到 sidecar 的 backend + Python + Blender，detached 拉起
 *   · 找不到 / 拉不起来 ⇒ **静默降级**（openVideoForge 照常可用，只是没有白膜渲染）
 *
 * 环境变量（都能覆盖自动探测）：
 *   VIDEOFORGE_BACKEND_DIR  sidecar 的 backend 目录
 *   VIDEOFORGE_PYTHON       python 可执行文件
 *   VIDEOFORGE_BLENDER      blender.exe
 *   VIDEOFORGE_DATA_DIR     数据目录（默认 <用户目录>/.videoforge）
 *   VIDEOFORGE_PORT         后端端口（默认 8798）
 * ========================================================================== */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir } from './paths.mjs';

const log = (...a) => console.error('[vf-auto]', ...a);

const WIN = process.platform === 'win32';
const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 插件仓库所在目录（用来定位**同级**的 VideoForge 源码/产物）。 */
const REPO_ROOT = path.resolve(HERE, '..');
const DATA_DIR_DEFAULT = defaultDataDir();
const PORT_DEFAULT = 8798;

/* ── ① 找 sidecar 的 backend 目录 ─────────────────────────────────── */
const BACKEND_CANDIDATES = [
  process.env.VIDEOFORGE_BACKEND_DIR,
  // 新版 DSH 的源码布局 —— 按**同级目录**推导，不写死任何人的盘符路径
  path.resolve(REPO_ROOT, '..', 'VideoForge-dsh', 'deepseek-harness-master', 'apps', 'desktop', 'resources', 'videoforge-sidecar', '_internal', 'backend'),
  // 打包产物
  path.resolve(REPO_ROOT, '..', 'VideoForge-dsh', 'deepseek-harness-master', 'apps', 'desktop', '.desktop-build', 'targets', 'win-x64', 'unsigned-artifacts', 'win-unpacked', 'resources', 'videoforge-sidecar', '_internal', 'backend'),
  // 分享包里（如果带了）
  path.resolve(process.cwd(), 'videoforge-sidecar', '_internal', 'backend'),
].filter(Boolean);

function findBackendDir() {
  for (const d of BACKEND_CANDIDATES) {
    try {
      if (fs.existsSync(path.join(d, 'main.py'))) {
        // 同时要能拿到 _internal（依赖 fastapi/uvicorn 等）
        return { backend: d, internal: path.resolve(d, '..') };
      }
    } catch (_) { /* 忽略 */ }
  }
  return null;
}

/* ── ② 找 Python（要能 import fastapi + uvicorn） ───────────────────── */
function findPython() {
  const cands = [];
  if (process.env.VIDEOFORGE_PYTHON) cands.push(process.env.VIDEOFORGE_PYTHON);
  if (WIN) {
    const local = path.join(process.env.LOCALAPPDATA || '', 'Python');
    try {
      for (const d of fs.readdirSync(local)) {
        const p = path.join(local, d, 'python.exe');
        if (fs.existsSync(p)) cands.push(p);
      }
    } catch (_) { /* 忽略 */ }
    cands.push('python.exe');
  } else {
    cands.push('python3', 'python');
  }
  for (const p of cands) {
    try {
      const r = spawnSync(p, ['-c', 'import fastapi,uvicorn'], { stdio: 'ignore', timeout: 12000 });
      if (r.status === 0) return p;
    } catch (_) { /* 下一个 */ }
  }
  return null;
}

/* ── ③ 找 Blender ─────────────────────────────────────────────────── */
function findBlender() {
  if (process.env.VIDEOFORGE_BLENDER && fs.existsSync(process.env.VIDEOFORGE_BLENDER)) {
    return process.env.VIDEOFORGE_BLENDER;
  }
  const cands = [];
  for (const base of ['C:\\Program Files\\Blender Foundation', 'C:\\Program Files (x86)\\Blender Foundation']) {
    try {
      for (const d of fs.readdirSync(base)) {
        if (/^blender/i.test(d)) {
          const p = path.join(base, d, 'blender.exe');
          if (fs.existsSync(p)) cands.push(p);
        }
      }
    } catch (_) { /* 忽略 */ }
  }
  // 常见固定版本路径
  for (const p of [
    'C:\\Program Files\\Blender Foundation\\Blender 4.2\\blender.exe',
  ]) if (fs.existsSync(p)) cands.push(p);
  return cands[0] || null;
}

/* ── ④ 后端是不是已经在跑 ─────────────────────────────────────────── */
export async function studioAlive(port = PORT_DEFAULT) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(`http://127.0.0.1:${port}/api/studio/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return false;
    const j = await r.json().catch(() => ({}));
    const d = j.data || j;
    return !!(d.ready || d.blender_available || d.service);
  } catch (_) { return false; }
}

/* ── ⑤ 拉起 ───────────────────────────────────────────────────────── */
export async function startVideoForge(opts = {}) {
  const port = Number(opts.port || process.env.VIDEOFORGE_PORT || PORT_DEFAULT);
  if (await studioAlive(port)) {
    // ★ 已经在跑 ⇒ 复用（但也要报告 Blender 在哪，方便诊断）
    return { ok: true, already: true, port, blender: findBlender() };
  }

  const dir = findBackendDir();
  if (!dir) return { ok: false, error: '找不到 VideoForge 后端（sidecar）' };
  const py = findPython();
  if (!py) return { ok: false, error: '找不到带 fastapi/uvicorn 的 Python' };
  const blender = findBlender();

  // 生成一个启动脚本（main.py 需要 _internal 在 sys.path 上）
  const bootDir = path.join(os.tmpdir(), 'ovf-vf');
  fs.mkdirSync(bootDir, { recursive: true });
  const bootFile = path.join(bootDir, `vf_boot_${port}.py`);
  const boot = [
    'import sys, os',
    `sys.path.insert(0, r'${dir.backend}')`,
    `sys.path.insert(0, r'${dir.internal}')`,
    `src = open(r'${path.join(dir.backend, 'main.py')}', encoding='utf-8').read()`,
    `exec(compile(src, r'${path.join(dir.backend, 'main.py')}', 'exec'), {'__name__': '__main__', '__file__': r'${path.join(dir.backend, 'main.py')}'})`,
  ].join('\n');
  fs.writeFileSync(bootFile, boot, 'utf8');

  const dataDir = process.env.VIDEOFORGE_DATA_DIR || DATA_DIR_DEFAULT;
  try { fs.mkdirSync(dataDir, { recursive: true }); } catch (_) { /* 忽略 */ }
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    VIDEOFORGE_DATA_DIR: dataDir,
    VIDEOFORGE_HOST: '127.0.0.1',
    VIDEOFORGE_PORT: String(port),
    PYTHONPATH: dir.internal,
  };
  if (blender) env.VIDEOFORGE_BLENDER = blender;

  const logFile = path.join(bootDir, `vf_backend_${port}.log`);
  const out = fs.openSync(logFile, 'a');
  let child;
  try {
    child = spawn(py, [bootFile], {
      cwd: dir.backend,
      env,
      detached: true,               // ★ 脱离当前进程 ⇒ 桥/CLI 关了它还活着
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    child.unref();
  } catch (e) {
    try { fs.closeSync(out); } catch (_) {}
    return { ok: false, error: '拉起失败：' + (e && e.message) };
  }

  // 等它就绪（最多 40 秒）
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    await new Promise((r) => setTimeout(r, 800));
    if (await studioAlive(port)) {
      log(`VideoForge 后端已就绪：http://127.0.0.1:${port}（Blender: ${blender || '未找到'}）`);
      return { ok: true, already: false, port, blender, logFile, dataDir };
    }
  }
  return { ok: false, error: '拉起了但 40 秒内没就绪（看 ' + logFile + '）', logFile };
}

/**
 * 桥启动后调用：**不阻塞**（拉不起来也不影响桥）。
 * @returns {Promise<object>}
 */
export function autostartVideoForge(opts = {}) {
  if (process.env.VIDEOFORGE_NO_AUTOSTART === '1') {
    return Promise.resolve({ ok: false, skipped: true, error: '已通过 VIDEOFORGE_NO_AUTOSTART=1 禁用' });
  }
  return startVideoForge(opts).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
}
