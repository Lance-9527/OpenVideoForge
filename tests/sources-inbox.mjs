#!/usr/bin/env node
/* ============================================================================
 * tests/sources-inbox.mjs —— 外部素材源目录 + 收件箱
 *
 * 守的是三件事：
 *   ① 目录里每个源都有"去哪打开/能导出什么/署名怎么写"；
 *   ② 收件箱只认白名单格式，且**不能穿越路径**；
 *   ③ 出处说明要能自动写清"哪个工具 + 署名要求"。
 * ========================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SOURCES, sourceCatalog, findSource, INBOX_ACCEPT } from '../js/worldgen/sources.js';
import { scanInbox, resolveInboxFile, guessSource, provenance } from '../server/inbox.mjs';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};
const group = (t) => console.log('\n' + t);

/* ── 1. 目录本身 ───────────────────────────────────────────────────────── */
group('1. 素材源目录');
{
  ok('至少 5 个源', SOURCES.length >= 5, SOURCES.length);
  ok('id 唯一', new Set(SOURCES.map((s) => s.id)).size === SOURCES.length);
  for (const s of SOURCES) {
    ok(`${s.id} 有名字`, !!s.name);
    ok(`${s.id} 有工具直链`, /^https:\/\//.test(s.tool), s.tool);
    ok(`${s.id} 有说明页`, /^https:\/\//.test(s.info), s.info);
    ok(`${s.id} 列出可导出格式`, Array.isArray(s.exports) && s.exports.length > 0, s.exports);
    ok(`${s.id} 有署名口径`, typeof s.creditNote === 'string' && s.creditNote.length > 0);
    ok(`${s.id} 有 hint`, typeof s.hint === 'string' && s.hint.length > 0);
  }
  // 地图类必须有 ODbL 署名
  const rokehan = findSource('rokehan');
  ok('ロケハン 带 © OpenStreetMap contributors', rokehan.credit === '© OpenStreetMap contributors', rokehan.credit);
  ok('ロケHannah 标记为可一键', rokehan.auto === 'osm');
  ok('不存在的 id 返回 null', findSource('nope') === null);
}

/* ── 2. 目录打包 ───────────────────────────────────────────────────────── */
group('2. sourceCatalog');
{
  const cat = sourceCatalog(null);
  ok('返回全部源', cat.sources.length === SOURCES.length);
  ok('带 notice', typeof cat.notice === 'string' && cat.notice.length > 0);
  ok('inbox 可为空', cat.inbox === null);
  const cat2 = sourceCatalog({ dir: 'x', count: 0, files: [] });
  ok('inbox 原样带出', cat2.inbox.count === 0);
}

/* ── 3. 收件箱 ─────────────────────────────────────────────────────────── */
group('3. 收件箱');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf-inbox-'));
{
  const scan = scanInbox(tmp);
  ok('目录会自动建出来', fs.existsSync(scan.dir), scan.dir);
  ok('空收件箱 count=0', scan.count === 0);
  ok('列出可接受格式', scan.accept.length > 0);

  fs.writeFileSync(path.join(scan.dir, '背景ガチャ_教室.glb'), Buffer.alloc(128));
  fs.writeFileSync(path.join(scan.dir, 'shot.png'), Buffer.alloc(64));
  fs.writeFileSync(path.join(scan.dir, 'notes.txt'), 'ignore me');

  const s2 = scanInbox(tmp);
  ok('认出 2 个可导入文件', s2.count === 2, s2.files.map((f) => f.name));
  ok('.txt 被挡掉', !s2.files.some((f) => f.name === 'notes.txt'));
  ok('模型数 = 1', s2.models === 1, s2.models);
  ok('图片数 = 1', s2.images === 1, s2.images);
  ok('按时间倒序', s2.files[0].mtime >= s2.files[1].mtime);

  const r = resolveInboxFile('背景ガチャ_教室.glb', tmp);
  ok('能取到文件', r.ok === true, r);
  ok('返回绝对路径', path.isAbsolute(r.path));

  const bad = resolveInboxFile('../../secret.txt', tmp);
  ok('路径穿越被挡', bad.ok === false, bad);
  const ext = resolveInboxFile('notes.txt', tmp);
  ok('不支持的格式被挡', ext.ok === false, ext);
  const miss = resolveInboxFile('nope.glb', tmp);
  ok('不存在的文件被挡', miss.ok === false, miss);

  // 目录穿越到别处也不能读到
  const outside = path.join(tmp, '..', 'evil.glb');
  ok('只认收件箱里的文件', resolveInboxFile(outside, tmp).ok === false);
}

/* ── 4. 出处说明 ───────────────────────────────────────────────────────── */
group('4. 出处与署名');
{
  ok('能从文件名猜出源', guessSource('背景ガチャ_教室.glb') === 'haikeigacha', guessSource('背景ガチャ_教室.glb'));
  ok('worldgacha 能猜出', guessSource('worldgacha_town.glb') === 'worldgacha');
  ok('猜不出返回 null', guessSource('random.glb') === null);
  const p = provenance('背景ガチャ_教室.glb');
  ok('出处写了工具名', p.text.includes('背景ガチャ'), p.text);
  ok('出处标了来源 id', p.source === 'haikeigacha');
  const p2 = provenance('rokehan_shibuya.glb');
  ok('地图类出处带署名要求', p2.text.includes('© OpenStreetMap contributors'), p2.text);
  const p3 = provenance('random.glb');
  ok('猜不到也给出可用出处', p3.source === 'unknown' && p3.text.includes('工具'), p3.text);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? '✗' : '✓'} sources-inbox: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
