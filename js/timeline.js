// ============================================================================
// 多镜头时间线 · OpenVideoForge / Whitebox Workbench
// ----------------------------------------------------------------------------
// 把「摆机位」升级成「能做分镜」：一串镜头卡片，每张记一个轨道相机姿态 +
// 停留时长，播放时按时间轴在相邻镜头之间插值运动（推、拉、摇、移、跟）。
//
// 设计约束（重要）：
//  1. 本模块 **不 import three.js**。插值全部是纯数值运算（球坐标 + 目标点 +
//     fov），因此可以在 Node 里直接单测，见 docs/timeline.test.mjs。
//  2. 相机状态由宿主的 editor 拥有，本模块只通过两个方法读写：
//        editor.captureCam()    -> { r, phi, theta, t:[x,y,z], fov }
//        editor.applyCamState(cs) -> boolean
//     再加 editor.captureThumb(w,h) -> dataURL（可选，用于镜头缩略图）。
//  3. 不改 index.html：mountTimeline() 自己建 DOM、自己注入 timeline.css。
//  4. 全部 UI 中文；所有按钮有 title + aria-label；Space / ←/→ 可键盘操作。
//
// 镜头数据模型（getShots() 的返回，可直接持久化）：
//   { id: string, label: string, duration: number(秒), cam: {r,phi,theta,t,fov},
//     ease: 'inout' | 'linear' }
// 缩略图不进模型（dataURL 太大，会撑爆 localStorage），只活在本次会话里。
// ============================================================================

export const DEFAULT_SHOT_DURATION = 3;
export const MIN_SHOT_DURATION = 0.1;
export const MAX_SHOT_DURATION = 120;
export const TAU = Math.PI * 2;

const STYLE_ID = 'wb-timeline-css';
const STYLE_HREF = new URL('../css/timeline.css', import.meta.url).href;

// ---------------------------------------------------------------------------
// 纯数学（可单测，无 DOM / 无 three）
// ---------------------------------------------------------------------------

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function num(v, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 标准 easeInOutCubic：k∈[0,1] → 0..1，两端各占一半时间做加减速 */
export function easeInOutCubic(k) {
  k = clamp(k, 0, 1);
  return k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
}

export function easeValue(k, ease) {
  return ease === 'linear' ? clamp(k, 0, 1) : easeInOutCubic(k);
}

/**
 * 最短弧角度差：把 (to - from) 折算到 (-π, π]。
 * 相机 theta 会无限累加（绕圈操作），直接线性插值会出现「绕远路 / 甩镜头」，
 * 所以水平角必须走最短弧。正好相差 π 时统一取正方向（结果 +π），保证确定性。
 */
export function shortestAngleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

export function lerp(a, b, k) {
  return a + (b - a) * k;
}

/** 角度插值（最短弧） */
export function lerpAngle(from, to, k) {
  return from + shortestAngleDelta(from, to) * k;
}

/** 把任意来源的相机对象规整成安全值（防 NaN / 防 phi 退化） */
export function normalizeCam(cam) {
  const c = cam || {};
  const t = Array.isArray(c.t) ? c.t : [0, 0, 0];
  return {
    r: Math.max(0.01, num(c.r, 16)),
    phi: clamp(num(c.phi, 1.05), 0.0001, Math.PI - 0.0001),
    theta: num(c.theta, 0),
    t: [num(t[0], 0), num(t[1], 0), num(t[2], 0)],
    fov: clamp(num(c.fov, 45), 1, 179)
  };
}

/**
 * 两个相机姿态之间插值。
 *   r     线性（推拉）
 *   phi   线性（俯仰）
 *   theta 最短弧（水平环绕，关键）
 *   t     三分量线性（跟移）
 *   fov   线性（变焦）
 */
export function interpCam(a, b, k, ease) {
  const A = normalizeCam(a);
  const B = normalizeCam(b);
  const e = easeValue(k, ease);
  return {
    r: lerp(A.r, B.r, e),
    phi: lerp(A.phi, B.phi, e),
    theta: lerpAngle(A.theta, B.theta, e),
    t: [lerp(A.t[0], B.t[0], e), lerp(A.t[1], B.t[1], e), lerp(A.t[2], B.t[2], e)],
    fov: lerp(A.fov, B.fov, e)
  };
}

/** 规整一个镜头（容错：缺字段、字符串数字、超范围时长） */
export function normalizeShot(shot, index) {
  const s = shot || {};
  return {
    id: typeof s.id === 'string' && s.id ? s.id : 'sh_' + (index + 1),
    label: typeof s.label === 'string' && s.label.trim() ? s.label.trim().slice(0, 24) : '镜头 ' + (index + 1),
    duration: clamp(num(s.duration, DEFAULT_SHOT_DURATION), MIN_SHOT_DURATION, MAX_SHOT_DURATION),
    cam: normalizeCam(s.cam),
    ease: s.ease === 'linear' ? 'linear' : 'inout'
  };
}

/** 时间线总时长 = 各镜头时长之和（最后一个镜头的时长是「定格」） */
export function shotsTotalDuration(shots) {
  const list = Array.isArray(shots) ? shots : [];
  let total = 0;
  for (const s of list) total += Math.max(0, num(s && s.duration, DEFAULT_SHOT_DURATION));
  return total;
}

/** 第 index 个镜头的起始时间（秒） */
export function shotStartTime(shots, index) {
  const list = Array.isArray(shots) ? shots : [];
  const n = clamp(index | 0, 0, list.length);
  let acc = 0;
  for (let i = 0; i < n; i++) acc += Math.max(0, num(list[i] && list[i].duration, DEFAULT_SHOT_DURATION));
  return acc;
}

/**
 * 采样：给定时间 t，返回该时刻的相机姿态与所处镜头。
 * 语义：镜头 i 占用 [start_i, start_i + dur_i)，在这段时间里相机从
 * 镜头 i 的运动到镜头 i+1 的姿态（用镜头 i 的 ease）；最后一个镜头是
 * 静止定格（时长为停留时间）。
 * 返回 { cam, index, local, from, to, shot, atEnd }；空数组返回 null。
 */
export function sampleShots(shots, time) {
  const list = Array.isArray(shots) ? shots : [];
  if (!list.length) return null;
  const total = shotsTotalDuration(list);
  const t = clamp(num(time, 0), 0, total);
  const last = list.length - 1;
  let acc = 0;
  for (let i = 0; i <= last; i++) {
    const dur = Math.max(0, num(list[i] && list[i].duration, DEFAULT_SHOT_DURATION));
    const isLast = i === last;
    if (t < acc + dur || isLast) {
      const local = dur > 0 ? clamp((t - acc) / dur, 0, 1) : 1;
      const from = normalizeCam(list[i] && list[i].cam);
      if (isLast) {
        return { cam: from, index: i, local, from: i, to: i, shot: list[i], atEnd: t >= total };
      }
      const to = normalizeCam(list[i + 1] && list[i + 1].cam);
      return {
        cam: interpCam(from, to, local, list[i].ease),
        index: i, local, from: i, to: i + 1, shot: list[i], atEnd: false
      };
    }
    acc += dur;
  }
  // 理论不可达（循环内 isLast 一定命中），兜底保持最后一帧
  const s = list[last];
  return { cam: normalizeCam(s && s.cam), index: last, local: 1, from: last, to: last, shot: s, atEnd: true };
}

/** 秒 → "0:03.4" */
export function formatTime(sec) {
  const s = Math.max(0, num(sec, 0));
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
}

// ---------------------------------------------------------------------------
// 样式注入（不依赖 index.html 改动）
// ---------------------------------------------------------------------------
function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = STYLE_HREF;
  document.head.appendChild(link);
}

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------
export class Timeline {
  /**
   * @param {object} opts
   * @param {object} opts.editor   宿主 editor（需有 captureCam / applyCamState）
   * @param {Function} opts.onChange (shots) => void，用户改动时回调，宿主持久化
   * @param {boolean} opts.collapsed 初始折叠
   */
  constructor(opts) {
    opts = opts || {};
    this.editor = opts.editor || null;
    this.onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
    this.shots = [];
    this._thumbs = new Map();   // id -> dataURL（会话内有效，不进持久化模型）
    this._root = null;
    this._els = null;
    this._time = 0;
    this._playing = false;
    this._raf = 0;
    this._playStart = 0;
    this._timeOffset = 0;
    this._selected = null;
    this._collapsed = !!opts.collapsed;
    this._seq = 0;
    this._destroyed = false;
    this._keyHandler = (e) => this._onKeyDown(e);
  }

  // ---- 生命周期 ----
  mount(hostEl) {
    if (this._destroyed) return this;
    ensureStyles();
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    // 重复 mount（换宿主）时先摘掉旧的全局键盘监听，避免叠加触发
    if (typeof document !== 'undefined') document.removeEventListener('keydown', this._keyHandler, false);
    const host = hostEl || (typeof document !== 'undefined' ? document.getElementById('view-editor') : null) || (typeof document !== 'undefined' ? document.body : null);
    if (!host) return this;
    this._build();
    host.appendChild(this._root);
    document.addEventListener('keydown', this._keyHandler, false);
    this._renderTrack();
    this._updateTransport();
    return this;
  }

  destroy() {
    this._destroyed = true;
    this._cancelRaf();
    this._playing = false;
    if (typeof document !== 'undefined') document.removeEventListener('keydown', this._keyHandler, false);
    if (this._root && this._root.parentNode) this._root.parentNode.removeChild(this._root);
    this._root = null;
    this._els = null;
    this._thumbs.clear();
    this.shots = [];
  }

  // ---- 数据 ----
  getShots() {
    // 深拷贝：外部拿到的对象改不到内部状态
    return JSON.parse(JSON.stringify(this.shots));
  }

  /** 载入镜头列表（不触发 onChange，避免载入时把宿主写回环） */
  setShots(shots, thumbById) {
    this.shots = (Array.isArray(shots) ? shots : []).map((s, i) => normalizeShot(s, i));
    if (thumbById && typeof thumbById === 'object') {
      this._thumbs.clear();
      for (const k of Object.keys(thumbById)) if (thumbById[k]) this._thumbs.set(k, thumbById[k]);
    }
    this._time = clamp(this._time, 0, this.totalDuration());
    if (this._root) { this._renderTrack(); this._updateTransport(); }
    return this;
  }

  /** 缩略图另存（宿主想持久化时取走；dataURL 不建议进 localStorage） */
  getThumbs() {
    const out = {};
    for (const [k, v] of this._thumbs.entries()) out[k] = v;
    return out;
  }

  /** 抓当前相机为一帧新镜头 */
  addShotFromCamera() {
    if (this._destroyed || !this.editor || typeof this.editor.captureCam !== 'function') return null;
    const cam = normalizeCam(this.editor.captureCam());
    let thumb = null;
    try {
      if (typeof this.editor.captureThumb === 'function') thumb = this.editor.captureThumb(160, 90) || null;
    } catch (_) { /* 截图失败不影响加镜头 */ }
    const shot = normalizeShot({ label: '镜头 ' + (this.shots.length + 1), cam }, this.shots.length);
    shot.id = 'sh_' + Date.now().toString(36) + '_' + (++this._seq);
    this.shots.push(shot);
    if (thumb) this._thumbs.set(shot.id, thumb);
    this._selected = shot.id;
    this._emit();
    this._renderTrack();
    this._updateTransport();
    return JSON.parse(JSON.stringify(shot));
  }

  updateShot(id, patch) {
    const s = this._find(id);
    if (!s || !patch) return null;
    if (typeof patch.label === 'string') s.label = patch.label.trim().slice(0, 24) || s.label;
    if (patch.duration !== undefined) s.duration = clamp(num(patch.duration, s.duration), MIN_SHOT_DURATION, MAX_SHOT_DURATION);
    if (patch.cam) s.cam = normalizeCam(patch.cam);
    if (patch.ease) s.ease = patch.ease === 'linear' ? 'linear' : 'inout';
    this._emit();
    this._syncCard(s);
    this._updateTransport();
    return JSON.parse(JSON.stringify(s));
  }

  removeShot(id) {
    const i = this.shots.findIndex(s => s.id === id);
    if (i < 0) return false;
    this.shots.splice(i, 1);
    this._thumbs.delete(id);
    if (this._selected === id) this._selected = null;
    this._time = clamp(this._time, 0, this.totalDuration());
    this._emit();
    this._renderTrack();
    this._updateTransport();
    return true;
  }

  moveShot(from, to) {
    const n = this.shots.length;
    if (from === to || from < 0 || from >= n || to < 0 || to >= n) return false;
    const [s] = this.shots.splice(from, 1);
    this.shots.splice(to, 0, s);
    this._emit();
    this._renderTrack();
    this._updateTransport();
    return true;
  }

  /** 选中某镜头并跳到它的起始时刻（点卡片 / 键盘 ←→ 用） */
  selectShot(id, opts) {
    const i = this.shots.findIndex(s => s.id === id);
    if (i < 0) return false;
    this._selected = id;
    this._renderSelection();
    if (!opts || opts.seek !== false) this.seek(shotStartTime(this.shots, i));
    return true;
  }

  // ---- 播放 ----
  get isPlaying() { return this._playing; }

  totalDuration() { return shotsTotalDuration(this.shots); }

  play(opts) {
    if (!(opts && opts.keepPreview)) this._preview = null;
    if (this._destroyed || !this.shots.length) return false;
    const total = this.totalDuration();
    if (this._time >= total - 1e-6) this._time = 0;   // 播完再点播放 = 从头来
    this._playing = true;
    this._playStart = now();
    this._timeOffset = this._time;
    this._cancelRaf();
    this._raf = requestAnimationFrame(this._tick);
    this._updateTransport();
    return true;
  }

  pause() {
    if (!this._playing) return false;
    this._playing = false;
    this._cancelRaf();
    this._updateTransport();
    return true;
  }

  stop() {
    this._playing = false;
    this._cancelRaf();
    this._time = 0;
    this._applyAt(0);
    return true;
  }

  /** 镜头预演：只播这一个镜头（到镜头末尾自动停并还原机位） */
  previewShot(ref) {
    if (!this.shots.length) return false;
    const i = typeof ref === 'number' ? ref : this.shots.findIndex(s => s.id === ref);
    if (i < 0 || i >= this.shots.length) return false;
    const start = shotStartTime(this.shots, i);
    const dur = Math.max(MIN_SHOT_DURATION, Number(this.shots[i].duration) || DEFAULT_SHOT_DURATION);
    if (this.editor && typeof this.editor.saveCam === 'function') this.editor.saveCam();
    this._preview = { index: i, id: this.shots[i].id, start, end: start + dur };
    this._selected = this.shots[i].id;
    this._renderSelection();
    this.pause();
    this._time = start;
    this._applyAt(start);
    this.play({ keepPreview: true });
    return { index: i, id: this.shots[i].id, duration: dur, end: start + dur };
  }

  /** 结束预演并还原机位 */
  stopPreview() {
    const was = !!this._preview;
    this._preview = null;
    this.pause();
    if (was && this.editor && typeof this.editor.restoreCam === 'function') this.editor.restoreCam();
    return was;
  }

  get previewing() { return this._preview || null; }

  seek(sec) {
    const total = this.totalDuration();
    const t = clamp(num(sec, 0), 0, total);
    this._time = t;
    if (this._playing) { this._playStart = now(); this._timeOffset = t; }
    this._applyAt(t);
    return t;
  }

  toggle() { return this._playing ? this.pause() : this.play(); }

  // ---- 内部：播放循环 ----
  _tick = () => {
    if (!this._playing || this._destroyed) return;
    const total = this.totalDuration();
    const t = this._timeOffset + (now() - this._playStart) / 1000;
    this._time = Math.min(t, total);
    this._applyAt(this._time);
    if (this._preview && this._time >= this._preview.end - 1e-6) {
      // 单镜头预演：停在镜头末尾，还原机位
      this._time = this._preview.end;
      this._applyAt(this._time);
      this._playing = false;
      this._cancelRaf();
      this.stopPreview();
      this._updateTransport();
      return;
    }
    if (this._time >= total - 1e-6) { this._playing = false; this._cancelRaf(); this._updateTransport(); return; }
    this._raf = requestAnimationFrame(this._tick);
  };

  _cancelRaf() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
  }

  _applyAt(t) {
    const sample = sampleShots(this.shots, t);
    if (sample && this.editor && typeof this.editor.applyCamState === 'function') {
      try { this.editor.applyCamState(sample.cam); } catch (e) { console.error('[timeline] applyCamState 失败', e); }
    }
    this._updateTransport(sample);
  }

  _stepShot(dir) {
    if (!this.shots.length) return;
    const sample = sampleShots(this.shots, this._time);
    const idx = sample ? sample.index : 0;
    const curStart = shotStartTime(this.shots, idx);
    let target;
    if (dir < 0) {
      // NLE 习惯：不在本镜头开头时，先退回本镜头开头；再按一次才到上一个
      target = this._time - curStart > 0.25 ? idx : idx - 1;
    } else {
      target = idx + 1;
    }
    target = clamp(target, 0, this.shots.length - 1);
    if (this._playing) this.pause();
    this._selected = this.shots[target].id;
    this._renderSelection();
    this.seek(shotStartTime(this.shots, target));
  }

  // ---- 内部：DOM ----
  _build() {
    const root = document.createElement('div');
    root.className = 'tl-root' + (this._collapsed ? ' tl-collapsed' : '');
    root.id = 'wb-timeline';
    // 关键布局兜底（即使 CSS 还没加载也不至于盖住画面）
    root.style.flex = '0 0 auto';
    root.style.minHeight = '34px';

    root.innerHTML = [
      '<div class="tl-bar">',
      '  <button class="tl-collapse" data-act="collapse" title="折叠 / 展开时间线" aria-label="折叠或展开时间线" aria-expanded="' + (!this._collapsed) + '">' + (this._collapsed ? '▸' : '▾') + '</button>',
      '  <span class="tl-title">分镜时间线</span>',
      '  <span class="tl-now" aria-live="polite"></span>',
      '  <span class="tl-sum"></span>',
      '  <div class="tl-transport" role="group" aria-label="播放控制">',
      '    <button class="tl-btn tl-play" data-act="play" title="播放（Space）" aria-label="播放" aria-pressed="false">▶</button>',
      '    <button class="tl-btn tl-pause" data-act="pause" title="暂停（Space）" aria-label="暂停">⏸</button>',
      '    <button class="tl-btn tl-stop" data-act="stop" title="停止并回到开头" aria-label="停止">■</button>',
      '  </div>',
      '  <div class="tl-scrub-wrap">',
      '    <input class="tl-scrub" type="range" min="0" max="0" step="0.01" value="0" title="拖动定位到任意时刻" aria-label="时间轴进度">',
      '    <span class="tl-time">0:00.0 / 0:00.0</span>',
      '  </div>',
      '</div>',
      '<div class="tl-body">',
      '  <div class="tl-track" role="list" aria-label="镜头列表"></div>',
      '</div>'
    ].join('\n');

    this._root = root;
    this._els = {
      root,                      // _updateTransport() 要读 _els.root.classList（缺这个键会在 mount 时抛错，实例永远不会赋给宿主）
      bar: root.querySelector('.tl-bar'),
      collapse: root.querySelector('[data-act="collapse"]'),
      now: root.querySelector('.tl-now'),
      sum: root.querySelector('.tl-sum'),
      play: root.querySelector('.tl-play'),
      pause: root.querySelector('.tl-pause'),
      stop: root.querySelector('.tl-stop'),
      scrub: root.querySelector('.tl-scrub'),
      time: root.querySelector('.tl-time'),
      track: root.querySelector('.tl-track'),
      body: root.querySelector('.tl-body')
    };

    // 栏按钮（委托）
    this._els.bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'play') this.play();
      else if (act === 'pause') this.pause();
      else if (act === 'stop') this.stop();
      else if (act === 'collapse') this.toggleCollapse();
    });
    // 进度条：input 事件即 scrub（播放中也允许拖）
    this._els.scrub.addEventListener('input', () => this.seek(parseFloat(this._els.scrub.value) || 0));
    // 轨道（委托）
    this._els.track.addEventListener('click', (e) => this._onTrackClick(e));
    this._els.track.addEventListener('dblclick', (e) => this._onTrackDblClick(e));
    this._els.track.addEventListener('input', (e) => this._onTrackInput(e));
    this._els.track.addEventListener('change', (e) => this._onTrackChange(e));
    this._els.track.addEventListener('keydown', (e) => this._onTrackKeyDown(e));
  }

  toggleCollapse() {
    if (!this._root) return this._collapsed;
    this._collapsed = !this._collapsed;
    this._root.classList.toggle('tl-collapsed', this._collapsed);
    const b = this._els.collapse;
    b.textContent = this._collapsed ? '▸' : '▾';
    b.setAttribute('aria-expanded', String(!this._collapsed));
    return this._collapsed;
  }

  _renderTrack() {
    if (!this._els) return;
    const track = this._els.track;
    track.textContent = '';
    this.shots.forEach((s, i) => track.appendChild(this._makeCard(s, i)));
    const add = document.createElement('button');
    add.className = 'tl-add';
    add.dataset.act = 'add';
    add.title = '把当前相机保存为一个新镜头';
    add.setAttribute('aria-label', '加镜头：抓取当前相机');
    add.textContent = '＋ 加镜头';
    track.appendChild(add);
    this._renderSelection();
    this._updateTransport();
  }

  _makeCard(s, i) {
    const card = document.createElement('div');
    card.className = 'tl-card';
    card.dataset.id = s.id;
    card.setAttribute('role', 'listitem');
    card.tabIndex = 0;
    card.title = '点击定位到该镜头 · 双击名称改名 · Enter 定位';
    card.setAttribute('aria-label', '镜头 ' + (i + 1) + '：' + s.label + '，' + s.duration + ' 秒');

    const idx = document.createElement('span');
    idx.className = 'tl-idx';
    idx.textContent = String(i + 1).padStart(2, '0');

    const thumb = document.createElement('span');
    thumb.className = 'tl-thumb';
    const url = this._thumbs.get(s.id);
    if (url) thumb.style.backgroundImage = 'url("' + url + '")';
    else { thumb.classList.add('tl-thumb-empty'); thumb.textContent = String(i + 1); }

    const name = document.createElement('span');
    name.className = 'tl-name';
    name.dataset.role = 'name';
    name.textContent = s.label;
    name.title = '双击改名';

    const dur = document.createElement('input');
    dur.className = 'tl-dur';
    dur.type = 'number';
    dur.min = String(MIN_SHOT_DURATION);
    dur.max = String(MAX_SHOT_DURATION);
    dur.step = '0.1';
    dur.value = String(round1(s.duration));
    dur.dataset.role = 'dur';
    dur.title = '该镜头时长（秒）';
    dur.setAttribute('aria-label', '镜头 ' + (i + 1) + ' 时长（秒）');

    const unit = document.createElement('span');
    unit.className = 'tl-unit';
    unit.textContent = 's';

    const ops = document.createElement('span');
    ops.className = 'tl-ops';
    ops.appendChild(this._opBtn('preview', '⏵', '预演这个镜头（只播这一段）'));
    ops.appendChild(this._opBtn('left', '◀', '左移（前一个）'));
    ops.appendChild(this._opBtn('right', '▶', '右移（后一个）'));
    ops.appendChild(this._opBtn('del', '✕', '删除该镜头'));

    card.append(idx, thumb, name, dur, unit, ops);
    return card;
  }

  _opBtn(op, text, title) {
    const b = document.createElement('button');
    b.className = 'tl-op';
    b.dataset.op = op;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.textContent = text;
    return b;
  }

  /** 只更新单个卡片上的非结构内容（改名 / 改时长后不重建整条轨道） */
  _syncCard(s) {
    if (!this._els) return;
    const card = this._els.track.querySelector('[data-id="' + cssEscape(s.id) + '"]');
    if (!card) return;
    const name = card.querySelector('[data-role="name"]');
    if (name) name.textContent = s.label;
    const dur = card.querySelector('[data-role="dur"]');
    if (dur && document.activeElement !== dur) dur.value = String(round1(s.duration));
    card.setAttribute('aria-label', '镜头：' + s.label + '，' + s.duration + ' 秒');
  }

  _renderSelection() {
    if (!this._els) return;
    this._els.track.querySelectorAll('.tl-card').forEach(c => {
      c.classList.toggle('tl-selected', c.dataset.id === this._selected);
    });
  }

  _onTrackClick(e) {
    const add = e.target.closest('[data-act="add"]');
    if (add) { this.addShotFromCamera(); return; }
    const op = e.target.closest('[data-op]');
    if (op) {
      const card = op.closest('[data-id]');
      if (!card) return;
      const i = this.shots.findIndex(s => s.id === card.dataset.id);
      if (i < 0) return;
      const kind = op.dataset.op;
      if (kind === 'preview') this.previewShot(i);
      else if (kind === 'del') this.removeShot(card.dataset.id);
      else if (kind === 'left') this.moveShot(i, i - 1);
      else if (kind === 'right') this.moveShot(i, i + 1);
      return;
    }
    // 点在输入框上：不要抢去 seek
    if (e.target.closest('input,button')) return;
    const card = e.target.closest('[data-id]');
    if (card) this.selectShot(card.dataset.id);
  }

  _onTrackDblClick(e) {
    const name = e.target.closest('[data-role="name"]');
    if (!name) return;
    const card = name.closest('[data-id]');
    if (!card) return;
    e.preventDefault();
    this._startRename(card.dataset.id, name);
  }

  _onTrackInput(e) {
    const dur = e.target.closest('[data-role="dur"]');
    if (!dur) return;
    const card = dur.closest('[data-id]');
    if (!card) return;
    const s = this._find(card.dataset.id);
    if (!s) return;
    const v = parseFloat(dur.value);
    if (Number.isFinite(v)) {
      // 输入中只更新数据 + 总时长，不重建 DOM、不改写输入框
      s.duration = clamp(v, MIN_SHOT_DURATION, MAX_SHOT_DURATION);
      this._updateTransport();
    }
  }

  _onTrackChange(e) {
    const dur = e.target.closest('[data-role="dur"]');
    if (!dur) return;
    const card = dur.closest('[data-id]');
    if (!card) return;
    const s = this._find(card.dataset.id);
    if (!s) return;
    const v = parseFloat(dur.value);
    s.duration = clamp(Number.isFinite(v) ? v : DEFAULT_SHOT_DURATION, MIN_SHOT_DURATION, MAX_SHOT_DURATION);
    dur.value = String(round1(s.duration));
    this._time = clamp(this._time, 0, this.totalDuration());
    this._emit();
    this._updateTransport();
  }

  _onTrackKeyDown(e) {
    const card = e.target.closest && e.target.closest('[data-id]');
    if (!card) return;
    if (e.target !== card) return;   // 只在卡片本身获得焦点时接管
    if (e.key === 'Enter') {
      e.preventDefault();
      this.selectShot(card.dataset.id);
    }
  }

  _startRename(id, nameEl) {
    const s = this._find(id);
    if (!s || !nameEl) return;
    const input = document.createElement('input');
    input.className = 'tl-name-edit';
    input.type = 'text';
    input.maxLength = 24;
    input.value = s.label;
    input.title = '回车确认 · Esc 取消';
    input.setAttribute('aria-label', '镜头名称');
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = (input.value || '').trim();
      if (commit && v) this.updateShot(id, { label: v });
      else this._renderTrack();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    // 输入时不要触发宿主快捷键 / 卡片点击
    ['click', 'pointerdown', 'input', 'keyup'].forEach(t => input.addEventListener(t, ev => ev.stopPropagation()));
  }

  _onKeyDown(e) {
    if (this._destroyed || !this._root || !this._root.isConnected) return;
    const ae = typeof document !== 'undefined' ? document.activeElement : null;
    const tag = ae && ae.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (ae && ae.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const view = document.getElementById('view-editor');
    if (view && view.hidden) return;
    const modal = document.getElementById('modal');
    if (modal && !modal.hidden) return;
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); this.toggle(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); this._stepShot(-1); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); this._stepShot(1); return; }
  }

  _updateTransport(sample) {
    if (!this._els) return;
    const total = this.totalDuration();
    const t = clamp(this._time, 0, total);
    const scrub = this._els.scrub;
    scrub.max = String(round2(total));
    if (document.activeElement !== scrub) scrub.value = String(round2(t));
    this._els.time.textContent = formatTime(t) + ' / ' + formatTime(total);
    const sampleInfo = sample === undefined ? sampleShots(this.shots, t) : sample;
    this._els.now.textContent = sampleInfo && sampleInfo.shot ? '▸ ' + sampleInfo.shot.label : '';
    this._els.sum.textContent = this.shots.length + ' 个镜头 · 总时长 ' + formatTime(total);
    this._els.play.disabled = !this.shots.length || this._playing;
    this._els.pause.disabled = !this._playing;
    this._els.stop.disabled = !this.shots.length;
    this._els.play.setAttribute('aria-pressed', String(this._playing));
    this._els.root.classList.toggle('tl-playing', this._playing);
    // 当前镜头高亮（跟播放同步，但不动 DOM 结构）
    const activeId = sampleInfo && sampleInfo.shot ? sampleInfo.shot.id : null;
    this._els.track.querySelectorAll('.tl-card').forEach(c => {
      c.classList.toggle('tl-active', c.dataset.id === activeId);
    });
  }

  _find(id) { return this.shots.find(s => s.id === id) || null; }

  _emit() {
    if (!this.onChange) return;
    try { this.onChange(this.getShots()); }
    catch (e) { console.error('[timeline] onChange 抛错', e); }
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function round1(n) { return Math.round(n * 10) / 10; }
function round2(n) { return Math.round(n * 100) / 100; }
function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

/**
 * 一步挂载：自己找宿主、自己建 DOM、自己注入样式。
 *
 *   import { mountTimeline } from './timeline.js?v=75';
 *   const tl = mountTimeline({
 *     editor,                                   // EditorApp 实例
 *     shots: rec.data.shots || [],              // 载入已有分镜
 *     onChange: (shots) => { rec.data.shots = shots; persist(); },
 *   });
 *
 * @returns {Timeline}
 */
export function mountTimeline(opts) {
  opts = opts || {};
  const tl = new Timeline({
    editor: opts.editor,
    onChange: opts.onChange,
    collapsed: opts.collapsed
  });
  const host = opts.host ||
    (typeof document !== 'undefined' ? document.getElementById('view-editor') : null) ||
    (typeof document !== 'undefined' ? document.body : null);
  tl.mount(host);
  if (Array.isArray(opts.shots) && opts.shots.length) tl.setShots(opts.shots, opts.thumbs);
  return tl;
}

// 浏览器里再挂一份全局引用：宿主不方便改 import 时也能用
if (typeof window !== 'undefined') {
  window.WB_TIMELINE = Object.assign(window.WB_TIMELINE || {}, {
    Timeline,
    mountTimeline,
    sampleShots,
    interpCam,
    shotsTotalDuration,
    shortestAngleDelta,
    DEFAULT_SHOT_DURATION
  });
}
