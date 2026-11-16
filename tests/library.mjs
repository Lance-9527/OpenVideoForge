#!/usr/bin/env node
/* ============================================================================
 * tests/library.mjs —— 资产库（落盘持久化）
 *
 * 守的是用户的核心诉求：
 *   ① 落盘持久化（不是 localStorage）
 *   ② 四个种类都在：模型 / 场景模型 / 材质 / 灯光
 *   ③ 每条带来源与署名（可复用 ≠ 丢出处）
 *   ④ 复用接口能取到模型文件的绝对路径
 *   ⑤ 内置条目不能被删；坏索引不炸
 * ========================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  libraryList, libraryAdd, libraryRemove, libraryImportModel,
  libraryFilePath, librarySaveWorld, libDir, safeId,
  librarySaveThumb, libraryThumbPath, libraryThumbDir,
  BUILTIN_MATERIALS, BUILTIN_LIGHTS, BUILTIN_WORLDS,
} from '../server/library.mjs';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};
const group = (t) => console.log('\n' + t);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf-lib-'));

/* ── 1. 落盘 ───────────────────────────────────────────────────────────── */
group('1. 落盘持久化');
{
  const dir = libDir(tmp);
  ok('目录自动建出来', fs.existsSync(dir), dir);
  ok('目录名是 资产库', path.basename(dir) === '资产库', path.basename(dir));
  ok('models 子目录也建了', fs.existsSync(path.join(dir, 'models')));

  const r = libraryAdd({
    id: '我的角色', kind: 'model', category: 'character', name: '我的角色',
    file: 'models/my.glb', bytes: 12345, source: 'haikeigacha',
    attribution: '© OpenStreetMap contributors',
  }, tmp);
  ok('添加成功', r.ok === true, r);

  // ★ 关键：**换一个"浏览器"（=另一个进程读同一个目录）还能看到**
  const again = libraryList(tmp);
  ok('重新读得到（模拟关网页再打开）', again.items.some((i) => i.id === '我的角色'), again.items.length);
  ok('index.json 真在磁盘上', fs.existsSync(path.join(dir, 'index.json')));
}

/* ── 2. 四个种类 ───────────────────────────────────────────────────────── */
group('2. 四种资产都在');
{
  const l = libraryList(tmp);
  const kinds = new Set(l.items.map((i) => i.kind));
  ok('有 model', kinds.has('model'));
  ok('有 world（场景模型）', kinds.has('world'));
  ok('有 material（材质）', kinds.has('material'));
  ok('有 light（灯光）', kinds.has('light'));
  ok('内置材质 12 条', l.counts.material >= BUILTIN_MATERIALS.length, l.counts);
  ok('内置灯光 7 条', l.counts.light >= BUILTIN_LIGHTS.length, l.counts);
  ok('内置场景模型在', l.counts.world >= BUILTIN_WORLDS.length, l.counts);
  ok('用户条目数单独统计', l.userCount >= 1, l.userCount);

  // 分类过滤
  const scenes = libraryList(tmp, { category: 'scene' });
  ok('按分类过滤：场景模型', scenes.items.every((i) => i.category === 'scene'), scenes.items.length);
  const models = libraryList(tmp, { kind: 'model' });
  ok('按 kind 过滤：模型', models.items.every((i) => i.kind === 'model'), models.items.length);
  const searched = libraryList(tmp, { q: '角色' });
  ok('按名字搜得到', searched.items.length >= 1, searched.items.length);
}

/* ── 3. 出处与署名 ─────────────────────────────────────────────────────── */
group('3. 出处与署名跟着走');
{
  const l = libraryList(tmp);
  const mine = l.items.find((i) => i.id === '我的角色');
  ok('来源在', mine.source === 'haikeigacha', mine.source);
  ok('署名在', mine.attribution === '© OpenStreetMap contributors', mine.attribution);
  const w = librarySaveWorld({ kind: 'osm', url: 'http://x/y.json', attribution: '© OpenStreetMap contributors' }, '涩谷', tmp);
  ok('存场景模型成功', w.ok === true, w);
  const back = libraryList(tmp).items.find((i) => i.id === '涩谷');
  ok('场景模型的署名在', back.attribution === '© OpenStreetMap contributors', back.attribution);
  ok('场景模型的 spec 在', back.spec.kind === 'osm', back.spec);
  ok('场景模型分类是 scene', back.category === 'scene');
}

/* ── 4. 复用：能取到模型文件 ───────────────────────────────────────────── */
group('4. 复用：模型文件');
{
  // 造一个假 GLB
  const src = path.join(tmp, 'src.glb');
  fs.writeFileSync(src, Buffer.from([0x67, 0x6c, 0x54, 0x46, 1, 2, 3, 4]));
  const r = libraryImportModel(src, { name: '导入的模型', category: 'prop', source: 'worldgacha' }, tmp);
  ok('导入成功', r.ok === true, r);
  ok('文件进了 models/', r.item.file.startsWith('models/'), r.item.file);
  ok('字节数对', r.item.bytes === 8, r.item.bytes);

  const f = libraryFilePath(r.item.id, tmp);
  ok('能取到绝对路径', f.ok === true && path.isAbsolute(f.path), f);
  ok('文件真在', fs.existsSync(f.path));
  ok('取不存在的报错', libraryFilePath('nope', tmp).ok === false);
  // 「我的角色」只是登记了记录、磁盘上没有文件 ⇒ 必须报错，不能返回一个坏路径
  const ghost = libraryFilePath('我的角色', tmp);
  ok('文件不在磁盘上时明确报错', ghost.ok === false && /不在/.test(ghost.error || ''), ghost.error);
  // 非 model 条目（材质/灯光）根本没有文件可取
  ok('材质条目取不到文件', libraryFilePath('mat_white', tmp).ok === false);

  // 删条目时文件也删
  const del = libraryRemove(r.item.id, tmp);
  ok('删除成功', del.ok === true, del);
  ok('文件也删了', !fs.existsSync(f.path));
  ok('删不存在的报错', libraryRemove('nope', tmp).ok === false);
}

/* ── 5. 内置条目保护 ───────────────────────────────────────────────────── */
group('5. 内置条目');
{
  ok('内置条目删不掉', libraryRemove('mat_white', tmp).ok === false);
  ok('内置材质在清单里', libraryList(tmp).items.some((i) => i.id === 'mat_white'));
  ok('内置条目标记 builtin', libraryList(tmp).items.find((i) => i.id === 'light_noon').builtin === true);
  // 用户条目覆盖同名内置
  const over = libraryAdd({ id: 'mat_white', kind: 'material', name: '我的白', material: { color: '#fff' } }, tmp);
  ok('同名可覆盖', over.ok === true);
  const m = libraryList(tmp).items.find((i) => i.id === 'mat_white');
  ok('覆盖后是用户条目', m.builtin === false && m.name === '我的白', m.name);
  ok('覆盖后仍可删', libraryRemove('mat_white', tmp).ok === true);
}

/* ── 6. 坏数据不炸 ─────────────────────────────────────────────────────── */
group('6. 坏数据');
{
  fs.writeFileSync(path.join(libDir(tmp), 'index.json'), '{ 坏 JSON');
  let l = null;
  try { l = libraryList(tmp); } catch (e) { /* 应该不炸 */ }
  ok('坏索引不炸', !!l, l && l.items.length);
  ok('坏索引时仍返回内置条目', l && l.items.some((i) => i.id === 'mat_white'));
  fs.writeFileSync(path.join(libDir(tmp), 'index.json'), JSON.stringify({ version: 1, items: '不是数组' }));
  l = libraryList(tmp);
  ok('items 不是数组也不炸', !!l && Array.isArray(l.items));
}

/* ── 7. id 安全 ────────────────────────────────────────────────────────── */
group('7. id 安全');
{
  ok('斜杠被换掉', !safeId('a/b').includes('/'), safeId('a/b'));
  ok('长名截断', safeId('x'.repeat(200)).length <= 60);
  const evil = libraryAdd({ id: '../../evil', kind: 'model', name: 'evil', file: 'models/x.glb' }, tmp);
  ok('穿越名落在库里', evil.ok && !evil.item.id.includes('/'), evil.item.id);
}

fs.rmSync(tmp, { recursive: true, force: true });
/* ── 9. 缩略图 ─────────────────────────────────────────────────────────── */
group('9. 缩略图（页面渲染 → 送回 → 落盘）');
{
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
  const add = libraryAdd({ id: '缩略图测试', kind: 'model', category: 'prop', name: '缩略图测试' }, tmp);
  ok('条目加进去了', add.ok);

  const noThumb = libraryThumbPath('缩略图测试', tmp);
  ok('还没缩略图时取不到', noThumb.ok === false);

  const saved = librarySaveThumb('缩略图测试', PNG.toString('base64'), tmp);
  ok('存成功', saved.ok, saved);
  ok('index 里记了相对路径', saved.thumb === 'thumbs/' + safeId('缩略图测试') + '.png', saved.thumb);

  const got = libraryThumbPath('缩略图测试', tmp);
  ok('能取到缩略图', got.ok, got);
  ok('字节数对', got.bytes === PNG.length, { got: got.bytes, want: PNG.length });
  ok('文件真在 thumbs/ 里', got.path.startsWith(libraryThumbDir(tmp)));

  // dataURL 形式也要能吃
  const saved2 = librarySaveThumb('缩略图测试', 'data:image/png;base64,' + PNG.toString('base64'), tmp);
  ok('dataURL 形式也能存', saved2.ok, saved2);

  // 非 PNG 要拒
  const bad = librarySaveThumb('缩略图测试', Buffer.from('not a png at all').toString('base64'), tmp);
  ok('非 PNG 被拒', bad.ok === false, bad);
  const empty = librarySaveThumb('缩略图测试', '', tmp);
  ok('空数据被拒', empty.ok === false);

  // 不存在的条目
  const ghost = librarySaveThumb('根本没有这条', PNG.toString('base64'), tmp);
  ok('给不存在的条目存缩略图被拒', ghost.ok === false, ghost);

  // 路径穿越
  for (const evil of ['../../etc/passwd', '..\\..\\secret']) {
    const r = libraryThumbPath(evil, tmp);
    ok('拒绝穿越：' + evil, r.ok === false || r.path.startsWith(path.resolve(libraryThumbDir(tmp))), r);
  }

  // 删除条目时缩略图也要删（不留孤儿）
  const before = fs.existsSync(path.join(libraryThumbDir(tmp), safeId('缩略图测试') + '.png'));
  ok('删之前缩略图在', before);
  libraryRemove('缩略图测试', tmp);
  const after = fs.existsSync(path.join(libraryThumbDir(tmp), safeId('缩略图测试') + '.png'));
  ok('删条目后缩略图也删了', !after);
}

console.log(`\n${fail ? '✗' : '✓'} library: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
