/* ============================================================================
 * tools/fetch-hdri.mjs —— 从 Poly Haven 抓一批 CC0 HDRI 到本地素材库
 *
 * 为什么是 Poly Haven：全部 **CC0**（商用/自用都随便，不需要署名，
 * 但我们仍然把作者存进 index.json —— 万一以后要转素材包，出处不丢）。
 *
 * 落到哪：<OUT_DIR>\素材库\HDRI\
 *   ├── index.json     清单（id / 名字 / 槽位 / 作者 / 缩略图）
 *   ├── <id>.hdr       1K 的 Radiance HDR（~1.4MB/张）
 *   └── <id>.png       缩略图（~22KB）
 *
 * 用法：
 *   node tools/fetch-hdri.mjs                 # 默认 1K，9 个槽位
 *   node tools/fetch-hdri.mjs --res 2k        # 抓 2K（~5.4MB/张）
 *   node tools/fetch-hdri.mjs --out "<输出目录>"
 *   node tools/fetch-hdri.mjs --only sunset night
 * ========================================================================== */
import { defaultOutDir } from '../server/paths.mjs';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const OUT_DIR = arg('--out', defaultOutDir());
const RES = arg('--res', '1k');
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean);
const HDR_DIR = path.join(OUT_DIR, '素材库', 'HDRI');

/* ── 想要哪些"槽位"（每槽一张） ──────────────────────────────────────── */
/* 属性真值（从 Poly Haven API 查的，别猜）：
 *   time_of_day: sunrise | afternoon | dusk | sunset | morning | midday | night
 *   weather:     partly_cloudy | clear | overcast | fog | rain | snow
 *   light_type:  natural | mixed | artificial        ← 影棚是 artificial
 *   environment: outdoor | indoor
 */
const SLOTS = [
  { id: 'day-clear',   label: '晴天正午', match: { time_of_day: 'midday',    weather: 'clear',        environment: 'outdoor' } },
  { id: 'day-cloudy', label: '多云白天', match: { time_of_day: 'afternoon', weather: 'partly_cloudy', environment: 'outdoor' } },
  { id: 'overcast',   label: '阴天',     match: { weather: 'overcast', environment: 'outdoor' } },
  { id: 'sunset',     label: '黄昏',     match: { time_of_day: 'sunset' } },
  { id: 'sunrise',    label: '日出',     match: { time_of_day: 'sunrise' } },
  { id: 'night',      label: '夜晚',     match: { time_of_day: 'night', environment: 'outdoor' } },
  { id: 'studio',     label: '影棚',     match: { light_type: 'artificial' } },
  { id: 'indoor',     label: '室内',     match: { environment: 'indoor', light_type: 'natural' } },
  { id: 'forest',     label: '林地',     match: { catHas: 'Forest' } },
  { id: 'city',       label: '城市',     match: { catHas: 'Urban' } },
  { id: 'coast',      label: '海边',     match: { catHas: 'Coast' } },
  { id: 'mountain',   label: '山地',     match: { catHas: 'Mountain' } },
];

const HDR_URL = (id, res) => `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${res}/${id}_${res}.hdr`;
const THUMB_URL = (id) => `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=160`;
const API = 'https://api.polyhaven.com/assets?t=hdris';

function score(asset, m) {
  const a = asset.attributes || {};
  const cat = String(asset.category || '');
  let ok = 0, need = 0;
  for (const [k, v] of Object.entries(m)) {
    if (k === 'catHas') {
      need++;
      if (cat.toLowerCase().includes(String(v).toLowerCase())) ok++;
      continue;
    }
    need++;
    const got = Array.isArray(a[k]) ? a[k] : [a[k]];
    if (got.map(String).map((x) => x.toLowerCase()).includes(String(v).toLowerCase())) ok++;
  }
  return need ? ok / need : 0;
}

async function download(url, dest) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function main() {
  fs.mkdirSync(HDR_DIR, { recursive: true });
  console.log('素材库：', HDR_DIR, ' 分辨率：', RES);

  console.log('拉 Poly Haven 清单…');
  const list = await (await fetch(API)).json();
  const assets = Object.entries(list).map(([id, v]) => ({ id, ...v }));
  console.log('  共', assets.length, '张 HDRI');

  const indexPath = path.join(HDR_DIR, 'index.json');
  const index = fs.existsSync(indexPath)
    ? JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    : { version: 1, source: 'Poly Haven (CC0)', items: [] };
  // 同一张图不能占两个槽位（之前 overcast 和 indoor 都挑中了同一张影棚）
  const usedIds = new Set(index.items.map((i) => i.id));
  // ★ 2026-11-09：分辨率分开存（1K / 2K 共存）
  //   之前按 slot 判重 —— 下了 1K 之后再跑 --res 2k 会全部"已存在，跳过"。
  //   现在文件名带分辨率：<id>_1k.hdr / <id>_2k.hdr，同一个槽位可以有多个分辨率。
  const haveRes = new Map();   // slot → res
  for (const i of index.items) haveRes.set(i.slot, i.res || '1k');

  for (const slot of SLOTS) {
    if (ONLY.length && !ONLY.includes(slot.id)) continue;
    // 这个分辨率已经下过了？
    const cur = index.items.find((i) => i.slot === slot.id && (i.res || '1k') === RES);
    if (cur) { console.log('  ·', slot.id, RES, '已存在，跳过'); continue; }
    // ★ 2026-11-09：这个槽位**已经有图了**（别的分辨率）⇒ 必须复用同一张图，
    //   不能另挑一张 —— 否则 1K 是 Goegap、4K 变成 Venice，同一个"日景"预设
    //   在不同分辨率下画面完全不一样（实测踩到）。
    const existing = index.items.find((i) => i.slot === slot.id);
    if (existing) {
      const hdrPath2 = path.join(HDR_DIR, existing.id + '_' + RES + '.hdr');
      try {
        let b2 = 0;
        if (!fs.existsSync(hdrPath2)) b2 = await download(HDR_URL(existing.id, RES), hdrPath2);
        else b2 = fs.statSync(hdrPath2).size;
        index.items.push(Object.assign({}, existing, {
          file: existing.id + '_' + RES + '.hdr', res: RES, bytes: b2,
        }));
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
        console.log('  ✓', slot.id.padEnd(12), (existing.id + '_' + RES).padEnd(42), (b2 / 1048576).toFixed(2) + 'MB', '· 复用同一张');
      } catch (e) { console.log('  !', slot.id, '失败：', e.message); }
      continue;
    }
    // 选匹配度最高、且下载量高的（下载量高 = 公认质量好）
    const ranked = assets
      .map((a) => ({ a, s: score(a, slot.match), dl: a.download_count || 0 }))
      .filter((x) => x.s >= 0.999 && !usedIds.has(x.a.id))
      .sort((x, y) => y.dl - x.dl);
    if (!ranked.length) {
      console.log('  !', slot.id, '没找到匹配的，跳过');
      continue;
    }
    const pick = ranked[0].a;
    usedIds.add(pick.id);

    const hdrPath = path.join(HDR_DIR, pick.id + '_' + RES + '.hdr');
    const thumbPath = path.join(HDR_DIR, pick.id + '.png');
    try {
      let bytes = 0;
      if (!fs.existsSync(hdrPath)) bytes = await download(HDR_URL(pick.id, RES), hdrPath);
      else bytes = fs.statSync(hdrPath).size;
      if (!fs.existsSync(thumbPath)) await download(THUMB_URL(pick.id), thumbPath);

      // 作者信息（CC0 不强制，但存着）
      let authors = [];
      try {
        const info = await (await fetch(`https://api.polyhaven.com/info/${pick.id}`)).json();
        authors = [].concat(info.authors || []);
      } catch (_) {}

      index.items.push({
        id: pick.id,
        slot: slot.id,
        slotLabel: slot.label,
        name: pick.name,
        file: pick.id + '_' + RES + '.hdr',
        thumb: pick.id + '.png',
        res: RES,
        bytes,
        authors,
        categories: pick.categories || [],
        attributes: pick.attributes || {},
        license: 'CC0',
        source: 'Poly Haven',
        url: `https://polyhaven.com/a/${pick.id}`,
      });
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
      console.log('  ✓', slot.id.padEnd(12), (pick.id + '_' + RES).padEnd(42), (bytes / 1048576).toFixed(2) + 'MB', '·', pick.name);
    } catch (e) {
      console.log('  !', slot.id, '失败：', e.message);
    }
  }

  const total = index.items.reduce((a, i) => a + (i.bytes || 0), 0);
  console.log('\n完成：', index.items.length, '张，合计', (total / 1048576).toFixed(1), 'MB');
  console.log('清单：', indexPath);
}

main().catch((e) => { console.error(e); process.exit(1); });
