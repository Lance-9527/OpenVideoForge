/* ============================================================================
 * server/terrain.mjs —— 真实地形高程（DEM）
 *
 * 用户要的「真实世界」不能只有平的地面。
 * 数据源：**AWS 公开地形瓦片**（Mapzen Terrain Tiles / terrarium 编码）——
 *   https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
 *   · 免费公开、无需 key、无需注册
 *   · terrarium 编码：elevation_m = (R * 256 + G + B / 256) - 32768
 *   · 归到 OpenStreetMap 项目（ODbL），发布作品时同样要署名 OSM
 *
 * 抓不到就**降级为平地**（不阻塞主流程）。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { defaultOutDir } from './paths.mjs';
import zlib from 'node:zlib';

const TERRARIUM = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';
const TILE_PX = 256;

/** 经纬度 → 瓦片坐标 */
function lon2tileX(lon, z) { return Math.floor(((lon + 180) / 360) * Math.pow(2, z)); }
function lat2tileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * Math.pow(2, z));
}

/** PNG 解码 —— 只处理 8bit RGB/RGBA 无隔行（本瓦片源就是这个格式） */
function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行 PNG');
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error('只支持 8bit PNG');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error('只支持 RGB/RGBA PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

/** terrarium 编码 → 高程（米） */
function terrarium(r, g, b) {
  return r * 256 + g + b / 256 - 32768;
}

/**
 * 取一块区域的高程网格。
 * @param {object} o { lat, lng, spanMeters, res（格数，单边）, zoom, outDir, timeoutMs }
 * @returns {ok, grid:{size,res,minX,minZ,step,values}, stats}
 */
export async function getTerrain(o = {}) {
  const lat = Number(o.lat);
  const lng = Number(o.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: '缺少经纬度' };
  const spanM = Math.max(100, Math.min(8000, Number(o.spanMeters) || 1200));
  const res = Math.max(8, Math.min(128, Number(o.res) || 64));
  const zoom = Number.isFinite(o.zoom) ? o.zoom : 12;
  const outDir = o.outDir || process.env.WBWB_OUT_DIR || defaultOutDir();

  const mPerDegLat = 110540;
  const mPerDegLng = 111320 * Math.cos((lat * Math.PI) / 180);
  const step = spanM / res;                    // 每格多少米
  const dLat = step / mPerDegLat;
  const dLng = step / Math.max(1, mPerDegLng);

  // 要覆盖的区域 → 瓦片范围
  const z = zoom;
  const n = Math.pow(2, z);
  const x0 = lon2tileX(lng - spanM / 2 / Math.max(1, mPerDegLng), z);
  const x1 = lon2tileX(lng + spanM / 2 / Math.max(1, mPerDegLng), z);
  const y0 = lat2tileY(lat + spanM / 2 / mPerDegLat, z);
  const y1 = lat2tileY(lat - spanM / 2 / mPerDegLat, z);
  const tx0 = Math.max(0, Math.min(n - 1, x0));
  const tx1 = Math.max(0, Math.min(n - 1, x1));
  const ty0 = Math.max(0, Math.min(n - 1, y0));
  const ty1 = Math.max(0, Math.min(n - 1, y1));
  const tw = tx1 - tx0 + 1;
  const th = ty1 - ty0 + 1;
  if (tw * th > 40) return { ok: false, error: '瓦片范围太大' };

  const cacheDir = path.join(outDir, 'terrain-cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  // 取瓦片
  const tiles = [];
  let fetched = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const file = path.join(cacheDir, `${z}_${tx}_${ty}.png`);
      let buf = null;
      if (fs.existsSync(file)) {
        try { buf = fs.readFileSync(file); } catch (_) { buf = null; }
      }
      if (!buf) {
        const url = `${TERRARIUM}/${z}/${tx}/${ty}.png`;
        try {
          const ctl = AbortSignal.timeout(Number(o.timeoutMs) || 12000);
          const r = await fetch(url, { signal: ctl });
          if (r.ok) {
            buf = Buffer.from(await r.arrayBuffer());
            fs.writeFileSync(file, buf);
            fetched++;
          }
        } catch (_) { buf = null; }
      }
      tiles.push({ tx, ty, buf });
    }
  }
  const usable = tiles.filter((t) => t.buf);
  if (!usable.length) return { ok: false, error: '地形瓦片取不到（离线？）' };

  // 采样成 res×res 网格（双线性）
  // ★ 2026-11-08：每个瓦片**只解一次** PNG。
  //   之前是每个采样点都解一次（res=64 → 4096 次解码 256×256 PNG），
  //   实测要多花 800ms+。现在先解好缓存住。
  const decoded = new Map();
  const getDecoded = (tile) => {
    if (!tile || !tile.buf) return null;
    if (decoded.has(tile.key)) return decoded.get(tile.key);
    let d = null;
    try { d = decodePng(tile.buf); } catch (_) { d = null; }
    decoded.set(tile.key, d);
    return d;
  };
  for (const t of tiles) t.key = t.tx + '_' + t.ty;

  const values = new Float64Array(res * res);
  let minH = Infinity, maxH = -Infinity;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const px = ((i + 0.5) / res) * tw * TILE_PX;
      const py = ((j + 0.5) / res) * th * TILE_PX;
      const txi = Math.floor(px / TILE_PX);
      const tyi = Math.floor(py / TILE_PX);
      const fx = px - txi * TILE_PX;
      const fy = py - tyi * TILE_PX;
      const tile = tiles.find((t) => t.tx === tx0 + txi && t.ty === ty0 + tyi);
      const dec = getDecoded(tile);
      if (!dec) { values[j * res + i] = 0; continue; }
      const sample = (xx, yy) => {
        const x = Math.max(0, Math.min(dec.width - 1, Math.round(xx)));
        const y = Math.max(0, Math.min(dec.height - 1, Math.round(yy)));
        const o = (y * dec.width + x) * dec.channels;
        return terrarium(dec.data[o], dec.data[o + 1], dec.data[o + 2]);
      };
      const h00 = sample(fx, fy);
      const h10 = sample(Math.min(TILE_PX - 1, fx + 1), fy);
      const h01 = sample(fx, Math.min(TILE_PX - 1, fy + 1));
      const h11 = sample(Math.min(TILE_PX - 1, fx + 1), Math.min(TILE_PX - 1, fy + 1));
      const h = (h00 * (1 - fx / TILE_PX) * (1 - fy / TILE_PX)) + (h10 * (fx / TILE_PX) * (1 - fy / TILE_PX))
        + (h01 * (1 - fx / TILE_PX) * (fy / TILE_PX)) + (h11 * (fx / TILE_PX) * (fy / TILE_PX));
      values[j * res + i] = h;
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }

  if (!Number.isFinite(minH)) { minH = 0; maxH = 0; }
  return {
    ok: true,
    grid: {
      size: res,
      step,                                   // 每格米数
      minX: -spanM / 2, minZ: -spanM / 2,     // 相对世界中心
      values: Array.from(values),
      minH, maxH,
    },
    stats: { tiles: usable.length, fetched, minH: +minH.toFixed(1), maxH: +maxH.toFixed(1), spanM, zoom },
    attribution: '© OpenStreetMap contributors',
  };
}
