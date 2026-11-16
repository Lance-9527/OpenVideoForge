/* ============================================================================
 * server/osm.mjs —— 真实世界：Overpass 抓取 + **本地落盘缓存**
 *
 * 设计口径（用户：「本地可掌握」）：
 *   · 只在小范围查询时才联网，**抓到的原始数据立刻落盘**；
 *   · 之后同一地点/半径直接读缓存，断网也能重放同一座真实街区；
 *   · 缓存 TTL 7 天，过期不自动删（只标记），想刷新才 `force`。
 *
 * 版权：数据是 OpenStreetMap（ODbL）。唯一义务是**对外发布作品时署名**
 *   「© OpenStreetMap contributors」。normalizeOsm() 会把 attribution 带在
 *   world 里，出片/导出时写进片尾或字幕即可。
 *
 * 不碰任何第三方工具的代码或产物 —— 这条链路只依赖 OSM 官方 API 与本地磁盘。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { defaultOutDir as defaultOutDirFallback } from './paths.mjs';
import {
  bboxFromLatLng, overpassQuery, normalizeOsm, OSM_ATTRIBUTION,
} from '../js/worldgen/osm-parse.js';

const TTL_MS = 7 * 24 * 3600 * 1000;
const ENDPOINTS = [
  // ★ 2026-11-10：**实测通的端点排前面**。
  //   网络环境实测（2026-11-10）：
  //     overpass.osm.ch          → ✅ 0.6s 但**只覆盖瑞士**（别处返 0 元素）
  //     overpass-api.de          → ✅ **全球**，但慢（37s+），忙时 502
  //     overpass.kumi.systems    → ❌ 连接超时
  //     overpass.openstreetmap.ru→ ❌ 连接超时
  //     overpass.osm.jp          → ❌ 连接超时
  //     overpass.private.coffee  → ❌ 连接超时
  //
  //   ⇒ osm.de 放**第一**（它是全球的）；osm.ch 放第二当"瑞士走快捷通道"。
  //   fetchOverpass 会在多个端点里**选第一个有元素的**，所以顺序影响的是速度不是正确性。
  'https://overpass-api.de/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/**
 * 缓存目录的默认位置。
 * @returns {string} 产物目录。
 */
export function defaultOutDir() {
  return process.env.WBWB_OUT_DIR || defaultOutDirFallback();
}

export function cacheDir(outDir) {
  const d = path.join(outDir || defaultOutDir(), 'osm-cache');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** 缓存键：5 位小数（≈1.1m）足够，半径取整到 10m，避免每次微调都重抓 */
export function worldKey(lat, lng, radius) {
  const la = (Math.round(lat * 1e5) / 1e5).toFixed(5);
  const ln = (Math.round(lng * 1e5) / 1e5).toFixed(5);
  const r = Math.round(radius / 10) * 10;
  return `${la}_${ln}_${r}`;
}

export function readCache(key, outDir) {
  const dir = cacheDir(outDir);
  const f = path.join(dir, key + '.world.json');
  if (!fs.existsSync(f)) return null;
  try {
    const st = fs.statSync(f);
    const world = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { world, fetchedAt: st.mtimeMs, ageMs: Date.now() - st.mtimeMs, fresh: Date.now() - st.mtimeMs < TTL_MS, file: f };
  } catch (e) {
    return null;
  }
}

/** 原始 Overpass 数据的落盘路径（★ 重算 world 时复用，不用重抓） */
export function rawPath(key, outDir) {
  return path.join(cacheDir(outDir), key + '.raw.json');
}

export function writeCache(key, world, raw, outDir) {
  const dir = cacheDir(outDir);
  const wf = path.join(dir, key + '.world.json');
  const rf = path.join(dir, key + '.raw.json');
  fs.writeFileSync(wf, JSON.stringify(world));
  if (raw) fs.writeFileSync(rf, JSON.stringify(raw));
  return { world: wf, raw: raw ? rf : null, bytes: fs.statSync(wf).size };
}

/**
 * 抓 Overpass：带超时 + 端点回退 + `remark` 错误识别 + **502 重试**
 *
 * ★ 2026-11-10 实测（这台机器的网络环境）：
 *   · overpass-api.de        → ✅ 全球，但**慢**（简单查询 37 秒；复杂查询更久）
 *                              忙的时候返回 502（"server at capacity"）
 *   · overpass.osm.ch        → ✅ 快（0.6s）但**只覆盖瑞士** ⇒ 别处返回 0 元素
 *   · kumi / ru / jp / coffee → ❌ 连不上（CONNECT_TIMEOUT）
 *
 *   ⇒ 三条改法：
 *   ① 超时从 60s 放大到 **180s**（osm.de 慢）
 *   ② 502 视为"忙"，**原地重试** 2 次再换端点
 *   ③ 多端点时**选第一个 elements > 0 的** —— 否则 osm.ch 的"0 元素"会把全球查询废掉
 */
export async function fetchOverpass(bbox, opts = {}) {
  const ql = overpassQuery(bbox, opts.timeoutSec || 180);
  const timeoutMs = opts.timeoutMs || 200000;
  const endpoints = opts.endpoints || ENDPOINTS;
  let lastErr = null;
  const empty = [];          // 成功但 0 元素的结果（留作兜底）
  for (const url of endpoints) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'openVideoForge/0.9 (+local previz tool)',
          },
          body: 'data=' + encodeURIComponent(ql),
          signal: ac.signal,
        });
        clearTimeout(t);
        if (!r.ok) {
          lastErr = new Error('HTTP ' + r.status + ' @ ' + url);
          // 502/503/429 = "服务器忙" ⇒ 等一下原地重试
          if (r.status === 502 || r.status === 503 || r.status === 429) {
            await new Promise((s) => setTimeout(s, 3000 * (attempt + 1)));
            continue;
          }
          break;   // 别的错误 → 换端点
        }
        const txt = await r.text();
        const raw = JSON.parse(txt);
        if (raw.remark) { lastErr = new Error('Overpass remark: ' + raw.remark); break; }
        if (!Array.isArray(raw.elements)) { lastErr = new Error('返回里没有 elements'); break; }
        if (!raw.elements.length) {
          // ★ 成功但空 —— 记下来，继续试下一个端点
          //   （osm.ch 对瑞士以外一律返回空，会把全球查询废掉）
          empty.push({ raw, endpoint: url, bytes: txt.length });
          lastErr = new Error('0 元素 @ ' + url);
          break;
        }
        return { ok: true, raw, endpoint: url, bytes: txt.length };
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise((s) => setTimeout(s, 2000));
      }
    }
  }
  // 所有端点都返回空 ⇒ 那个空结果也是合法答案（真的没数据）
  if (empty.length) {
    return { ok: true, raw: empty[0].raw, endpoint: empty[0].endpoint, bytes: empty[0].bytes, emptyAll: true };
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr) };
}

/**
 * 拿到一座真实街区的规范化世界。
 *
 * ★ 2026-11-10 的语义（更清楚，也更快）：
 *   · `force: true`   → **重算** world（用本地 raw.json），不重新问 Overpass。
 *                       解析规则改了（加 relation、按面积推高度…）时用这个，几秒钟出结果。
 *   · `refetch: true` → 连**原始数据**也重抓（想拿更新的 OSM 数据时用，慢：要 1~2 分钟）。
 *
 * @param {object} o { lat, lng, radius, force, refetch, outDir, timeoutMs, maxBuildings }
 */
export async function getOsmWorld(o = {}) {
  const lat = Number(o.lat), lng = Number(o.lng);
  const radius = Number(o.radius) || 400;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { ok: false, error: '缺少 lat / lng（十进制度数）' };
  }
  if (Math.abs(lat) > 85) return { ok: false, error: 'lat 超范围（|lat| ≤ 85）' };
  if (radius < 50 || radius > 3000) return { ok: false, error: 'radius 需在 50–3000 米之间' };

  const key = worldKey(lat, lng, radius);
  const outDir = o.outDir || defaultOutDir();

  // ① 缓存命中且新鲜
  if (!o.force) {
    const hit = readCache(key, outDir);
    if (hit && hit.fresh) {
      // ★ 2026-11-10：**返回结构要和"刚抓完"那条分支一致**。
      //   之前缓存分支不返回 stats / attribution ⇒ 调用方（wb_world_build）
      //   拿到 stats: {}，界面上"抓到多少栋楼"显示不出来（实测踩到）。
      return {
        ok: true, key, world: hit.world,
        url: '/osm/world/' + key + '.json',
        stats: hit.world.stats,
        attribution: OSM_ATTRIBUTION,
        meta: { cached: true, ageHours: +(hit.ageMs / 3600000).toFixed(1), bytes: fs.statSync(hit.file).size, attribution: OSM_ATTRIBUTION },
      };
    }
  }

  // ② 抓取
  // ★ 2026-11-10：**raw 已在本地就不要再抓**。
  //   解析规则改了（比如加了 relation、加了按面积推高度）时，
  //   直接用本地 raw.json 重算 world —— 不用再花 2 分钟去问 Overpass。
  const rawFile = rawPath(key, outDir);
  let got = null;
  let reusedRaw = false;
  if (fs.existsSync(rawFile) && !o.refetch) {
    try {
      const raw = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
      if (raw && Array.isArray(raw.elements) && raw.elements.length) {
        got = { ok: true, raw, endpoint: 'local-cache', bytes: fs.statSync(rawFile).size };
        reusedRaw = true;
      }
    } catch (_) { /* 缓存坏了就重新抓 */ }
  }
  if (!got) {
    const bbox = bboxFromLatLng(lat, lng, radius);
    got = await fetchOverpass(bbox, o);
  }  if (!got.ok) {
    // 抓不到但有过期缓存 ⇒ 降级用旧数据，并如实说明
    const stale = readCache(key, outDir);
    if (stale) {
      return {
        ok: true, key, world: stale.world,
        url: '/osm/world/' + key + '.json',
        stats: stale.world.stats,
        attribution: OSM_ATTRIBUTION,
        meta: {
          cached: true, stale: true, offline: true,
          fetchError: got.error,
          ageHours: +(stale.ageMs / 3600000).toFixed(1),
          attribution: OSM_ATTRIBUTION,
        },
        warning: '联网抓取失败，用的是本机 ' + (stale.ageMs / 86400000).toFixed(1) + ' 天前的缓存（原始数据仍可离线重放）',
      };
    }
    return { ok: false, error: '抓取失败且本地无缓存：' + got.error, key };
  }

  // ③ 规范化 + 落盘
  // ★ 2026-11-10：把 **bbox** 传给 normalizeOsm ——
  //   Overpass 对 relation 会返回完整成员几何（实测黄浦江 relation 跨 -80km~+30km），
  //   不按 bbox 裁剪 ⇒ 江面横跨全场、场景被带偏。
  const world = normalizeOsm(got.raw, { lat, lng }, { maxBuildings: o.maxBuildings, bbox: bboxFromLatLng(lat, lng, radius) });
  const saved = writeCache(key, world, got.raw, outDir);
  return {
    ok: true, key, world,
    url: '/osm/world/' + key + '.json',
    meta: {
      cached: false, stale: false, endpoint: got.endpoint,
      reusedRaw,
      rawBytes: got.bytes, bytes: saved.bytes,
      fetchedAt: new Date().toISOString(),
      attribution: OSM_ATTRIBUTION,
    },
    stats: world.stats,
  };
}

/** 列出本机已缓存的真实世界（离线可用清单） */
export function listCachedWorlds(outDir) {
  const dir = cacheDir(outDir);
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.world.json')) continue;
    const key = f.replace(/\.world\.json$/, '');
    try {
      const st = fs.statSync(path.join(dir, f));
      const m = key.match(/^(-?[\d.]+)_(-?[\d.]+)_(\d+)$/);
      out.push({
        key,
        lat: m ? Number(m[1]) : null,
        lng: m ? Number(m[2]) : null,
        radius: m ? Number(m[3]) : null,
        ageHours: +((Date.now() - st.mtimeMs) / 3600000).toFixed(1),
        fresh: Date.now() - st.mtimeMs < TTL_MS,
        bytes: st.size,
        url: '/osm/world/' + key + '.json',
        attribution: OSM_ATTRIBUTION,
      });
    } catch { /* 坏文件跳过 */ }
  }
  return out.sort((a, b) => a.ageHours - b.ageHours);
}
