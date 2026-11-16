#!/usr/bin/env node
/* ============================================================================
 * tests/presets.mjs —— 预设库（存画面 / 随时调出来）
 *
 * 守的是：存得下、读得出、名字安全（不能穿越路径）、同名覆盖、
 *         出处/署名跟着走、删得掉。
 * ========================================================================== */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  savePreset, readPreset, listPresets, deletePreset, updatePreset,
  presetDir, safeId,
} from '../server/presets.mjs';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};
const group = (t) => console.log('\n' + t);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ovf-presets-'));

const sample = {
  id: '涩谷鸟瞰',
  name: '涩谷鸟瞰',
  spec: { kind: 'osm', url: 'http://127.0.0.1:8787/osm/world/35.65950_139.70050_200.json', attribution: '© OpenStreetMap contributors' },
  env: 'osm',
  size: 'xxl',
  camera: { r: 510.9, phi: 0.86, theta: 0.6, target: [-98.3, 1.7, -47.7] },
  light: { azimuth: 134, elevation: 20 },
  assets: [{ assetId: 'car1', instanceId: 'i1', x: 1, y: 0, z: 2, ry: 90, scale: 1 }],
  interior: false,
  thumb: 'data:image/jpeg;base64,AAAA',
};

/* ── 1. 存取 ───────────────────────────────────────────────────────────── */
group('1. 存取');
{
  const dir = presetDir(tmp);
  ok('目录自动建出来', fs.existsSync(dir), dir);
  ok('目录名是 预设库', path.basename(dir) === '预设库', path.basename(dir));

  const r = savePreset(sample, tmp);
  ok('保存成功', r.ok === true, r);
  ok('返回了记录', !!r.preset && r.preset.id === '涩谷鸟瞰');
  ok('落盘了 json', fs.existsSync(r.path));

  const back = readPreset('涩谷鸟瞰', tmp);
  ok('读得回来', back.ok === true, back);
  ok('机位在', back.preset.camera.r === 510.9);
  ok('资产在', back.preset.assets.length === 1);
  ok('署名跟着走', back.preset.attribution === '© OpenStreetMap contributors', back.preset.attribution);
  ok('出处类型在', back.preset.source === 'osm', back.preset.source);
  ok('缩略图在', !!back.preset.thumb);
}

/* ── 2. 同名覆盖 ───────────────────────────────────────────────────────── */
group('2. 同名覆盖');
{
  const s2 = { ...sample, camera: { r: 999, phi: 0.5, theta: 0.1, target: [0, 0, 0] } };
  const r = savePreset(s2, tmp);
  ok('覆盖成功', r.ok === true);
  const back = readPreset('涩谷鸟瞰', tmp);
  ok('内容已更新', back.preset.camera.r === 999, back.preset.camera.r);
  ok('文件数没变多', listPresets(tmp).length === 1, listPresets(tmp).length);
}

/* ── 3. 列表 ───────────────────────────────────────────────────────────── */
group('3. 列表');
{
  savePreset({ ...sample, id: '城市夜景', name: '城市夜景' }, tmp);
  savePreset({ ...sample, id: '室内一瞥', name: '室内一瞥', interior: true }, tmp);
  const l = listPresets(tmp);
  ok('列出 3 个', l.length === 3, l.length);
  ok('含名字/类型/机位', l.every((p) => p.name && p.kind !== undefined));
  ok('含资产数', l.every((p) => typeof p.assets === 'number'));
  ok('含署名', l.every((p) => p.attribution === '© OpenStreetMap contributors'));
  ok('按更新时间倒序', String(l[0].updatedAt) >= String(l[1].updatedAt));
}

/* ── 4. 改名 / 删除 ────────────────────────────────────────────────────── */
group('4. 改名与删除');
{
  const u = updatePreset('室内一瞥', { name: '室内一瞥2', note: '早上' }, tmp);
  ok('改名成功', u.ok === true, u);
  ok('新名字生效', readPreset('室内一瞥', tmp).preset.name === '室内一瞥2');
  ok('备注生效', readPreset('室内一瞥', tmp).preset.note === '早上');

  const d = deletePreset('室内一瞥', tmp);
  ok('删除成功', d.ok === true, d);
  ok('删掉了', readPreset('室内一瞥', tmp).ok === false);
  ok('删不存在的报错', deletePreset('nope', tmp).ok === false);
}

/* ── 5. 安全 ───────────────────────────────────────────────────────────── */
group('5. 名字安全（不能穿越路径）');
{
  ok('斜杠被换掉', !safeId('a/b\\c').includes('/'), safeId('a/b\\c'));
  ok('冒号被换掉', !safeId('a:b').includes(':'), safeId('a:b'));
  ok('空格变下划线', !safeId('a b').includes(' '), safeId('a b'));
  ok('长名被截断', safeId('x'.repeat(200)).length <= 48, safeId('x'.repeat(200)).length);
  ok('空名有兜底', safeId('') === 'preset', safeId(''));

  const evil = savePreset({ ...sample, id: '../../evil' }, tmp);
  ok('穿越名落在预设目录里', evil.ok && evil.path.startsWith(presetDir(tmp)), evil.path);
  ok('没写到目录外', !fs.existsSync(path.join(path.dirname(presetDir(tmp)), 'evil.json')));
  // 穿越名会被消毒成无害文件名，**读到的也只可能是消毒后的那个**，
  // 绝不可能读到目录外的文件。
  const rr = readPreset('../../evil', tmp);
  ok('读穿越名也只在目录内', rr.ok === false || rr.path.startsWith(presetDir(tmp)), rr.path);
  ok('目录外没有同名文件', !fs.existsSync(path.join(tmp, 'evil.json')));
}

/* ── 6. 坏文件不影响列表 ───────────────────────────────────────────────── */
group('6. 坏文件');
{
  fs.writeFileSync(path.join(presetDir(tmp), 'broken.json'), '{ 这不是 JSON');
  const l = listPresets(tmp);
  ok('坏文件被跳过', l.length === 3, l.length);
  ok('好的还在', l.some((p) => p.id === '涩谷鸟瞰'));
  fs.unlinkSync(path.join(presetDir(tmp), 'broken.json'));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${fail ? '✗' : '✓'} presets: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
