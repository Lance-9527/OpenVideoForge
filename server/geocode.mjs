/* ==========================================================================
 * server/geocode.mjs —— 城市名 → 经纬度（**地名解析**）
 *
 * ★ 2026-11-10：为什么加这个
 *   之前「真实世界(OSM)」只能传 **lat/lng/radius**，
 *   等于用户得自己查经纬度 —— "任意选一个城市"根本做不到。
 *   现在：输城市名（中文/英文/别名）⇒ 直接定位并抓取。
 *
 * 两条路：
 *   ① 本地表（server/cities.json，180+ 城市）—— **零延迟、离线可用**
 *   ② Nominatim（OSM 官方地名服务）—— 表里没有的现查
 *      · 必须带 User-Agent（不带 403）
 *      · 使用政策：最多 1 req/s ⇒ 串行 + 缓存
 *
 * 许可口径：
 *   · cities.json 的坐标是公开地理事实（城市中心点）
 *   · Nominatim 返回 © OpenStreetMap contributors
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const UA = 'OpenVideoForge/1.0 (local desktop app; contact: local user)';
/* ★ 2026-11-10：网络实测
 *   nominatim.openstreetmap.org → ❌ CONNECT_TIMEOUT（连不上）
 *   nominatim.openstreetmap.fr → ❌ DNS 解析不了
 *   photon.komoot.io            → ✅ HTTP 200（~2s）⇒ 用它
 *   api.openstreetmap.org       → ❌ CONNECT_TIMEOUT
 *
 *   Photon 是 OSM 生态的地名服务（komoot 运营），返回 GeoJSON，
 *   结构和 Nominatim 不同 ⇒ 这里做适配。
 *   过滤规则：只要 osm_key=place（城市/镇/村/州/国家），不要车站之类。 */
const PHOTON = 'https://photon.komoot.io/api/';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const CACHE_FILE = 'geocode-cache.json';
/** Photon 里我们要的 place 类型（按优先级） */
const PLACE_RANKS = ['city', 'town', 'village', 'municipality', 'county', 'state', 'province', 'country', 'district'];

/* ── 本地城市表 ─────────────────────────────────────────────────────── */
let CITY_TABLE = null;
export function cityTable() {
  if (CITY_TABLE) return CITY_TABLE;
  const p = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'cities.json');
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    CITY_TABLE = Array.isArray(j.cities) ? j.cities : [];
  } catch (_) {
    CITY_TABLE = [];
  }
  return CITY_TABLE;
}

/* ── Nominatim 缓存（落盘，避免重复请求） ──────────────────────────── */
function cachePath(outDir) { return path.join(outDir, CACHE_FILE); }
function readCache(outDir) {
  try { return JSON.parse(fs.readFileSync(cachePath(outDir), 'utf8')); } catch (_) { return {}; }
}
function writeCache(outDir, c) {
  try { fs.writeFileSync(cachePath(outDir), JSON.stringify(c, null, 2), 'utf8'); } catch (_) {}
}

/* ── 本地表模糊匹配 ─────────────────────────────────────────────────── */
/** 归一化：去空格、去行政后缀、小写（用来做城市名匹配） */
function normalize(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[市省州區区縣县自治区特别行政区]/g, '');
}

/**
 * 在本地表里找城市。
 * 匹配顺序：完全相等 → 前缀 → 包含。
 * @returns {object|null}
 */
export function findLocal(query) {
  const list = cityTable();
  if (!list.length) return null;
  const q = normalize(query);
  if (!q) return null;
  // 1) 完全相等（中文名 / 英文名 / 别名）
  for (const c of list) {
    const names = [c.name, c.en, ...(c.aliases || [])];
    if (names.some((n) => normalize(n) === q)) return c;
  }
  // 2) 前缀匹配（"东京" → "东京市"；"纽约" → "纽约市"）
  const byPrefix = list.filter((c) => {
    const names = [c.name, c.en, ...(c.aliases || [])];
    return names.some((n) => normalize(n).startsWith(q) || q.startsWith(normalize(n)));
  });
  if (byPrefix.length) {
    byPrefix.sort((a, b) => String(a.name).length - String(b.name).length);
    return byPrefix[0];
  }
  // 3) 包含匹配
  const byInclude = list.filter((c) => {
    const names = [c.name, c.en, ...(c.aliases || [])];
    return names.some((n) => normalize(n).includes(q));
  });
  if (byInclude.length) {
    byInclude.sort((a, b) => String(a.name).length - String(b.name).length);
    return byInclude[0];
  }
  return null;
}

/** 本地表里的搜索建议（给输入框下拉用） */
export function searchLocal(query, limit = 12) {
  const list = cityTable();
  const q = normalize(query);
  if (!q) return list.slice(0, limit).map((c) => ({ ...c, source: 'local' }));
  const hit = list.filter((c) => {
    const names = [c.name, c.en, c.country, ...(c.aliases || [])];
    return names.some((n) => normalize(n).includes(q));
  });
  hit.sort((a, b) => {
    const aHit = [a.name, a.en, ...(a.aliases || [])].some((n) => normalize(n).startsWith(q)) ? 0 : 1;
    const bHit = [b.name, b.en, ...(b.aliases || [])].some((n) => normalize(n).startsWith(q)) ? 0 : 1;
    return aHit - bHit || String(a.name).length - String(b.name).length;
  });
  return hit.slice(0, limit).map((c) => ({ ...c, source: 'local' }));
}

/* ── Photon（主）/ Nominatim（回退） ───────────────────────────────── */
let lastNominatimAt = 0;

/** 从 Photon 的 GeoJSON 里挑最合适的"城市"（要 place，不要车站） */
function pickPhoton(features) {
  if (!Array.isArray(features) || !features.length) return null;
  const scored = [];
  for (const f of features) {
    const p = f.properties || {};
    const geo = f.geometry || {};
    const coords = geo.coordinates || [];
    if (coords.length < 2) continue;
    const key = p.osm_key || '';
    const val = p.osm_value || '';
    const type = p.osm_type || '';
    let score = -1;
    if (key === 'place') {
      const r = PLACE_RANKS.indexOf(val);
      score = 100 - (r >= 0 ? r : 50);
    } else if (key === 'boundary' && val === 'administrative') {
      score = 40;
    } else if (type === 'R' && p.name) {
      score = 20;
    }
    if (score < 0) continue;
    score -= Math.min(20, String(p.name || '').length / 2);
    scored.push({
      score,
      name: p.name || p.city || p.state || '',
      en: p.name || '',
      country: p.country || '',
      state: p.state || '',
      lat: +(+coords[1]).toFixed(4),
      lng: +(+coords[0]).toFixed(4),
      display: [p.name, p.city, p.state, p.country].filter(Boolean).join(' · '),
      source: 'photon',
    });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  return scored[0];
}

/**
 * 查地名（Photon 优先，Nominatim 回退）。带磁盘缓存（30 天）。
 * @returns {Promise<object|null>}
 */
export async function geocodeNominatim(query, outDir, opt = {}) {
  const key = normalize(query);
  if (!key) return null;
  const cache = readCache(outDir);
  if (cache[key] && Date.now() - (cache[key].at || 0) < 30 * 86400000) {
    return cache[key].hit ? { ...cache[key].hit, cached: true } : null;
  }

  let hit = null;
  // ① Photon（2026-11-10 实测可用：photon.komoot.io HTTP 200 / ~2s）
  try {
    const u = PHOTON + '?q=' + encodeURIComponent(query) + '&limit=8';
    const r = await fetch(u, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh,en' },
      signal: AbortSignal.timeout(Number(opt.timeoutMs) || 12000),
    });
    if (r.ok) {
      const j = await r.json();
      hit = pickPhoton(j && j.features);
    }
  } catch (_) { hit = null; }

  // ② Nominatim 回退（当前网络连不上；换环境后能顶上）
  if (!hit) {
    const wait = 1000 - (Date.now() - lastNominatimAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatimAt = Date.now();
    try {
      const url = NOMINATIM + '?q=' + encodeURIComponent(query) + '&format=json&limit=1&accept-language=zh,en';
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept-Language': 'zh,en' },
        signal: AbortSignal.timeout(Number(opt.timeoutMs) || 9000),
      });
      if (r.ok) {
        const arr = await r.json();
        const h = Array.isArray(arr) && arr[0];
        if (h && typeof h.lat === 'string') {
          hit = {
            name: h.name || String(h.display_name || '').split(',')[0],
            en: h.name || '',
            country: String(h.display_name || '').split(',').slice(-1)[0].trim(),
            lat: +(+h.lat).toFixed(4),
            lng: +(+h.lon).toFixed(4),
            display: h.display_name,
            source: 'nominatim',
          };
        }
      }
    } catch (_) { /* 回退也失败 */ }
  }

  // ★ 只缓存**成功**的命中。
  //   之前把失败也缓存了（hit: null），而缓存期 30 天
  //   ⇒ 第一次网络不通，之后 30 天全查不到（实测踩到）。
  if (hit) {
    cache[key] = { at: Date.now(), hit };
    writeCache(outDir, cache);
  }
  return hit;
}

/**
 * 城市名 → 坐标（本地表优先，Nominatim 兜底）。
 * @param {string} query 城市名（中文/英文/别名）
 * @param {string} outDir 输出目录（缓存用）
 */
export async function geocodeCity(query, outDir, opt = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '没给城市名' };
  const local = findLocal(q);
  if (local && !opt.forceOnline) {
    return {
      ok: true,
      city: {
        name: local.name, en: local.en, country: local.country,
        lat: local.lat, lng: local.lng, source: 'local',
        aliases: local.aliases || [],
      },
      candidates: searchLocal(q, 6),
    };
  }
  const online = await geocodeNominatim(q, outDir, opt);
  if (online) {
    return { ok: true, city: online, candidates: searchLocal(q, 6) };
  }
  // 两边都没有
  const near = searchLocal(q, 6);
  if (near.length) {
    return { ok: false, error: `没找到「${q}」，你是不是想找：${near.map((c) => c.name).join('、')}？`, candidates: near };
  }
  return { ok: false, error: `查不到「${q}」（本地表没有，在线地名服务也问不着）。可以试试英文名，或者直接给我经纬度。` };
}
