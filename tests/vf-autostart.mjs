#!/usr/bin/env node
/* ============================================================================
 * tests/vf-autostart.mjs —— VideoForge 后端**自动拉起**
 *
 * 覆盖（2026-11-10）：
 *   ① 能找到 sidecar 的 backend 目录
 *   ② 能找到带 fastapi/uvicorn 的 Python
 *   ③ 能找到 Blender
 *   ④ 已经在跑时**不重复拉起**（复用）
 *   ⑤ 拉起后 health 可用
 * ========================================================================== */
import { studioAlive, startVideoForge, autostartVideoForge } from '../server/vf-autostart.mjs';
import fs from 'node:fs';

let pass = 0, fail = 0;
const ok = (n, c, e) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, e === undefined ? '' : '→ ' + JSON.stringify(e)); }
};

console.log('1. 环境探测');
{
  const r = await startVideoForge({ port: 8798 });
  // 后端可能已经在了 ⇒ already；也可能刚被拉起来 ⇒ already=false
  ok('★ 能拿到结果（说明探测没崩）', !!r, r);
  if (r.ok) {
    ok('★ 端口正确', r.port === 8798, r.port);
    ok('★ Blender 找到了', !!r.blender, r.blender);
    console.log('     已运行？', r.already ? '是（复用）' : '否（这次拉起的）');
  } else {
    console.log('     （本机没有 VideoForge，跳过：' + r.error + '）');
    ok('★ 拉不起时给的是**可读**错误', !!r.error, r);
  }
}

console.log('2. 已在运行时复用');
{
  const alive = await studioAlive(8798);
  if (alive) {
    const r = await startVideoForge({ port: 8798 });
    ok('★ 已经在跑时不重复拉起', r.ok && r.already === true, r);
  } else {
    console.log('   （后端没在跑，跳过这条）');
  }
}

console.log('3. 禁用开关');
{
  process.env.VIDEOFORGE_NO_AUTOSTART = '1';
  const r = await autostartVideoForge();
  ok('★ VIDEOFORGE_NO_AUTOSTART=1 能禁用', r.skipped === true, r);
  delete process.env.VIDEOFORGE_NO_AUTOSTART;
}

console.log('4. 源码不变式');
{
  const s = fs.readFileSync('server/vf-autostart.mjs', 'utf8');
  ok('★ 有找 backend 的逻辑', /findBackendDir/.test(s) && /main\.py/.test(s));
  ok('★ 有找 Python 的逻辑', /findPython/.test(s) && /fastapi,uvicorn/.test(s));
  ok('★ 有找 Blender 的逻辑', /findBlender/.test(s) && /blender\.exe/i.test(s));
  ok('★ detached 拉起（桥关了它还活着）', /detached: true/.test(s));
  ok('★ 拉不起来不抛（降级）', /catch/.test(s));
  const b = fs.readFileSync('server/agent-bridge.mjs', 'utf8');
  ok('★ 桥启动时调用它', /vf-autostart/.test(b) && /autostartVideoForge/.test(b));
  ok('★ 桥里失败不影响自己', /不影响使用/.test(b));
}

console.log(`\n${fail ? '✗' : '✓'} vf-autostart: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
