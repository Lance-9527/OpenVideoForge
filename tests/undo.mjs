#!/usr/bin/env node
/* ==========================================================================
 * tests/undo.mjs —— 撤销/恢复（checkpoint）**纯逻辑**回归
 *
 * 为什么要有这个：2026-11-08 的实测抓到两个真 bug，
 *   ① 「恢复」永远失效 —— undo 内部 loadScene → loadEnv → checkpoint()
 *      → **fut 栈被自己清空**（loadEnv 被自动 patch 过）。
 *   ② 拖拉拽放置（新增路径）**撤销不了** —— beginPlace 根本没被 patch。
 * 这两个都不会让程序报错，只是"点了没反应"—— 不测就发现不了。
 *
 * 这里测的是**纯逻辑**（不依赖浏览器）：
 *   把 studio-topbar.js 的 hist/fut/checkpoint 语义抽成最小模型，
 *   验证"撤销栈不被自己的撤销动作清空""新增入口也记点"这两条不变式。
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};
const group = (t) => console.log('\n' + t);

/* ── 读 studio-topbar.js，确认关键不变式在源码里成立 ─────────────────── */
const TOPBAR = path.resolve('js/studio-topbar.js');
const src = fs.existsSync(TOPBAR) ? fs.readFileSync(TOPBAR, 'utf8') : '';

group('1. 源码不变式（防止回归）');
ok('studio-topbar.js 在', !!src);
ok('★ checkpoint 里有 suppressCheckpoint 守卫',
  /function checkpoint\(\)\s*\{[^}]*if\s*\(suppressCheckpoint\)/m.test(src),
  '没有守卫 → undo 里的 loadEnv 会把 redo 栈清空');
ok('★ undo/redo 用 quietly() 包住 loadScene',
  /await quietly\(\(\)\s*=>\s*e\.loadScene/.test(src),
  '撤销/恢复必须屏蔽期间的自动检查点');
ok('★ 拖拉拽入口也记检查点',
  /beginPlace/.test(src) && /beginPlaceExternal/.test(src),
  '新增的放置入口没被 patch → 撤销不了');
ok('★ patch 列表含 duplicateAsset / enterBuilding',
  /duplicateAsset/.test(src) && /enterBuilding/.test(src));

/* ── 用一个最小模型复现 hist/fut 的语义 ─────────────────────────────── */
group('2. hist / fut 语义（最小模型）');
function makeHist() {
  const hist = [], fut = [];
  let suppress = false;
  const snap = () => state.s;
  const state = { s: 'S0' };
  const checkpoint = () => {
    if (suppress) return;
    const s = snap();
    if (hist[hist.length - 1] !== s) hist.push(s);
    fut.length = 0;
  };
  const quietly = async (fn) => { const w = suppress; suppress = true; try { await fn(); } finally { suppress = w; } };
  const undo = async (load) => {
    if (!hist.length) return false;
    const cur = snap(); const s = hist.pop();
    if (cur) fut.push(cur);
    await quietly(async () => { state.s = s; await load(s); });
    return true;
  };
  const redo = async (load) => {
    if (!fut.length) return false;
    const cur = snap(); const s = fut.pop();
    if (cur) hist.push(cur);
    await quietly(async () => { state.s = s; await load(s); });
    return true;
  };
  return { hist, fut, state, checkpoint, undo, redo, setSuppress: (v) => { suppress = v; } };
}

// 模拟 loadScene 内部会触发 checkpoint（loadEnv 被 patch）
function makeLoader(h) {
  return async (s) => {
    h.state.s = s;
    h.checkpoint();          // ← loadEnv 的自动检查点
  };
}

{
  const h = makeHist();
  h.checkpoint();            // 操作前：S0
  h.state.s = 'S1';          // 加了物体
  const did = await h.undo(makeLoader(h));
  ok('撤销成功', did);
  ok('撤销后状态回到 S0', h.state.s === 'S0', h.state);
  ok('★ redo 栈没被撤销动作清空', h.fut.length === 1, { fut: h.fut.length });
  await h.redo(makeLoader(h));
  ok('★ 恢复成功，状态回到 S1', h.state.s === 'S1', h.state);
}

group('3. 新操作会清空 redo 栈（正常语义）');
{
  const h = makeHist();
  h.checkpoint();
  h.state.s = 'S1';
  await h.undo(makeLoader(h));
  ok('撤销后 fut 有 1 项', h.fut.length === 1);
  h.checkpoint();            // 用户又做了新操作
  ok('★ 新操作后 fut 被清空', h.fut.length === 0, { fut: h.fut.length });
}

group('4. 连续多次撤销/恢复');
{
  const h = makeHist();
  for (const s of ['S1', 'S2', 'S3']) { h.checkpoint(); h.state.s = s; }
  await h.undo(makeLoader(h));   // S3 → S2
  ok('撤销 1 次到 S2', h.state.s === 'S2', h.state);
  await h.undo(makeLoader(h));   // S2 → S1
  ok('撤销 2 次到 S1', h.state.s === 'S1', h.state);
  await h.redo(makeLoader(h));   // S1 → S2
  ok('恢复 1 次到 S2', h.state.s === 'S2', h.state);
  await h.redo(makeLoader(h));   // S2 → S3
  ok('恢复 2 次到 S3', h.state.s === 'S3', h.state);
}

group('5. 边界');
{
  const h = makeHist();
  ok('没东西可撤销时返回 false', (await h.undo(makeLoader(h))) === false);
  ok('没东西可恢复时返回 false', (await h.redo(makeLoader(h))) === false);
  const h2 = makeHist();
  h2.checkpoint();
  h2.state.s = 'S1';
  await h2.undo(makeLoader(h2));
  ok('撤销后 hist 空了（栈里只剩更早的状态）', h2.hist.length === 0, { hist: h2.hist.length });
  ok('撤销后 fut 有 1 项', h2.fut.length === 1, { fut: h2.fut.length });
  await h2.redo(makeLoader(h2));
  ok('恢复后 hist 恢复为 1', h2.hist.length === 1, { hist: h2.hist.length });
  ok('恢复后状态回到 S1', h2.state.s === 'S1', h2.state);
}

console.log(`\n${fail ? '✗' : '✓'} undo: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
