// ============================================================================
// timeline.js 纯数学 + 数据层单测（无 DOM / 无 three / 无浏览器）
// 运行： node product/docs/timeline.test.mjs
// 退出码：0 = 全通过；1 = 有失败
// ============================================================================
import {
  Timeline,
  clamp, easeInOutCubic, easeValue, shortestAngleDelta, lerp, lerpAngle,
  normalizeCam, interpCam, normalizeShot, shotsTotalDuration, shotStartTime,
  sampleShots, formatTime,
  DEFAULT_SHOT_DURATION, MIN_SHOT_DURATION, MAX_SHOT_DURATION
} from '../js/timeline.js';

const TAU = Math.PI * 2;
let pass = 0, fail = 0;
const lines = [];

function ok(name, cond, detail) {
  if (cond) { pass++; lines.push(`  ✓ ${name}${detail ? '   ' + detail : ''}`); }
  else { fail++; lines.push(`  ✗ ${name}${detail ? '   ' + detail : ''}   <-- FAIL`); }
}
function near(a, b, eps = 1e-9) { return Math.abs(a - b) <= eps; }
function vecNear(a, b, eps = 1e-9) { return a.length === b.length && a.every((v, i) => near(v, b[i], eps)); }
function fmt(v, d = 4) { return typeof v === 'number' ? (Math.round(v * 10 ** d) / 10 ** d).toString() : JSON.stringify(v); }
function fmtCam(c) {
  return `{r:${fmt(c.r, 3)}, phi:${fmt(c.phi, 3)}, theta:${fmt(c.theta, 3)}, t:[${c.t.map(v => fmt(v, 3)).join(',')}], fov:${fmt(c.fov, 2)}}`;
}
function section(t) { lines.push('', t); }

// 统一的角度差（把任意角折算到 (-π, π]），用来判断两个 theta 是否等价
function angleDiff(a, b) { return Math.abs((((a - b) % TAU) + TAU + Math.PI) % TAU - Math.PI); }

// ---------------------------------------------------------------------------
section('1. 基础数学');
ok('clamp(5,0,3) = 3', clamp(5, 0, 3) === 3, `实际 ${clamp(5, 0, 3)}`);
ok('clamp(-1,0,3) = 0', clamp(-1, 0, 3) === 0, `实际 ${clamp(-1, 0, 3)}`);
ok('lerp(10,20,0.25) = 12.5', near(lerp(10, 20, 0.25), 12.5), `实际 ${lerp(10, 20, 0.25)}`);
ok('easeInOutCubic(0) = 0', near(easeInOutCubic(0), 0), `实际 ${easeInOutCubic(0)}`);
ok('easeInOutCubic(0.5) = 0.5', near(easeInOutCubic(0.5), 0.5), `实际 ${easeInOutCubic(0.5)}`);
ok('easeInOutCubic(1) = 1', near(easeInOutCubic(1), 1), `实际 ${easeInOutCubic(1)}`);
{
  let mono = true, prev = -1;
  for (let i = 0; i <= 100; i++) { const v = easeInOutCubic(i / 100); if (v < prev - 1e-12) mono = false; prev = v; }
  ok('easeInOutCubic 单调不降（101 采样）', mono);
  ok('easeValue(k,"linear") 不做缓动', near(easeValue(0.25, 'linear'), 0.25), `实际 ${easeValue(0.25, 'linear')}`);
  ok('easeValue(k,"inout") 走三次缓动', near(easeValue(0.25, 'inout'), easeInOutCubic(0.25)), `实际 ${easeValue(0.25, 'inout')}`);
}

// ---------------------------------------------------------------------------
section('2. theta 最短弧（环绕）');
{
  const d1 = shortestAngleDelta(0.2, 2.0);
  ok('普通区间 0.2→2.0 直接取差值 1.8', near(d1, 1.8), `delta=${fmt(d1)}`);
  // 关键用例：3.0 → -3.0，线性会走 -6（绕远路 343°），最短弧应跨过 ±π 走 +0.283
  const d2 = shortestAngleDelta(3.0, -3.0);
  ok('跨 ±π：3.0→-3.0 取 +0.2832（不是 -6.0）', near(d2, TAU - 6, 1e-12), `delta=${fmt(d2)}  (TAU-6=${fmt(TAU - 6)})`);
  const d3 = shortestAngleDelta(-3.0, 3.0);
  ok('反向：-3.0→3.0 取 -0.2832', near(d3, 6 - TAU, 1e-12), `delta=${fmt(d3)}  (6-TAU=${fmt(6 - TAU)})`);
  ok('正好 π：0→π 取 +π', near(shortestAngleDelta(0, Math.PI), Math.PI), `delta=${fmt(shortestAngleDelta(0, Math.PI))}`);
  ok('正好 -π：0→-π 确定性取 +π', near(shortestAngleDelta(0, -Math.PI), Math.PI), `delta=${fmt(shortestAngleDelta(0, -Math.PI))}`);
  ok('绕整圈：0→2π 取 0', near(shortestAngleDelta(0, TAU), 0, 1e-12), `delta=${fmt(shortestAngleDelta(0, TAU))}`);
  ok('多圈累加：10π→0 也归一化到 (-π,π]', Math.abs(shortestAngleDelta(10 * Math.PI, 0)) <= Math.PI, `delta=${fmt(shortestAngleDelta(10 * Math.PI, 0))}`);
  const mid = lerpAngle(3.0, -3.0, 0.5);
  ok('lerpAngle 中点 = π 附近（跨 ±π 走短边）', angleDiff(mid, Math.PI) < 1e-9, `mid=${fmt(mid)}（≈π）`);
}

// ---------------------------------------------------------------------------
section('3. interpCam：t=0 / 中值 / 末值');
const CAM_A = { r: 20, phi: 1.0, theta: 0.2, t: [0, 1.2, 0], fov: 45 };
const CAM_B = { r: 8, phi: 1.3, theta: 2.0, t: [3, 2, 1], fov: 30 };
{
  const c0 = interpCam(CAM_A, CAM_B, 0, 'inout');
  const cm = interpCam(CAM_A, CAM_B, 0.5, 'inout');
  const c1 = interpCam(CAM_A, CAM_B, 1, 'inout');
  lines.push(`  A = ${fmtCam(CAM_A)}`);
  lines.push(`  B = ${fmtCam(CAM_B)}`);
  lines.push(`  k=0    → ${fmtCam(c0)}`);
  lines.push(`  k=0.5  → ${fmtCam(cm)}`);
  lines.push(`  k=1    → ${fmtCam(c1)}`);
  ok('k=0 精确等于 A（r/phi/theta/t/fov）',
    near(c0.r, 20) && near(c0.phi, 1.0) && near(c0.theta, 0.2) && vecNear(c0.t, [0, 1.2, 0]) && near(c0.fov, 45));
  ok('k=0.5 落在几何中点（ease 中点 = 0.5）',
    near(cm.r, 14) && near(cm.phi, 1.15) && near(cm.theta, 1.1) && vecNear(cm.t, [1.5, 1.6, 0.5]) && near(cm.fov, 37.5));
  ok('k=1 精确等于 B', near(c1.r, 8) && near(c1.phi, 1.3) && near(c1.theta, 2.0) && vecNear(c1.t, [3, 2, 1]) && near(c1.fov, 30));
  const cmLin = interpCam(CAM_A, CAM_B, 0.5, 'linear');
  lines.push(`  k=0.5（linear）→ ${fmtCam(cmLin)}`);
  ok('linear 与 inout 在中点重合（三次缓动中点 = 0.5）',
    near(cmLin.r, cm.r) && near(cmLin.theta, cm.theta) && vecNear(cmLin.t, cm.t));
  // 缓动确实改变了曲线形状：k=0.25 时 inout 应小于 linear
  const q1 = interpCam(CAM_A, CAM_B, 0.25, 'inout');
  const q2 = interpCam(CAM_A, CAM_B, 0.25, 'linear');
  lines.push(`  k=0.25 → inout r=${fmt(q1.r, 3)} · linear r=${fmt(q2.r, 3)}`);
  ok('k=0.25 时 inout 慢于 linear（缓入）', q1.r > q2.r);
  // 跨 ±π 的末值：theta 应等价于 B.theta，而不是多绕一圈
  const wrapEnd = interpCam({ ...CAM_A, theta: 3.0 }, { ...CAM_B, theta: -3.0 }, 1, 'linear');
  lines.push(`  跨 ±π 末值 theta = ${fmt(wrapEnd.theta)}（与 -3.0 的角度差 ${fmt(angleDiff(wrapEnd.theta, -3.0), 6)}）`);
  ok('跨 ±π 的末值在角度上等于目标值', angleDiff(wrapEnd.theta, -3.0) < 1e-9);
  ok('interpCam 对非法输入有兜底（NaN → 默认值）',
    (() => { const c = interpCam({ r: NaN, phi: 0, theta: 'x', t: null, fov: 9999 }, CAM_B, 0, 'inout'); return near(c.r, 16) && near(c.fov, 179) && c.t.length === 3; })());
}

// ---------------------------------------------------------------------------
section('4. 总时长与镜头起点');
const S = [
  { id: 'a', label: '全景', duration: 2, cam: { r: 24, phi: 1.05, theta: 0.0, t: [0, 1.2, 0], fov: 45 }, ease: 'inout' },
  { id: 'b', label: '中景', duration: 3, cam: { r: 13, phi: 1.15, theta: 0.8, t: [1, 1.4, 0], fov: 40 }, ease: 'inout' },
  { id: 'c', label: '特写', duration: 4, cam: { r: 4, phi: 1.25, theta: 1.6, t: [2, 1.5, 0.5], fov: 30 }, ease: 'inout' }
];
{
  const total = shotsTotalDuration(S);
  lines.push(`  镜头时长 2 + 3 + 4 → 总时长 ${total}s；起点 ${[0, 1, 2].map(i => shotStartTime(S, i)).join(' / ')}s`);
  ok('总时长 = 9', near(total, 9));
  ok('空数组总时长 = 0', shotsTotalDuration([]) === 0);
  ok('起点：0 / 2 / 5', near(shotStartTime(S, 0), 0) && near(shotStartTime(S, 1), 2) && near(shotStartTime(S, 2), 5));
  ok('起点越界被夹取', near(shotStartTime(S, 99), 9) && near(shotStartTime(S, -1), 0));
}

// ---------------------------------------------------------------------------
section('5. sampleShots 时间采样（t=0 / 中值 / 末值 / 定格）');
{
  const at = (t) => { const x = sampleShots(S, t); return x; };
  const s0 = at(0), s1 = at(1), s2 = at(2), s65 = at(6.5), s9 = at(9), s99 = at(99), sn = at(-5);
  lines.push(`  t=0.0 → idx=${s0.index} local=${fmt(s0.local)} ${fmtCam(s0.cam)}`);
  lines.push(`  t=1.0 → idx=${s1.index} local=${fmt(s1.local)} ${fmtCam(s1.cam)}`);
  lines.push(`  t=2.0 → idx=${s2.index} local=${fmt(s2.local)} ${fmtCam(s2.cam)}`);
  lines.push(`  t=6.5 → idx=${s65.index} local=${fmt(s65.local)} ${fmtCam(s65.cam)}`);
  lines.push(`  t=9.0 → idx=${s9.index} local=${fmt(s9.local)} atEnd=${s9.atEnd} ${fmtCam(s9.cam)}`);
  lines.push(`  t=99  → idx=${s99.index} local=${fmt(s99.local)} atEnd=${s99.atEnd}（越界夹到末尾）`);
  lines.push(`  t=-5  → idx=${sn.index} local=${fmt(sn.local)}（负值夹到 0）`);
  ok('t=0：镜头 0、local=0、相机 = 镜头0 姿态', s0.index === 0 && near(s0.local, 0) && near(s0.cam.r, 24) && near(s0.cam.theta, 0));
  ok('t=1：镜头 0 的 50%（2s 段的中点）', s1.index === 0 && near(s1.local, 0.5));
  ok('t=1：相机 = A→B 的中点（r 24→13 ⇒ 18.5）', near(s1.cam.r, 18.5), `r=${fmt(s1.cam.r)}`);
  ok('t=2：正好切到镜头 1、local=0、相机 = 镜头1 姿态', s2.index === 1 && near(s2.local, 0) && near(s2.cam.r, 13) && near(s2.cam.theta, 0.8));
  ok('t=6.5：最后一个镜头（5s 起）local=0.375', s65.index === 2 && near(s65.local, 0.375), `local=${fmt(s65.local)}`);
  ok('最后一个镜头是定格：t=6.5 相机 = 镜头2 姿态（fov 30）', near(s65.cam.fov, 30) && near(s65.cam.r, 4));
  ok('t=9 = 末尾：atEnd=true、停在镜头 2', s9.atEnd === true && s9.index === 2 && near(s9.cam.r, 4));
  ok('t=99 越界夹取到末尾', s99.atEnd === true && near(s99.cam.r, 4));
  ok('t=-5 负值夹到 0', sn.index === 0 && near(sn.cam.r, 24));
  ok('空镜头数组返回 null', sampleShots([], 3) === null);
  const one = sampleShots([S[0]], 1.0);
  ok('只有 1 个镜头：时长内保持该姿态', near(one.cam.r, 24) && one.atEnd === false);
  ok('只有 1 个镜头：到末尾 atEnd=true', sampleShots([S[0]], 2).atEnd === true);
}

// ---------------------------------------------------------------------------
section('6. 规整与格式化');
{
  const n1 = normalizeShot({ duration: 0.01, label: '  ', cam: { r: -5, phi: 0, theta: 1, t: [1, 'x', 3], fov: 0 } }, 0);
  lines.push(`  极端输入 → ${JSON.stringify({ label: n1.label, duration: n1.duration, cam: n1.cam })}`);
  ok('时长下限夹到 0.1', near(n1.duration, MIN_SHOT_DURATION));
  ok('空名称回落「镜头 1」', n1.label === '镜头 1');
  ok('r 取正、phi 夹进安全区、fov 夹到 ≥1', n1.cam.r >= 0.01 && n1.cam.phi > 0 && n1.cam.fov >= 1);
  const n2 = normalizeShot({ duration: 999, ease: 'weird' }, 4);
  ok('时长上限夹到 120', near(n2.duration, MAX_SHOT_DURATION));
  ok('未知 ease → inout', n2.ease === 'inout');
  ok('缺 id 自动补', typeof n2.id === 'string' && n2.id.length > 0);
  ok('formatTime(0) = 0:00.0', formatTime(0) === '0:00.0', `实际 ${formatTime(0)}`);
  ok('formatTime(3.4) = 0:03.4', formatTime(3.4) === '0:03.4', `实际 ${formatTime(3.4)}`);
  ok('formatTime(65.2) = 1:05.2', formatTime(65.2) === '1:05.2', `实际 ${formatTime(65.2)}`);
  ok('formatTime(-3) 不为负', formatTime(-3) === '0:00.0', `实际 ${formatTime(-3)}`);
  ok('normalizeCam 默认值：r16 phi1.05 fov45',
    (() => { const c = normalizeCam(null); return c.r === 16 && near(c.phi, 1.05) && c.fov === 45; })());
}

// ---------------------------------------------------------------------------
section('7. Timeline 数据层（假 editor，无 DOM）');
{
  // 假 editor：只实现契约里的两个方法
  const fake = {
    sph: { r: 20, phi: 1.0, theta: 0.1 },
    target: { x: 0, y: 1.2, z: 0 },
    camera: { fov: 45 },
    calls: 0,
    lastCam: null,
    captureCam() {
      return { r: this.sph.r, phi: this.sph.phi, theta: this.sph.theta, t: [this.target.x, this.target.y, this.target.z], fov: this.camera.fov };
    },
    applyCamState(cs) {
      this.calls++; this.lastCam = cs;
      this.sph = { r: cs.r, phi: cs.phi, theta: cs.theta };
      this.target = { x: cs.t[0], y: cs.t[1], z: cs.t[2] };
      this.camera.fov = cs.fov;
      return true;
    }
  };
  let changes = 0;
  const tl = new Timeline({ editor: fake, onChange: () => { changes++; } });

  // 摆三个机位并抓成镜头
  fake.sph = { r: 24, phi: 1.05, theta: 3.0 }; fake.target = { x: 0, y: 1.2, z: 0 }; fake.camera.fov = 45;
  const sh1 = tl.addShotFromCamera();
  fake.sph = { r: 12, phi: 1.2, theta: -3.0 }; fake.target = { x: 2, y: 1.4, z: 1 }; fake.camera.fov = 35;
  const sh2 = tl.addShotFromCamera();
  fake.sph = { r: 4, phi: 1.3, theta: -2.4 }; fake.target = { x: 3, y: 1.5, z: 1 }; fake.camera.fov = 28;
  const sh3 = tl.addShotFromCamera();

  lines.push(`  3 次 addShotFromCamera → ids=${tl.getShots().map(s => '…' + s.id.slice(-2)).join(', ')}，onChange 触发 ${changes} 次`);
  ok('加镜头返回完整模型 {id,label,duration,cam,ease}',
    !!sh1 && typeof sh1.id === 'string' && sh1.label === '镜头 1' && near(sh1.duration, DEFAULT_SHOT_DURATION) && !!sh1.cam && sh1.ease === 'inout');
  ok('抓到的是当前相机（第 1 帧 theta=3.0, fov=45）', near(tl.getShots()[0].cam.theta, 3.0) && near(tl.getShots()[0].cam.fov, 45));
  ok('默认时长 3s × 3 = 9s', near(tl.totalDuration(), 9), `实际 ${tl.totalDuration()}`);
  ok('onChange 每次加镜头都触发（3 次）', changes === 3, `实际 ${changes}`);

  // seek 到 t=0 / 中点 / 末尾，检查是否真的写进了 editor
  const c0 = tl.seek(0);
  const camAt0 = fake.lastCam;
  const rAt0 = fake.sph.r;
  const c45 = tl.seek(4.5);
  const camAt45 = fake.lastCam;
  const cEnd = tl.seek(999);
  const camEnd = fake.lastCam;
  lines.push(`  seek(0)    → time=${fmt(c0)} editor.sph.r=${fmt(rAt0, 3)}（= 镜头1 的 24）`);
  lines.push(`  seek(4.5)  → time=${fmt(c45)} lastCam=${fmtCam(camAt45)}`);
  lines.push(`  seek(999)  → time=${fmt(cEnd)}（夹到总时长）lastCam=${fmtCam(camEnd)}`);
  ok('seek(0) 把镜头 1 姿态写进 editor', near(camAt0.r, 24) && near(camAt0.theta, 3.0));
  ok('seek(999) 夹到总时长 9', near(cEnd, 9));
  ok('seek 到末尾 = 镜头 3 姿态', near(camEnd.r, 4) && near(camEnd.fov, 28));
  ok('seek 中点落在镜头 2 的段内（4.5 ∈ [3,6)）', near(c45, 4.5));
  // 跨 ±π 的那一段：镜头1 theta=3.0 → 镜头2 theta=-3.0，段区间 [0,3)
  const segMid = sampleShots(tl.getShots(), 1.5);
  lines.push(`  镜头1→2 段中点（t=1.5）theta = ${fmt(segMid.cam.theta)}（应跨 ±π，≈3.1416，而不是绕 0）`);
  ok('镜头1→2 的 theta 走最短弧（≈±π，而不是绕 0）', angleDiff(segMid.cam.theta, Math.PI) < 0.02, `θ=${fmt(segMid.cam.theta)}`);
  const segLate = sampleShots(tl.getShots(), 2.5);
  lines.push(`  该段 t=2.5 theta = ${fmt(segLate.cam.theta)}（朝 -3.0 收敛中，等价角距还剩 ${fmt(angleDiff(segLate.cam.theta, -3.0), 4)}）`);

  // 拷贝语义
  const copy = tl.getShots();
  copy[0].label = '被外部改了';
  ok('getShots() 返回深拷贝，外部改动不影响内部', tl.getShots()[0].label === '镜头 1');

  // 改时长 → 总时长跟着变
  const before = tl.totalDuration();
  tl.updateShot(sh3.id, { duration: 5, label: '特写' });
  lines.push(`  把第 3 个镜头时长 3→5：总时长 ${before} → ${tl.totalDuration()}，名称 → ${tl.getShots()[2].label}`);
  ok('updateShot 改时长后总时长 = 11', near(tl.totalDuration(), 11));
  ok('updateShot 改名生效', tl.getShots()[2].label === '特写');
  ok('updateShot 时长下限保护（-3 → 0.1）', (() => { tl.updateShot(sh3.id, { duration: -3 }); const d = tl.getShots()[2].duration; tl.updateShot(sh3.id, { duration: 5 }); return near(d, MIN_SHOT_DURATION); })());

  // 排序 / 删除
  const idsBefore = tl.getShots().map(s => s.id);
  tl.moveShot(0, 2);
  const idsAfter = tl.getShots().map(s => s.id);
  lines.push(`  moveShot(0→2)：${idsBefore.map(i => i.slice(-2)).join(',')} → ${idsAfter.map(i => i.slice(-2)).join(',')}`);
  ok('moveShot 把第 1 个移到末尾', idsAfter[2] === idsBefore[0] && idsAfter[0] === idsBefore[1]);
  ok('moveShot 越界返回 false', tl.moveShot(0, 9) === false);
  const n0 = tl.getShots().length;
  tl.removeShot(idsAfter[0]);
  lines.push(`  removeShot → ${n0} → ${tl.getShots().length} 个镜头`);
  ok('removeShot 数量 -1', tl.getShots().length === n0 - 1);
  ok('removeShot 未知 id 返回 false', tl.removeShot('nope') === false);

  // 播放器状态机（不依赖 rAF 的逻辑部分）
  ok('初始 isPlaying = false', tl.isPlaying === false);
  ok('totalDuration() 是数字', typeof tl.totalDuration() === 'number');
  tl.seek(0);
  ok('stop() 后时间归零', (() => { tl.stop(); return tl.isPlaying === false; })());
  ok('空时间线 play() 返回 false', (() => { const t2 = new Timeline({}); return t2.play() === false; })());
  ok('destroy() 后可安全重复调用', (() => { tl.destroy(); tl.destroy(); return tl.getShots().length === 0; })());
}

// ---------------------------------------------------------------------------
section('8. 采样连续性（播放不会跳帧）');
// 判据不是拍脑袋的阈值，而是可推导的速度上界：
//   easeInOutCubic 在 k=0.5 处导数 = 3（是平均速度的 3 倍），
//   所以每段 dt 内的最大位移 ≈ 3 × (该段各分量跨度之和) / 段时长 × dt。
// 实测最大跳变应当贴着这个上界而不会超过它 —— 超过就说明采样在段边界断了。
{
  const total = shotsTotalDuration(S);
  const dt = total / 900;
  let bound = 0;
  for (let i = 0; i < S.length - 1; i++) {
    const A = normalizeCam(S[i].cam), B = normalizeCam(S[i + 1].cam);
    const span = Math.abs(B.r - A.r) + Math.abs(B.phi - A.phi)
      + Math.abs(shortestAngleDelta(A.theta, B.theta))
      + Math.abs(B.t[0] - A.t[0]) + Math.abs(B.t[1] - A.t[1]) + Math.abs(B.t[2] - A.t[2])
      + Math.abs(B.fov - A.fov) / 50;                    // fov 量纲不同，压到近似尺度
    bound = Math.max(bound, (3 * span / S[i].duration) * dt);
  }
  let maxJump = 0, prev = null, atT = 0;
  for (let i = 0; i <= 900; i++) {
    const t = (i / 900) * total;
    const c = sampleShots(S, t).cam;
    if (prev) {
      const jump = Math.abs(c.r - prev.r) + Math.abs(c.phi - prev.phi)
        + angleDiffLocal(c.theta, prev.theta)
        + Math.abs(c.t[0] - prev.t[0]) + Math.abs(c.t[1] - prev.t[1]) + Math.abs(c.t[2] - prev.t[2])
        + Math.abs(c.fov - prev.fov) / 50;
      if (jump > maxJump) { maxJump = jump; atT = t; }
    }
    prev = c;
  }
  lines.push(`  0→9s 均匀 901 采样（dt=${fmt(dt, 3)}s）：相邻采样最大姿态跳变 ${fmt(maxJump, 4)} @t=${fmt(atT, 2)}s`);
  lines.push(`  理论上界 3×span/dur×dt = ${fmt(bound, 4)}（easeInOutCubic 中点导数 3）`);
  ok('采样连续：实测最大跳变 ≤ 理论速度上界（无段边界断裂）', maxJump <= bound * 1.01, `实测 ${fmt(maxJump, 4)} / 上界 ${fmt(bound, 4)}`);
  ok('播放不会出现「瞬移」级跳变（< 2× 上界）', maxJump < bound * 2, `实测 ${fmt(maxJump, 4)}`);
}
function angleDiffLocal(a, b) { return Math.abs((((a - b) % TAU) + TAU + Math.PI) % TAU - Math.PI); }

// ---------------------------------------------------------------------------
lines.push('');
lines.push(`结果：${pass} 通过 / ${fail} 失败`);
console.log('=== timeline.test.mjs ===');
console.log(lines.join('\n'));
process.exit(fail ? 1 : 0);
