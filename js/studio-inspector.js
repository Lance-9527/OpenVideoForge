/* ==========================================================================
 * studio-inspector.js · 编辑器右侧三栏（环境 / 对象 / 相机）· v0.4
 *
 * 参考酷家乐 3D 棚拍编辑器的右栏分层（环境 / 对象 / 相机 / 后处理 / 动画），
 * 落地其中对「白膜预演」真正有用的三栏：
 *   环境 —— 背景环境、阳光开关、方位角、俯仰角、色温、亮度、阴影柔和度、雾
 *   对象 —— 保留上游原有的资产检查器（选择 / 变换 / 涂装 / 删除）
 *   相机 —— 机位读数、出图分辨率、抓取当前视角、渲染下载
 *
 * 不改 app.js：它照旧往 #edInspect 写对象检查器；本文件只把 #edInspect 包进
 * 右栏的第三页，并新增两页。编辑器实例通过 window.__wb.editor 现取（每次打开都是新的）。
 * ========================================================================== */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const RES_PRESETS = [
  { id: 'hd', label: '1920 × 1080', w: 1920, h: 1080 },
  { id: 'print', label: '3000 × 4000', w: 3000, h: 4000 },
  { id: '4x5', label: '1080 × 1350', w: 1080, h: 1350 },
  { id: 'story', label: '1080 × 1920', w: 1080, h: 1920 },
];

const TEMP_PRESETS = [
  { k: 2000, label: '红日' },
  { k: 5500, label: '正午' },
  { k: 8000, label: '月光' },
];

let ui = null;          // 生成后的元素引用
let activeTab = 'env';
let resId = 'hd';

const ed = () => (window.__wb && window.__wb.editor) || null;

function toast(msg, kind = 'ok', ms = 2800) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  box.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, ms);
}

/* ------------------------------------------------------------ */
/* 建 UI                                                         */
/* ------------------------------------------------------------ */
function build() {
  const inspect = $('#edInspect');
  if (!inspect || $('.studio-right')) return;

  const right = document.createElement('aside');
  right.className = 'studio-right';
  right.setAttribute('aria-label', '环境 / 对象 / 相机');

  /* --- tab 条 --- */
  const tabs = document.createElement('div');
  tabs.className = 'sr-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.innerHTML = [
    ['env', '环境'], ['obj', '对象'], ['cam', '相机'], ['post', '后处理'], ['anim', '动画'],
  ].map(([id, label]) => `
    <button class="sr-tab${id === 'env' ? ' is-on' : ''}" type="button" role="tab"
            data-tab="${id}" aria-selected="${id === 'env'}">${label}</button>`).join('');

  /* --- 环境页 --- */
  const envPanel = document.createElement('div');
  envPanel.className = 'sr-panel';
  envPanel.dataset.panel = 'env';
  envPanel.innerHTML = `
    <div class="sr-group">
      <div class="sr-label"><b>背景环境</b></div>
      <select class="sr-select" id="srEnv"></select>
    </div>

    <div class="sr-group">
      <div class="sr-label"><b>场地大小</b></div>
      <select class="sr-select" id="srEnvSize"></select>
      <div class="sr-hint">地图大小是**设置**，不是写死的：小场景＝今天的尺寸，
        大场景能装下好莱坞级别的外景。换档位只重建环境，不动已摆好的模型。</div>
    </div>

    <div class="sr-group">
      <div class="sr-label"><b>阳光</b>
        <label class="sr-toggle"><input type="checkbox" id="srSunOn" checked><span class="track"></span></label>
      </div>
      <div class="sr-row">
        <span class="sr-value" style="width:34px">方位</span>
        <input class="sr-slider" id="srAz" type="range" min="0" max="360" step="1" value="134" aria-label="方位角">
        <input class="sr-num" id="srAzNum" type="number" min="0" max="360" value="134" aria-label="方位角度数">
      </div>
      <div class="sr-row">
        <span class="sr-value" style="width:34px">俯仰</span>
        <input class="sr-slider" id="srEl" type="range" min="0" max="90" step="1" value="20" aria-label="俯仰角">
        <input class="sr-num" id="srElNum" type="number" min="0" max="90" value="20" aria-label="俯仰角度数">
      </div>
    </div>

    <div class="sr-group">
      <div class="sr-label"><b>光源色温</b><span class="sr-value" id="srKVal">5500 K</span></div>
      <div class="sr-presets" id="srKPresets">
        ${TEMP_PRESETS.map(t => `<button class="sr-preset" type="button" data-k="${t.k}">${t.label}</button>`).join('')}
      </div>
      <input class="sr-slider" id="srK" type="range" min="2000" max="9000" step="100" value="5500" aria-label="色温">
    </div>

    <div class="sr-group">
      <div class="sr-label"><b>亮度</b><span class="sr-value" id="srIntVal">120%</span></div>
      <input class="sr-slider" id="srInt" type="range" min="0" max="250" step="5" value="120" aria-label="阳光亮度">
      <div class="sr-label" style="margin-top:10px"><b>阴影柔和度</b><span class="sr-value" id="srSoftVal">0.50</span></div>
      <input class="sr-slider" id="srSoft" type="range" min="0" max="1" step="0.05" value="0.5" aria-label="阴影柔和度">
    </div>

    <div class="sr-group">
      <div class="sr-label"><b>全局雾</b>
        <label class="sr-toggle"><input type="checkbox" id="srFog" checked><span class="track"></span></label>
      </div>
      <div class="sr-hint">雾让远处墙面变淡，画面更有纵深；白模对比图建议关掉。</div>
    </div>`;

  /* --- 对象页：包住原有的 #edInspect --- */
  const objPanel = document.createElement('div');
  objPanel.className = 'sr-panel object-panel';
  objPanel.dataset.panel = 'obj';
  objPanel.hidden = true;

  /* --- 相机页 --- */
  const camPanel = document.createElement('div');
  camPanel.className = 'sr-panel';
  camPanel.dataset.panel = 'cam';
  camPanel.hidden = true;
  camPanel.innerHTML = `
    <div class="sr-group">
      <div class="sr-label"><b>当前机位</b><span class="sr-value" id="srCamMode">轨道相机</span></div>
      <div class="sr-readout">
        <span>距离 r <b id="srR">–</b></span>
        <span>俯仰 φ <b id="srPhi">–</b></span>
        <span>方位 θ <b id="srTheta">–</b></span>
        <span>视角 FOV <b id="srFov">–</b></span>
        <span>目标 X <b id="srTX">–</b></span>
        <span>目标 Y <b id="srTY">–</b></span>
      </div>
      <button class="sr-btn ghost" type="button" id="srCamRefresh">刷新读数</button>
    </div>

    <div class="sr-group">
      <div class="sr-label"><b>出图分辨率</b></div>
      <select class="sr-select" id="srRes">
        ${RES_PRESETS.map(r => `<option value="${r.id}">${r.label}</option>`).join('')}
      </select>
      <div class="sr-thumb" id="srThumb">抓一张看构图</div>
      <button class="sr-btn" type="button" id="srGrab">抓取当前视角</button>
      <button class="sr-btn ghost" type="button" id="srRender">渲染并下载 PNG</button>
      <div class="sr-hint">抓取只更新预览；渲染按所选分辨率出图并下载。分镜表请用顶栏「分镜表」。</div>
    </div>`;

  /* --- 后处理页 --- */
  const postPanel = document.createElement('div');
  postPanel.className = 'sr-panel';
  postPanel.dataset.panel = 'post';
  postPanel.hidden = true;
  postPanel.innerHTML = `
    <div class="sr-group">
      <div class="sr-label"><b>曝光</b><span class="sr-value" id="srExpVal">100%</span></div>
      <input class="sr-slider" id="srExp" type="range" min="10" max="300" step="5" value="100" aria-label="曝光">
      <div class="sr-hint">ACES 色调映射的曝光，影响实时画面与导出的 PNG。</div>
    </div>
    <div class="sr-group">
      <div class="sr-label"><b>对比</b><span class="sr-value" id="srConVal">1.00</span></div>
      <input class="sr-slider" id="srCon" type="range" min="50" max="200" step="1" value="100" aria-label="对比度">
      <div class="sr-label" style="margin-top:10px"><b>饱和</b><span class="sr-value" id="srSatVal">1.00</span></div>
      <input class="sr-slider" id="srSat" type="range" min="0" max="200" step="1" value="100" aria-label="饱和度">
      <div class="sr-label" style="margin-top:10px"><b>暗角</b><span class="sr-value" id="srVigVal">0%</span></div>
      <input class="sr-slider" id="srVig" type="range" min="0" max="100" step="1" value="0" aria-label="暗角">
      <div class="sr-hint">对比 / 饱和 / 暗角在导出时用 2D canvas 复算，预览与出图一致。</div>
    </div>
    <div class="sr-group">
      <div class="sr-label"><b>成片</b><span class="sr-value" id="srFilmVal">开</span></div>
      <div class="sr-anim-row">
        <button class="sr-btn small" type="button" id="srFilmToggle">成片开 / 关</button>
      </div>
      <div class="sr-label" style="margin-top:10px"><b>辉光</b><span class="sr-value" id="srBloomVal">30%</span></div>
      <input class="sr-slider" id="srBloom" type="range" min="0" max="100" step="1" value="30" aria-label="辉光">
      <div class="sr-label" style="margin-top:10px"><b>颗粒</b><span class="sr-value" id="srGrainVal">9%</span></div>
      <input class="sr-slider" id="srGrain" type="range" min="0" max="30" step="1" value="9" aria-label="颗粒">
      <div class="sr-label" style="margin-top:10px"><b>画幅</b><span class="sr-value" id="srBarVal">2.39</span></div>
      <div class="sr-anim-row" id="srBars">
        <button class="sr-btn small ghost" type="button" data-bar="off">关</button>
        <button class="sr-btn small ghost" type="button" data-bar="1.85">1.85</button>
        <button class="sr-btn small ghost" type="button" data-bar="2.39">2.39</button>
      </div>
      <div class="sr-hint">成片管线（辉光 / 暖冷调 / 暗角 / 颗粒 / 遮幅）同时在右上角小窗和导出图里生效，所见即所出。</div>
    </div>
    <div class="sr-group">
      <button class="sr-btn ghost" type="button" id="srGradeReset">恢复默认调色</button>
    </div>`;

  /* --- 动画页（关键帧 = 镜头）--- */
  const animPanel = document.createElement('div');
  animPanel.className = 'sr-panel';
  animPanel.dataset.panel = 'anim';
  animPanel.hidden = true;
  animPanel.innerHTML = `
    <div class="sr-group">
      <div class="sr-label"><b>关键帧</b><span class="sr-value" id="srAnimSum">0 个 · 0:00.0</span></div>
      <div class="sr-keylist" id="srKeyList"></div>
      <button class="sr-btn" type="button" id="srKeyAdd">＋ 用当前相机添加关键帧</button>
    </div>
    <div class="sr-group">
      <div class="sr-label"><b>播放</b></div>
      <div class="sr-anim-row">
        <button class="sr-btn small" type="button" id="srPlay">▶ 播放</button>
        <button class="sr-btn small ghost" type="button" id="srStop">■ 停止</button>
      </div>
      <div class="sr-hint">关键帧即底部分镜时间线的镜头：每帧有时长，帧间做球坐标最短弧 + easeInOutCubic 插值。</div>
    </div>`;

  // 先把右栏插到原 #edInspect 的位置（此时 #edInspect 还在文档里），
  // 再把 #edInspect 搬进「对象」页。顺序反了会把整个检查器带出 DOM。
  const body = inspect.parentNode;
  body.insertBefore(right, inspect);
  right.appendChild(tabs);
  right.appendChild(envPanel);
  right.appendChild(objPanel);
  right.appendChild(camPanel);
  right.appendChild(postPanel);
  right.appendChild(animPanel);
  objPanel.appendChild(inspect);        // 原对象检查器搬进第三页

  ui = {
    right, tabs, envPanel, objPanel, camPanel, postPanel, animPanel,
    env: $('#srEnv', envPanel),
    envSize: $('#srEnvSize', envPanel),
    sunOn: $('#srSunOn', envPanel),
    az: $('#srAz', envPanel), azNum: $('#srAzNum', envPanel),
    el: $('#srEl', envPanel), elNum: $('#srElNum', envPanel),
    k: $('#srK', envPanel), kVal: $('#srKVal', envPanel), kPresets: $('#srKPresets', envPanel),
    int: $('#srInt', envPanel), intVal: $('#srIntVal', envPanel),
    soft: $('#srSoft', envPanel), softVal: $('#srSoftVal', envPanel),
    fog: $('#srFog', envPanel),
    r: $('#srR', camPanel), phi: $('#srPhi', camPanel), theta: $('#srTheta', camPanel),
    fov: $('#srFov', camPanel), tx: $('#srTX', camPanel), ty: $('#srTY', camPanel),
    res: $('#srRes', camPanel), thumb: $('#srThumb', camPanel),
    exp: $('#srExp', postPanel), expVal: $('#srExpVal', postPanel),
    con: $('#srCon', postPanel), conVal: $('#srConVal', postPanel),
    sat: $('#srSat', postPanel), satVal: $('#srSatVal', postPanel),
    vig: $('#srVig', postPanel), vigVal: $('#srVigVal', postPanel),
    keyList: $('#srKeyList', animPanel), animSum: $('#srAnimSum', animPanel),
  };

  // 环境下拉
  const envs = (window.WB_ENVIRONMENTS || []).map(e => ({ id: e.id, name: e.name }));
  ui.env.innerHTML = envs.map(e => `<option value="${e.id}">${e.name}</option>`).join('');
  // 场地大小档位（地图大小是设置）
  const sizes = Object.values(window.WB_SCENE_SIZES || {});
  if (ui.envSize) {
    ui.envSize.innerHTML = sizes.map(s =>
      `<option value="${s.id}">${s.label} · ${s.desc}</option>`).join('');
    ui.envSize.value = window.WB_DEFAULT_SCENE_SIZE || 'small';
  }

  bind();
  syncPanels();
}

/* ------------------------------------------------------------ */
/* 交互                                                          */
/* ------------------------------------------------------------ */
function bind() {
  if (!ui) return;

  ui.tabs.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    activeTab = b.dataset.tab;
    $$('.sr-tab', ui.tabs).forEach(x => {
      const on = x === b;
      x.classList.toggle('is-on', on);
      x.setAttribute('aria-selected', String(on));
    });
    ui.envPanel.hidden = activeTab !== 'env';
    ui.objPanel.hidden = activeTab !== 'obj';
    ui.camPanel.hidden = activeTab !== 'cam';
    ui.postPanel.hidden = activeTab !== 'post';
    ui.animPanel.hidden = activeTab !== 'anim';
    if (activeTab === 'cam') readCam();
    if (activeTab === 'post') { syncGradeUI(); if (window.__syncFilmUI) window.__syncFilmUI(); }
    if (activeTab === 'anim') renderKeys();
  });

  const setFill = (el) => {
    const min = Number(el.min || 0), max = Number(el.max || 100);
    const v = Number(el.value);
    el.style.setProperty('--fill', ((v - min) / (max - min) * 100).toFixed(1) + '%');
  };
  const applyLight = (patch) => {
    const e = ed();
    if (!e || !e.setLight) return;
    e.setLight(patch);
    readCam();
  };

  ui.env.addEventListener('change', () => {
    const e = ed();
    if (!e) return;
    e.loadEnv(ui.env.value);
    const badge = $('#edEnvBadge');
    if (badge) badge.textContent = ui.env.selectedOptions[0].textContent;
    syncPanels();
    toast('已切换环境：' + ui.env.selectedOptions[0].textContent);
  });

  // 场地大小（地图大小是设置：small/medium/large）
  if (ui.envSize) ui.envSize.addEventListener('change', () => {
    const e = ed();
    if (!e || !e.setEnvSize) return;
    const r = e.setEnvSize(ui.envSize.value);
    const label = (window.WB_SCENE_SIZES || {})[r.size];
    toast('场地大小：' + (label ? label.label : r.size));
    syncPanels();
  });

  ui.sunOn.addEventListener('change', () => applyLight({ on: ui.sunOn.checked }));

  const linkPair = (range, num, key, after) => {
    const push = (v) => {
      v = Math.max(Number(range.min), Math.min(Number(range.max), Number(v) || 0));
      range.value = String(v); num.value = String(Math.round(v));
      setFill(range);
      if (after) after(v);
      applyLight({ [key]: v });
    };
    range.addEventListener('input', () => push(range.value));
    num.addEventListener('change', () => push(num.value));
    setFill(range);
  };
  linkPair(ui.az, ui.azNum, 'azimuth');
  linkPair(ui.el, ui.elNum, 'elevation');

  ui.k.addEventListener('input', () => {
    const k = Number(ui.k.value);
    ui.kVal.textContent = k + ' K';
    setFill(ui.k);
    $$('.sr-preset', ui.kPresets).forEach(b => b.classList.toggle('is-on', Number(b.dataset.k) === k));
    applyLight({ kelvin: k });
  });
  ui.kPresets.addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]');
    if (!b) return;
    const k = Number(b.dataset.k);
    ui.k.value = String(k);
    ui.k.dispatchEvent(new Event('input'));
  });

  ui.int.addEventListener('input', () => {
    const pct = Number(ui.int.value);
    ui.intVal.textContent = pct + '%';
    setFill(ui.int);
    applyLight({ intensity: pct / 100 });
  });
  ui.soft.addEventListener('input', () => {
    const v = Number(ui.soft.value);
    ui.softVal.textContent = v.toFixed(2);
    setFill(ui.soft);
    applyLight({ shadowSoft: v });
  });
  ui.fog.addEventListener('change', () => applyLight({ fog: ui.fog.checked }));

  ui.res.addEventListener('change', () => { resId = ui.res.value; });
  $('#srCamRefresh', ui.camPanel).addEventListener('click', readCam);
  $('#srGrab', ui.camPanel).addEventListener('click', () => grab(false));
  $('#srRender', ui.camPanel).addEventListener('click', () => grab(true));

  /* --- 后处理 --- */
  const pushGrade = () => {
    const e = ed();
    if (!e) return;
    const exp = Number(ui.exp.value) / 100;
    const con = Number(ui.con.value) / 100;
    const sat = Number(ui.sat.value) / 100;
    const vig = Number(ui.vig.value) / 100;
    if (e.setExposure) e.setExposure(exp);
    if (e.setColorGrade) e.setColorGrade({ contrast: con, saturation: sat, vignette: vig });
    ui.expVal.textContent = Math.round(exp * 100) + '%';
    ui.conVal.textContent = con.toFixed(2);
    ui.satVal.textContent = sat.toFixed(2);
    ui.vigVal.textContent = Math.round(vig * 100) + '%';
    [ui.exp, ui.con, ui.sat, ui.vig].forEach(setFill);
  };
  [ui.exp, ui.con, ui.sat, ui.vig].forEach(el => el.addEventListener('input', pushGrade));
  $('#srGradeReset', ui.postPanel).addEventListener('click', () => {
    ui.exp.value = '100'; ui.con.value = '100'; ui.sat.value = '100'; ui.vig.value = '0';
    pushGrade();
    toast('已恢复默认调色');
  });

  /* --- 成片管线（v1.5：辉光 / 颗粒 / 画幅，与导出共用） --- */
  const bloomEl = $('#srBloom', ui.postPanel);
  const grainEl = $('#srGrain', ui.postPanel);
  const barsBox = $('#srBars', ui.postPanel);
  const filmVal = $('#srFilmVal', ui.postPanel);
  const pushFilm = (patch) => {
    const e = ed();
    if (!e || !e.setFilmLook) return;
    const look = e.setFilmLook(Object.assign({
      bloom: Number(bloomEl.value) / 100,
      grain: Number(grainEl.value) / 100,
    }, patch || {}));
    syncFilmUI(look);
  };
  [bloomEl, grainEl].forEach(el => el.addEventListener('input', () => pushFilm()));
  barsBox.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-bar]');
    if (!b) return;
    pushFilm({ letterbox: b.dataset.bar === 'off' ? null : b.dataset.bar });
  });
  $('#srFilmToggle', ui.postPanel).addEventListener('click', () => {
    const e = ed();
    if (!e || !e.setFilmLook) return;
    const on = !(e.getFilmLook().on);
    syncFilmUI(e.setFilmLook({ on }));
    toast(on ? '成片管线：开（小窗与导出都会过这条管线）' : '成片管线：关（回到纯白膜直出）');
  });
  function syncFilmUI(look) {
    const l = look || (ed() && ed().getFilmLook && ed().getFilmLook()) || {};
    if (bloomEl) { bloomEl.value = String(Math.round((l.bloom == null ? 0.3 : l.bloom) * 100)); setFill(bloomEl); }
    if (grainEl) { grainEl.value = String(Math.round((l.grain == null ? 0.085 : l.grain) * 100)); setFill(grainEl); }
    const bv = $('#srBloomVal', ui.postPanel), gv = $('#srGrainVal', ui.postPanel), barv = $('#srBarVal', ui.postPanel);
    if (bv) bv.textContent = Math.round((l.bloom == null ? 0.3 : l.bloom) * 100) + '%';
    if (gv) gv.textContent = Math.round((l.grain == null ? 0.085 : l.grain) * 100) + '%';
    if (barv) barv.textContent = l.letterbox ? String(l.letterbox) : '关';
    if (filmVal) filmVal.textContent = l.on === false ? '关' : '开';
    if (barsBox) $$('[data-bar]', barsBox).forEach(x => {
      const val = x.dataset.bar === 'off' ? null : x.dataset.bar;
      x.classList.toggle('is-on', (val || null) === (l.letterbox || null));
      x.classList.toggle('sr-btn-on', (val || null) === (l.letterbox || null));
    });
  }
  syncFilmUI();
  window.__syncFilmUI = syncFilmUI;

  /* --- 动画 --- */
  $('#srKeyAdd', ui.animPanel).addEventListener('click', () => {
    const t = timelineApi();
    if (!t) { toast('时间线未就绪', 'warn'); return; }
    const s = t.addShotFromCamera();
    renderKeys();
    toast(s ? '已添加关键帧：' + s.label : '添加失败', s ? 'ok' : 'warn');
  });
  $('#srPlay', ui.animPanel).addEventListener('click', () => {
    const t = timelineApi(); if (t) t.play();
    renderKeys();
  });
  $('#srStop', ui.animPanel).addEventListener('click', () => {
    const t = timelineApi(); if (t) t.stop();
    renderKeys();
  });
}

function preset() {
  return RES_PRESETS.find(r => r.id === resId) || RES_PRESETS[0];
}

function readCam() {
  const e = ed();
  if (!e || !ui) return;
  const r = (n) => (Number.isFinite(n) ? (n / Math.PI * 180).toFixed(1) : '–');
  ui.r.textContent = Number(e.sph.r).toFixed(2);
  ui.phi.textContent = r(e.sph.phi) + '°';
  ui.theta.textContent = r(e.sph.theta) + '°';
  ui.fov.textContent = Number(e.camera.fov).toFixed(0) + '°';
  ui.tx.textContent = Number(e.target.x).toFixed(2);
  ui.ty.textContent = Number(e.target.y).toFixed(2);
}

function grab(download) {
  const e = ed();
  if (!e) return;
  const p = preset();
  const url = e.captureThumb(p.w, p.h);
  if (ui && ui.thumb) ui.thumb.innerHTML = `<img alt="当前视角预览" src="${url}">`;
  if (download) {
    const a = document.createElement('a');
    a.href = url;
    a.download = '白膜_' + p.w + 'x' + p.h + '_' + Date.now() + '.jpg';
    a.click();
    toast('已渲染 ' + p.label + ' 并下载');
  } else {
    toast('已抓取当前视角（' + p.label + '）');
  }
}

/* 打开编辑器时把面板值同步成当前状态（每次 openEditor 都是新实例） */
function syncPanels() {
  const e = ed();
  if (!e || !ui) return;
  const o = e.getLight ? e.getLight() : e.lightOpts;
  if (!o) return;
  ui.env.value = e.envId || ui.env.value;
  if (ui.envSize) ui.envSize.value = e.envSize || ui.envSize.value;   // 场地大小档位
  ui.sunOn.checked = !!o.on;
  ui.az.value = String(o.azimuth); ui.azNum.value = String(Math.round(o.azimuth));
  ui.el.value = String(o.elevation); ui.elNum.value = String(Math.round(o.elevation));
  ui.k.value = String(o.kelvin); ui.kVal.textContent = o.kelvin + ' K';
  ui.int.value = String(Math.round((o.intensity || 0) * 100));
  ui.intVal.textContent = Math.round((o.intensity || 0) * 100) + '%';
  ui.soft.value = String(o.shadowSoft); ui.softVal.textContent = Number(o.shadowSoft).toFixed(2);
  ui.fog.checked = !!o.fog;
  [ui.az, ui.el, ui.k, ui.int, ui.soft].forEach(el => {
    const min = Number(el.min || 0), max = Number(el.max || 100);
    el.style.setProperty('--fill', ((Number(el.value) - min) / (max - min) * 100).toFixed(1) + '%');
  });
  $$('.sr-preset', ui.kPresets).forEach(b => b.classList.toggle('is-on', Number(b.dataset.k) === Number(o.kelvin)));
  readCam();
  syncGradeUI();
  renderKeys();
}

/* ------------------------------------------------------------ */
/* 后处理 / 动画 辅助                                            */
/* ------------------------------------------------------------ */
function timelineApi() {
  return (window.__wb && window.__wb.timeline) || null;
}

function syncGradeUI() {
  const e = ed();
  if (!e || !ui) return;
  const g = (e.getColorGrade && e.getColorGrade()) || { contrast: 1, saturation: 1, vignette: 0 };
  const exp = Number(e.exposure || (e.renderer && e.renderer.toneMappingExposure) || 1);
  ui.exp.value = String(Math.round(exp * 100));
  ui.con.value = String(Math.round(g.contrast * 100));
  ui.sat.value = String(Math.round(g.saturation * 100));
  ui.vig.value = String(Math.round(g.vignette * 100));
  ui.expVal.textContent = Math.round(exp * 100) + '%';
  ui.conVal.textContent = g.contrast.toFixed(2);
  ui.satVal.textContent = g.saturation.toFixed(2);
  ui.vigVal.textContent = Math.round(g.vignette * 100) + '%';
  [ui.exp, ui.con, ui.sat, ui.vig].forEach(el => {
    const min = Number(el.min || 0), max = Number(el.max || 100);
    el.style.setProperty('--fill', ((Number(el.value) - min) / (max - min) * 100).toFixed(1) + '%');
  });
}

function fmtT(sec) {
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

/** 关键帧列表 = 底部分镜时间线的镜头 */
function renderKeys() {
  if (!ui) return;
  const t = timelineApi();
  const shots = t ? t.getShots() : [];
  let acc = 0;
  const rows = shots.map((s, i) => {
    const start = acc;
    acc += Number(s.duration) || 3;
    return { s, i, start };
  });
  const total = t ? t.totalDuration() : 0;
  ui.animSum.textContent = shots.length + ' 个 · ' + fmtT(total);

  if (!shots.length) {
    ui.keyList.innerHTML = '<div class="sr-key-empty">还没有关键帧 —— 摆好相机后点「＋ 用当前相机添加关键帧」</div>';
    return;
  }
  ui.keyList.innerHTML = rows.map(({ s, i, start }) => `
    <div class="sr-key" data-id="${s.id}">
      <span class="sr-key-idx">${String(i + 1).padStart(2, '0')}</span>
      <span class="sr-key-name">${s.label || '镜头 ' + (i + 1)}</span>
      <span class="sr-key-time">${fmtT(start)} · ${Number(s.duration).toFixed(1)}s</span>
      <button class="sr-key-btn" type="button" data-act="go" data-id="${s.id}" title="跳到这一帧">↦</button>
      <button class="sr-key-btn" type="button" data-act="del" data-id="${s.id}" title="删除这一帧">×</button>
    </div>`).join('');

  ui.keyList.querySelectorAll('.sr-key-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tl2 = timelineApi();
      if (!tl2) return;
      const id = btn.dataset.id;
      if (btn.dataset.act === 'go') {
        const row = rows.find(r => r.s.id === id);
        if (row) tl2.seek(row.start);
        readCam();
      } else {
        tl2.removeShot(id);
        renderKeys();
      }
    });
  });
}


function mountRenderButton() {
  const acts = document.querySelector('.ed-top-actions');
  if (!acts || acts.querySelector('#edRender')) return;
  const b = document.createElement('button');
  b.className = 'ed-btn';
  b.id = 'edRender';
  b.type = 'button';
  b.title = '按所选分辨率渲染当前视角并下载 PNG';
  b.textContent = '渲染';
  b.addEventListener('click', () => {
    activeTab = 'cam';
    $$('.sr-tab', ui.tabs).forEach(x => {
      const on = x.dataset.tab === 'cam';
      x.classList.toggle('is-on', on);
      x.setAttribute('aria-selected', String(on));
    });
    if (ui) { ui.envPanel.hidden = true; ui.objPanel.hidden = true; ui.camPanel.hidden = false; }
    syncPanels();
    grab(true);
  });
  acts.insertBefore(b, acts.querySelector('#edSave') || null);
}

function init() {
  build();
  if (!ui) return;
  mountRenderButton();

  // 编辑器视图每次显示 / 隐藏变化时同步一次（app.js 用 hidden 切换视图）
  const view = $('#view-editor');
  if (view) {
    const mo = new MutationObserver(() => {
      if (!view.hidden) {
        // 等 app.js 的 openEditor 同步逻辑跑完
        setTimeout(syncPanels, 0);
        setTimeout(syncPanels, 120);
      }
    });
    mo.observe(view, { attributes: true, attributeFilter: ['hidden'] });
  }

  window.__studioInspector = { syncPanels, readCam, grab, get tab() { return activeTab; } };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
