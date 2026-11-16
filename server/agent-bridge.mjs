#!/usr/bin/env node
/**
 * agent-bridge.mjs —— OpenVideoForge「AI 操作」桥（零依赖）
 *
 * 作用：
 *   外部 Agent（MCP / 任意 HTTP 客户端）→ 本桥 → 浏览器页面（studio-agent.js）执行
 *   → 结果原路返回。页面侧同时保留「AI 指令」面板，人也能发同一套指令。
 *
 * 启动：
 *   node server/agent-bridge.mjs              # 只起 HTTP + SSE 桥（页面连它）
 *   node server/agent-bridge.mjs --mcp        # 同时以 stdio 提供 MCP 服务（Agent 平台用）
 *
 * 端口：8787（可用 --port 覆盖）
 *
 * HTTP:
 *   GET  /events        SSE：桥 → 页面下发指令（页面自己连，不用你调）
 *   POST /cmd           {name, args, timeoutMs}  → {ok, data|error}
 *   POST /result        页面回传执行结果（内部用）
 *   GET  /health        {ok, page:bool, pending:int}
 *
 * MCP（stdio, JSON-RPC 2.0, 逐行 JSON）：
 *   initialize / tools/list / tools/call / ping
 */
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { defaultOutDir } from './paths.mjs';
// ★ 2026-11-08 真实世界：OSM 抓取 + 本地落盘缓存（见 server/osm.mjs 的版权口径）
import { getOsmWorld, listCachedWorlds, cacheDir } from './osm.mjs';
import { geocodeCity, searchLocal, cityTable } from './geocode.mjs';
// ★ 2026-11-08 地形高程（AWS 公开 terrarium 瓦片，ODbL）
import { getTerrain } from './terrain.mjs';
// ★ 2026-11-08 外部素材源：目录 + 收件箱
import { sourceCatalog, findSource } from '../js/worldgen/sources.js';
import { scanInbox, resolveInboxFile, provenance } from './inbox.mjs';
// ★ 2026-11-08 预设库：存画面、随时调出来
import { savePreset, readPreset, listPresets, deletePreset, updatePreset, presetDir } from './presets.mjs';

import { listHdri, hdriFilePath, hdriThumbPath, hdriDir } from './hdri.mjs';
import { listPbr, pbrFilePath, pbrDir } from './pbr.mjs';
import { shareSave, shareLoad, shareDelete, shareList, sharePrune } from './share.mjs';
// ★ 2026-11-08 资产库：落盘持久化（模型/场景模型/材质/灯光）
import {
  libraryList, libraryAdd, libraryRemove, libraryImportModel,
  libraryFilePath, librarySaveWorld, libDir,
  librarySaveThumb, libraryThumbPath, librarySaveParts,
} from './library.mjs';

const argv = process.argv.slice(2);
const MCP = argv.includes('--mcp');
const portArg = argv.indexOf('--port');
const PORT = portArg >= 0 ? Number(argv[portArg + 1]) : 8787;
// 所有「页面里的下载」都落到这个目录，方便直接去找
const outArg = argv.indexOf('--out');
const OUT_DIR = outArg >= 0 ? String(argv[outArg + 1] || '') : defaultOutDir();

let pageClient = null;               // SSE 响应对象（最近连接的那个，兼容旧逻辑）
const clients = new Map();           // clientName -> SSE 响应对象
const clientView = new Map();        // clientName -> 页面自报的 view（entry/editor/library）
const clientMeta = new Map();        // clientName -> {view, visible, at}
const pending = new Map();           // id -> {resolve, timer}
let forwardOnly = false;
let FORCE_CLIENT = '';  // /tool 里指定的目标页面             // 端口被占（已有桥在跑）时，本进程只做 MCP，转发给已有桥

/* ------------------------------------------------------------ */
/* HTTP + SSE                                                    */
/* ------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

  if (req.url.startsWith('/health')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'videoforge-studio-bridge',
      protocol: 1,
      page: !!pageClient,
      clients: [...clients.keys()],
      views: Object.fromEntries(clientView),
      meta: Object.fromEntries([...clientMeta.entries()].map(([k, v]) => [k, { view: v.view, visible: v.visible, focus: !!v.focus, ageMs: Date.now() - v.at }])),
      pending: pending.size,
    }));
    return;
  }

  // 页面每 2s 自报当前视图，桥用它把指令路由到「正在编辑器里」的那个页面
  if (req.url === '/hi' && req.method === 'POST') {
    readJson(req, (b) => {
      if (b && b.client) {
        clientView.set(b.client, String(b.view || ''));
        clientMeta.set(b.client, { view: String(b.view || ''), visible: b.visible !== false, focus: !!b.focus, at: Date.now() });
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }

  if (req.url.startsWith('/events') && req.method === 'GET') {
    res.writeHead(200, {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    pageClient = res;
    // 每个文档一个唯一身份：同名页面（多标签/隐藏副本）不会互相覆盖
    const key = 'doc-' + randomUUID().slice(0, 8);
    clients.set(key, res);
    res.write('data: ' + JSON.stringify({ type: 'hello', client: key }) + '\n\n');
    req.on('close', () => {
      if (pageClient === res) pageClient = null;
      if (clients.get(key) === res) { clients.delete(key); clientView.delete(key); clientMeta.delete(key); }
    });
    return;
  }

  if (req.url.startsWith('/out')) {
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ outDir: OUT_DIR }));
    return;
  }

  // 在资源管理器里打开输出文件夹（可选 file 打开并选中某个文件）
  if (req.url === '/open' && req.method === 'POST') {
    readJson(req, (body) => {
      const out = openOut(body && body.file);
      res.writeHead(out.ok ? 200 : 400, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }

  if (req.url === '/save' && req.method === 'POST') {
    readJson(req, (body) => {
      const out = writeOut(body || {});
      res.writeHead(out.ok ? 200 : 400, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }

  if (req.url === '/result' && req.method === 'POST') {
    readJson(req, (body) => {
      const p = pending.get(body.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(body.id);
        p.resolve({ ok: !!body.ok, data: body.data, error: body.error });
      }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  // 直接调用任意 wb_* 工具（CLI / agent 平台 / 自动化测试用）
  if (req.url === '/tool' && req.method === 'POST') {
    readJson(req, async (body) => {
      FORCE_CLIENT = body.client || '';
      const out = await callTool(body.name, body.args || {});
      FORCE_CLIENT = '';
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }

  if (req.url === '/cmd' && req.method === 'POST') {
    readJson(req, async (body) => {
      const out = await dispatch(body.name, body.args, body.timeoutMs, body.client);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }

  // ★ 2026-11-08：本地 HDRI 素材库（环境光照贴图，Poly Haven CC0）
  //   /hdri/list         → 全部 HDRI 的清单（含缩略图、作者、许可证）
  //   /hdri/file/<id>    → .hdr 本体（RGBELoader 走 fetch+arrayBuffer，MIME 无关）
  //   /hdri/thumb/<id>   → 缩略图 png
  if (req.url.startsWith('/hdri/list')) {
    try {
      const items = listHdri(OUT_DIR);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dir: hdriDir(OUT_DIR), count: items.length, items }));
    } catch (e) {
      res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
    }
    return;
  }

  if (req.url.startsWith('/hdri/thumb/') && req.method === 'GET') {
    try {
      const id = decodeURIComponent(req.url.slice('/hdri/thumb/'.length));
      const f = hdriThumbPath(id, OUT_DIR);
      if (!f.ok) { res.writeHead(404, { ...cors }); res.end('not found'); return; }
      const buf = require('node:fs').readFileSync(f.path);
      res.writeHead(200, { ...cors, 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'max-age=86400' });
      res.end(buf);
    } catch (_) { res.writeHead(500, { ...cors }); res.end('error'); }
    return;
  }

  if (req.url.startsWith('/hdri/file/') && req.method === 'GET') {
    try {
      const id = decodeURIComponent(req.url.slice('/hdri/file/'.length).replace(/\.hdr$/, ''));
      const f = hdriFilePath(id, OUT_DIR);
      if (!f.ok) { res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' }); res.end(f.error); return; }
      const buf = require('node:fs').readFileSync(f.path);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'max-age=604800' });
      res.end(buf);
    } catch (_) { res.writeHead(500, { ...cors }); res.end('error'); }
    return;
  }

  // ★ 2026-11-10：**城市名 → 经纬度**（地名解析）
  //   GET  /geocode?q=北京        → { city: {name,lat,lng,...} }
  //   GET  /cities?q=京            → 搜索建议
  if (req.url.startsWith('/geocode') && req.method === 'GET') {
    (async () => {
      try {
        const q = decodeURIComponent((new URL(req.url, 'http://x').searchParams.get('q') || ''));
        const j = await geocodeCity(q, OUT_DIR);
        res.writeHead(j.ok ? 200 : 404, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(j));
      } catch (e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    })().catch(() => { try { res.writeHead(500); res.end('error'); } catch (_) {} });
    return;
  }
  if (req.url.startsWith('/cities') && req.method === 'GET') {
    try {
      const q = decodeURIComponent((new URL(req.url, 'http://x').searchParams.get('q') || ''));
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, total: cityTable().length, items: searchLocal(q, 30) }));
    } catch (_) { res.writeHead(500, { ...cors }); res.end('error'); }
    return;
  }

  // ★ 2026-11-09：**短链接分享**（场景存本地，链接只带 id）
  //   POST /share        { state, ttlDays } → { id, url }
  //   GET  /share/<id>   → { state }
  //   GET  /share/list   → 列出
  //   DELETE /share/<id> → 撤回
  if (req.url === '/share' && req.method === 'POST') {
    (async () => {
      try {
        const j = JSON.parse(await readBody(req) || '{}');
        const r = shareSave(j.state, OUT_DIR, { ttlDays: j.ttlDays });
        if (!r.ok) { res.writeHead(400, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); return; }
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(Object.assign({}, r, { url: '/index.html?s=' + r.id })));
      } catch (e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    })().catch(() => { try { res.writeHead(500); res.end('error'); } catch (_) {} });
    return;
  }
  if (req.url === '/share/list' && req.method === 'GET') {
    try {
      const j = shareList(OUT_DIR);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(j));
    } catch (_) { res.writeHead(500, { ...cors }); res.end('error'); }
    return;
  }
  if (req.url.startsWith('/share/') && req.method === 'GET') {
    try {
      const id = decodeURIComponent(req.url.slice('/share/'.length));
      const r = shareLoad(id, OUT_DIR);
      if (!r.ok) { res.writeHead(404, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); return; }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (_) { res.writeHead(500, { ...cors }); res.end('error'); }
    return;
  }
  if (req.url.startsWith('/share/') && req.method === 'DELETE') {
    try {
      const id = decodeURIComponent(req.url.slice('/share/'.length));
      const r = shareDelete(id, OUT_DIR);
      res.writeHead(r.ok ? 200 : 404, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (_) { res.writeHead(500, { ...cors }); res.end('error'); }
    return;
  }

  // ★ 2026-11-09：本地 PBR 素材（ambientCG CC0）  //   GET /pbr/list              → 清单
  //   GET /pbr/file/<id>/<file>  → 贴图文件
  if (req.url === '/pbr/list' && req.method === 'GET') {
    try {
      const j = listPbr(OUT_DIR);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(j));
    } catch (_) { res.writeHead(500, { ...cors }); res.end('error'); }
    return;
  }
  if (req.url.startsWith('/pbr/file/') && req.method === 'GET') {
    try {
      const rest = decodeURIComponent(req.url.slice('/pbr/file/'.length));
      const slash = rest.indexOf('/');
      const id = slash > 0 ? rest.slice(0, slash) : rest;
      const file = slash > 0 ? rest.slice(slash + 1) : '';
      const f = pbrFilePath(id, file, OUT_DIR);
      if (!f.ok) { res.writeHead(404, { ...cors }); res.end('not found'); return; }
      const buf = require('node:fs').readFileSync(f.path);
      const ext = require('node:path').extname(f.path).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : 'image/jpeg';
      res.writeHead(200, { ...cors, 'Content-Type': mime, 'Content-Length': buf.length, 'Cache-Control': 'max-age=604800' });
      res.end(buf);
    } catch (_) { res.writeHead(500, { ...cors }); res.end('error'); }
    return;
  }

  // ★ 2026-11-08：资产库缩略图
  //   GET  /library/thumb/<id>  → PNG（页面渲染好送回来的）
  //   POST /library/thumb/<id>  → 存缩略图（base64 PNG / dataURL）
  if (req.url.startsWith('/library/thumb/') && req.method === 'GET') {
    try {
      const id = decodeURIComponent(req.url.slice('/library/thumb/'.length).replace(/\.png$/, ''));
      const f = libraryThumbPath(id, OUT_DIR);
      if (!f.ok) { res.writeHead(404, { ...cors }); res.end('not found'); return; }
      const buf = require('node:fs').readFileSync(f.path);
      res.writeHead(200, { ...cors, 'Content-Type': 'image/png', 'Content-Length': buf.length, 'Cache-Control': 'max-age=86400' });
      res.end(buf);
    } catch (_) { res.writeHead(500, { ...cors }); res.end('error'); }
    return;
  }

  if (req.url.startsWith('/library/thumb/') && req.method === 'POST') {
    (async () => {
      try {
        const id = decodeURIComponent(req.url.slice('/library/thumb/'.length).replace(/\.png$/, ''));
        const j = JSON.parse(await readBody(req) || '{}');
        const out = librarySaveThumb(id, j.data || j.base64 || j.thumb, OUT_DIR);
        res.writeHead(out.ok ? 200 : 400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    })().catch(() => { try { res.writeHead(500); res.end('error'); } catch (_) {} });
    return;
  }

  // ★ 2026-11-09：模型**分件索引**（"精准 copy 某个地方的某个物体"）
  //   POST /library/parts/<id> → 页面回报分件清单，服务端存进 index.json
  if (req.url.startsWith('/library/parts/') && req.method === 'POST') {
    (async () => {
      try {
        const id = decodeURIComponent(req.url.slice('/library/parts/'.length));
        const j = JSON.parse(await readBody(req) || '{}');
        const out = librarySaveParts(id, j.parts, OUT_DIR);
        res.writeHead(out.ok ? 200 : 400, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { ...cors, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
      }
    })().catch(() => { try { res.writeHead(500); res.end('error'); } catch (_) {} });
    return;
  }

  // ★ 2026-11-08：资产库**上传**（页面选文件 → 直接落进 资产库/models/）
  //   不依赖 VideoForge 客户端(8765)，所以没开 Blender 也能用。
  if (req.url.startsWith('/library/upload') && req.method === 'POST') {
    (async () => {
    try {
      const nfs = require('node:fs');
      const npath = require('node:path');
      const j = JSON.parse(await readBody(req) || '{}');
      const b64 = String(j.base64 || '');
      if (!b64) { res.writeHead(400, { ...cors, 'Content-Type': 'text/plain' }); res.end('缺少 base64'); return; }
      const raw = Buffer.from(b64, 'base64');
      const name = String(j.name || 'model.glb');
      const ext = (npath.extname(name) || '.glb').toLowerCase();
      if (!['.glb', '.gltf'].includes(ext)) { res.writeHead(400, { ...cors, 'Content-Type': 'text/plain' }); res.end('只支持 .glb/.gltf'); return; }
      const id = npath.basename(name).replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'model';
      const dir = npath.join(libDir(OUT_DIR), 'models');
      nfs.mkdirSync(dir, { recursive: true });
      const dest = npath.join(dir, id + ext);
      nfs.writeFileSync(dest, raw);
      const rec = libraryAdd({
        id, kind: 'model', category: j.category || 'prop', name: j.displayName || name,
        file: 'models/' + id + ext, bytes: raw.length,
        source: j.source || 'local', attribution: j.attribution || null,
        thumb: j.thumb || null, note: j.note || '',
      }, OUT_DIR);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id, name, bytes: raw.length, item: rec.item }));
    } catch (e) {
      res.writeHead(500, { ...cors, 'Content-Type': 'text/plain' }); res.end(String((e && e.message) || e));
    }
    })().catch(() => { try { res.writeHead(500); res.end('error'); } catch (_) {} });
    return;
  }

  // ★ 2026-11-08：资产库模型文件服务（给页面的 GLTFLoader 直接吃）。
  //   路由挂在桥上；页面用绝对地址 http://127.0.0.1:8787/library/file/<id>
  if (req.url.startsWith('/library/file/') && req.method === 'GET') {
    try {
      const id = decodeURIComponent(req.url.slice('/library/file/'.length).replace(/\.glb$/, ''));
      const f = libraryFilePath(id, OUT_DIR);
      if (!f.ok) { res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' }); res.end(f.error); return; }
      const buf = require('node:fs').readFileSync(f.path);
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'model/gltf-binary',
        'Content-Length': buf.length,
        'Cache-Control': 'no-store',
      });
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { ...cors, 'Content-Type': 'text/plain' }); res.end(String((e && e.message) || e));
    }
    return;
  }

  // ★ 2026-11-08：真实世界数据文件。抓到的世界落在 OUT_DIR/osm-cache，
  //   页面按 URL 拉取（几何在浏览器里建，node 不碰 three）。
  if (req.url.startsWith('/osm/world/') && req.method === 'GET') {
    try {
      const key = decodeURIComponent(req.url.slice('/osm/world/'.length).replace(/\.json$/, ''));
      // 只允许缓存键的形状，防路径穿越
      if (!/^-?[\d.]+_-?[\d.]+_\d+$/.test(key)) {
        res.writeHead(400, { ...cors, 'Content-Type': 'text/plain' }); res.end('bad key'); return;
      }
      const p = require('node:path').join(cacheDir(OUT_DIR), key + '.world.json');
      if (!require('node:fs').existsSync(p)) {
        res.writeHead(404, { ...cors, 'Content-Type': 'text/plain' }); res.end('not found'); return;
      }
      const buf = require('node:fs').readFileSync(p);
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { ...cors, 'Content-Type': 'text/plain' }); res.end(String(e));
    }
    return;
  }

  res.writeHead(404, cors);
  res.end('not found');
});

/** 把 base64 内容写进 OUT_DIR（自动去重、防路径穿越） */
function writeOut(body) {
  try {
    const rawName = String(body.name || ('输出_' + Date.now())).replace(/[\\/:*?"<>|]/g, '_');
    const name = rawName.length > 120 ? rawName.slice(-120) : rawName;
    const dir = OUT_DIR;
    require('node:fs').mkdirSync(dir, { recursive: true });
    let target = require('node:path').join(dir, name);
    const ext = require('node:path').extname(target);
    const base = target.slice(0, target.length - ext.length);
    let i = 1;
    while (require('node:fs').existsSync(target)) { target = base + '_' + (i++) + ext; }
    const buf = Buffer.from(String(body.base64 || ''), 'base64');
    require('node:fs').writeFileSync(target, buf);
    return { ok: true, path: target, bytes: buf.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

/** 调 Windows 资源管理器打开输出目录（带 /select 时选中该文件） */
function openOut(file) {
  try {
    require('node:fs').mkdirSync(OUT_DIR, { recursive: true });
    const cp = require('node:child_process');
    let target = OUT_DIR;
    if (file) {
      const safe = String(file).replace(/[\\/:*?"<>|]/g, '_');
      const p = require('node:path').join(OUT_DIR, safe);
      if (require('node:fs').existsSync(p)) target = p;
    }
    if (process.platform === 'win32') {
      if (target === OUT_DIR) cp.spawn('explorer.exe', [OUT_DIR], { detached: true, stdio: 'ignore' }).unref();
      else cp.spawn('explorer.exe', ['/select,', target], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      cp.spawn('open', [target === OUT_DIR ? OUT_DIR : require('node:path').dirname(target)], { detached: true, stdio: 'ignore' }).unref();
    } else {
      cp.spawn('xdg-open', [OUT_DIR], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, opened: OUT_DIR, selected: target !== OUT_DIR ? target : null };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function readJson(req, cb) {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    try { cb(JSON.parse(raw || '{}')); }
    catch (e) { cb({}); }
  });
}

/** 把一条指令发给页面并等结果（可选 client 指定哪个页面执行） */
async function dispatch(name, args, timeoutMs = 20000, clientName) {
  if (!name) return Promise.resolve({ ok: false, error: '缺少 name' });
  if (!forwardOnly && clientName && !clients.has(clientName)) return { ok: false, error: '指定页面未连接：' + clientName };
  let target = (clientName && clients.get(clientName)) || null;
  if (!target) {
    // 多标签场景：优先挑「自报在编辑器里」的页面，同状态时取最近连接的那个
    const entries = [...clients.entries()];
    const pick = (pred) => {
      for (let i = entries.length - 1; i >= 0; i--) {
        const meta = clientMeta.get(entries[i][0]) || {};
        if (pred(meta)) return entries[i][1];
      }
      return null;
    };
    target = pick(m => m.focus && m.view === 'editor' && m.visible !== false)
      || pick(m => m.focus && m.visible !== false)
      || pick(m => m.view === 'editor' && m.visible !== false)
      || pick(m => m.visible !== false)
      || pick(m => m.view === 'editor')
      || (entries.length ? entries[entries.length - 1][1] : null);
  }
  if (!target) target = pageClient;
  // 端口被占（另有桥在服务页面）→ 转发给那个桥
  if (forwardOnly) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/cmd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args: args || {}, timeoutMs, client: clientName }),
        signal: AbortSignal.timeout(Math.max(2000, timeoutMs + 2000)),
      });
      return await r.json();
    } catch (e) {
      if (!pageClient) return { ok: false, error: '没有页面连接：先在浏览器打开OpenVideoForge并切到编辑器' };
    }
  }
  const client = target;
  if (!client) return { ok: false, error: '没有页面连接：先在浏览器打开OpenVideoForge并切到编辑器' };
  const id = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ ok: false, error: '超时：页面没有在 ' + timeoutMs + 'ms 内回结果' });
    }, Math.max(1000, Math.min(120000, timeoutMs)));
    pending.set(id, { resolve, timer, client });
    client.write('data: ' + JSON.stringify({ id, name, args: args || {} }) + '\n\n');
  });
}

/** 读完整请求体（带大小上限） */
function readBody(req, limit = 220 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > limit) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------ */
/* MCP（stdio）                                                   */
/* ------------------------------------------------------------ */
const TOOLS = [
  { name: 'wb_state', description: '读取工作台状态（环境/对象/选中/灯光/调色/镜头/总时长）', schema: { type: 'object', properties: {} } },
  { name: 'wb_env_load', description: '切换环境：room/street/temple/office/wild/studio；可带 size 场地大小档位（small/medium/large）', schema: { type: 'object', properties: { env: { type: 'string' }, size: { type: 'string', enum: ['small', 'medium', 'large'] } }, required: ['env'] } },
  { name: 'wb_env_size', description: '改当前场景的场地大小档位（地图大小是设置，不是写死）：small/medium/large/xl/xxl。factor 分别 1/4/20/60/150，相机远裁面与阴影范围会跟着档位放大', schema: { type: 'object', properties: { size: { type: 'string', enum: ['small', 'medium', 'large', 'xl', 'xxl'] } }, required: ['size'] } },
  { name: 'wb_world_info', description: '当前世界的体检数据：环境名 / 场地档位与系数 / 世界边长 / 楼数·路数·道具数·分块数 / 最高楼 / 运行时 LOD 档 / draw call 估算。普通预设环境 world 为 null', schema: { type: 'object', properties: {} } },
  { name: 'wb_world_build', description: '生成型世界。kind=city：按场地档位程序化铺一座城（世界放大不改物件尺寸、只增加数量，楼高 4~120m，街区间距 90m 恒定，上限 9000 栋，同一 seed 同一座城）。kind=osm：抓 OpenStreetMap 真实街区（本地落盘缓存 7 天，断网可重放；输出需署名 © OpenStreetMap contributors）。name：给城市起个名，会记进「继续上次」', schema: { type: 'object', properties: { kind: { type: 'string', enum: ['city', 'osm'] }, seed: { type: 'number' }, density: { type: 'number' }, size: { type: 'string', enum: ['small', 'medium', 'large', 'xl', 'xxl'] }, lat: { type: 'number', description: 'kind=osm 必填，十进制度数' }, lng: { type: 'number', description: 'kind=osm 必填' }, radius: { type: 'number', description: 'kind=osm 的取样半径，50–3000 米' }, force: { type: 'boolean', description: 'kind=osm 时忽略缓存重新抓取' }, refetch: { type: 'boolean', description: '连原始数据也重抓（慢：1~2 分钟）；默认只用本地 raw 重算' }, name: { type: 'string', description: '城市名（记进「继续上次」）' }, maxBuildings: { type: 'number' } } } },
  { name: 'wb_world_list', description: '列出本机已缓存的真实世界（OSM）清单：key/经纬度/半径/缓存年龄/是否新鲜。离线可用', schema: { type: 'object', properties: {} } },
  { name: 'wb_building_enter', description: '★ 进到楼里：在当前世界（city 程序化楼 / osm 真实楼）找脚下那栋，生成室内（地板·天花·带窗洞的外墙·带门洞的隔墙·家具·顶灯），并把机位搬到屋里眼高 1.4m。之后 wb_camera / wb_render 就是室内实拍', schema: { type: 'object', properties: { x: { type: 'number' }, z: { type: 'number' }, index: { type: 'number', description: '直接按楼序号进入（不给 x/z 时用）' }, maxDist: { type: 'number' } } } },
  { name: 'wb_building_exit', description: '退出室内，机位还原到进屋前', schema: { type: 'object', properties: {} } },
  { name: 'wb_building_info', description: '室内体检：房间列表（用途/中心/面积）、家具、灯数、当前机位与眼高。不在室内返回 inside:false', schema: { type: 'object', properties: {} } },
  { name: 'wb_building_list', description: '当前世界里可进入的楼清单（序号/坐标/底面尺寸/高度/面积/用途），按面积从大到小排。拿到序号后用 wb_building_enter{index} 直接进屋', schema: { type: 'object', properties: { limit: { type: 'number' } } } },
  { name: 'wb_building_floor', description: '多层室内换层：0 = 一层。进屋后用这个上下楼（室内按层高 3.1m 分层，最多 40 层，带楼梯间）。floor = -1 ⇒ 总览模式（一次画出全部楼层，相机退到楼外俯瞰整栋）', schema: { type: 'object', properties: { floor: { type: 'number' } } } },
  { name: 'wb_building_overview', description: '★ 室内总览：一次画出当前这栋楼的**全部楼层**，相机退到楼外斜上方俯瞰整栋（比逐层看快得多）', schema: { type: 'object', properties: {} } },
  { name: 'wb_source_list', description: '外部素材源目录：背景ガチャ / ワールドガチャ / どこでもロケハン / ポーズガチャ / コミックモデラー —— 各是什么、能导出什么、署名要求、工具直达链接，外加收件箱状态', schema: { type: 'object', properties: {} } },
  { name: 'wb_inbox_scan', description: '扫描外部素材收件箱，列出待导入的 GLB/图片/场景文件（路径/大小/时间）', schema: { type: 'object', properties: {} } },
  { name: 'wb_inbox_import', description: '把收件箱里的 GLB 登记进资产库，之后就能像内置资产一样摆位/打光/出片。返回出处说明与署名要求', schema: { type: 'object', properties: { file: { type: 'string', description: '收件箱里的文件名' }, source: { type: 'string', description: '来源 id（haikeigacha/worldgacha/rokehan/posegacha/comicmodeler）' }, asset_name: { type: 'string' } }, required: ['file'] } },
  { name: 'wb_preset_save', description: '★ 存预设：把当前画面整套存下来（世界怎么来的 + 机位 + 摆了什么 + 灯 + 缩略图 + 出处署名）。以后 wb_preset_load 一键调出来', schema: { type: 'object', properties: { name: { type: 'string', description: '预设名（同名覆盖）' }, note: { type: 'string' } }, required: ['name'] } },
  { name: 'wb_preset_list', description: '列预设库：id/名字/类型/机位/资产数/署名/缩略图', schema: { type: 'object', properties: {} } },
  { name: 'wb_preset_load', description: '★ 把预设调出来：还原世界、机位、灯光、已摆的资产', schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'wb_preset_delete', description: '删预设', schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'wb_preset_rename', description: '改预设的名字/备注', schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, note: { type: 'string' } }, required: ['id'] } },
  { name: 'wb_render_batch', description: '★ 批量出图：一次给多个机位（r/phi/theta/target/fov），每个机位出一张 JPG 存到输出目录的「批量出图」文件夹', schema: { type: 'object', properties: { shots: { type: 'array', items: { type: 'object' } }, w: { type: 'number' }, h: { type: 'number' }, save: { type: 'boolean' } }, required: ['shots'] } },
  { name: 'wb_share_link', description: '★ 生成分享链接：把当前场景状态编码进 URL，打开链接即可还原（状态即链接）', schema: { type: 'object', properties: {} } },
  { name: 'wb_library_list', description: '★ 资产库清单（**落盘持久化**，关网页/重启浏览器都不丢）：模型 / 场景模型 / 材质 / 灯光，每条带来源与署名要求', schema: { type: 'object', properties: { kind: { type: 'string', enum: ['model', 'world', 'material', 'light'] }, category: { type: 'string' }, q: { type: 'string', description: '按名字/来源搜' } } } },
  { name: 'wb_library_import_model', description: '★ 把收件箱里的 GLB 收进资产库（复制进资产库目录，之后随时复用）', schema: { type: 'object', properties: { file: { type: 'string' }, source: { type: 'string' }, category: { type: 'string', description: 'scene/character/prop' }, asset_name: { type: 'string' } }, required: ['file'] } },
  { name: 'wb_library_save_world', description: '★ 把当前世界存成资产库里的场景模型（城市参数或真实世界 URL + 署名），之后一键调用', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'wb_library_save_material', description: '★ 把当前选中对象的材质存成可复用材质', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'wb_library_save_light', description: '★ 把当前灯光存成可复用灯光预设', schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'wb_library_remove', description: '从资产库删除一条（内置条目不可删）', schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'wb_add_asset', description: '添加白膜资产（name 可传中文名如「站立的人」/id），可带位置与旋转', schema: { type: 'object', properties: { asset: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, ry: { type: 'number' }, scale: { type: 'number' } }, required: ['asset'] } },
  { name: 'wb_transform', description: '改选中对象的位置/旋转/缩放（只传要改的字段）', schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, ry: { type: 'number' }, scale: { type: 'number' } } } },
  { name: 'wb_delete_selected', description: '删除当前选中对象', schema: { type: 'object', properties: {} } },
  { name: 'wb_array', description: '阵列复制选中对象', schema: { type: 'object', properties: { cols: { type: 'number' }, rows: { type: 'number' }, gap: { type: 'number' } } } },
  { name: 'wb_drop', description: '把选中对象放到地面（包围盒底部对齐 y=0）', schema: { type: 'object', properties: {} } },
  { name: 'wb_layout_solve', description: '去重叠：确定性布局求解器，把互相穿插的物体在水平面分开（最小平移向量，clearance=最小间隙米，anchored=钉住不动的 instanceId）。不是刚体物理——结果可复现、页与 Blender 逐帧一致', schema: { type: 'object', properties: { clearance: { type: 'number' }, iterations: { type: 'number' }, instanceIds: { type: 'array', items: { type: 'string' } }, anchored: { type: 'array', items: { type: 'string' } }, axes: { type: 'string', enum: ['horizontal', 'all'] } } } },
  { name: 'wb_asset_list', description: '列出可用资产（按类别）', schema: { type: 'object', properties: {} } },
  { name: 'wb_light', description: '灯光：preset 传 正午/黄昏/夜景/影棚/侧光；或直接传 azimuth/elevation/kelvin/intensity/shadowSoft/hemi/fog/on', schema: { type: 'object', properties: { preset: { type: 'string' }, azimuth: { type: 'number' }, elevation: { type: 'number' }, kelvin: { type: 'number' }, intensity: { type: 'number' }, shadowSoft: { type: 'number' }, hemi: { type: 'number' }, fog: { type: 'boolean' }, on: { type: 'boolean' } } } },
  { name: 'wb_grade', description: '后处理：exposure(0.1-3) / contrast(0.5-2) / saturation(0-2) / vignette(0-1)', schema: { type: 'object', properties: { exposure: { type: 'number' }, contrast: { type: 'number' }, saturation: { type: 'number' }, vignette: { type: 'number' } } } },
  { name: 'wb_shot_add', description: '把当前相机存为一个镜头（可带名称与时长秒）', schema: { type: 'object', properties: { label: { type: 'string' }, duration: { type: 'number' } } } },
  { name: 'wb_shot_list', description: '列出镜头与起止时间', schema: { type: 'object', properties: {} } },
  { name: 'wb_shot_preview', description: '镜头预演：只播这一个镜头（到末尾自动停并还原机位）', schema: { type: 'object', properties: { index: { type: 'number' }, id: { type: 'string' } } } },
  { name: 'wb_shot_preview_stop', description: '结束镜头预演并还原机位', schema: { type: 'object', properties: {} } },
  { name: 'wb_play', description: '播放镜头序列', schema: { type: 'object', properties: {} } },
  { name: 'wb_stop', description: '停止播放', schema: { type: 'object', properties: {} } },
  { name: 'wb_camera', description: '设置轨道相机：r/phi/theta/target(tx,ty,tz)/fov', schema: { type: 'object', properties: { r: { type: 'number' }, phi: { type: 'number' }, theta: { type: 'number' }, tx: { type: 'number' }, ty: { type: 'number' }, tz: { type: 'number' }, fov: { type: 'number' } } } },
  { name: 'wb_render', description: '按分辨率出图（returnBase64=true 直接拿图）', schema: { type: 'object', properties: { w: { type: 'number' }, h: { type: 'number' }, returnBase64: { type: 'boolean' } } } },
  { name: 'wb_studio_render', description: '电商棚拍出图：**Blender 真渲染**（Cycles），**场景 + 物品 + 效果**三件套（3ds Max 那一套，不是白膜）。物品：objects[] 多个受管资产，各带 position/quaternion/scale；单件也可用 asset_id。场景：preset=white_seamless(白底)/warm_wood(暖木)/living_room(家居)/black_mirror(黑镜)/color_studio(彩棚)，environment 可覆盖 backdrop/backdrop_color/world，lights 可覆盖 key/fill/rim/background。效果：effects={dof{enabled,fstop,focus_distance},motion_blur{enabled,shutter},glare{enabled,threshold,size},grain{enabled,amount}}。product_material=keep(默认·保留GLB真实材质)|ceramic|metal|glass|plastic，samples=采样数(96~256)，w/h=尺寸，frames=帧数。素材用受管资产（wb_asset_upload）', schema: { type: 'object', properties: { asset_id: { type: 'string' }, objects: { type: 'array', items: { type: 'object', properties: { asset_id: { type: 'string' }, name: { type: 'string' }, position: { type: 'array', items: { type: 'number' } }, quaternion: { type: 'array', items: { type: 'number' } }, scale: { type: 'array', items: { type: 'number' } } }, required: ['asset_id'] } }, preset: { type: 'string', enum: ['white_seamless', 'warm_wood', 'living_room', 'black_mirror', 'color_studio'] }, environment: { type: 'object' }, lights: { type: 'object' }, effects: { type: 'object' }, product_material: { type: 'string', enum: ['keep', 'ceramic', 'metal', 'glass', 'plastic'] }, samples: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, frames: { type: 'number' }, camera: { type: 'object' }, project_id: { type: 'string' }, shot_id: { type: 'string' } } } },
  { name: 'wb_panorama', description: '用一张等距圆柱全景图做背景+环境光', schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'wb_scene_save', description: '保存当前场景（可改标题）', schema: { type: 'object', properties: { title: { type: 'string' } } } },
  { name: 'wb_scene_list', description: '列出已保存场景', schema: { type: 'object', properties: {} } },
  { name: 'wb_scene_new', description: '新建场景并进入编辑器（env: room/street/temple/office/wild/studio；size: small/medium/large 场地大小档位，缺省 small）', schema: { type: 'object', properties: { env: { type: 'string' }, size: { type: 'string', enum: ['small', 'medium', 'large'] } } } },
  { name: 'wb_device_add', description: '加一台设备机位（手机竖屏 / 无人机），可直接用它的视角出图出片', schema: { type: 'object', properties: { kind: { type: 'string', enum: ['phone', 'drone'] }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, lookX: { type: 'number' }, lookY: { type: 'number' }, lookZ: { type: 'number' } }, required: ['kind'] } },
  { name: 'wb_device_aim', description: '自由调整设备机位：yaw 水平角 / pitch 俯仰 / fov 焦距 / x,y,z 位置', schema: { type: 'object', properties: { id: { type: 'string' }, yaw: { type: 'number' }, pitch: { type: 'number' }, fov: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } } },
  { name: 'wb_device_look', description: '把设备机位对准选中物体（或给定世界坐标点）', schema: { type: 'object', properties: { id: { type: 'string' }, target: { type: 'array', items: { type: 'number' } } } } },
  { name: 'wb_device_list', description: '列出设备机位', schema: { type: 'object', properties: {} } },
  { name: 'wb_device_shoot', description: '用设备机位出图/出片：type=image|video，video 会走无人机航线或手机手持晃动', schema: { type: 'object', properties: { kind: { type: 'string', enum: ['phone', 'drone'] }, id: { type: 'string' }, type: { type: 'string', enum: ['image', 'video'] }, seconds: { type: 'number' }, aspect: { type: 'number' }, download: { type: 'boolean' } } } },
  { name: 'wb_storyboard', description: '打开分镜表（接触表/清单/PNG 序列）', schema: { type: 'object', properties: {} } },
  { name: 'wb_video', description: '把分镜导出成视频（WebM，实时录制）。白膜或成片管线；download=true 才会真的下载', schema: { type: 'object', properties: { w: { type: 'number' }, h: { type: 'number' }, fps: { type: 'number' }, mode: { type: 'string', enum: ['wb', 'film'] }, download: { type: 'boolean' } } } },
  { name: 'wb_raw', description: '直接调用底层指令：{cmd, args}（cmd 见 wb_state 的 commands）', schema: { type: 'object', properties: { cmd: { type: 'string' }, args: { type: 'object' } }, required: ['cmd'] } },
  // ★ 棚拍场景模式（SuperSplat，2026-10-31）：把指令投进 sidecar 的命令队列，
  //   客户端里的 SuperSplat 会轮询取走并执行，然后回传结果。
  { name: 'wb_splat_cmd', description: '指挥**棚拍场景**（SuperSplat 高斯泼溅编辑器，跑在 VideoForge 客户端里）。tool=SuperSplat 的工具名：get_scene(读场景) / set_camera(设机位: view=top/front/back/left/right/bottom 或 position+target 或 azimuth/elevation/distance/fov) / focus_camera(聚焦，**scope 必填**: selection|layer|scene，聚焦整个场景用 scope=scene) / capture_viewport(把当前视口渲染成 PNG，args: width/height/filename，返回 {data:base64, media_type, filename, bytes}) / set_view(显示选项: 背景/网格/色调映射，不是切视角) / select_region|select_rectangle|select_property(选区) / transform(移动旋转缩放选中) / apply_color|reset_color(上色) / undo / redo / import_url(导入场景文件) / export_scene(导出). args 按工具而定。返回 {ok, result|error}。', schema: { type: 'object', properties: { tool: { type: 'string' }, args: { type: 'object' } }, required: ['tool'] } },
  { name: 'wb_splat_results', description: '读取 wb_splat_cmd 的执行结果（按 id 取，或取全部）', schema: { type: 'object', properties: { id: { type: 'string' } } } },
  { name: 'wb_splat_tools', description: '列出棚拍场景（SuperSplat）可用的工具名与参数说明 —— 指挥场景前先查这个', schema: { type: 'object', properties: {} } },
];

const TOOL_MAP = {
  wb_asset_import: ['studio.asset.import', a => a],
  wb_instance_set: ['studio.instance.set', a => a],
  wb_scene_export: ['studio.scene.export', a => a],
  wb_scene_load: ['studio.scene.load', a => a],
  wb_track_set: ['studio.track.set', a => a],
  wb_track_orbit: ['studio.track.orbit', a => a],
  wb_track_preview: ['studio.track.preview', a => a],
  wb_render_submit: ['studio.render.submit', a => a],
  wb_render_status: ['studio.render.status', a => a],
  wb_render_cancel: ['studio.render.cancel', a => a],
  wb_render_watch: ['studio.render.watch', a => a],
  wb_render_bind: ['studio.render.bind', a => a],
  wb_state: ['state.get', () => ({})],
  wb_env_load: ['env.load', (a) => a],
  wb_env_size: ['env.size', (a) => a],
  wb_world_info: ['world.info', () => ({})],
  wb_world_build: ['world.build', (a) => a],
  wb_building_enter: ['building.enter', (a) => a],
  wb_building_floor: ['building.floor', (a) => a],
  wb_building_overview: ['building.overview', (a) => a],
  wb_building_exit: ['building.exit', () => ({})],
  wb_building_info: ['building.info', () => ({})],
  wb_building_list: ['building.list', (a) => a],
  wb_add_asset: ['asset.add', (a) => a],
  wb_transform: ['asset.transform', (a) => a],
  wb_delete_selected: ['asset.delete', () => ({})],
  wb_array: ['asset.array', (a) => a],
  wb_drop: ['asset.drop', () => ({})],
  wb_layout_solve: ['scene.layout.solve', (a) => a],
  wb_asset_list: ['asset.list', () => ({})],
  wb_light: ['__light', (a) => a],
  wb_grade: ['grade.set', (a) => a],
  wb_shot_add: ['shot.add', (a) => a],
  wb_shot_list: ['shot.list', () => ({})],
  wb_shot_preview: ['shot.preview', (a) => a],
  wb_shot_preview_stop: ['shot.previewStop', () => ({})],
  wb_play: ['shot.play', () => ({})],
  wb_stop: ['shot.stop', () => ({})],
  wb_camera: ['camera.set', (a) => a],
  wb_render: ['render', (a) => a],
  wb_panorama: ['panorama.set', (a) => a],
  wb_scene_save: ['scene.save', (a) => a],
  wb_scene_list: ['scene.list', () => ({})],
  wb_scene_new: ['scene.new', (a) => a],
  wb_device_add: ['device.add', (a) => a],
  wb_device_aim: ['device.aim', (a) => a],
  wb_device_look: ['device.look', (a) => a],
  wb_device_list: ['device.list', () => ({})],
  wb_device_shoot: ['device.shoot', (a) => a],
  wb_storyboard: ['storyboard.open', () => ({})],
  wb_video: ['video.export', (a) => a],
  wb_raw: ['__raw', (a) => a],
};

for (const [name, description] of Object.entries({
  wb_asset_import:'导入已登记GLB：asset_id；文件先通过/api/studio/assets上传',
  wb_instance_set:'按实例ID设置米制Z-up position/quaternion/scale',
  wb_scene_export:'将当前场景与逐帧相机轨迹导出为videoforge.scene/1并存入后端',
  wb_scene_load:'从已保存的场景ID/revision恢复模型与精确相机轨迹，或传入scene JSON',
  wb_track_set:'设置显式camera.keys逐帧轨迹和object_tracks，使用米制Z-up',
  wb_track_orbit:'生成完整环绕轨迹：seconds/fps/turns，不用最短弧折返',
  wb_track_preview:'预览显式轨迹中的指定frame',
  wb_render_submit:'提交Blender后台白膜任务，可附project_id/shot_id，返回job_id',
  wb_render_status:'查询Blender任务状态与真实输出manifest：job_id',
  wb_render_cancel:'取消指定Blender任务：job_id',
  wb_render_bind:'绑定成功渲染白膜到VideoForge：job_id/project_id/shot_id',
})) TOOLS.push({name,description,schema:{type:'object',additionalProperties:true,properties:{}}});
TOOLS.push({
  name: 'wb_caps',
  description: '能力探测：本机是否有 Blender 渲染服务（8765）、输出目录在哪；页面据此决定"拍成片"走 Blender 还是浏览器录制',
  schema: { type: 'object', properties: { url: { type: 'string' } } },
});
TOOLS.push({
  name: 'wb_render_save',
  description: '把已完成 Blender 任务的 MP4/首帧 PNG 下载到输出目录（默认 <用户目录>/Downloads/OpenVideoForge），返回本地路径与 sha256',
  schema: { type: 'object', properties: { job_id: { type: 'string' }, prefix: { type: 'string' } }, required: ['job_id'] },
});
TOOLS.push({
  name: 'wb_render_frames',
  description: '帧级进度：扫任务目录返回已渲染帧数、最新帧索引与可直接显示的 PNG URL（job_id, 可选 total）',
  schema: { type: 'object', properties: { job_id: { type: 'string' }, total: { type: 'number' } }, required: ['job_id'] },
});
TOOLS.push({
  name: 'wb_asset_upload',
  description: '把磁盘上的 GLB 直接登记进 Blender 服务（Agent/Blender 产物入口，无需浏览器选择文件）：path',
  schema: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' } }, required: ['path'] },
});
TOOLS.push({
  name: 'wb_handoff',
  description: '一条命令跑完整条流水线：上传 GLB → 导入工作台 → 生成轨迹 → 提交 Blender → 盯进度 → 产物下载到输出目录。返回 job_id / 文件本地路径 / manifest 摘要 / 分步 steps',
  schema: { type: 'object', properties: {
    glb_path: { type: 'string' }, asset_id: { type: 'string' }, name: { type: 'string' },
    seconds: { type: 'number' }, fps: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
    turns: { type: 'number' }, camera_keys: { type: 'array' }, fov: { type: 'number' }, use_page_track: { type: 'boolean' },
    prefix: { type: 'string' }, wait_ms: { type: 'number' }, poll_ms: { type: 'number' },
    project_id: { type: 'string' }, shot_id: { type: 'string' }, download: { type: 'boolean' },
  } },
});

TOOLS.push({
  name: 'wb_previz_list',
  description: '列出 VideoForge 白膜阶段在本机产出的资产：白膜场景（scenes）、模型（assets/GLB）、渲染任务（jobs，含首帧/成片 URL）',
  schema: { type: 'object', properties: {} },
});
TOOLS.push({
  name: 'wb_previz_import_model',
  description: '把某个白膜模型（studio_bridge/assets/<id>/model.glb）重新登记进 8765，返回新 asset 元数据，供 OpenVideoForge「我的模型」复用',
  schema: { type: 'object', properties: { asset_id: { type: 'string' } }, required: ['asset_id'] },
});
TOOLS.push({
  name: 'wb_asset_deposit',
  description: '把一个 GLB **存进**工作台的可复用资产清单（path 指向磁盘 .glb，或给已登记的 asset_id）：'
    + '先登记进 8765（按内容哈希去重，同内容不会重复登记），再让页面把它记进「我的模型」，'
    + '下次做类似生产过程可以直接复用',
  schema: { type: 'object', properties: { path: { type: 'string' }, asset_id: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' } } },
});
TOOLS.push({
  name: 'wb_previz_import_scene',
  description: '把整场白膜场景（studio_bridge/scenes/<scene_id>）导入 OpenVideoForge：上传全部 GLB，返回 Y-up 已转换的 objects/camera，可直接生成「我的场景」记录',
  schema: { type: 'object', properties: { scene_id: { type: 'string' } }, required: ['scene_id'] },
});
TOOLS.push({
  name: 'wb_handoff_check',
  description: '交接前体检：导出规范场景并检查资产登记/实例/帧数/轨迹起点/坐标前提，返回 issues 列表',
  schema: { type: 'object', properties: { seconds: { type: 'number' }, fps: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } },
});


/* ==== HANDOFF LAYER v33 ==== */
/* ★ 2026-11-09：端口不再写死 —— 探测 8765 / 8798（见 probeStudio）。
 *   STUDIO_BASE 变成 getter，每次拿当前探测到的地址。 */
const STUDIO_BASE_FALLBACK = 'http://127.0.0.1:8765/api/studio';
async function studioBaseUrl() {
  const p = await probeStudio();
  return (p && p.url ? p.url : 'http://127.0.0.1:8765') + '/api/studio';
}

function pageCall(name, args, timeoutMs = 30000) {
  return dispatch(name, args || {}, timeoutMs, FORCE_CLIENT || undefined);
}

async function studioGet(path) {
  // ★ sidecar 每次启动端口可能都变（随机端口）⇒ 失败时清缓存重探一次
  for (let attempt = 0; attempt < 2; attempt++) {
    const base = await studioBaseUrl();
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(20000) });
      // ★ 2026-11-10：404 ⇒ 这个 sidecar 没这个接口（不是"服务挂了"），
      //   给出能看懂的提示，别抛成"Blender 服务请求失败"。
      if (r.status === 404) return { __notFound: true, error: 'sidecar 没有这个接口：' + path };
      const j = await r.json().catch(() => ({}));
      // ★ 2026-11-10：**sidecar 有几个端点不套 code**（直接返回数据，如 /splat/results
      //   返回 {"results":[]}）。之前一律要求 j.code === '000000' ⇒ 把正常响应误判成失败
      //   （实测：wb_splat_results 报"Blender 服务请求失败 HTTP 200"）。
      //   ⇒ code **不存在**时按成功处理；存在时才校验。
      if (!r.ok || (j.code !== undefined && j.code !== '000000' && j.code !== 0)) {
        throw new Error(j.detail?.message || j.detail || j.message || ('Blender 服务请求失败 HTTP ' + r.status));
      }
      return j.data !== undefined ? j.data : j;
    } catch (e) {
      if (attempt === 0) { studioBaseHit = null; studioScanAt = 0; continue; }
      throw e;
    }
  }
}

/** POST 到 sidecar（命令队列、产物落盘等）。返回 data 字段。 */
async function studioPost(path, body, timeoutMs = 20000) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const base = await studioBaseUrl();
    try {
      const r = await fetch(base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // ★ 2026-11-10：**404 不重试也不抛** —— 路径写错是编程错误，重试没用，
      //   而且抛出去会一路冒到 callTool（现在有兜底，但更好的做法是给个能看懂的错）。
      if (r.status === 404) {
        return { __notFound: true, error: 'sidecar 没有这个接口：' + path };
      }
      const j = await r.json().catch(() => ({}));
      if (!r.ok || (j.code !== undefined && j.code !== '000000' && j.code !== 0)) {
        throw new Error(j.detail?.message || j.detail || j.message || ('sidecar 请求失败 HTTP ' + r.status));
      }
      return j.data !== undefined ? j.data : j;
    } catch (e) {
      if (attempt === 0) { studioBaseHit = null; studioScanAt = 0; continue; }
      throw e;
    }
  }
}

/** 把磁盘上的 GLB 直接登记进 VideoForge（Agent/Blender 产物的入口） */
async function uploadAssetFromDisk(filePath, name) {
  try {
    const fsp = require('node:fs'), path = require('node:path');
    if (!filePath) return { ok: false, error: '缺少 path' };
    if (!fsp.existsSync(filePath)) return { ok: false, error: '文件不存在：' + filePath };
    const stat = fsp.statSync(filePath);
    if (stat.size > 200 * 1024 * 1024) return { ok: false, error: 'GLB 超过 200MB，请先减面' };
    const buf = fsp.readFileSync(filePath);
    // ★ 文件名**必须以 .glb 结尾**（8765 那边按扩展名校验）。
    //   显示名是给人看的（可以是"主角"这种中文），不能拿来当文件名 ——
    //   否则用户传 name="主角" 就会被后端以「仅支持完整的GLB 2文件」拒掉，
    //   而磁盘上的文件明明就是 .glb（2026-10-26 实测踩到）。
    let fname = String(name || path.basename(filePath)).replace(/["\r\n]/g, '_').trim();
    if (!fname.toLowerCase().endsWith('.glb')) fname = fname + '.glb';
    const boundary = '----wbhandoff' + randomUUID().replace(/-/g, '');
    const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' + fname +
      '"\r\nContent-Type: model/gltf-binary\r\n\r\n');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const body = Buffer.concat([head, buf, tail]);
    const r = await fetch((await studioBaseUrl()) + '/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body,
      signal: AbortSignal.timeout(120000),
    });
    const j = await r.json();
    if (!r.ok || j.code !== '000000') return { ok: false, error: j.detail?.message || j.detail || j.message || '上传失败' };
    return { ok: true, data: { ...j.data, source_path: filePath, source_bytes: buf.length } };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 下载 Blender 产物到统一输出目录，返回本地绝对路径 */
async function downloadToOut(url, name) {
  try {
    const path = require('node:path'), fsp = require('node:fs');
    fsp.mkdirSync(OUT_DIR, { recursive: true });
    // ★ 2026-11-09：base 用**探测到的**地址（sidecar 端口是随机的）——
    //   写死 8765 会导致 "fetch failed"（实测：Blender 渲完了但产物下不下来）。
    const p = await probeStudio();
    const base = (p && p.url) || 'http://127.0.0.1:8765';
    const abs = new URL(url, base).href;
    const r = await fetch(abs, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) return { ok: false, error: '下载失败 HTTP ' + r.status };
    const buf = Buffer.from(await r.arrayBuffer());
    let target = path.join(OUT_DIR, String(name).replace(/[\\/:*?"<>|]/g, '_'));
    const ext = path.extname(target), base2 = target.slice(0, target.length - ext.length);
    let i = 1;
    while (fsp.existsSync(target)) target = base2 + '_' + (i++) + ext;
    fsp.writeFileSync(target, buf);
    return { ok: true, path: target, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 一条命令跑完整条流水线（职责分工：Agent 造 → 工作台排 → VideoForge 渲）
 * args: { glb_path?|asset_id?, name?, seconds?, fps?, width?, height?, turns?, camera_keys?, fov?,
 *         prefix?, wait_ms?, poll_ms?, project_id?, shot_id?, download? }
 */
/** 把某个已完成任务的产物下载到输出目录（Agent 出片后收尾用） */
/** 能力探测：本机有没有 Blender 渲染服务（页面据此决定"拍成片"走哪条路） */
/* ── Blender 侧车地址探测 ────────────────────────────────────────────────
 * ★ 2026-11-09：**别把端口写死**。
 *   · 8765 = 老版 VideoForge studio 后端（`python main.py`）
 *   · 8798 = 新版 VideoForgeService.exe（打包的 sidecar）
 *   两者提供**同一套** `/api/studio/*` API（health/assets/scenes/renders）。
 *   ★★ 但新版 sidecar **默认用随机端口**（实测：起一次是 52056）——
 *     端口每次都不同，写死根本没法用。
 *   ⇒ 除了两个固定端口，还要**扫本机监听端口**找那个提供 studio API 的。
 */
const STUDIO_PORTS = [
  process.env.WBWB_VF_URL || '',
  'http://127.0.0.1:8765',
  'http://127.0.0.1:8798',
].filter(Boolean);

/** 扫本机监听端口（找随机端口的 sidecar）—— 从它的日志里拿端口最快 */
async function scanStudioPorts() {
  const found = new Set();
  try {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const home = os.homedir();
    const logs = [
      // ★ VideoForgeService.exe 的日志（launcher 写的，"Port: NNNNN" / "Backend ready on port NNNNN"）
      path.join(home, '.videoforge', 'videoforge.log'),
      'D:/VideoForge-dsh/sidecar-out.log',
    ];
    for (const lg of logs) {
      if (!fs.existsSync(lg)) continue;
      const txt = fs.readFileSync(lg, 'utf8');
      // 只看最近的部分（日志可能几 MB）
      const tail = txt.slice(-400000);
      const ms = [...tail.matchAll(/Backend ready on port (\d+)/g)];
      for (const m of ms.slice(-8)) found.add(m[1]);
      const ms2 = [...tail.matchAll(/Port: (\d+)/g)];
      for (const m of ms2.slice(-8)) found.add(m[1]);
    }
  } catch (_) { /* 日志读不到就算了 */ }
  return [...found].map((p) => 'http://127.0.0.1:' + p);
}

let studioBaseHit = null;      // 已探测到的可用地址（缓存）
let studioScanAt = 0;           // 上次扫描时间（10 秒扫一次够了）

async function probeStudio() {
  if (studioBaseHit) return studioBaseHit;
  // 固定端口先试（快），失败再扫
  const tries = [...STUDIO_PORTS];
  if (Date.now() - studioScanAt > 10000) {
    studioScanAt = Date.now();
    const scanned = await scanStudioPorts();
    for (const s of scanned) if (!tries.includes(s)) tries.push(s);
  }
  const tried = [];
  for (const base of tries) {
    try {
      const r = await fetch(base + '/api/studio/health', { signal: AbortSignal.timeout(2000) });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        studioBaseHit = {
          url: base,
          ready: !!(j?.data?.ready ?? j?.ready),
          blender_available: !!(j?.data?.blender_available ?? j?.blender_available),
          blender_version: j?.data?.blender_version || j?.blender_version || null,
          service: j?.data?.service || j?.service || 'videoforge',
        };
        return studioBaseHit;
      }
      tried.push(base + ' → HTTP ' + r.status);
    } catch (e) {
      tried.push(base + ' → ' + String((e && e.message) || e));
    }
  }
  return { url: STUDIO_PORTS[0], ready: false, blender_available: false, tried };
}

async function caps(args = {}) {
  const out = { out_dir: OUT_DIR, blender: false, url: null, latency_ms: null };
  const t0 = Date.now();
  if (args.url) {
    // 显式指定就只探它
    try {
      const r = await fetch(String(args.url) + '/api/studio/health', { signal: AbortSignal.timeout(2500) });
      out.latency_ms = Date.now() - t0;
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        out.blender = true;
        out.url = String(args.url);
        out.service = j?.data?.service || j?.service || 'videoforge';
        out.version = j?.data?.version || j?.version || null;
        out.ready = !!(j?.data?.ready ?? j?.ready);
        out.blender_available = !!(j?.data?.blender_available ?? j?.blender_available);
      } else out.status = r.status;
    } catch (e) { out.error = String((e && e.message) || e); }
    return { ok: true, data: out };
  }

  const p = await probeStudio();
  out.latency_ms = Date.now() - t0;
  out.url = p.url;
  out.tried = p.tried || null;
  out.candidates = STUDIO_PORTS;
  // ★ 分清两件事：**服务在不在** ≠ **Blender 装了没**
  //   服务在但没装 Blender → 提交任务也会失败（studio_bridge 里会 503「未找到Blender」）
  const serviceUp = !!(p && p.url && p.ready !== false);
  out.service_up = serviceUp;
  if (serviceUp) {
    out.blender = p.blender_available !== false;   // ★ 真能用 Blender 才算 true
    out.service = p.service || 'videoforge';
    out.ready = p.ready !== false;
    out.blender_available = p.blender_available !== false;
    out.blender_version = p.blender_version || null;
    if (!out.blender) {
      out.hint = 'VideoForge 服务在，但**没检测到 Blender**（要 Blender 4.2+）。'
        + '不装也能用——「一键出片」会自动走浏览器录制（MP4）。';
    }
  } else {
    out.blender = false;
    out.error = '没找到 VideoForge 渲染服务（试过 ' + STUDIO_PORTS.join(' / ') + '）';
    // ★ 明确告诉用户**缺什么**
    out.hint = '装 Blender 4.2+ 并启动 VideoForge（或设置 WBWB_VF_URL）后可用 Blender 离线渲染；'
      + '不装也能用——「一键出片」会自动走浏览器录制（MP4）。';
  }
  return { ok: true, data: out };
}

async function renderSave(args = {}) {
  try {
    const jobId = String(args.job_id || '');
    if (!jobId) return { ok: false, error: '缺少 job_id' };
    const st = await studioGet('/renders/' + encodeURIComponent(jobId));
    if (String(st.status) !== 'succeeded') return { ok: false, error: '任务未成功：' + st.status, data: { status: st.status, progress: st.progress } };
    const prefix = String(args.prefix || 'Blender白膜');
    const files = [];
    for (const f of st.manifest?.outputs || []) {
      const name = prefix + '_' + jobId.slice(4, 12) + '_' + (f.kind === 'video' ? 'mp4.mp4' : 'png.png');
      const r = await downloadToOut(f.url, name);
      files.push({ kind: f.kind, bytes: f.bytes, sha256: f.sha256, path: r.path, error: r.error });
    }
    return { ok: true, data: { job_id: jobId, blender: st.manifest?.blender_version, render: st.manifest?.render, files, out_dir: OUT_DIR } };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/**
 * ★ 2026-11-10：布尔参数解析。
 *   JSON 里 `false` / `"false"` / `0` / `"0"` / `""` 都应该算"假"。
 *   直接 `if (x)` 的话，字符串 "false" 是真值 ⇒ 走错分支（实测踩过）。
 */
function boolArg(v, dflt = false) {
  if (v === undefined || v === null) return dflt;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (['false', '0', 'no', 'off', 'none', ''].includes(s)) return false;
  if (['true', '1', 'yes', 'on'].includes(s)) return true;
  return !!v;
}

async function handoff(args = {}) {
  const steps = [];
  const t0 = Date.now();
  const render = {
    seconds: Number(args.seconds) || 3,
    fps: Number(args.fps) || 24,
    width: Number(args.width) || 640,
    height: Number(args.height) || 360,
  };
  let assetId = args.asset_id || '';
  let instanceId = '';

  if (!assetId) {
    if (!args.glb_path) return { ok: false, error: '需要 glb_path（Blender 导出的 .glb）或 asset_id', steps };
    const up = await uploadAssetFromDisk(args.glb_path, args.name);
    steps.push({ step: 'upload', ok: up.ok, asset_id: up.data?.id, bytes: up.data?.source_bytes, error: up.error });
    if (!up.ok) return { ok: false, error: up.error, steps };
    assetId = up.data.id;
  }

  const imp = await pageCall('studio.asset.import', { asset_id: assetId }, args.import_timeout_ms || 60000);
  steps.push({ step: 'import', ok: imp.ok, instance_id: imp.data?.instance_id, error: imp.error });
  if (!imp.ok) return { ok: false, error: imp.error, steps, asset_id: assetId };
  instanceId = imp.data?.instance_id;

  let trk;
  // ★ 2026-11-10：布尔参数要**显式解析**。
  //   JSON 里传 "false"（字符串）是常见做法，`if (args.use_page_track)` 会把它当真
  //   ⇒ 走错分支（实测：use_page_track:false 反而去读页面轨迹，报"camera.keys不能为空"）。
  if (boolArg(args.use_page_track)) {
    // 用页面里已经画好的轨迹（物体 + 机位），帧数以轨迹为准
    const info = await pageCall('track.path.info', {}, 15000);
    const cf = Number(info?.data?.camera_frames) || 0;
    if (!cf) return { ok: false, error: '勾选了「用页面轨迹」但页面还没有机位轨迹（先在「轨迹」里手绘，或让 Agent 下 keys）', steps, asset_id: assetId, instance_id: instanceId };
    const f = Number(info.data.fps) || render.fps;
    render.frame_count = cf;
    render.fps = f;
    render.seconds = cf / f;
    trk = { ok: true, data: { source: 'page', camera_frames: cf, object_tracks: info.data.object_tracks?.length || 0 } };
  } else {
    // ★ 2026-11-10：**空数组也是真值** —— `args.camera_keys ? ...` 会让
    //   `camera_keys: []` 走进 track.set，然后报"camera.keys不能为空"。
    //   现在只有**真的有 key** 才走 set。
    trk = (Array.isArray(args.camera_keys) && args.camera_keys.length)
      ? await pageCall('studio.track.set', { camera: { keys: args.camera_keys, vertical_fov: Number(args.fov) || 45 }, render }, 60000)
      : await pageCall('studio.track.orbit', { ...render, turns: args.turns == null ? 1 : Number(args.turns) }, 60000);
  }
  steps.push({ step: 'track', ok: trk.ok, detail: trk.ok ? trk.data : trk.error });
  if (!trk.ok) return { ok: false, error: trk.error, steps, asset_id: assetId, instance_id: instanceId };

  const sub = await pageCall('studio.render.submit', render, args.submit_timeout_ms || 120000);
  steps.push({ step: 'submit', ok: sub.ok, job_id: sub.data?.job_id, error: sub.error });
  if (!sub.ok) return { ok: false, error: sub.error, steps, asset_id: assetId, instance_id: instanceId };
  const jobId = sub.data.job_id;

  // 让页面 HUD 接管（用户能看到进度；失败也不影响后台任务）
  pageCall('studio.render.watch', { job_id: jobId }, 4000).catch(() => {});

  // 记录场景版本，便于「载入 A/B 继续改」
  let sceneInfo = null;
  try { const si = await pageCall('state.get', {}, 15000); if (si && si.ok) sceneInfo = si.data; } catch (_) {}

  let state = null;
  const deadline = Date.now() + (Number(args.wait_ms) || 240000);
  const pollMs = Math.max(300, Number(args.poll_ms) || 900);
  while (Date.now() < deadline) {
    try { state = await studioGet('/renders/' + encodeURIComponent(jobId)); }
    catch (e) { steps.push({ step: 'poll', error: String(e.message || e) }); }
    if (state && ['succeeded', 'failed', 'cancelled'].includes(String(state.status))) break;
    steps.push({ step: 'poll', status: state?.status, progress: state?.progress });
    await new Promise(r => setTimeout(r, pollMs));
  }

  const files = [];
  if (state && state.status === 'succeeded') {
    for (const f of (state.manifest?.outputs || [])) {
      const ext = f.kind === 'video' ? '.mp4' : '.png';
      const label = f.kind === 'video' ? 'mp4' : (f.kind === 'first_frame' ? 'png' : f.kind);
      const name = (args.prefix || 'Blender白膜') + '_' + String(jobId).slice(4, 12) + '_' + label + ext;
      const saved = boolArg(args.download, true) === false ? { ok: true, path: null, bytes: f.bytes } : await downloadToOut(f.url, name);
      files.push({ kind: f.kind, bytes: f.bytes, sha256: f.sha256, path: saved.path || null, error: saved.error });
    }
  }

  const ok = !!state && state.status === 'succeeded';
  return {
    ok,
    data: {
      job_id: jobId,
      status: state?.status || 'unknown',
      progress: state?.progress,
      blender: state?.manifest?.blender_version,
      render: state?.manifest?.render,
      validation: state?.manifest?.validation,
      outputs: state?.manifest?.outputs || [],
      asset_id: assetId,
      instance_id: instanceId,
      scene_id: sceneInfo?.scene_id || null,
      revision: sceneInfo?.revision ?? null,
      files,
      out_dir: OUT_DIR,
      elapsed_ms: Date.now() - t0,
    },
    steps,
    error: ok ? undefined : (state?.error || '渲染未成功：' + (state?.status || 'timeout')),
  };
}

/** 交接体检：导出一次规范场景，检查资产登记/实例/帧数/轨迹/坐标前提 */
async function handoffCheck(args = {}) {
  const issues = [];
  const opt = { seconds: Number(args.seconds) || 3, fps: Number(args.fps) || 24, width: Number(args.width) || 640, height: Number(args.height) || 360 };
  const exp = await pageCall('studio.scene.export', opt, 120000);
  if (!exp.ok) return { ok: false, error: exp.error, issues: ['场景导出失败：' + exp.error] };
  const sc = exp.data && exp.data.scene ? exp.data.scene : exp.data;
  if (!sc || sc.schema !== 'videoforge.scene/1') issues.push('导出结果不是 videoforge.scene/1');
  const assets = sc?.assets || [], instances = sc?.instances || [], keys = sc?.camera?.keys || [];
  if (!assets.length) issues.push('没有登记资产（assets 为空）');
  if (!instances.length) issues.push('没有实例（instances 为空）');
  if (!(sc?.render?.frame_count > 0)) issues.push('render.frame_count 无效');
  if (!keys.length) issues.push('相机轨迹为空');
  if (keys.length && keys[0].frame !== 0) issues.push('轨迹不是从第 0 帧开始');
  const last = keys.length ? keys[keys.length - 1].frame : -1;
  if (keys.length && last >= (sc?.render?.frame_count || 0)) issues.push('轨迹帧 ' + last + ' 超出渲染帧数 ' + sc?.render?.frame_count);
  if (keys.some(k => !k.position || !k.target)) issues.push('关键帧缺 position/target');
  if (sc?.coordinates?.up !== 'Z') issues.push('坐标系不是 Z-up（规范要求右手 Z-up）');
  try {
    const reg = await studioGet('/assets');
    const ids = new Set((reg.assets || []).map(a => a.id));
    for (const a of assets) if (!ids.has(a.id)) issues.push('资产未在服务登记：' + a.id);
  } catch (e) { issues.push('资产服务不可用：' + e.message); }
  return {
    ok: issues.length === 0,
    data: { scene_id: sc?.scene_id, revision: sc?.revision, assets: assets.length, instances: instances.length, frames: sc?.render?.frame_count, keys: keys.length, coordinates: sc?.coordinates },
    issues,
  };
}
/* ==== HANDOFF LAYER v33 ==== */


/* ==== PREVIZ INGEST v72 ====
 * 把 VideoForge 白膜阶段产出的场景/模型收进 OpenVideoForge：
 *   wb_previz_list            列出 studio_bridge 里的白膜场景 / 模型 / 渲染任务
 *   wb_previz_import_model    把某个 asset 的 GLB 重新登记进 8765，返回新 asset 元数据
 *   wb_previz_import_scene    导出整场：上传该场景引用的所有 GLB + 返回可直接用的 objects（Y-up 已转换）
 */
function vfStudioDir() {
  const path = require('node:path');
  const fs2 = require('node:fs');
  // ★ 2026-11-10：数据目录**不能只认 AppData**。
  //   sidecar 的 resolve_data_root() 顺序是：
  //     VIDEOFORGE_DATA_DIR → %LOCALAPPDATA%\VideoForge\data（要求已有 db）→ <cwd>\data
  //   本机把库放在了 D 盘（VIDEOFORGE_DATA_DIR=<你的数据目录>），
  //   这里如果还写死 AppData ⇒ 白膜场景/模型/任务**一个都扫不到**
  //   （实测 wb_previz_list 返回 scenes:0 / models:0 / jobs:0）。
  const cands = [];
  const env = process.env.VIDEOFORGE_DATA_DIR;
  if (env) cands.push(path.join(env, 'studio_bridge'));
  const la = process.env.LOCALAPPDATA || '';
  if (la) cands.push(path.join(la, 'VideoForge', 'data', 'studio_bridge'));
  // 再兜底：常见的其它位置
  cands.push(path.join('D:', '\\', 'VideoForgeData', 'studio_bridge'));
  for (const c of cands) {
    try { if (fs2.existsSync(c)) return c; } catch (_) { /* 忽略 */ }
  }
  return cands[0] || path.join(la, 'VideoForge', 'data', 'studio_bridge');
}

function canonPoint(p) {
  const x = Number(p?.[0] || 0), y = Number(p?.[1] || 0), z = Number(p?.[2] || 0);
  return [x, -z, y];                       // Blender Z-up → three Y-up
}

function canonQuat(q) {
  const [x, y, z, w] = (Array.isArray(q) && q.length === 4) ? q.map(Number) : [0, 0, 0, 1];
  const h = -Math.PI / 4, sx = Math.sin(h), cx = Math.cos(h);   // 绕 X 轴 -90°
  const mul = (a, b) => ({
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  });
  const r = mul({ x: sx, y: 0, z: 0, w: cx }, { x, y, z, w });
  return [r.x, r.y, r.z, r.w];
}

function previzJobForScene(sceneId) {
  const fs2 = require('node:fs'), path = require('node:path');
  const jobsDir = path.join(vfStudioDir(), 'jobs');
  let best = null;
  try {
    for (const name of fs2.readdirSync(jobsDir)) {
      const jf = path.join(jobsDir, name, 'job.json');
      if (!fs2.existsSync(jf)) continue;
      try {
        const j = JSON.parse(fs2.readFileSync(jf, 'utf8'));
        if (j.scene_id !== sceneId || j.status !== 'succeeded') continue;
        const t = Number(j.created_at || 0);
        if (!best || t > best.t) best = { t, job_id: j.job_id, manifest: j.manifest };
      } catch (_) {}
    }
  } catch (_) {}
  return best;
}

async function previzList(args = {}) {
  const fs2 = require('node:fs'), path = require('node:path');
  const root = vfStudioDir();
  const scenes = [], models = [], jobs = [];
  // ★ 默认只回**最近 50 条**（本机实测：83 个模型 / 43 个场景 / 125 个任务）。
  //   全量回会把 MCP 回复撑爆 —— 以前 MCP 那边按 20000 字符截断，
  //   JSON 被拦腰切断，**客户端一个都解析不了**（2026-10-26 实测踩到）。
  //   limit=0 表示"全都要"。
  const limit = Number(args.limit) === 0 ? Infinity : (Number(args.limit) > 0 ? Number(args.limit) : 50);
  // 场景：每个 scene 目录取最新 revision
  try {
    for (const name of fs2.readdirSync(path.join(root, 'scenes'))) {
      const dir = path.join(root, 'scenes', name);
      let files = [];
      try { files = fs2.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).sort(); } catch (_) { continue; }
      if (!files.length) continue;
      const file = path.join(dir, files[files.length - 1]);
      let doc = null;
      try { doc = JSON.parse(fs2.readFileSync(file, 'utf8')); } catch (_) { continue; }
      const st = fs2.statSync(file);
      const jb = previzJobForScene(doc.scene_id || name);
      scenes.push({
        scene_id: doc.scene_id || name,
        revision: doc.revision,
        assets: (doc.assets || []).length,
        instances: (doc.instances || []).length,
        camera_keys: (doc.camera && doc.camera.keys || []).length,
        frame_count: (doc.render && doc.render.frame_count) || null,
        fps: (doc.render && doc.render.fps) || null,
        mtime: st.mtimeMs,
        job_id: jb ? jb.job_id : null,
        thumb_url: jb ? ('/api/studio/renders/' + encodeURIComponent(jb.job_id) + '/files/frame_000000.png') : null,
      });
    }
  } catch (_) {}
  // 模型
  try {
    for (const name of fs2.readdirSync(path.join(root, 'assets'))) {
      const meta = path.join(root, 'assets', name, 'asset.json');
      const glb = path.join(root, 'assets', name, 'model.glb');
      if (!fs2.existsSync(meta) || !fs2.existsSync(glb)) continue;
      try {
        const m = JSON.parse(fs2.readFileSync(meta, 'utf8'));
        models.push({ id: m.id || name, name: m.name || name, bytes: m.bytes || fs2.statSync(glb).size,
          created_at: m.created_at || fs2.statSync(glb).mtimeMs / 1000 });
      } catch (_) {}
    }
  } catch (_) {}
  // 渲染任务（留痕/预览）
  try {
    for (const name of fs2.readdirSync(path.join(root, 'jobs'))) {
      const jf = path.join(root, 'jobs', name, 'job.json');
      if (!fs2.existsSync(jf)) continue;
      try {
        const j = JSON.parse(fs2.readFileSync(jf, 'utf8'));
        const mf = j.manifest || {};
        jobs.push({ job_id: j.job_id || name, status: j.status, scene_id: j.scene_id,
          created_at: j.created_at, frames: mf.render && mf.render.frame_count,
          fps: mf.render && mf.render.fps, duration: mf.duration,
          first_frame_url: '/api/studio/renders/' + encodeURIComponent(j.job_id || name) + '/files/frame_000000.png',
          video_url: '/api/studio/renders/' + encodeURIComponent(j.job_id || name) + '/files/frames.mp4' });
      } catch (_) {}
    }
  } catch (_) {}
  scenes.sort((a, b) => b.mtime - a.mtime);
  models.sort((a, b) => Number(b.created_at) - Number(a.created_at));
  jobs.sort((a, b) => Number(b.created_at) - Number(a.created_at));
  const counts = { scenes: scenes.length, models: models.length, jobs: jobs.length };
  return {
    ok: true,
    data: {
      root,
      counts,
      limit: Number.isFinite(limit) ? limit : 0,
      // 说明：有条数被 limit 截掉时**如实说清**，别让 agent 以为"就这些"。
      truncated: counts.scenes > limit || counts.models > limit || counts.jobs > limit,
      scenes: scenes.slice(0, limit),
      models: models.slice(0, limit),
      jobs: jobs.slice(0, limit),
    },
  };
}

function previzAssetPath(assetId) {
  const path = require('node:path'), fs2 = require('node:fs');
  const dir = path.join(vfStudioDir(), 'assets', String(assetId));
  const glb = path.join(dir, 'model.glb');
  if (!fs2.existsSync(glb)) return null;
  let name = assetId;
  try { name = JSON.parse(fs2.readFileSync(path.join(dir, 'asset.json'), 'utf8')).name || assetId; } catch (_) {}
  return { glb, name };
}

async function previzImportModel(args = {}) {
  const id = String(args.asset_id || args.id || '');
  if (!id) return { ok: false, error: '缺少 asset_id' };
  const hit = previzAssetPath(id);
  if (!hit) return { ok: false, error: '找不到白膜模型文件：' + id };
  const up = await uploadAssetFromDisk(hit.glb, hit.name);
  if (!up.ok) return up;
  // ★ 顺手"存进"工作台的可复用清单（沉淀钩子）：让页面的「我的模型」里能看到它
  let deposited = null;
  try { deposited = await pageCall('studio.asset.deposit', { asset_id: up.data.id, role: 'previz-model' }, 20000); }
  catch (e) { deposited = { ok: false, error: String((e && e.message) || e) }; }
  return { ok: true, data: { previz_asset_id: id, name: hit.name, asset: up.data, deposited: !!(deposited && deposited.ok) } };
}

/**
 * 把一个 GLB 存进可复用资产清单（沉淀入口）。
 * ★ 为什么要这个钩子（用户：「后面生产过程中你生成的都最好存资产库，
 *   后面遇到类似的生产过程可以直接复用」）：
 *   Agent/后端产出的模型原来只能"用一次"（登记进 8765 之后就没下文了），
 *   现在统一走这里：登记（按内容哈希去重）+ 记进页面「我的模型」⇒ 可复用。
 */
async function assetDeposit(args = {}) {
  const diskPath = String(args.path || args.glb_path || '');
  let assetId = String(args.asset_id || '');
  let uploaded = null;
  if (!assetId) {
    if (!diskPath) return { ok: false, error: '需要 path（磁盘上的 .glb）或 asset_id' };
    uploaded = await uploadAssetFromDisk(diskPath, args.name);
    if (!uploaded.ok) return uploaded;
    assetId = uploaded.data.id;
  }
  let deposited = null;
  try {
    deposited = await pageCall('studio.asset.deposit',
      { asset_id: assetId, role: args.role || 'agent-deposit' }, 20000);
  } catch (e) {
    deposited = { ok: false, error: String((e && e.message) || e) };
  }
  return {
    ok: true,
    data: {
      asset_id: assetId,
      asset: uploaded ? uploaded.data : null,
      deposited: !!(deposited && deposited.ok),
      deposit: deposited,
      note: deposited && deposited.ok ? '已存进「我的模型」，可直接复用'
        : '资产已登记（页面没连上/页面里没记），后续可用 asset_id 手动复用',
    },
  };
}

async function previzImportScene(args = {}) {
  const fs2 = require('node:fs'), path = require('node:path');
  const sceneId = String(args.scene_id || '');
  if (!sceneId) return { ok: false, error: '缺少 scene_id' };
  const dir = path.join(vfStudioDir(), 'scenes', sceneId);
  if (!fs2.existsSync(dir)) return { ok: false, error: '找不到白膜场景：' + sceneId };
  const files = fs2.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).sort();
  if (!files.length) return { ok: false, error: '场景没有 revision 文件' };
  const doc = JSON.parse(fs2.readFileSync(path.join(dir, files[files.length - 1]), 'utf8'));
  const map = {};                                   // 旧 asset id → 新 asset 元数据
  const failed = [];
  for (const a of (doc.assets || [])) {
    const id = a.id;
    if (map[id]) continue;
    const hit = previzAssetPath(id);
    if (!hit) { failed.push(id); continue; }
    const up = await uploadAssetFromDisk(hit.glb, hit.name);
    if (up.ok) map[id] = up.data; else failed.push(id + ':' + (up.error || 'upload failed'));
  }
  const objects = (doc.instances || []).map(inst => {
    const up = map[inst.asset_id];
    return {
      instanceId: inst.id,
      previz_asset_id: inst.asset_id,
      externalAsset: up ? { id: up.id, name: up.name || inst.asset_id, file_url: '/api/studio/assets/' + up.id + '/file', sha256: up.sha256 || '' } : null,
      p: canonPoint(inst.position),
      q: canonQuat(inst.quaternion),
      scale: Array.isArray(inst.scale) && inst.scale.length === 3 ? inst.scale.map(Number) : [1, 1, 1],
    };
  });
  const cam = doc.camera || {};
  const camera = { vertical_fov: cam.vertical_fov || null,
    keys: (cam.keys || []).map(k => ({ frame: k.frame, position: canonPoint(k.position), target: canonPoint(k.target), roll: k.roll || 0, vertical_fov: k.vertical_fov || cam.vertical_fov || 45 })) };
  const jb = previzJobForScene(sceneId);
  return { ok: true, data: {
    scene_id: doc.scene_id || sceneId, revision: doc.revision, title: '白膜 · ' + String(doc.scene_id || sceneId).slice(-8),
    objects, camera, render: doc.render || null, object_tracks: doc.object_tracks || null,
    assets: Object.entries(map).map(([oldId, a]) => ({ previz_asset_id: oldId, asset: a })),
    failed_assets: failed,
    job_id: jb ? jb.job_id : null,
    thumb_url: jb ? ('/api/studio/renders/' + encodeURIComponent(jb.job_id) + '/files/frame_000000.png') : null,
    imported_at: Date.now(),
  } };
}

/* ==== FRAME PROGRESS v35 ==== */
/** 帧级进度：直接扫 VideoForge 任务目录，返回已渲染帧数 + 最新帧 URL */
async function renderFrames(args = {}) {
  try {
    const path = require('node:path'), fsp = require('node:fs');
    const jobId = String(args.job_id || '');
    if (!jobId) return { ok: false, error: '缺少 job_id' };
    // ★ 2026-11-10：用 vfStudioDir()（会认 VIDEOFORGE_DATA_DIR），
    //   别再写死 %LOCALAPPDATA% —— 数据在 D 盘时这里会扫不到任何帧。
    const base = path.join(vfStudioDir(), 'jobs', jobId);
    const framesDir = path.join(base, 'frames');
    let files = [];
    try { files = fsp.readdirSync(framesDir).filter(f => /^frame_\d+\.png$/.test(f)).sort(); } catch (_) { files = []; }
    const latest = files.length ? files[files.length - 1] : null;
    const idx = latest ? Number(latest.match(/(\d+)/)[1]) : -1;
    let total = Number(args.total) || null;
    if (!total) {
      // 渲染早期 manifest 还没出来：先看 input.json（任务开始就有），再看 job.json
      try {
        const inp = JSON.parse(fsp.readFileSync(path.join(base, 'input.json'), 'utf8'));
        total = inp.scene?.render?.frame_count || inp.render?.frame_count || null;
      } catch (_) {}
    }
    if (!total) {
      try {
        const jj = JSON.parse(fsp.readFileSync(path.join(base, 'job.json'), 'utf8'));
        total = jj.manifest?.render?.frame_count || jj.frame_count || jj.render?.frame_count || jj.scene?.render?.frame_count || jj.request?.scene?.render?.frame_count || null;
      } catch (_) {}
    }
    return {
      ok: true,
      data: {
        job_id: jobId,
        frames_dir: framesDir,
        count: files.length,
        latest_index: idx,
        total,
        latest_url: latest ? '/api/studio/renders/' + encodeURIComponent(jobId) + '/files/' + latest : null,
        latest_path: latest ? path.join(framesDir, latest) : null,
      },
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
/* ==== FRAME PROGRESS v35 ==== */
/**
 * ★ 2026-11-10：**包一层 try/catch**。
 *   之前 callTool 里任何一处抛异常都会**打死整个桥进程**
 *   （实测：wb_splat_cmd 的路径写错 → 404 → throw → 桥崩
 *     ⇒ 之后所有工具全部 "Failed to fetch"）。
 *   一个工具调用不该让整个 agent 服务下线。
 */
async function callTool(name, args = {}) {
  try {
    return await callToolInner(name, args || {});
  } catch (err) {
    const msg = String((err && err.message) || err || '未知错误');
    console.error('[wbwb] 工具异常 ' + name + ': ' + msg);
    return { ok: false, error: '工具 ' + name + ' 执行失败：' + msg };
  }
}

async function callToolInner(name, args = {}) {
  // v35：帧级进度
  if (name === 'wb_render_frames') return renderFrames(args);
  // ★ 2026-11-08 真实世界：wb_world_build(kind=osm) 是**服务端**工具
  //   （要跑 Overpass 抓取 + 落盘缓存），拿到 URL 后再让页面去建几何。
  if (name === 'wb_world_build' && String(args.kind || '') === 'osm') {
    const r = await getOsmWorld({
      lat: args.lat, lng: args.lng, radius: args.radius,
      force: boolArg(args.force), outDir: OUT_DIR, maxBuildings: args.maxBuildings,
      refetch: boolArg(args.refetch),
      timeoutMs: args.timeoutMs,
    });
    if (!r.ok) return r;
    // ★ 绝对地址：/osm/world/ 路由挂在**桥**（8787）上，不是静态服务器（8802）。
    //   之前给的是相对路径，页面 fetch 时打到 8802 → 404（实测过）。
    const absUrl = 'http://127.0.0.1:' + PORT + r.url;
    // ★ 2026-11-08 地形高程：真实世界的地面不该是平的。
    //   取不到就降级成平地（不阻塞主流程）。
    let terrain = null;
    if (args.terrain !== false) {
      try {
        const span = Math.max(400, Math.min(6000, Number(args.spanMeters) || Math.max(600, r.world.size * 1.1)));
        const t = await getTerrain({
          lat: args.lat, lng: args.lng,
          spanMeters: span, res: Number(args.terrainRes) || 64,
          outDir: OUT_DIR, timeoutMs: 12000,
        });
        if (t.ok) terrain = t;
      } catch (_) { terrain = null; }
    }
    let page = null;
    try {
      page = await pageCall('world.osm', {
        url: absUrl,
        attribution: r.world.attribution,
        stats: r.world.stats,
        size: r.world.size,
        // ★ 2026-11-10：**把城市名带下去** ⇒ 入口页「继续上次：上海黄浦区」
        //   而不是「继续上次：31.2304, 121.4737」
        name: args.name || null,
        terrain: terrain ? terrain.grid : null,
        terrainStats: terrain ? terrain.stats : null,
      }, 60000);
    } catch (e) {
      page = { ok: false, error: String((e && e.message) || e) };
    }
    return {
      ok: true, key: r.key, url: absUrl, meta: r.meta,
      stats: r.world.stats, attribution: r.world.attribution,
      terrain: terrain ? terrain.stats : null,
      warning: r.warning || null, page,
    };
  }
  if (name === 'wb_world_list') {
    return { ok: true, worlds: listCachedWorlds(OUT_DIR), attribution: '© OpenStreetMap contributors' };
  }
  // ★ 2026-11-08 资产库（落盘持久化）
  if (name === 'wb_library_list') {
    return { ok: true, ...libraryList(OUT_DIR, { kind: args.kind, category: args.category, q: args.q }) };
  }
  if (name === 'wb_library_add') {
    return libraryAdd(args.item || args, OUT_DIR);
  }
  if (name === 'wb_library_remove') {
    return libraryRemove(args.id, OUT_DIR);
  }
  if (name === 'wb_library_import_model') {
    // 从收件箱或任意本地路径把 GLB 收进资产库（复制进 models/，不依赖外部进程）
    const f = resolveInboxFile(args.file || args.name, OUT_DIR);
    if (!f.ok) return { ok: false, error: f.error };
    const prov = provenance(f.name, args.source);
    const r = libraryImportModel(f.path, {
      id: args.id || f.name.replace(/\.[^.]+$/, ''),
      name: args.asset_name || f.name,
      category: args.category || 'prop',
      source: prov.source,
      attribution: (findSource(prov.source) || {}).credit || null,
      thumb: args.thumb || null,
      note: args.note || '',
    }, OUT_DIR);
    if (!r.ok) return r;
    return { ok: true, item: r.item, provenance: prov };
  }
  if (name === 'wb_library_save_world') {
    // 把"当前世界"存成资产库里的场景模型
    const cap = await pageCall('preset.capture', { name: args.name }, 30000);
    if (!cap || !cap.ok) return { ok: false, error: (cap && cap.error) || '抓不到当前状态' };
    const st = cap.data && cap.data.state ? cap.data.state : cap.data;
    const r = librarySaveWorld(st.spec, args.name, OUT_DIR, {
      thumb: cap.data && cap.data.thumb ? cap.data.thumb : null,
      attribution: (st.spec && st.spec.attribution) || null,
      stats: st.spec ? null : null,
    });
    return r;
  }
  if (name === 'wb_library_save_material') {
    // 把当前选中对象的材质存成可复用材质
    const cap = await pageCall('material.capture', {}, 20000);
    if (!cap || !cap.ok) return { ok: false, error: (cap && cap.error) || '抓不到当前材质' };
    return libraryAdd({
      id: args.name, kind: 'material', category: 'material', name: args.name,
      material: cap.data && cap.data.material ? cap.data.material : cap.data,
      source: 'local',
    }, OUT_DIR);
  }
  if (name === 'wb_library_save_light') {
    const cap = await pageCall('light.capture', {}, 20000);
    if (!cap || !cap.ok) return { ok: false, error: (cap && cap.error) || '抓不到当前灯光' };
    return libraryAdd({
      id: args.name, kind: 'light', category: 'light', name: args.name,
      light: cap.data && cap.data.light ? cap.data.light : cap.data,
      source: 'local',
    }, OUT_DIR);
  }
  // ★ 2026-11-08 预设库：存画面、随时调出来
  if (name === 'wb_preset_list') {
    return { ok: true, dir: presetDir(OUT_DIR), presets: listPresets(OUT_DIR) };
  }
  if (name === 'wb_preset_save') {
    // 页面侧负责"把当前状态拍成快照"，这里负责落盘
    const cap = await pageCall('preset.capture', { name: args.name }, 30000);
    if (!cap || !cap.ok) return { ok: false, error: (cap && cap.error) || '抓不到当前状态' };
    const st = cap.data && cap.data.state ? cap.data.state : cap.data;
    const thumb = cap.data && cap.data.thumb ? cap.data.thumb : (args.thumb || null);
    const r = savePreset({
      id: args.name, name: args.name, note: args.note || '',
      spec: st.spec, env: st.env, size: st.size, camera: st.camera,
      light: st.light, assets: st.assets, interior: st.interior,
      attribution: args.attribution || (st.spec && st.spec.attribution) || null,
      source: args.source || (st.spec && st.spec.kind) || null,
      thumb,
    }, OUT_DIR);
    return r;
  }
  if (name === 'wb_preset_load') {
    const r = readPreset(args.id, OUT_DIR);
    if (!r.ok) return r;
    const page = await pageCall('preset.restore', { state: r.preset }, 90000);
    return { ok: page.ok !== false, preset: { id: r.preset.id, name: r.preset.name, attribution: r.preset.attribution }, page };
  }
  if (name === 'wb_preset_delete') {
    return deletePreset(args.id, OUT_DIR);
  }
  if (name === 'wb_preset_rename') {
    return updatePreset(args.id, { name: args.name, note: args.note }, OUT_DIR);
  }
  // ★ 批量出图：页面侧按多机位渲染，桥侧落盘
  if (name === 'wb_render_batch') {
    const page = await pageCall('render.batch', {
      shots: args.shots || [], w: args.w, h: args.h, save: args.save !== false,
    }, 180000);
    if (!page || !page.ok) return { ok: false, error: (page && page.error) || '批量出图失败', data: page };
    return { ok: true, ...page.data, out_dir: OUT_DIR };
  }
  // ★ 存一张图（批量出图用）
  if (name === 'wb_shot_save') {
    const b64 = String(args.base64 || '');
    if (!b64) return { ok: false, error: '缺少 base64' };
    const npath = require('node:path');
    const nfs = require('node:fs');
    const name = String(args.name || 'shot.jpg').replace(/[\\/:*?"<>|]+/g, '_');
    const dir = npath.join(OUT_DIR, '批量出图');
    nfs.mkdirSync(dir, { recursive: true });
    const p = npath.join(dir, name);
    nfs.writeFileSync(p, Buffer.from(b64, 'base64'));
    return { ok: true, path: p, bytes: nfs.statSync(p).size };
  }
  // ★ 分享链接（状态即链接）
  if (name === 'wb_share_link') {
    const page = await pageCall('share.link', {}, 20000);
    if (!page || !page.ok) return { ok: false, error: (page && page.error) || '生成链接失败' };
    return { ok: true, url: page.data.url, code: page.data.code };
  }
  // ★ 2026-11-08 外部素材源：目录 + 收件箱
  if (name === 'wb_source_list') {
    return { ok: true, ...sourceCatalog(scanInbox(OUT_DIR)) };
  }
  if (name === 'wb_inbox_scan') {
    return { ok: true, inbox: scanInbox(OUT_DIR) };
  }
  if (name === 'wb_inbox_import') {
    const f = resolveInboxFile(args.file || args.name, OUT_DIR);
    if (!f.ok) return { ok: false, error: f.error };
    // 只有模型能进资产库（图/场景走各自的导入通道）
    if (!/\.(glb|gltf)$/i.test(f.name)) {
      return { ok: false, error: '只有 .glb/.gltf 能进资产库；图片请用「导入 3D 模型」通道，场景 JSON 用场景导入', file: f.name };
    }
    const prov = provenance(f.name, args.source);
    // ★ 2026-11-08：直接收进**资产库**（复制进 资产库/models/）。
    //   之前走的是 uploadAssetFromDisk（要 VideoForge 客户端 8765 在跑），
    //   结果没开 Blender 时点「导入」什么也不会发生 —— 这就是"按钮点了没反应"的根因。
    const lib = libraryImportModel(f.path, {
      id: args.id || f.name.replace(/\.[^.]+$/, ''),
      name: args.asset_name || f.name,
      category: args.category || 'prop',
      source: prov.source,
      attribution: (findSource(prov.source) || {}).credit || null,
      thumb: args.thumb || null,
      note: args.note || '',
    }, OUT_DIR);
    if (!lib.ok) return lib;
    return {
      ok: true,
      file: f.name,
      asset: lib.item,
      provenance: prov,
      credit: (findSource(prov.source) || {}).credit || null,
      libraryDir: libDir(OUT_DIR),
    };
  }

  if (name === 'wb_render_save') return renderSave(args);
  if (name === 'wb_caps') return caps(args);
  // v72 白膜资产回收
  if (name === 'wb_previz_list') return previzList();
  if (name === 'wb_previz_import_model') return previzImportModel(args);
  if (name === 'wb_asset_deposit') return assetDeposit(args);
  if (name === 'wb_previz_import_scene') return previzImportScene(args);
  // v33 交接层：磁盘 GLB 登记 / 一键流水线 / 交接体检
  if (name === 'wb_asset_upload') return uploadAssetFromDisk(args.path || args.glb_path, args.name);
  if (name === 'wb_handoff') return handoff(args);
  if (name === 'wb_handoff_check') return handoffCheck(args);

  // ★ 棚拍场景模式（SuperSplat）：把工具调用投进 sidecar 的命令队列，
  //   客户端里的 SuperSplat 轮询取走 → postMessage 执行 → 回传结果。
  if (name === 'wb_splat_cmd') {
    const tool = String(args.tool || '').trim();
    if (!tool) return { ok: false, error: 'wb_splat_cmd 需要 tool' };
    // ★ 2026-11-10：路径**不能重复 /api/studio** ——
    //   studioPost 的 base 已经带 /api/studio 了，写成 '/api/studio/splat/commands'
    //   会变成 /api/studio/api/studio/splat/commands ⇒ 404 ⇒ 抛异常。
    //   而这个异常**没人接** ⇒ 整个桥进程崩掉（实测：崩一个，后面所有工具全 "Failed to fetch"）。
    const res = await studioPost('/splat/commands', { tool, args: args.args || {} });
    if (res && res.__notFound) return { ok: false, error: res.error };
    return { ok: true, command: (res && res.command) || res };
  }
  if (name === 'wb_splat_results') {
    const res = await studioGet('/splat/results');
    if (res && res.__notFound) return { ok: false, error: res.error };
    const all = (res && res.results) || [];
    if (args.id) {
      const one = all.find((r) => r.id === args.id);
      return one ? { ok: true, result: one } : { ok: false, error: `没有命令 ${args.id} 的结果` };
    }
    return { ok: true, results: all.slice(-10) };
  }
  if (name === 'wb_splat_tools') {
    // ★ 2026-11-10：这个工具**注册了但没实现**（调它只会得到"未知工具"）。
    //   给一份可用的工具清单（来自 sidecar 的能力描述，缺了就用内置的兜底清单）。
    const FALLBACK = [
      ['get_scene', '读取当前场景'],
      ['set_camera', '设机位：view=top/front/back/left/right/bottom 或 position+target 或 azimuth/elevation/distance/fov'],
      ['focus_camera', '聚焦（scope 必填：selection|layer|scene）'],
      ['capture_viewport', '把当前视口渲染成 PNG（width/height/filename）'],
      ['set_view', '显示选项：背景/网格/色调映射'],
      ['select_region', '选区'], ['select_rectangle', '矩形选区'], ['select_property', '按属性选'],
      ['transform', '移动/旋转/缩放选中'],
      ['apply_color', '上色'], ['reset_color', '重置颜色'],
      ['undo', '撤销'], ['redo', '重做'],
      ['import_url', '导入场景文件'], ['export_scene', '导出场景'],
    ];
    try {
      const res = await studioGet('/splat/tools');
      if (res && !res.__notFound) {
        const tools = res.tools || res.items || res;
        if (Array.isArray(tools) && tools.length) return { ok: true, tools, source: 'sidecar' };
        if (tools && typeof tools === 'object') return { ok: true, tools, source: 'sidecar' };
      }
    } catch (_) { /* sidecar 没这个接口就用内置清单 */ }
    return { ok: true, source: 'builtin', tools: FALLBACK.map(([name, desc]) => ({ name, description: desc })) };
  }

  // Once a Blender job exists, polling/cancelling/binding must survive a closed browser page.
  let studioPath, studioBody;
  if (name === 'wb_studio_render') {
    // 电商棚拍：**场景 + 物品 + 效果**（3ds Max 那一套），不是"换预设的白膜"。
    //   · 物品：objects[] 多个受管资产，各自带位置/旋转/缩放（单物品时仍可用 asset_id）
    //   · 场景：preset 是场景模板，environment/lights 可逐项覆盖
    //   · 效果：景深 / 运动模糊 / 辉光 / 颗粒
    const single = String(args.asset_id || '');
    const objects = Array.isArray(args.objects) ? args.objects : [];
    if (!single && objects.length === 0) return { ok: false, error: 'wb_studio_render 需要 asset_id 或 objects[]' };
    const w = Math.max(64, Math.min(1920, Math.round(Number(args.w) || 900)));
    const h = Math.max(64, Math.min(1920, Math.round(Number(args.h) || 900)));
    const cam = args.camera && typeof args.camera === 'object' ? args.camera : {};
    const position = Array.isArray(cam.position) && cam.position.length === 3 ? cam.position : [0.34, -0.55, 0.24];
    const target = Array.isArray(cam.target) && cam.target.length === 3 ? cam.target : [0, 0, 0.045];
    const fov = Number(cam.vertical_fov) || 32;
    // ── 物品清单 ──
    const items = objects.length
      ? objects
      : [{ asset_id: single, position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] }];
    const instances = [];
    const assets = [];
    // ★ 实例 id 必须是合法 ID（字母/数字/下划线/短横线）——
    //   直接拿商品名当 id（"mug_blue.glb" 带点）⇒ 后端报 "ID只能包含字母、数字、下划线和短横线"。
    const usedIds = new Set();
    const sanitizeId = (raw, index) => {
      let id = String(raw || '').replace(/[^0-9A-Za-z_-]/g, '_').replace(/^_+/, '');
      if (!id) id = 'object_' + index;
      let candidate = id, n = 1;
      while (usedIds.has(candidate)) { candidate = id + '_' + n; n++; }
      usedIds.add(candidate);
      return candidate;
    };
    items.forEach((item, index) => {
      const assetId = String(item.asset_id || item.id || '');
      if (!assetId) return;
      if (!assets.some((a) => a.id === assetId)) assets.push({ id: assetId });
      const position3 = Array.isArray(item.position) && item.position.length === 3 ? item.position : [0, 0, 0];
      const quaternion = Array.isArray(item.quaternion) && item.quaternion.length === 4
        ? item.quaternion
        : [0, 0, 0, 1];
      const scale = Array.isArray(item.scale) && item.scale.length === 3 ? item.scale : [1, 1, 1];
      instances.push({
        id: sanitizeId(item.name || item.id || ('object_' + index), index),
        asset_id: assetId, position: position3, quaternion, scale,
      });
    });
    if (instances.length === 0) return { ok: false, error: 'objects 里没有有效的 asset_id' };
    const scene = {
      schema: 'videoforge.scene/1',
      // ★ 每次渲染用**唯一 scene_id**（revision 固定 1）：
      //   固定 id + 固定 revision 会被后端判成"场景版本已存在，修改请增加 revision"，
      //   第二次渲染直接被拒（实测踩过）。调用方也可以显式传 scene_id/revision 覆盖。
      scene_id: String(args.scene_id || ('studio_shot_' + Date.now().toString(36))),
      revision: Number(args.revision || 1),
      coordinates: { up: 'Z', handedness: 'right', unit: 'meter' },
      assets,
      instances,
      camera: { vertical_fov: fov, keys: [{ frame: 0, position, target, roll: 0, vertical_fov: fov }] },
      object_tracks: [],
      render: { width: w, height: h, fps: 24, frame_count: Math.max(1, Math.min(120, Math.round(Number(args.frames) || 1))) },
    };
    const studio = {
      preset: args.preset || 'white_seamless',
      engine: 'cycles',
      samples: Math.max(32, Math.min(512, Math.round(Number(args.samples) || 128))),
      // ★ 默认 keep：保留 GLB 自带的真实材质（"真实色彩"的前提）
      product_material: args.product_material || 'keep',
      auto_exposure: true,
    };
    if (args.environment && typeof args.environment === 'object') studio.environment = args.environment;
    if (args.lights && typeof args.lights === 'object') studio.lights = args.lights;
    if (args.effects && typeof args.effects === 'object') studio.effects = args.effects;
    // ★ drop_to_floor：按包围盒把物体落到地面（否则 GLB 原点不在底部 ⇒ 商品半悬空）
    if (args.drop_to_floor !== undefined) studio.drop_to_floor = boolArg(args.drop_to_floor);
    studioPath = '/renders';
    studioBody = { scene, studio, ...(args.project_id ? { project_id: args.project_id } : {}), ...(args.shot_id ? { shot_id: args.shot_id } : {}) };
  }
  if (name === 'wb_studio_assets') {
    // 列出 **受管资产**（棚拍能直接用的 GLB）——页面侧跨域取不到，走桥中转。
    // ★ 2026-11-10：base 用**探测到的**地址，别写死 8765（sidecar 端口是随机的）。
    try {
      const response = await fetch((await studioBaseUrl()) + '/assets', { signal: AbortSignal.timeout(15000) });
      const result = await response.json();
      if (!response.ok || result.code !== '000000') return { ok: false, error: result.detail?.message || '取受管资产失败' };
      return { ok: true, data: { assets: result.data?.assets || [] } };
    } catch (error) { return { ok: false, error: 'Blender服务不可用：' + error.message }; }
  }
  if (name === 'wb_studio_samples') {
    // 把随包样例商品（agent-side/products/*.glb）登记进 8765 受管资产库，返回可直接开拍的 asset 列表。
    // ★ 样例是**程序化生成**的（make_product.py）⇒ 自己的模型 = 可商用。
    // ★ ESM 里没有 `__dirname`（踩过：直接把桥搞崩了）⇒ 用文件里统一的 require 写法。
    const fs2 = require('node:fs'), path = require('node:path');
    const dir = path.join(require('node:path').dirname(require('node:url').fileURLToPath(import.meta.url)), '..', 'agent-side', 'products');
    const wanted = ['mug_blue.glb', 'can_red.glb', 'bottle_mint.glb'];
    const out = [];
    for (const file of wanted) {
      const full = path.join(dir, file);
      if (!fs2.existsSync(full)) continue;
      const bytes = fs2.readFileSync(full);
      const form = new FormData();
      form.append('file', new Blob([bytes]), file);
      try {
        // ★ 2026-11-10：base 用探测到的地址（sidecar 端口随机，写死 8765 会 fetch failed）
        const response = await fetch((await studioBaseUrl()) + '/assets', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
        const result = await response.json();
        if (response.ok && result.code === '000000' && result.data?.id) {
          out.push({ id: result.data.id, name: file.replace(/\.glb$/, ''), bytes: bytes.length, group: 'sample' });
        }
      } catch (error) { /* 某个样例失败就跳过，不影响其它 */ }
    }
    return { ok: true, data: { assets: out } };
  }
  if (name === 'wb_render_status') studioPath = '/renders/' + encodeURIComponent(args.job_id || '');  if (name === 'wb_render_cancel') { studioPath = '/renders/' + encodeURIComponent(args.job_id || '') + '/cancel'; studioBody = {}; }
  if (name === 'wb_render_bind') { studioPath = '/renders/' + encodeURIComponent(args.job_id || '') + '/bind'; studioBody = { project_id: args.project_id, shot_id: args.shot_id }; }
  if (name === 'wb_render_submit' && args.scene) { studioPath = '/renders'; studioBody = { scene: args.scene, ...(args.project_id ? {project_id:args.project_id} : {}), ...(args.shot_id ? {shot_id:args.shot_id} : {}), ...(args.idempotency_key ? {idempotency_key:args.idempotency_key} : {}), ...(args.studio ? {studio:args.studio} : {}) }; }
  if (studioPath) {
    try {
      // ★ 2026-11-10：base 用探测到的地址（sidecar 端口随机，写死 8765 ⇒ "Blender服务不可用：fetch failed"）
      const response = await fetch((await studioBaseUrl()) + studioPath, { method: studioBody ? 'POST' : 'GET',
        headers: {'Content-Type':'application/json'}, ...(studioBody ? {body:JSON.stringify(studioBody)} : {}), signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      if (!response.ok || result.code !== '000000') return {ok:false,error:result.detail?.message || result.detail || result.message || 'Blender服务请求失败'};
      return {ok:true,data:result.data};
    } catch (error) { return {ok:false,error:'Blender服务不可用：' + error.message}; }
  }
  const spec = TOOL_MAP[name];
  if (!spec) return { ok: false, error: '未知工具：' + name };
  const [cmd, mapArgs] = spec;
  if (cmd === '__raw') return dispatch(args.cmd, args.args || {});
  if (cmd === '__light') {
    const { preset, ...rest } = args;
    if (preset) return dispatch('light.preset', { name: preset });
    return dispatch('light.set', rest);
  }
  return dispatch(cmd, mapArgs(args));
}

function reply(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function startMcp() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    const s = line.trim();
    if (!s) return;
    let msg;
    try { msg = JSON.parse(s); } catch (_) { return; }
    const { id, method, params } = msg;

    if (method === 'initialize') {
      reply({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'openvideoforge', version: '0.9.0' },
        },
      });
      return;
    }
    if (method === 'notifications/initialized') return;

    if (method === 'tools/list') {
      reply({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.schema })) } });
      return;
    }

    if (method === 'tools/call') {
      const name = params && params.name;
      const args = (params && params.arguments) || {};
      const out = await callTool(name, args);
      // ★ 载荷再大也必须是**能解析的 JSON**。
      //   以前这里 `JSON.stringify(out, null, 2).slice(0, 20000)` —— 超过 20000 字符
      //   就把 JSON **拦腰切断**，客户端解析必炸（2026-10-26 实测：
      //   wb_previz_list 在本机 83 模型/43 场景/125 任务时直接"没有返回"）。
      //   现在：上限放大到 2MB；真超了也返回**合法 JSON**（带 truncated 说明），
      //   绝不返回半截字符串。
      const LIMIT = 2 * 1024 * 1024;
      let text = JSON.stringify(out, null, 2);
      if (text.length > LIMIT) {
        text = JSON.stringify({
          ok: out && out.ok !== false,
          error: '载荷过大（' + text.length + ' 字符），已省略；请缩小查询范围（例如 wb_previz_list 的 limit 参数）',
          truncated: true,
          bytes: text.length,
        }, null, 2);
      }
      reply({
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text }],
          isError: !out.ok,
        },
      });
      return;
    }

    if (method === 'ping') { reply({ jsonrpc: '2.0', id, result: {} }); return; }

    if (id !== undefined) {
      reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
    }
  });
}

/* ------------------------------------------------------------ */
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    forwardOnly = true;
    console.error(`[agent-bridge] 端口 ${PORT} 已有桥在跑 → 本进程只提供 MCP，转发给它`);
    if (MCP) startMcp();
    return;
  }
  console.error('[agent-bridge] error', err);
});

server.listen(PORT, '127.0.0.1', () => {
  const line = `[agent-bridge] http://127.0.0.1:${PORT}  (页面连 /events)`;
  if (MCP) {
    // stdio 是 MCP 通道，日志只能走 stderr
    console.error(line);
    console.error('[agent-bridge] MCP over stdio ready');
    startMcp();
  } else {
    console.log(line);
    console.log('[agent-bridge] POST /cmd {"name":"state.get","args":{}}');
  }
  // ★ 2026-11-10：**顺手把 VideoForge 后端拉起来**。
  //   没有它，「拍成片」会报"Blender服务不可用"，用户得先手动开 PowerShell。
  //   已经在跑就复用；拉不起来也**不影响桥**（openVideoForge 照常用，只是没有白膜渲染）。
  setTimeout(async () => {
    try {
      const mod = await import('./vf-autostart.mjs?v=77');
      const r = await mod.autostartVideoForge();
      if (r.ok && !r.already) console.error('[agent-bridge] VideoForge 后端已自动拉起：' + r.port);
      else if (!r.ok && !r.skipped) console.error('[agent-bridge] VideoForge 后端未就绪（不影响使用）：' + (r.error || ''));
    } catch (e) {
      console.error('[agent-bridge] 自动拉起 VideoForge 失败（不影响使用）：' + String((e && e.message) || e));
    }
  }, 1500);
});
