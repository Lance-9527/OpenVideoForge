/* ==========================================================================
 * studio-tracks.js · 运动轨迹系统（v52）
 *
 * 目标（可切换）：主相机 / 任意物体 / 任意无人机·手机
 *   → 点目标行即切换，之后画线、编辑手柄、看向、时间调整都作用于它
 *
 * 时间线（类剪映可拖条）：每个目标一条 bar
 *   · 拖条身 = 整体前后移动（时间顺序）
 *   · 拖左/右边缘 = 起止时间
 *   · 速度 = ×0.5 / ×1 / ×1.5 / ×2（点速度按钮循环）
 *   · 总时长自由填（不再"轨迹走完就停"，没走完的时间保持姿态）
 *
 * 拍成片：按总时长渲染（Blender），轨迹按各自 start/end/speed 映射到整条时间轴。
 * ========================================================================== */
import * as THREE from 'three';

const $ = (s, r) => (r || document).querySelector(s);
const ed = () => (window.__wb && window.__wb.editor) || null;
const tl = () => (window.__wb && window.__wb.timeline) || null;

const BAS = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const BAS_INV = BAS.clone().invert();
const canon = (p) => [p[0], -p[2], p[1]];
const uncanon = (p) => [p[0], p[2], -p[1]];
const fmt = (n) => Math.round(n * 100) / 100;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function canonQuat(q) {
  const out = BAS.clone().multiply(new THREE.Quaternion(q[0], q[1], q[2], q[3])).multiply(BAS_INV).normalize();
  return [out.x, out.y, out.z, out.w].map((v) => Math.round(v * 1e6) / 1e6);
}
function yawQuat(yaw) { const h = yaw / 2; return canonQuat([0, Math.sin(h), 0, Math.cos(h)]); }
const EASES = {
  linear: (k) => k,
  easeInOut: (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2),
  easeIn: (k) => k * k * k,
  easeOut: (k) => 1 - Math.pow(1 - k, 3),
};
const SPEEDS = [0.5, 1, 1.5, 2];

let panel = null;
let drawing = false;
let drawPoints = [];
let mode = '';            // '' | 'draw' | 'edit'
let handles = [];
let handleGroup = null;
let lines = [];
let preview = null;
let dragKey = null;
let shootBusy = false;
let caps = { blender: null, checkedAt: 0, latency: null, error: null };

/** 问本机桥：有没有 Blender 渲染服务（没有就走浏览器录制） */
async function probeCaps(force) {
  if (!force && caps.checkedAt && Date.now() - caps.checkedAt < 8000) return caps;
  try {
    const res = await fetch('http://127.0.0.1:8787/tool', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'wb_caps', args: {} }),
    });
    const j = await res.json();
    const d = (j && j.data) || {};
    caps = {
      blender: !!d.blender,                 // ★ 真能用 Blender 渲染
      serviceUp: !!d.service_up,            // 服务在不在（≠ Blender 装了没）
      checkedAt: Date.now(),
      latency: d.latency_ms ?? null,
      error: d.error || null,
      hint: d.hint || null,
      url: d.url || null,
      outDir: d.out_dir || null,
    };
  } catch (e) {
    caps = { blender: false, serviceUp: false, checkedAt: Date.now(), latency: null, error: String(e && e.message || e) };
  }
  updateCapsUI();
  return caps;
}

function updateCapsUI() {
  const el = panel && $('#tkCap', panel);
  if (!el) return;
  if (caps.blender === null) { el.textContent = '检测中…'; el.className = 'tk-cap'; return; }
  if (caps.blender) {
    el.textContent = 'Blender 在线' + (caps.latency != null ? ' · ' + caps.latency + 'ms' : '');
    el.className = 'tk-cap ok';
  } else if (caps.serviceUp) {
    // ★ 服务在、但没装 Blender —— 说清楚差什么
    el.textContent = '服务在 · 没装 Blender → 浏览器录制';
    el.className = 'tk-cap warn';
    el.title = caps.hint || '';
  } else {
    el.textContent = '浏览器录制（没起 VideoForge / 没装 Blender）';
    el.className = 'tk-cap warn';
    el.title = caps.hint || (caps.error || '');
  }
}

function toast(msg, kind = 'ok', ms = 3000) {
  const box = $('#toasts');
  if (!box) return;
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  box.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}

/* ------------------------------------------------------------ */
/* 数据                                                          */
/* ------------------------------------------------------------ */
const fps = () => Number(ed()?.studioRender?.fps) || 24;

function meta() {
  const e = ed();
  if (!e) return null;
  if (!e._trackMeta) {
    const d = (tl() && tl().totalDuration && tl().totalDuration() > 0.2) ? tl().totalDuration() : 3;
    e._trackMeta = { duration: +d.toFixed(2), fps: fps(), camera: null, objects: {}, devices: {}, active: { kind: 'camera' } };
  }
  const m = e._trackMeta;
  m.objects = m.objects || {};
  m.devices = m.devices || {};
  m.active = m.active || { kind: 'camera' };
  if (!(m.duration > 0.2)) m.duration = 3;
  return m;
}
function tracks() {
  const e = ed();
  if (!e) return null;
  e.studioTracks = e.studioTracks || { camera: null, object_tracks: [], device_tracks: [] };
  e.studioTracks.object_tracks = e.studioTracks.object_tracks || [];
  e.studioTracks.device_tracks = e.studioTracks.device_tracks || [];
  return e.studioTracks;
}
const dur = () => meta()?.duration || 3;
const totalFrames = () => Math.max(2, Math.round(dur() * fps()));

function targetLabel(t) {
  const e = ed();
  if (!t || t.kind === 'camera') return '主相机';
  if (t.kind === 'device') {
    const d = e && e.deviceById(t.id);
    return (d ? (d.device === 'drone' ? '无人机' : '手机') : '设备') + ' ' + String(t.id).slice(-6);
  }
  const rec = e && e.objects.find(o => o.instanceId === t.id);
  return rec ? String(rec.assetId || '').replace('external:asset_', 'GLB ').slice(0, 16) : String(t.id || '').slice(0, 8);
}
function active() { return meta()?.active || { kind: 'camera' }; }

/** 每个目标的默认时间窗 */
function timing(t) {
  const m = meta();
  if (!m) return { start: 0, end: 3, speed: 1 };
  const box = t.kind === 'camera' ? m.camera : (t.kind === 'device' ? m.devices[t.id] : m.objects[t.id]);
  const tg = (box && box.timing) || null;
  return tg ? { ...tg } : { start: 0, end: m.duration, speed: 1 };
}

function setTiming(t, patch) {
  const m = meta(); if (!m) return;
  const box = t.kind === 'camera' ? (m.camera = m.camera || {}) : t.kind === 'device'
    ? (m.devices[t.id] = m.devices[t.id] || { segments: [], ease: 'linear' })
    : (m.objects[t.id] = m.objects[t.id] || { segments: [], ease: 'linear', follow: true });
  const cur = timing(t);
  box.timing = {
    start: clamp(Number(patch.start ?? cur.start), 0, m.duration - 0.2),
    end: clamp(Number(patch.end ?? cur.end), 0.2, m.duration),
    speed: clamp(Number(patch.speed ?? cur.speed), 0.2, 4),
  };
  if (box.timing.end <= box.timing.start + 0.15) box.timing.end = Math.min(m.duration, box.timing.start + 0.2);
}

/* ---------- 路径采样 ---------- */
function resamplePolyline(pts, n) {
  if (!pts || pts.length < 2) return (pts || []).slice();
  const seg = []; let total = 0;
  for (let i = 1; i < pts.length; i++) { const d = pts[i].distanceTo(pts[i - 1]); seg.push(d); total += d; }
  if (total < 1e-6) return [pts[0].clone(), pts[pts.length - 1].clone()];
  const out = [];
  for (let i = 0; i < n; i++) {
    const target = (total * i) / Math.max(1, n - 1);
    let acc = 0, k = 0;
    while (k < seg.length - 1 && acc + seg[k] < target) { acc += seg[k]; k++; }
    const local = seg[k] > 1e-9 ? (target - acc) / seg[k] : 0;
    out.push(pts[k].clone().lerp(pts[k + 1], clamp(local, 0, 1)));
  }
  return out;
}

function targetConfig(t) {
  const m = meta();
  if (!m) return null;
  if (t.kind === 'camera') return m.camera;
  if (t.kind === 'device') return m.devices[t.id] || null;
  return m.objects[t.id] || null;
}

/** 把多个 segment 按弧长拼成一条采样器：u∈[0,1] → 点 */
function makeSampler(segments) {
  if (!segments || !segments.length) return () => null;
  const segs = segments.map(sg => ({ pts: sg.points, ease: EASES[sg.ease] || EASES.linear }));
  const lens = segs.map(sg => {
    let L = 0;
    for (let i = 1; i < sg.pts.length; i++) L += sg.pts[i].distanceTo(sg.pts[i - 1]);
    return L || 0.001;
  });
  const total = lens.reduce((a, b) => a + b, 0);
  return (u) => {
    const k = clamp(u, 0, 1) * total;
    let acc = 0, i = 0;
    while (i < lens.length - 1 && acc + lens[i] < k) { acc += lens[i]; i++; }
    const localRaw = lens[i] > 1e-9 ? (k - acc) / lens[i] : 0;
    const local = segs[i].ease(clamp(localRaw, 0, 1));
    const dense = segs[i]._dense || (segs[i]._dense = resamplePolyline(segs[i].pts, Math.max(24, Math.round(lens[i] * 12))));
    const idx = clamp(Math.round(local * (dense.length - 1)), 0, dense.length - 1);
    return dense[idx];
  };
}

function tangentYawOf(sampler, u) {
  const a = sampler(clamp(u - 0.01, 0, 1));
  const b = sampler(clamp(u + 0.01, 0, 1));
  if (!a || !b) return null;
  const dx = b.x - a.x, dz = b.z - a.z;
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return null;
  return Math.atan2(dx, dz) + Math.PI;
}

function lookAtPoint() {
  const e = ed();
  const sel = e && e.selected;
  if (sel) {
    const b = new THREE.Box3().setFromObject(sel.group);
    const c = b.getCenter(new THREE.Vector3());
    return { x: c.x, y: Math.max(c.y, 0.8), z: c.z };
  }
  const t = e && e.target;
  return { x: t ? t.x : 0, y: t ? Math.max(t.y, 0.8) : 1, z: t ? t.z : 0 };
}

/** 生成某个目标在整条时间轴上的稠密关键帧（含"等待/保持"段） */
function buildKeys(t) {
  const e = ed(); const st = tracks(); const m = meta();
  if (!e || !st || !m) return 0;
  const cfg = targetConfig(t);
  if (!cfg || !cfg.segments || !cfg.segments.length) return 0;
  const sampler = makeSampler(cfg.segments);
  const frames = totalFrames();
  const tg = timing(t);
  const startF = Math.round(tg.start * m.fps);
  const endF = Math.max(startF + 1, Math.round(tg.end * m.fps));
  const isCam = t.kind === 'camera';
  const look = (isCam && cfg.look) ? cfg.look : lookAtPoint();
  const baseY = Number(e.camera.position.y) || 1.4;
  const y0 = Number(cfg.y0 ?? baseY), y1 = Number(cfg.y1 ?? y0);
  const follow = t.kind === 'object' && cfg.follow !== false;
  const keys = [];

  for (let f = 0; f < frames; f++) {
    let u;
    if (f <= startF) u = 0;
    else if (f >= endF) u = 1;
    else u = ((f - startF) / Math.max(1, endF - startF)) * Number(tg.speed || 1);
    u = clamp(u, 0, 1);
    const p = sampler(u);
    if (!p) continue;
    if (isCam) {
      const y = y0 + (y1 - y0) * (f / Math.max(1, frames - 1));
      keys.push({
        frame: f,
        position: canon([p.x, y, p.z]).map(fmt),
        target: canon([look.x, look.y, look.z]).map(fmt),
        roll: 0,
        vertical_fov: Number(e.camera.fov) || 45,
      });
    } else if (t.kind === 'object') {
      const yaw = follow ? tangentYawOf(sampler, u) : null;
      keys.push({
        frame: f,
        position: canon([p.x, 0, p.z]).map(fmt),
        quaternion: yaw == null ? [0, 0, 0, 1] : yawQuat(yaw),
        scale: [1, 1, 1],
      });
    } else {
      keys.push({ frame: f, position: canon([p.x, p.y, p.z]).map(fmt) });
    }
  }
  keys.forEach((k, i) => { k.frame = i; });

  if (isCam) st.camera = { vertical_fov: Number(e.camera.fov) || 45, keys };
  else if (t.kind === 'object') {
    const rec = e.objects.find(o => o.instanceId === t.id);
    const entry = { instance_id: t.id, asset_id: rec?.assetId || null, keys };
    const i = st.object_tracks.findIndex(x => x.instance_id === t.id);
    if (i >= 0) st.object_tracks[i] = entry; else st.object_tracks.push(entry);
  } else {
    const entry = { device_id: t.id, keys };
    const i = st.device_tracks.findIndex(x => x.device_id === t.id);
    if (i >= 0) st.device_tracks[i] = entry; else st.device_tracks.push(entry);
  }
  return keys.length;
}

function rebuildAll() {
  const m = meta(); const st = tracks();
  if (!m || !st) return;
  if (m.camera && m.camera.segments && m.camera.segments.length) buildKeys({ kind: 'camera' });
  for (const id of Object.keys(m.objects)) {
    if (m.objects[id].segments && m.objects[id].segments.length) buildKeys({ kind: 'object', id });
  }
  for (const id of Object.keys(m.devices)) {
    if (m.devices[id].segments && m.devices[id].segments.length) buildKeys({ kind: 'device', id });
  }
}

/* ------------------------------------------------------------ */
/* 线 / 手柄                                                     */
/* ------------------------------------------------------------ */
function clearLines() {
  const e = ed(), sc = e && e.scene;
  const old = lines; lines = [];
  old.forEach(l => { if (sc) sc.remove(l); try { l.geometry.dispose(); l.material.dispose(); } catch (_) {} });
  if (e) e._extraHelpers = (e._extraHelpers || []).filter(h => !old.includes(h));
}
function clearHandles() {
  const sc = ed() && ed().scene;
  handles = [];
  if (handleGroup) {
    if (sc) sc.remove(handleGroup);
    const e = ed();
    if (e) e._extraHelpers = (e._extraHelpers || []).filter(h => h !== handleGroup);
    handleGroup = null;
  }
}
function lineFromPoints(pts, color) {
  const e = ed(); const sc = e && e.scene;
  if (!sc || pts.length < 2) return null;
  const geo = new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(p.x, p.y, p.z)));
  const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false });
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 996;
  sc.add(line); lines.push(line);
  e._extraHelpers = e._extraHelpers || []; e._extraHelpers.push(line);
  return line;
}
function activeKeys() {
  const e = ed(); const t = active();
  if (!e) return null;
  const st = e.studioTracks;
  if (t.kind === 'camera') return st?.camera?.keys || null;
  if (t.kind === 'object') return (st?.object_tracks || []).find(x => x.instance_id === t.id)?.keys || null;
  return (st?.device_tracks || []).find(x => x.device_id === t.id)?.keys || null;
}
function devicePosKeys() {
  const e = ed(); const st = e?.studioTracks;
  return st?.device_tracks || [];
}
function redraw() {
  clearLines();
  const st = ed()?.studioTracks;
  if (!st) return;
  if (st.camera?.keys?.length > 1) {
    lineFromPoints(st.camera.keys.map(k => { const w = uncanon(k.position); return { x: w[0], y: w[1], z: w[2] }; }), 0xb08d57);
  }
  for (const tr of st.object_tracks || []) {
    if (!tr.keys || tr.keys.length < 2) continue;
    lineFromPoints(tr.keys.map(k => { const w = uncanon(k.position); return { x: w[0], y: w[1] + 0.02, z: w[2] }; }), 0x6e8a75);
  }
  for (const tr of st.device_tracks || []) {
    if (!tr.keys || tr.keys.length < 2) continue;
    lineFromPoints(tr.keys.map(k => { const w = uncanon(k.position); return { x: w[0], y: w[1], z: w[2] }; }), 0x5f7fa8);
  }
  if (mode === 'edit') buildHandles();
}
function buildHandles() {
  clearHandles();
  const keys = activeKeys();
  const e = ed(); const sc = e && e.scene;
  if (!keys || !sc) return;
  handleGroup = new THREE.Group();
  const color = active().kind === 'camera' ? 0xd4b68a : (active().kind === 'device' ? 0x8fb0d6 : 0x8fac96);
  const step = Math.max(1, Math.round(keys.length / 24));
  keys.forEach((k, i) => {
    if (i % step !== 0 && i !== keys.length - 1) return;
    const w = uncanon(k.position);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
    mesh.position.set(w[0], w[1], w[2]);
    mesh.renderOrder = 999;
    mesh.userData = { index: i };
    handleGroup.add(mesh);
  });
  sc.add(handleGroup);
  e._extraHelpers = e._extraHelpers || []; e._extraHelpers.push(handleGroup);
}

/* ------------------------------------------------------------ */
/* 指针：绘制 / 编辑                                              */
/* ------------------------------------------------------------ */
const ndc = new THREE.Vector2();
const ray = new THREE.Raycaster();
const plane = new THREE.Plane();

function groundPoint(ev, y) {
  const e = ed();
  const cv = e.renderer.domElement, r = cv.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, e.camera);
  plane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, y, 0));
  const hit = new THREE.Vector3();
  return ray.ray.intersectPlane(plane, hit) ? hit : null;
}
function pickHandle(ev) {
  const e = ed();
  if (!e || !handleGroup) return null;
  const cv = e.renderer.domElement, r = cv.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, e.camera);
  const hit = ray.intersectObjects(handleGroup.children, false)[0];
  return hit ? hit.object : null;
}
function drawPlaneY() {
  const e = ed(); const t = active();
  if (t.kind === 'camera') return Math.max(0.2, e.camera.position.y * 0.35);
  if (t.kind === 'device') { const d = e.deviceById(t.id); return d ? d.group.position.y : 1.4; }
  const rec = e.selected;
  return rec ? rec.group.position.y : 0;
}

function onDown(ev) {
  const e = ed();
  if (!e) return;
  if (mode === 'edit') {
    const h = pickHandle(ev);
    if (h) {
      if (ev.altKey) { deleteKey(h.userData.index); ev.preventDefault(); ev.stopPropagation(); return; }
      dragKey = { index: h.userData.index, lastY: ev.clientY };
      try { e.renderer.domElement.setPointerCapture(ev.pointerId); } catch (_) {}
      ev.preventDefault(); ev.stopPropagation();
    }
    return;
  }
  if (mode !== 'draw') return;
  if (ev.button !== 0) return;
  const t = active();
  if (t.kind === 'object' && !e.selected) { toast('先选中要运动的物体', 'warn'); return; }
  drawing = true;
  drawPoints = [];
  const p = groundPoint(ev, drawPlaneY());
  if (p) drawPoints.push(p);
  try { e.renderer.domElement.setPointerCapture(ev.pointerId); } catch (_) {}
  ev.preventDefault(); ev.stopPropagation();
}
function onMove(ev) {
  const e = ed();
  if (!e) return;
  if (dragKey && mode === 'edit') {
    const keys = activeKeys();
    const k = keys && keys[dragKey.index];
    if (!k) return;
    const cur = uncanon(k.position);
    if (ev.shiftKey) {
      const dy = ev.clientY - (dragKey.lastY ?? ev.clientY);
      dragKey.lastY = ev.clientY;
      k.position = canon([cur[0], Math.max(0, cur[1] - dy * 0.012), cur[2]]).map(fmt);
    } else {
      const p = groundPoint(ev, cur[1]);
      if (p) k.position = canon([p.x, cur[1], p.z]).map(fmt);
    }
    redraw();
    ev.preventDefault(); ev.stopPropagation();
    return;
  }
  if (!drawing) return;
  const p = groundPoint(ev, drawPlaneY());
  if (p) {
    const last = drawPoints[drawPoints.length - 1];
    if (!last || last.distanceTo(p) > 0.03) { drawPoints.push(p); redrawTemp(); }
  }
  ev.preventDefault(); ev.stopPropagation();
}
function onUp(ev) {
  if (dragKey) { dragKey = null; if (mode === 'edit') syncMetaFromKeys(); ev.preventDefault(); ev.stopPropagation(); return; }
  if (!drawing) return;
  drawing = false;
  ev.preventDefault(); ev.stopPropagation();
  if (drawPoints.length < 2) { toast('点太少，画一条长一点的线', 'warn'); return; }
  commitSegment();
}
function redrawTemp() {
  const tmp = lines.find(l => l.userData.tmp);
  if (tmp) { const sc = ed().scene; sc.remove(tmp); lines = lines.filter(l => l !== tmp); try { tmp.geometry.dispose(); } catch (_) {} }
  const line = lineFromPoints(drawPoints, 0xc2634e);
  if (line) line.userData.tmp = true;
}

function targetBox(t) {
  const m = meta();
  if (!m) return null;
  if (t.kind === 'camera') return (m.camera = m.camera || { segments: [], ease: 'linear', y0: undefined, y1: undefined });
  if (t.kind === 'device') return (m.devices[t.id] = m.devices[t.id] || { segments: [], ease: 'linear' });
  return (m.objects[t.id] = m.objects[t.id] || { segments: [], ease: 'linear', follow: true });
}

function commitSegment() {
  const t = active();
  const box = targetBox(t);
  if (!box) return;
  if (box.segments.length >= 8) { toast('每个目标最多 8 段，先清空', 'warn'); return; }
  const pts = drawPoints.map(p => p.clone());
  drawPoints = [];
  box.segments.push({ points: pts, ease: box.ease || 'linear' });
  if (!box.timing) box.timing = { start: 0, end: dur(), speed: 1 };
  rebuildAll(); redraw(); renderPanel();
  toast(targetLabel(t) + ' · ' + box.segments.length + ' 段 · ' + (box.timing ? '' : ''));
}

function syncMetaFromKeys() {
  const t = active();
  const keys = activeKeys();
  const box = targetConfig(t);
  if (!keys || !box) return;
  const web = keys.map(k => { const w = uncanon(k.position); return new THREE.Vector3(w[0], w[1], w[2]); });
  box.segments = [{ points: web, ease: 'linear' }];
  if (t.kind === 'camera') { box.y0 = web[0].y; box.y1 = web[web.length - 1].y; }
}

function deleteKey(index) {
  const keys = activeKeys();
  if (!keys) return;
  if (keys.length <= 2) { toast('至少保留 2 个关键帧', 'warn'); return; }
  keys.splice(index, 1);
  keys.forEach((k, i) => { k.frame = i; });
  syncMetaFromKeys(); redraw(); renderPanel();
}

function insertKeyAt(ev) {
  const keys = activeKeys();
  if (!keys || keys.length < 2) return;
  const e = ed();
  const cv = e.renderer.domElement, r = cv.getBoundingClientRect();
  const nd = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  const rr = new THREE.Raycaster();
  rr.setFromCamera(nd, e.camera);
  const campos = e.camera.position;
  let bestI = 1, bestD = Infinity;
  for (let i = 1; i < keys.length; i++) {
    const a = new THREE.Vector3(...uncanon(keys[i - 1].position));
    const b = new THREE.Vector3(...uncanon(keys[i].position));
    const line = new THREE.Line3(a, b);
    const p = new THREE.Vector3();
    line.closestPointToPoint(campos, false, p);
    const d = campos.distanceTo(p);
    if (d < bestD) { bestD = d; bestI = i; }
  }
  const a = new THREE.Vector3(...uncanon(keys[bestI - 1].position));
  const b = new THREE.Vector3(...uncanon(keys[bestI].position));
  const mid = a.add(b).multiplyScalar(0.5);
  const k = JSON.parse(JSON.stringify(keys[bestI - 1]));
  k.position = canon([mid.x, mid.y, mid.z]).map(fmt);
  keys.splice(bestI, 0, k);
  keys.forEach((kk, i) => { kk.frame = i; });
  syncMetaFromKeys(); redraw(); renderPanel();
  toast('已插入关键帧');
}

/* ------------------------------------------------------------ */
/* 模式切换                                                      */
/* ------------------------------------------------------------ */
function bindCanvas() {
  const e = ed();
  if (!e) return;
  const cv = e.renderer.domElement;
  if (cv.__tkBound) return;
  cv.__tkBound = true;
  cv.addEventListener('pointerdown', onDown, true);
  cv.addEventListener('pointermove', onMove, true);
  cv.addEventListener('pointerup', onUp, true);
  cv.addEventListener('dblclick', (ev) => { if (mode === 'edit') { insertKeyAt(ev); ev.preventDefault(); } }, true);
  cv.style.cursor = 'crosshair';
}
function unbindCanvas() {
  const e = ed();
  if (!e) return;
  const cv = e.renderer.domElement;
  cv.__tkBound = false;
  cv.removeEventListener('pointerdown', onDown, true);
  cv.removeEventListener('pointermove', onMove, true);
  cv.removeEventListener('pointerup', onUp, true);
  cv.style.cursor = '';
}

function startDraw() {
  const e = ed();
  if (!e) { toast('先打开场景', 'warn'); return; }
  stopEdit();
  mode = 'draw';
  bindCanvas();
  toast('画 ' + targetLabel(active()) + ' 的轨迹：按住左键画（可多段）；Esc 结束', 'ok', 4200);
  renderPanel();
}
function startEdit() {
  const e = ed();
  if (!e) return;
  stopDraw();
  if (!activeKeys()) { toast('这个目标还没有轨迹', 'warn'); return; }
  mode = 'edit';
  bindCanvas();
  redraw(); renderPanel();
  toast('编辑 ' + targetLabel(active()) + '：拖手柄改点（Shift 升降）· 双击加帧 · Alt 点删帧', 'ok', 5000);
}
function stopDraw() { if (mode === 'draw') mode = ''; drawing = false; unbindCanvas(); renderPanel(); }
function stopEdit() { if (mode === 'edit') mode = ''; clearHandles(); if (mode !== 'draw') unbindCanvas(); renderPanel(); }

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { stopDraw(); stopEdit(); }
  if ((ev.key === 'p' || ev.key === 'P') && !ev.repeat && !ev.ctrlKey && !ev.metaKey && !mode) {
    const tag = (ev.target && ev.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    const e = ed(); if (!e) return;
    startDraw();
  }
});
document.addEventListener('keyup', (ev) => { if ((ev.key === 'p' || ev.key === 'P') && mode === 'draw') stopDraw(); });

/* ------------------------------------------------------------ */
/* 目标切换                                                      */
/* ------------------------------------------------------------ */
function targets() {
  const e = ed();
  const out = [{ kind: 'camera' }];
  if (!e) return out;
  for (const o of e.objects || []) out.push({ kind: 'object', id: o.instanceId });
  for (const d of e.listDevices() || []) out.push({ kind: 'device', id: d.id });
  return out;
}
function setActive(kind, id) {
  const e = ed(); const m = meta();
  if (!m) return;
  m.active = { kind, id };
  if (kind === 'device' && e && e.deviceById(id)) {
    e.focusDevice(id);              // 视口高亮 + 小窗切到该设备
  }
  redraw(); renderPanel();
}

/* ------------------------------------------------------------ */
/* 时间线（可拖条）                                               */
/* ------------------------------------------------------------ */
let dragBar = null;

function barPointerDown(ev) {
  const bar = ev.target.closest('.tkl-bar');
  if (!bar) return;
  ev.preventDefault(); ev.stopPropagation();
  const row = bar.closest('.tkl-row');
  const kind = row.dataset.kind, id = row.dataset.id || undefined;
  const rect = bar.getBoundingClientRect();
  const zone = ev.clientX - rect.left < 10 ? 'start' : (rect.right - ev.clientX < 10 ? 'end' : 'move');
  // 切目标（只改高亮，不重建 DOM，避免拖拽中途条子被换掉）
  const m = meta();
  if (m) m.active = { kind, id };
  if (panel) $$('.tkl-bar.on', panel).forEach(b => b.classList.remove('on'));
  bar.classList.add('on');
  if (kind === 'device') { const e = ed(); if (e && e.focusDevice) e.focusDevice(id); }
  dragBar = { kind, id, zone, x0: ev.clientX, t0: timing({ kind, id }), bar, row };
  document.body.style.cursor = zone === 'move' ? 'grabbing' : 'ew-resize';
  window.addEventListener('pointermove', barPointerMove);
  window.addEventListener('pointerup', barPointerUp, { once: true });
}

function barPointerMove(ev) {
  if (!dragBar) return;
  const trackEl = dragBar.row.querySelector('.tkl-track');
  const w = (trackEl && trackEl.clientWidth) || 1;
  const dt = ((ev.clientX - dragBar.x0) / w) * dur();
  const t0 = dragBar.t0;
  const t = { kind: dragBar.kind, id: dragBar.id };
  if (dragBar.zone === 'move') {
    const span = t0.end - t0.start;
    const start = clamp(t0.start + dt, 0, dur() - span);
    setTiming(t, { start, end: start + span });
  } else if (dragBar.zone === 'start') {
    setTiming(t, { start: clamp(t0.start + dt, 0, t0.end - 0.2) });
  } else {
    setTiming(t, { end: clamp(t0.end + dt, t0.start + 0.2, dur()) });
  }
  // 局部更新条子（不重建）
  const tg = timing(t);
  const bar = dragBar.bar;
  bar.style.left = (tg.start / dur()) * 100 + '%';
  bar.style.width = Math.max(2, ((tg.end - tg.start) / dur()) * 100) + '%';
  const label = bar.querySelector('b');
  if (label) label.textContent = tg.start.toFixed(1) + '–' + tg.end.toFixed(1) + 's';
}

function barPointerUp() {
  if (!dragBar) return;
  window.removeEventListener('pointermove', barPointerMove);
  dragBar = null;
  document.body.style.cursor = '';
  rebuildAll(); redraw(); renderTimeline(); renderPanel();
}

function renderTimeline() {
  const box = panel && $('#tkTimeline', panel);
  if (!box) return;
  const m = meta();
  if (!m) return;
  const w = dur();
  const rows = targets().map(t => {
    const cfg = targetConfig(t);
    const tg = timing(t);
    const has = !!(cfg && cfg.segments && cfg.segments.length);
    const left = (tg.start / w) * 100, width = Math.max(2, ((tg.end - tg.start) / w) * 100);
    const key = t.kind === 'camera' ? 'camera' : t.id;
    return `<div class="tkl-row${has ? '' : ' dim'}" data-kind="${t.kind}" data-id="${t.id || ''}">
      <span class="tkl-name" title="${targetLabel(t)}">${targetLabel(t)}</span>
      <div class="tkl-track">
        <div class="tkl-bar${active().kind === t.kind && active().id === t.id ? ' on' : ''}" style="left:${left}%;width:${width}%" title="拖条身移动 · 拖两端改起止">
          <i class="tkl-edge l"></i><i class="tkl-edge r"></i>
          <b>${tg.start.toFixed(1)}–${tg.end.toFixed(1)}s</b>
        </div>
      </div>
      <button type="button" class="tkl-speed" data-speed="${t.kind}|${t.id || ''}" title="点击切换速度">×${tg.speed}</button>
    </div>`;
  }).join('');
  box.innerHTML = rows;
  $$('.tkl-speed', box).forEach(btn => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const [kind, id] = btn.dataset.speed.split('|');
      const t = { kind, id: id || undefined };
      const cur = timing(t).speed;
      const next = SPEEDS[(SPEEDS.indexOf(cur) + 1) % SPEEDS.length];
      setTiming(t, { speed: next });
      rebuildAll(); redraw(); renderTimeline();
      toast(targetLabel(t) + ' 速度 ×' + next);
    };
  });
}
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ------------------------------------------------------------ */
/* 预览                                                          */
/* ------------------------------------------------------------ */
function stopPreview() { if (preview?.raf) cancelAnimationFrame(preview.raf); preview = null; renderPanel(); }

function playPreview() {
  const e = ed(); const st = e?.studioTracks;
  if (!e || !st) { toast('还没有轨迹', 'warn'); return; }
  const frames = totalFrames();
  const durSec = frames / fps();
  stopPreview();
  const startCam = e.captureCam();
  const startPos = new Map();
  for (const tr of st.object_tracks || []) { const r = e.objects.find(o => o.instanceId === tr.instance_id); if (r) startPos.set('o:' + tr.instance_id, { p: r.group.position.clone(), q: r.group.quaternion.clone() }); }
  for (const tr of st.device_tracks || []) { const d = e.deviceById(tr.device_id); if (d) startPos.set('d:' + tr.device_id, { p: d.group.position.clone() }); }
  const t0 = performance.now();
  preview = { raf: 0 };
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / 1000 / durSec);
    const f = Math.min(frames - 1, Math.round(k * (frames - 1)));
    const camK = st.camera?.keys?.[f];
    if (camK) {
      const p = uncanon(camK.position), t = uncanon(camK.target);
      const off = new THREE.Vector3(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
      const r = off.length();
      if (r > 1e-4) e.applyCamState({ r, phi: Math.acos(clamp(off.y / r, -1, 1)), theta: Math.atan2(off.x, off.z), t, fov: camK.vertical_fov || e.camera.fov });
    }
    for (const tr of st.object_tracks || []) {
      const rec = e.objects.find(o => o.instanceId === tr.instance_id);
      const key = tr.keys?.[f];
      if (!rec || !key) continue;
      const w = uncanon(key.position);
      rec.group.position.set(w[0], w[1], w[2]);
      if (key.quaternion) {
        const qc = new THREE.Quaternion(key.quaternion[0], key.quaternion[1], key.quaternion[2], key.quaternion[3]);
        rec.group.quaternion.copy(BAS_INV.clone().multiply(qc).multiply(BAS));
      }
    }
    for (const tr of st.device_tracks || []) {
      const d = e.deviceById(tr.device_id);
      const key = tr.keys?.[f];
      if (!d || !key) continue;
      const w = uncanon(key.position);
      d.group.position.set(w[0], w[1], w[2]);
      if (d.cam) d.cam.position.copy(d.group.position);
    }
    if (k < 1) {
      // ★ 2026-11-10：rAF 在后台页面会被饿死 ⇒ 加 setTimeout 兜底
      let fired = false;
      const once = () => { if (fired) return; fired = true; step(); };
      preview.raf = requestAnimationFrame(once);
      setTimeout(once, 16);
    }
    else {
      stopPreview();
      e.applyCamState(startCam);
      for (const [id, s] of startPos) {
        if (id.startsWith('o:')) { const r = e.objects.find(o => o.instanceId === id.slice(2)); if (r) { r.group.position.copy(s.p); r.group.quaternion.copy(s.q); } }
        else { const d = e.deviceById(id.slice(2)); if (d) { d.group.position.copy(s.p); if (d.cam) d.cam.position.copy(s.p); } }
      }
      redraw(); toast('预览结束（已回到原位）');
    }
  };
  preview.raf = requestAnimationFrame(step);
  renderPanel();
}

/* ------------------------------------------------------------ */
/* 清空 / 撤销段                                                  */
/* ------------------------------------------------------------ */
/** 没有 Blender 时的兜底：离屏渲染 + MediaRecorder 实时录一条 MP4/WebM（带成片调色） */
async function shootBrowser() {
  if (shootBusy) return { ok: false, error: '正在拍摄中' };
  const e = ed(); const st = tracks(); const m = meta();
  if (!e || !st || !m) return { ok: false, error: '先打开场景' };
  if (!st.camera?.keys?.length && !(st.object_tracks || []).length && !(st.device_tracks || []).length) {
    toast('先画轨迹（主相机或物体）', 'warn'); return { ok: false, error: '没有轨迹' };
  }
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(x => {
    try { return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(x); } catch (_) { return false; }
  });
  if (!mime) { toast('这个浏览器不支持录制（换 Chrome/Edge）', 'warn'); return { ok: false, error: '不支持 MediaRecorder' }; }
  const [w, h] = String(($('#tkRes', panel) && $('#tkRes', panel).value) || '1280x720').split('x').map(Number);
  const fps = Number(m.fps) || 24;
  const frames = totalFrames();
  const durSec = frames / fps;
  shootBusy = true;
  setStatus('浏览器录制中 · 0%', 'run');
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = Number(e.exposure || 1);
  const cam = new THREE.PerspectiveCamera(Number(st.camera?.vertical_fov) || 45, w / h, 0.1, 500);
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  const grade = (e.getColorGrade && e.getColorGrade()) || { contrast: 1, saturation: 1, vignette: 0 };
  const film = (e.getFilmLook && e.getFilmLook()) || {};
  const FG = window.FilmGrade;
  const startCam = e.captureCam();
  const startObj = new Map();
  for (const tr of st.object_tracks || []) { const r = e.objects.find(o => o.instanceId === tr.instance_id); if (r) startObj.set(tr.instance_id, { p: r.group.position.clone(), q: r.group.quaternion.clone() }); }
  const startDev = new Map();
  for (const tr of st.device_tracks || []) { const d = e.deviceById(tr.device_id); if (d) startDev.set(tr.device_id, d.group.position.clone()); }
  let rec = null, chunks = [], firstPng = null, done = null;
  try {
    const stream = out.captureStream(fps);
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(w * h * fps * 0.12) });
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) chunks.push(ev.data); };
    done = new Promise((res) => { rec.onstop = res; });
    rec.start(250);
    const t0 = performance.now();
    await new Promise((resolve) => {
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / 1000 / durSec);
        const f = Math.min(frames - 1, Math.round(k * (frames - 1)));
        const ck = st.camera?.keys?.[f];
        if (ck) {
          const p = uncanon(ck.position), t = uncanon(ck.target);
          const off = new THREE.Vector3(p[0] - t[0], p[1] - t[1], p[2] - t[2]);
          const r = off.length();
          if (r > 1e-4) e.applyCamState({ r, phi: Math.acos(clamp(off.y / r, -1, 1)), theta: Math.atan2(off.x, off.z), t, fov: ck.vertical_fov || cam.fov });
        }
        for (const tr of st.object_tracks || []) {
          const r = e.objects.find(o => o.instanceId === tr.instance_id);
          const key = tr.keys?.[f];
          if (!r || !key) continue;
          const wp = uncanon(key.position);
          r.group.position.set(wp[0], wp[1], wp[2]);
          if (key.quaternion) {
            const qc = new THREE.Quaternion(key.quaternion[0], key.quaternion[1], key.quaternion[2], key.quaternion[3]);
            r.group.quaternion.copy(BAS_INV.clone().multiply(qc).multiply(BAS));
          }
        }
        for (const tr of st.device_tracks || []) {
          const d = e.deviceById(tr.device_id);
          const key = tr.keys?.[f];
          if (!d || !key) continue;
          const wp = uncanon(key.position);
          d.group.position.set(wp[0], wp[1], wp[2]);
          if (d.cam) d.cam.position.copy(d.group.position);
        }
        const restore = e.hideEditorHelpers ? e.hideEditorHelpers() : null;
        // ★ 2026-11-09：**把主相机同步到录制相机**。
        //   原来 cam 是个**新建的空相机**，从没被更新过 ——
        //   applyCamState() 更新的是 e.camera（主相机），而渲染用的是局部 cam。
        //   ⇒ cam 永远停在原点 (0,0,0) 朝 -Z ⇒ **录出来是一片白**（实测：ffmpeg 抽帧确认）。
        cam.position.copy(e.camera.position);
        cam.quaternion.copy(e.camera.quaternion);
        cam.fov = e.camera.fov;
        cam.aspect = w / h;
        cam.near = e.camera.near;
        cam.far = e.camera.far;
        cam.updateProjectionMatrix();
        // ★ 真实感也套上（HDRI + PBR 材质 + 统一调色）—— 不然录出来的跟小窗预览对不上
        const RL = window.__ovfRealLook;
        const restoreReal = (RL && RL.isReal())
          ? RL.applyCurrent(e.scene, e, renderer)
          : null;
        renderer.render(e.scene, cam);
        if (restoreReal) restoreReal();
        if (restore) restore();
        if (FG) {
          // 调色也用同一份（真实感开着时）
          const gopts = (RL && RL.isReal())
            ? Object.assign({}, film, RL.gradeForLook(RL.getLook()))
            : Object.assign({}, film, { contrast: grade.contrast, saturation: grade.saturation, vignette: grade.vignette });
          FG.apply(ctx, renderer.domElement, w, h, gopts);
        }
        else ctx.drawImage(renderer.domElement, 0, 0, w, h);
        if (!firstPng) firstPng = out.toDataURL('image/png');
        setStatus('浏览器录制中 · ' + Math.round(k * 100) + '%', 'run');
        // ★ 2026-11-10：**不要只靠 rAF**（页面在后台时 rAF 会被饿死，
        //   实测：hidden 页面的第一个 rAF 要等 214 秒 ⇒ 浏览器录制直接卡死）。
        if (k < 1) {
          let fired = false;
          const once = () => { if (fired) return; fired = true; step(); };
          requestAnimationFrame(once);
          setTimeout(once, 16);
        } else { try { rec.stop(); } catch (_) {} resolve(); }
      };
      requestAnimationFrame(step);
      setTimeout(() => { /* 兜底：rAF 不来也能起步 */ }, 0);
    });
    await done;
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    const ext = mime.includes('mp4') ? '.mp4' : '.webm';
    const stamp = Date.now().toString(36);
    const prefix = (document.querySelector('#edName') ? document.querySelector('#edName').value : '') || '白膜';
    const name = prefix + '_浏览器_' + frames + 'f' + ext;
    const url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
    if (window.WBSave) await window.WBSave.save(url, name);
    if (firstPng && window.WBSave) await window.WBSave.save(firstPng, prefix + '_浏览器_' + frames + 'f_首帧.png');
    setStatus('✓ 拍好了 · 浏览器录制 · ' + w + '×' + h + ' · ' + durSec.toFixed(1) + 's · ' + (blob.size / 1048576).toFixed(1) + ' MB', 'ok');
    toast('没有 Blender：已用浏览器录制出片（' + name + '）', 'ok', 5000);
    return { ok: true, data: { mode: 'browser', frames, seconds: durSec, bytes: blob.size, name } };
  } catch (err) {
    setStatus('✗ ' + err.message, 'err');
    toast('录制失败：' + err.message, 'warn', 4000);
    return { ok: false, error: err.message };
  } finally {
    shootBusy = false;
    try { e.applyCamState(startCam); } catch (_) {}
    for (const [id, s0] of startObj) { const r = e.objects.find(o => o.instanceId === id); if (r) { r.group.position.copy(s0.p); r.group.quaternion.copy(s0.q); } }
    for (const [id, p0] of startDev) { const d = e.deviceById(id); if (d) d.group.position.copy(p0); }
    try { renderer.dispose(); } catch (_) {}
    redraw();
  }
}

function clearTracks() {
  const e = ed();
  if (e) {
    e.studioTracks = { camera: null, object_tracks: [], device_tracks: [] };
    if (e._trackMeta) { e._trackMeta.camera = null; e._trackMeta.objects = {}; e._trackMeta.devices = {}; }
  }
  clearLines(); clearHandles(); stopEdit();
  renderPanel(); toast('已清空轨迹');
}
function removeLastSegment() {
  const t = active();
  const box = targetConfig(t);
  if (!box || !box.segments || !box.segments.length) { toast('这个目标还没有轨迹', 'warn'); return; }
  box.segments.pop();
  if (!box.segments.length) {
    const m = meta();
    if (t.kind === 'camera') m.camera = null;
    else if (t.kind === 'device') delete m.devices[t.id];
    else delete m.objects[t.id];
    const st = tracks();
    if (t.kind === 'object') st.object_tracks = st.object_tracks.filter(x => x.instance_id !== t.id);
    if (t.kind === 'device') st.device_tracks = st.device_tracks.filter(x => x.device_id !== t.id);
    if (t.kind === 'camera') st.camera = null;
  }
  rebuildAll(); redraw(); renderTimeline(); renderPanel();
  toast('已撤销上一段');
}

/* ------------------------------------------------------------ */
/* 拍成片（时长自由）                                             */
/* ------------------------------------------------------------ */
function setStatus(text, kind) {
  const el = panel && $('#tkStatus', panel);
  if (!el) return;
  if (!text) { el.hidden = true; return; }
  el.hidden = false;
  el.className = 'tk-status' + (kind ? ' ' + kind : '');
  el.textContent = text;
}

async function shootFinal() {
  if (shootBusy) return { ok: false, error: '正在拍摄中' };
  const e = ed();
  if (!e) return { ok: false, error: '先打开场景' };
  const m = meta();
  const st = tracks();
  if (!st.camera?.keys?.length && !(st.object_tracks || []).length) { toast('先画轨迹（主相机或物体）', 'warn'); return { ok: false, error: '没有轨迹' }; }
  const sec = clamp(Number(m.duration) || 3, 0.5, 120);
  const fpsV = fps();
  const c = await probeCaps();
  if (!c.blender) return shootBrowser();      // 没装 Blender：浏览器录制兜底
  const [w, h] = String(($('#tkRes', panel) && $('#tkRes', panel).value) || '1280x720').split('x').map(Number);
  shootBusy = true;
  setStatus('提交中…', 'run');
  try {
    // 时长若大于页面时间线，先将时间线总长同步到页面（Blender 侧用 seconds 参数）
    let sub = null;
    try {
      sub = await window.WB_AGENT.run('studio.render.submit', { seconds: sec, fps: fpsV, width: w, height: h });
    } catch (e) {
      setStatus('Blender 掉线，改浏览器录制…', 'run');
      shootBusy = false;
      return shootBrowser();
    }
    const job = sub?.data?.job_id || sub?.data?.id;
    if (!job) {
      setStatus('Blender 不可用，改浏览器录制…', 'run');
      shootBusy = false;
      return shootBrowser();
    }
    if (window.WBRender) window.WBRender.watch(job);
    setStatus('渲染中 · 0%', 'run');
    const t0 = Date.now();
    let done = null;
    for (let i = 0; i < 600; i++) {
      await new Promise(r => setTimeout(r, 1200));
      const stt = await window.WB_AGENT.run('studio.render.status', { job_id: job });
      const d = stt?.data || {};
      const status = String(d.status || '');
      const pct = Math.round((Number(d.progress) || 0) * 100);
      if (status === 'succeeded') { done = d; break; }
      if (status === 'failed' || status === 'cancelled') throw new Error('任务' + status + '：' + (d.error || ''));
      setStatus('渲染中 · ' + pct + '% · ' + ((Date.now() - t0) / 1000).toFixed(0) + 's', 'run');
    }
    if (!done) throw new Error('等待超时');
    setStatus('下载产物…', 'run');
    const prefix = (document.querySelector('#edName') ? document.querySelector('#edName').value : '') || '白膜';
    let saved = null;
    try {
      const res = await fetch('http://127.0.0.1:8787/tool', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'wb_render_save', args: { job_id: job, prefix } }),
      });
      saved = await res.json();
    } catch (_) {}
    const files = (saved && saved.data && saved.data.files) || [];
    const paths = files.map(x => x.path).filter(Boolean);
    // ★ 2026-11-10：帧数可能被**轨迹长度**顶高了（studio-bridge 会自动扩帧），
    //   所以实际时长要用返回的帧数重算，不能拿面板上那个 sec 糊弄。
    const realFrames = done.manifest?.render?.frame_count || 0;
    const realFps = done.manifest?.render?.fps || fpsV;
    const realSec = realFrames && realFps ? +(realFrames / realFps).toFixed(2) : sec;
    setStatus('✓ 拍好了 · ' + realFrames + ' 帧 · ' + realSec + 's · ' + (done.manifest?.blender_version || 'Blender'), 'ok');
    toast('成片已存到输出目录' + (paths.length ? '：' + paths[0].split('\\\\').pop() : ''), 'ok', 5000);
    if (window.WBRevisions) {
      window.WBRevisions.add({
        job_id: job, scene_id: e.studioSceneId || null, revision: e.studioRevision ?? null,
        render: done.manifest?.render, outputs: done.manifest?.outputs || [],
        blender: done.manifest?.blender_version, prefix, turns: null,
      });
    }
    return { ok: true, data: { job_id: job, files: paths, frames: realFrames, seconds: realSec } };
  } catch (err) {
    setStatus('✗ ' + err.message, 'err');
    toast('拍摄失败：' + err.message, 'warn', 4000);
    return { ok: false, error: err.message };
  } finally { shootBusy = false; }
}

/* ------------------------------------------------------------ */
/* 面板                                                          */
/* ------------------------------------------------------------ */
function build() {
  if (panel) return panel;
  const el = document.createElement('aside');
  el.id = 'trackPanel';
  el.className = 'tk-panel';
  el.hidden = true;
  el.innerHTML = `
    <header class="tk-head"><b>运动轨迹</b><span class="tk-sub">目标 · 时间线</span><button type="button" class="tk-x">×</button></header>
    <div class="tk-body">
      <div class="tk-row tk-target-row">
        <label class="tk-tlabel">目标</label>
        <select id="tkTarget"></select>
      </div>
      <div class="tk-row">
        <button type="button" class="tk-btn" id="tkDraw">✎ 画轨迹</button>
        <button type="button" class="tk-btn ghost" id="tkEdit">◆ 编辑关键帧</button>
        <button type="button" class="tk-btn ghost" id="tkLook" title="机位注视点设为选中物体">◎ 看向</button>
      </div>
      <div class="tk-grid">
        <label>缓动 <select id="tkEase"><option value="linear">线性</option><option value="easeInOut">缓入缓出</option><option value="easeIn">缓入</option><option value="easeOut">缓出</option></select></label>
        <label class="tk-check"><input type="checkbox" id="tkFollow"> 朝向跟随</label>
        <label>起高 <input type="number" id="tkY0" step="0.1" value="1.4"></label>
        <label>止高 <input type="number" id="tkY1" step="0.1" value="1.4"></label>
      </div>
      <div class="tk-tl-head"><span>时间线（拖条=改时间顺序 · 两端=起止 · 点 ×N=速度）</span></div>
      <div class="tk-timeline" id="tkTimeline"></div>
      <div class="tk-row tk-shoot-row">
        <label class="tk-tlabel">总时长</label>
        <input type="number" id="tkDur" step="0.5" min="0.5" max="120" value="3">
        <span class="tk-unit">s</span>
        <select id="tkRes" title="拍摄分辨率">
          <option value="1280x720" selected>1280×720</option>
          <option value="1920x1080">1920×1080</option>
          <option value="640x360">640×360</option>
        </select>
      </div>
      <div class="tk-row tk-caprow">
        <label class="tk-tlabel">渲染器</label>
        <span class="tk-cap" id="tkCap">检测中…</span>
        <button type="button" class="tk-cap-retry" id="tkCapRetry" title="重新检测 Blender">↻</button>
      </div>
      <div class="tk-row">
        <button type="button" class="tk-btn" id="tkShoot">🎬 拍成片</button>
        <button type="button" class="tk-btn ghost" id="tkPreview">▶ 预览</button>
        <button type="button" class="tk-btn ghost" id="tkStop">■ 停止</button>
      </div>
      <div class="tk-row">
        <button type="button" class="tk-btn ghost" id="tkUndoSeg">撤销段</button>
        <button type="button" class="tk-btn ghost" id="tkClear">清空</button>
      </div>
      <div class="tk-status" id="tkStatus" hidden></div>
      <div class="tk-hint" id="tkState"></div>
    </div>`;
  document.body.appendChild(el);
  panel = el;
  $('.tk-x', el).onclick = () => { el.hidden = true; };
  $('#tkDraw', el).onclick = startDraw;
  $('#tkEdit', el).onclick = startEdit;
  $('#tkLook', el).onclick = () => {
    const e = ed(); const m = meta(); const rec = e && e.selected;
    if (!m?.camera?.segments?.length) { toast('先画主相机轨迹', 'warn'); return; }
    if (!rec) { toast('先选中要看的物体', 'warn'); return; }
    const b = new THREE.Box3().setFromObject(rec.group);
    const c = b.getCenter(new THREE.Vector3());
    m.camera.look = { x: c.x, y: c.y, z: c.z };
    rebuildAll(); redraw(); toast('机位注视点 → 选中的物体');
  };
  $('#tkShoot', el).onclick = () => shootFinal();
  $('#tkCapRetry', el).onclick = () => probeCaps(true);
  $('#tkPreview', el).onclick = playPreview;
  $('#tkStop', el).onclick = () => { stopPreview(); stopDraw(); stopEdit(); };
  $('#tkUndoSeg', el).onclick = removeLastSegment;
  $('#tkClear', el).onclick = clearTracks;
  $('#tkTarget', el).onchange = () => {
    const v = $('#tkTarget', el).value;
    const [kind, id] = v.split('|');
    setActive(kind, id || undefined);
  };
  $('#tkEase', el).onchange = () => {
    const v = $('#tkEase', el).value;
    const t = active();
    const box = targetConfig(t);
    if (!box?.segments?.length) { toast('先画一条轨迹再选缓动', 'warn'); return; }
    box.ease = v; box.segments.forEach(s => s.ease = v);
    rebuildAll(); redraw(); toast('缓动：' + v);
  };
  $('#tkFollow', el).onchange = () => {
    const t = active(); const box = targetConfig(t);
    if (t.kind !== 'object' || !box) { toast('朝向跟随只对物体轨迹有效', 'warn'); return; }
    box.follow = $('#tkFollow', el).checked;
    rebuildAll(); redraw();
  };
  const applyHeights = () => {
    const m = meta(); if (!m?.camera) { toast('先画主相机轨迹', 'warn'); return; }
    m.camera.y0 = Number($('#tkY0', el).value);
    m.camera.y1 = Number($('#tkY1', el).value);
    rebuildAll(); redraw();
  };
  $('#tkY0', el).onchange = applyHeights;
  $('#tkY1', el).onchange = applyHeights;
  $('#tkDur', el).onchange = () => {
    const m = meta(); if (!m) return;
    const v = clamp(Number($('#tkDur', el).value) || 3, 0.5, 120);
    m.duration = v;
    // 时间窗不能超出新总长
    for (const box of [m.camera, ...Object.values(m.objects), ...Object.values(m.devices)]) {
      if (!box) continue;
      if (!box.timing) box.timing = { start: 0, end: v, speed: 1 };
      box.timing.end = clamp(box.timing.end, 0.2, v);
      box.timing.start = clamp(box.timing.start, 0, box.timing.end - 0.2);
    }
    rebuildAll(); redraw(); renderTimeline(); renderPanel();
    toast('总时长 ' + v + 's → ' + totalFrames() + ' 帧');
  };
  const tlBox = $('#tkTimeline', el);
  tlBox.addEventListener('pointerdown', barPointerDown);
  return el;
}

function renderPanel() {
  if (!panel) return;
  const e = ed();
  const m = meta();
  if (!e || !m) return;
  const sel = $('#tkTarget', panel);
  const cur = active();
  const opts = targets().map(t => {
    const v = t.kind + '|' + (t.id || '');
    const has = targetConfig(t)?.segments?.length;
    return `<option value="${v}" ${cur.kind === t.kind && cur.id === t.id ? 'selected' : ''}>${targetLabel(t)}${has ? ' ●' : ''}</option>`;
  }).join('');
  if (sel.innerHTML !== opts) sel.innerHTML = opts;
  sel.value = cur.kind + '|' + (cur.id || '');
  const box = targetConfig(cur);
  if (box) { $('#tkEase', panel).value = box.ease || 'linear'; $('#tkFollow', panel).checked = box.follow !== false; }
  if (m.camera) { $('#tkY0', panel).value = String(m.camera.y0 ?? 1.4); $('#tkY1', panel).value = String(m.camera.y1 ?? 1.4); }
  const durEl = $('#tkDur', panel);
  if (document.activeElement !== durEl) durEl.value = String(m.duration);
  $('#tkState', panel).textContent = mode === 'draw'
    ? ('正在画 ' + targetLabel(cur) + '：按住左键画，可多段；Esc 结束')
    : (mode === 'edit' ? ('编辑 ' + targetLabel(cur) + '：拖手柄（Shift 升降）· 双击加帧 · Alt 点删帧')
      : '选目标 → 画轨迹 → 拖时间线 → 拍成片。Esc 退出绘制。');
  renderTimeline();
}

function open() { build().hidden = false; renderPanel(); redraw(); probeCaps(); }
function toggle() { if (!panel || panel.hidden) open(); else panel.hidden = true; }

/* ------------------------------------------------------------ */
/* 命令                                                          */
/* ------------------------------------------------------------ */
const COMMANDS = {
  'track.path.begin': ({ kind, id }) => { setActive(kind || 'camera', id); startDraw(); return { mode }; },
  'track.path.end': () => { stopDraw(); stopEdit(); return { mode }; },
  'track.edit.begin': ({ kind, id }) => { setActive(kind || 'camera', id); startEdit(); return { mode }; },
  'track.target.set': ({ kind, id }) => { setActive(kind || 'camera', id); return { active: active() }; },
  'track.path.clear': () => { clearTracks(); return { cleared: true }; },
  'track.duration.set': ({ seconds }) => {
    const m = meta();
    const v = clamp(Number(seconds) || 3, 0.5, 120);
    m.duration = v;
    for (const box of [m.camera, ...Object.values(m.objects), ...Object.values(m.devices)]) {
      if (!box) continue;
      if (!box.timing) box.timing = { start: 0, end: v, speed: 1 };
      box.timing.end = clamp(box.timing.end, 0.2, v);
    }
    rebuildAll(); redraw(); renderTimeline(); renderPanel();
    return { seconds: v, frames: totalFrames() };
  },
  'track.timing.set': ({ kind, id, start, end, speed }) => {
    const t = { kind: kind || 'camera', id };
    if (!targetConfig(t)?.segments?.length) return { error: '该目标还没有轨迹' };
    setTiming(t, { start, end, speed });
    rebuildAll(); redraw(); renderTimeline();
    return { timing: timing(t) };
  },
  'track.path.info': () => {
    const e = ed(); const st = e?.studioTracks || {}; const m = meta() || {};
    return {
      duration: m.duration, fps: m.fps || fps(), frames: totalFrames(),
      active: active(),
      camera_frames: st.camera?.keys?.length || 0,
      camera_segments: (m.camera?.segments || []).length,
      camera_timing: m.camera ? timing({ kind: 'camera' }) : null,
      object_tracks: (st.object_tracks || []).map(t => ({ instance_id: t.instance_id, frames: t.keys?.length || 0, timing: m.objects?.[t.instance_id]?.timing || null })),
      device_tracks: (st.device_tracks || []).map(t => ({ device_id: t.device_id, frames: t.keys?.length || 0, timing: m.devices?.[t.device_id]?.timing || null })),
      objects: (e?.objects || []).length, devices: (e?.listDevices() || []).length,
    };
  },
  'track.path.set': ({ kind, id, points: pts, segments, keys, instance_id, target, ease, follow, y0, y1, look_at, look_at_instance, timing: tgPatch }) => {
    const e = ed();
    if (!e) return { error: '先打开场景' };
    const m = meta();
    const k2 = kind === 'device' ? 'device' : (kind === 'camera' ? 'camera' : 'object');
    const tid = id || instance_id || (k2 === 'object' ? (target === 'selected' || !target ? e.selected?.instanceId : null) : (k2 === 'device' ? (target === 'selected' || !target ? e._lastDeviceId : null) : undefined));
    const segs = segments && segments.length ? segments : (pts && pts.length >= 2 ? [{ points: pts, ease: ease || 'linear' }] : null);
    const t = { kind: k2, id: tid };
    if (k2 === 'camera' && keys && keys.length) {
      tracks().camera = { vertical_fov: Number(e.camera.fov) || 45, keys };
      redraw(); renderPanel(); return { camera_frames: keys.length };
    }
    if (k2 === 'camera' && segs) {
      let look = null;
      if (Array.isArray(look_at) && look_at.length === 3) look = { x: look_at[0], y: look_at[1], z: look_at[2] };
      else if (look_at_instance) { const tgt = e.objects.find(o => o.instanceId === look_at_instance); if (tgt) { const b = new THREE.Box3().setFromObject(tgt.group); const c = b.getCenter(new THREE.Vector3()); look = { x: c.x, y: c.y, z: c.z }; } }
      m.camera = {
        look,
        segments: segs.map(sg => ({ points: sg.points.map(p => new THREE.Vector3(p[0], p[1], p[2])), ease: sg.ease || ease || 'linear' })),
        ease: ease || 'linear',
        y0: y0 ?? e.camera.position.y,
        y1: y1 ?? y0 ?? e.camera.position.y,
      };
      if (tgPatch) m.camera.timing = tgPatch;
      buildKeys({ kind: 'camera' }); redraw(); renderTimeline(); renderPanel();
      return { camera_frames: totalFrames(), segments: m.camera.segments.length };
    }
    if (keys && keys.length && k2 !== 'camera') {
      if (k2 === 'object') {
        const rec = tid ? e.objects.find(o => o.instanceId === tid) : e.selected;
        if (!rec) return { error: '找不到目标物体' };
        const entry = { instance_id: rec.instanceId, asset_id: rec.assetId || null, keys };
        const st = tracks();
        const i = st.object_tracks.findIndex(x => x.instance_id === rec.instanceId);
        if (i >= 0) st.object_tracks[i] = entry; else st.object_tracks.push(entry);
        redraw(); return { instance_id: rec.instanceId, frames: keys.length };
      }
      return { error: '设备轨迹请用 points/segments' };
    }
    if (!segs) return { error: '需要 points / segments / keys' };
    if (k2 === 'device') {
      const d = tid ? e.deviceById(tid) : null;
      if (!d) return { error: '找不到设备（传 id）' };
      m.devices[d.id] = { segments: segs.map(sg => ({ points: sg.points.map(p => new THREE.Vector3(p[0], p[1], p[2])), ease: sg.ease || ease || 'linear' })), ease: ease || 'linear' };
      if (tgPatch) m.devices[d.id].timing = tgPatch;
      buildKeys({ kind: 'device', id: d.id }); redraw(); renderTimeline(); renderPanel();
      return { device_id: d.id, frames: totalFrames(), segments: m.devices[d.id].segments.length };
    }
    const rec = tid ? e.objects.find(o => o.instanceId === tid) : e.selected;
    if (!rec) return { error: '找不到目标物体（先选中，或传 id/instance_id）' };
    m.objects[rec.instanceId] = {
      segments: segs.map(sg => ({ points: sg.points.map(p => new THREE.Vector3(p[0], 0, p[2])), ease: sg.ease || ease || 'linear' })),
      ease: ease || 'linear', follow: follow !== false,
    };
    if (tgPatch) m.objects[rec.instanceId].timing = tgPatch;
    buildKeys({ kind: 'object', id: rec.instanceId }); redraw(); renderTimeline(); renderPanel();
    return { instance_id: rec.instanceId, frames: totalFrames(), segments: m.objects[rec.instanceId].segments.length };
  },
  'track.key.insert': ({ kind, id, index }) => {
    setActive(kind || active().kind, id);
    const keys = activeKeys();
    if (!keys || keys.length < 2) return { error: '轨迹太短' };
    const i = clamp(Number(index) || Math.floor(keys.length / 2), 1, keys.length - 1);
    const k = JSON.parse(JSON.stringify(keys[i - 1]));
    k.position = keys[i - 1].position.map((v, j) => fmt((v + keys[i].position[j]) / 2));
    keys.splice(i, 0, k);
    keys.forEach((kk, idx) => { kk.frame = idx; });
    syncMetaFromKeys(); redraw(); return { count: keys.length, index: i };
  },
  'track.key.delete': ({ kind, id, index }) => {
    setActive(kind || active().kind, id);
    const keys = activeKeys();
    if (!keys || keys.length <= 2) return { error: '至少保留 2 帧' };
    const i = clamp(Number(index) || 0, 0, keys.length - 1);
    keys.splice(i, 1);
    keys.forEach((kk, idx) => { kk.frame = idx; });
    syncMetaFromKeys(); redraw(); return { count: keys.length };
  },
  'track.render.shoot': () => shootFinal(),
  'track.preview.play': () => { playPreview(); return { playing: true }; },
  'track.preview.stop': () => { stopPreview(); return { stopped: true }; },
};

function registerCommands() {
  const agent = window.WB_AGENT;
  if (!agent || !agent.register || agent.__tracksV2) return;
  for (const [name, fn] of Object.entries(COMMANDS)) { try { agent.register(name, fn); } catch (_) {} }
  agent.__tracksV2 = true;
}

/* 视口里点设备 → 面板目标切到该设备 */
document.addEventListener('wb-device-focus', (ev) => {
  const id = ev && ev.detail && ev.detail.id;
  if (!id) return;
  const m = meta();
  if (!m) return;
  if (m.active?.kind === 'device' && m.active.id === id) return;
  m.active = { kind: 'device', id };
  redraw(); renderPanel();
});
/** 选中物体 → 面板目标跟着切到该物体（若它没有轨迹就仍指向它，方便直接画） */
function hookSelect() {
  const e = ed();
  if (!e || e.__tkSelectHooked) return;
  e.__tkSelectHooked = true;
  const prev = e.opts && e.opts.onSelect;
  if (e.opts) {
    e.opts.onSelect = (rec) => {
      if (typeof prev === 'function') prev(rec);
      const m = meta();
      if (!m || !rec || !rec.instanceId) return;
      if (m.active?.kind === 'object' && m.active.id === rec.instanceId) return;
      m.active = { kind: 'object', id: rec.instanceId };
      if (panel && !panel.hidden) { redraw(); renderPanel(); }
    };
  }
}

let mounted = false;
function mount() {
  registerCommands();
  hookSelect();
  if (mounted) return;
  const tools = document.querySelector('.tb-tools');
  if (!tools) return;
  const b = document.createElement('button');
  b.id = 'wbTracks'; b.className = 'tb-btn'; b.type = 'button'; b.textContent = '轨迹';
  b.title = '运动轨迹：目标切换 / 手绘 / 关键帧 / 时间线拖条 / 拍成片';
  b.onclick = toggle;
  const anchor = document.querySelector('#wbHandoff');
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(b, anchor.nextSibling);
  else tools.appendChild(b);
  mounted = true;
}

const mo = new MutationObserver(() => mount());
mo.observe(document.body, { childList: true, subtree: true });
setInterval(() => { registerCommands(); mount(); hookSelect(); }, 1500);
mount();

window.WBTracks = {
  open, toggle, startDraw, stopDraw, startEdit, stopEdit, playPreview, stopPreview,
  shoot: shootFinal, shootBrowser, clear: clearTracks, undo: removeLastSegment, setActive, caps: probeCaps,
  info: COMMANDS['track.path.info'], setPath: COMMANDS['track.path.set'],
  setDuration: COMMANDS['track.duration.set'], setTiming: COMMANDS['track.timing.set'],
  get mode() { return mode; }, get active() { return active(); },
};
