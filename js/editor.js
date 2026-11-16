// 白膜场景编辑器：Cinemap 导演台精简版
// 轨道相机 / 资产生成放置 / 地面拖拽移动 / 变换检查器 / 机位书签 / 序列化
import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js?v=60';
import { updateCityLod, applyChunkCulling } from './worldgen/city.js?v=76';
import { buildOsm } from './worldgen/osm.js?v=76';
import { buildInterior } from './worldgen/interior.js?v=76';
import { findBuildingAt } from './worldgen/interior-plan.js?v=76';

const SHOT_SIZES = [
  { id: 'full', name: '全景', r: 24 },
  { id: 'medium', name: '中景', r: 13 },
  { id: 'close', name: '近景', r: 7 },
  { id: 'ecu', name: '特写', r: 3.6 }
];

/** 色温 K → 十六进制颜色（Tanner Helland 近似，够白模用） */
function kelvinToColor(k) {
  const t = Math.max(1000, Math.min(12000, Number(k) || 5500)) / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

export class EditorApp {
  constructor(container, opts) {
    this.container = container;
    this.opts = opts || {};
    this.objects = [];        // 用户放置的资产 { assetId, group }
    this.envId = 'room';
    this.cams = [];
    this.selected = null;
    this.dragging = null;
    this.camAnim = null;
    this.disposed = false;
    this.snap = false;
    this.dragMode = 'free';   // v0.8 默认自由三轴拖拽

    this._initRenderer();
    this._initScene();
    this._initLights();
    this._initCamera();
    this._initEvents();
    this._bindFlyKeys();
    this._animate();
  }

  // ---------- 基础 ----------
  _initRenderer() {
    const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setPixelRatio(Math.min(devicePixelRatio, 2));
    r.setSize(this.container.clientWidth, this.container.clientHeight);
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.domElement.style.display = 'block';
    this.container.appendChild(r.domElement);
    this.renderer = r;
  }
  _initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xeceae4);
    this.envGroup = new THREE.Group();
    this.assetGroup = new THREE.Group();
    this.scene.add(this.envGroup, this.assetGroup);
    this.grid = new THREE.GridHelper(60, 60, 0xb9b4a6, 0xd6d2c6);
    this.grid.position.y = 0.01;
    this.grid.visible = false;
    this.scene.add(this.grid);
    // 选中框
    this.selBox = new THREE.Box3();
    this.selHelper = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)),
      new THREE.LineBasicMaterial({ color: 0xd4882a, depthTest: false })
    );
    this.selHelper.visible = false;
    this.selHelper.renderOrder = 999;
    this.scene.add(this.selHelper);
  }
  _initLights() {
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xd8d2c4, 0.95);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff6e8, 1.2);
    this.sun.position.set(18, 26, 12);
    // v0.4 灯光参数（右侧「环境」面板可调；loadEnv 会重置 sun.intensity，所以这里存一份状态）
    this.lightOpts = {
      on: true,
      azimuth: 134,     // 方位角 deg
      elevation: 20,    // 俯仰角 deg
      intensity: 1.2,
      kelvin: 5500,
      shadowSoft: 0.5,  // 0=锐利 1=柔和（映射到 shadow radius）
      hemi: 0.95,
      fog: true,
    };
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const c = this.sun.shadow.camera;
    c.left = -32; c.right = 32; c.top = 32; c.bottom = -32; c.near = 1; c.far = 90;
    this.sun.shadow.bias = -0.0006;
    this.scene.add(this.sun);
    // ★ 2026-11-08：DirectionalLight.target 必须进场景，它的 matrixWorld 才会更新；
    //   不加的话"动态阴影跟随"会失效（光源看着原点，主体动影子不跟）。
    this.scene.add(this.sun.target);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));
  }
  _initCamera() {
    this.camera = new THREE.PerspectiveCamera(45, this.container.clientWidth / this.container.clientHeight, 0.1, 400);
    this.target = new THREE.Vector3(0, 1.2, 0);
    this.sph = { r: 16, phi: 1.05, theta: 0.85 };
    this._applyCamera();
  }
  _applyCamera() {
    const s = this.sph;
    // v0.2 安全网：任何路径把 sph 写成 NaN 时回落到默认机位，避免整屏消失后再也回不来
    if (!Number.isFinite(s.r) || !Number.isFinite(s.phi) || !Number.isFinite(s.theta)) {
      s.r = 16; s.phi = 1.05; s.theta = 0.85;
    }
    this.camera.position.set(
      this.target.x + s.r * Math.sin(s.phi) * Math.sin(s.theta),
      this.target.y + s.r * Math.cos(s.phi),
      this.target.z + s.r * Math.sin(s.phi) * Math.cos(s.theta)
    );
    this.camera.lookAt(this.target);
  }

  /**
   * ★ 2026-11-08：场地尺度联动 —— 把「看得见的世界」和「场地档位」绑在一起。
   *
   * 之前 large 档（factor 20，街道地面 2400m）其实**根本没生效**，因为下面三堵墙
   * 全都是按 small 档写死的常量：
   *   ① 相机 far 写死 400m（_initCamera）⇒ 2400m 的世界有一大半被远裁面切掉，
   *      屏幕上看到的是"很近的一小块 + 一片雾"，不是大世界；
   *   ② 太阳阴影相机 ±32m / far 90（_initLights）⇒ 阴影只覆盖 64×64m，
   *      大场景里几乎**所有物体都没有影子**，画面立刻"飘"；
   *   ③ 太阳距离 d=30 写死（applyLighting）⇒ 场地放大 20 倍后太阳缩在中心，
   *      光的方向相对尺度全错。
   * 另外网格（60m）、新物体放置偏移（4.5m）、景别半径（全景 24m 等）
   * 也全是绝对米数，一起按档位放大，否则大场景里"放个东西看不见、点全景还在墙里"。
   *
   * 这里统一按 factor 等比缩放。near 也跟着放大 —— 否则 near 0.1 / far 数万，
   * 深度缓冲精度不够，大场景会满屏 z-fighting（闪面）。
   */
  _applySceneScale(f) {
    const k = (typeof f === 'number' && isFinite(f) && f > 0) ? f : 1;
    this.envScale = k;
    // ① 相机远裁面 + 近裁面（近裁面必须跟着放大，否则深度精度崩）
    if (this.camera) {
      this.camera.near = Math.max(0.1, 0.05 * k);
      this.camera.far = Math.max(400, 500 * k);
      this.camera.updateProjectionMatrix();
    }
    // ② 阴影相机：覆盖范围 ±32k，投射距离覆盖整块场地
    if (this.sun && this.sun.shadow) {
      const sc = this.sun.shadow.camera;
      const half = 32 * k;
      sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
      sc.near = 0.5;
      sc.far = 110 * k;
      sc.updateProjectionMatrix();
      this.sun.shadow.needsUpdate = true;
    }
    // ③ 地面网格：基础网格 60m，随场地放大（格子自身也跟着放大）
    if (this.grid) this.grid.scale.setScalar(k);
    return k;
  }

  // ---------- 环境 ----------
  /** 归一化场地尺寸档位（老场景没有 size 字段 → small = 今天的尺寸） */
  _resolveEnvSize(size) {
    const sizes = window.WB_SCENE_SIZES || {};
    if (size && sizes[size]) return size;
    // 没指定就**保持当前档位**（换环境时别把场地大小悄悄改回 small）
    if (this.envSize && sizes[this.envSize]) return this.envSize;
    return window.WB_DEFAULT_SCENE_SIZE || 'small';
  }
  /**
   * 载入环境。
   * @param envId 环境 id
   * @param opts  {size} 场地尺寸档位（small/medium/large）—— 地图大小是**设置**，
   *              不是写死的常量；老场景没有这个字段时走 small（= 今天的行为）。
   */
  loadEnv(envId, opts) {
    opts = opts || {};
    this.externalEnvironment = false;
    this.envId = envId;
    const env = window.WB_ENVIRONMENTS.find(e => e.id === envId) || window.WB_ENVIRONMENTS[0];
    const sizeId = this._resolveEnvSize(opts.size);
    const factor = (window.WB_SCENE_SIZE_FACTOR || (() => 1))(sizeId);
    this.envSize = sizeId;
    this.envScale = factor;
    // ★ 2026-11-08：先按档位把"看得见的边界"（相机/阴影/网格）铺开，再建环境
    this._applySceneScale(factor);
    this._clearGroup(this.envGroup);
    const built = env.build(factor, opts);
    built.objects.forEach(o => this.envGroup.add(o));
    // ★ 2026-11-08：城市/OSM 这类"生成型世界"要留一份状态，
    //   供运行时 LOD（updateCityLod）和 wb_world_info 读取。
    //   普通预设环境没有这个字段 ⇒ null，行为不变。
    this._cityState = built.cityState || null;
    this._citySize = built.cityState && built.cityState.plan ? built.cityState.plan.size : 0;
    this.scene.background = new THREE.Color(built.sky);
    this.scene.fog = new THREE.Fog(built.fog[0], built.fog[1], built.fog[2]);
    this._envFog = built.fog;
    this.sun.intensity = built.sun;
    this.lightOpts.intensity = built.sun;
    // ★ 2026-11-08：生成型世界的灯光预设（夜景城市等）—— 放在 intensity 之后，
    //   让预设可以覆盖环境自带的太阳强度。
    if (built.lightPreset) Object.assign(this.lightOpts, built.lightPreset);
    this.applyLighting();
    this.target.set(built.tgt[0], built.tgt[1], built.tgt[2]);
    this.sph.r = Math.hypot(built.cam[0], built.cam[2]) || 16;
    this.sph.phi = 1.05; this.sph.theta = Math.atan2(built.cam[0], built.cam[2]);
    this._applyCamera();
    if (this.opts.onStatus) this.opts.onStatus('已加载环境：' + env.name);
  }

  /**
   * 换场地尺寸档位（用户：地图大小要是设置，不是写死）。
   * 只重建环境（地面/墙/道具），**不动已摆好的资产**，并尽量保留当前机位方向。
   */
  setEnvSize(size) {
    const sizeId = this._resolveEnvSize(size);
    if (sizeId === this.envSize) return { size: sizeId, factor: this.envScale };
    const oldFactor = this.envScale || 1;
    const newFactor = (window.WB_SCENE_SIZE_FACTOR || (() => 1))(sizeId) || 1;
    const keepR = this.sph.r, keepPhi = this.sph.phi, keepTheta = this.sph.theta;
    const keepTarget = this.target.clone();
    this.loadEnv(this.envId, { size: sizeId });
    // 机位：半径/目标按新尺寸等比缩放，角度保持（用户的视角感受不被打断）
    const ratio = oldFactor > 0 ? newFactor / oldFactor : 1;
    this.sph.r = keepR * ratio; this.sph.phi = keepPhi; this.sph.theta = keepTheta;
    this.target.copy(keepTarget).multiplyScalar(ratio);
    this._applyCamera();
    if (this.opts.onStatus) {
      const label = (window.WB_SCENE_SIZES || {})[sizeId];
      this.opts.onStatus('场地尺寸：' + (label ? label.label : sizeId));
    }
    return { size: sizeId, factor: this.envScale };
  }

  /**
   * ★ 2026-11-08：装载**真实世界**（OSM）。
   *
   * 数据由服务端抓好并落盘缓存（server/osm.mjs），这里只做两件事：
   *   ① 按 URL 拉规范化数据 → 建几何（worldgen/osm.js，4 个 draw call）；
   *   ② 按真实世界的实际跨度反推场地系数，让相机远裁面 / 阴影 / 网格跟着走。
   *
   * 相机落在街区中心、眼高 1.7m —— "进到楼里实拍"可以从这里直接接着走。
   */
  async loadOsmWorld(spec) {
    const url = spec && spec.url;
    if (!url) throw new Error('缺少 url');
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error('拉取世界数据失败 HTTP ' + res.status);
    const world = await res.json();

    // ★ 2026-11-08 地形高程：真实世界的地面是**起伏的**。
    //   地形网格由服务端抓（AWS terrarium 瓦片），这里只建几何。
    const built = buildOsm(world, { terrain: spec.terrain || null });
    this._clearGroup(this.envGroup);           // 顺带把旧世界的 _cityState 清掉
    this.externalEnvironment = false;
    this.envId = 'osm';
    this.envGroup.add(built.group);
    this.terrainStats = spec.terrainStats || null;

    const size = built.plan.size;
    const factor = Math.max(1, Math.min(150, size / 120));
    this._applySceneScale(factor);

    this.scene.background = new THREE.Color(0xdfe3e6);
    // ★ 2026-11-10：雾的范围按**城市本体**算（citySize），不用含远郊道路的 size。
    //   实测上海黄浦区：size=15454（连着通向远方的快速路）⇒ fogFar=20090m
    //   ⇒ 相机 r=4200 时整个远景城市被雾吃掉，画面白茫茫一片（实测）。
    const fogSize = (world && world.citySize) || size;
    const fogNear = fogSize * 0.55, fogFar = fogSize * 2.6;
    this.scene.fog = new THREE.Fog(0xdfe3e6, fogNear, fogFar);
    this._envFog = [0xdfe3e6, fogNear, fogFar];
    this.applyLighting();

    // ── 取景 ────────────────────────────────────────────────────────────
    // ★ 2026-11-08：不能直接用 bbox 中心。
    //   OSM 的 bbox 把延伸很远的路也算进去（实测 x∈[-1964,594]），
    //   中心落在 x=-685 —— 那里**一栋楼都没有**，而楼群集中在 x∈[-297,237]。
    //   结果就是相机盯着空地，画面一片灰（这个坑我踩过一次）。
    //   改成用**楼群的中位数**与稳健范围来取景。
    const framing = this._osmFraming(built.plan, built.plan.bounds);
    // ★ 2026-11-10：target 的 y 用**楼基实际高度 + 人眼高**，不再写死 1.7。
    //   真实世界是起伏地形（京都楼基在 y=61），写死 1.7 ⇒ 相机在地形下面，画面一片灰。
    this.target.set(framing.x, framing.y != null ? framing.y : 1.7, framing.z);
    this.sph.r = framing.r;
    this.sph.phi = framing.phi;
    this.sph.theta = framing.theta;
    this._applyCamera();

    this._cityState = built;
    this._citySize = size;
    // ★ 2026-11-08：把"场地大小"下拉同步成最接近真实世界尺寸的档位，
    //   否则载入一个 2.5km 的真实街区后，面板还写着"小场景 · 今天的默认尺寸"（实测过）。
    const sizeIds = Object.keys(window.WB_SCENE_SIZES || {});
    let best = null, bestD = Infinity;
    for (const sid of sizeIds) {
      const s = window.WB_SCENE_SIZES[sid];
      const meters = 120 * (s.factor || 1);
      const d = Math.abs(meters - size);
      if (d < bestD) { bestD = d; best = sid; }
    }
    if (best) this.envSize = best;
    // ★ 2026-11-08：记住"这个世界是怎么来的"，预设才能复现它
    this._worldSpec = { kind: 'osm', url, attribution: (world && world.attribution) || '© OpenStreetMap contributors' };
    this.osmAttribution = (world && world.attribution) || '© OpenStreetMap contributors';
    if (this.opts.onStatus) {
      const t = this.terrainStats;
      this.opts.onStatus('已载入真实世界：' + built.plan.stats.buildings + ' 栋 / ' + built.plan.stats.roads + ' 条路'
        + (t ? ' · 地形 ' + t.minH + '~' + t.maxH + 'm' : ''));
    }
    return this.worldInfo();
  }

  /**
   * ★ 2026-11-08：真实世界的取景计算。
   *
   * 用楼群中心的**中位数**当目标点，用 10%–90% 分位的跨度当范围。
   * 为什么要这么绕：
   *   bbox 会把长路算进去（实测涩谷那份 x 从 -1964 到 594，中心偏到 -685），
   *   那里没有楼。直接用 bbox 中心 = 相机盯着空地。
   *   中位数 + 分位数对这种长尾分布稳健得多。
   */
  _osmFraming(plan, bounds) {
    const bs = (plan && plan.buildings) || [];
    const cx = [], cz = [], cy = [];
    for (const b of bs) {
      if (b.ring && b.ring.length) {
        let sx = 0, sz = 0;
        for (const p of b.ring) { sx += p.x; sz += p.z; }
        cx.push(sx / b.ring.length);
        cz.push(sz / b.ring.length);
      } else if (Number.isFinite(b.x)) {
        cx.push(b.x); cz.push(b.z);
      }
      // ★ 2026-11-10：**楼基高度**（真实世界是起伏地形，楼的地面不在 y=0）
      const y0 = Number(b.y0 != null ? b.y0 : (b.baseY != null ? b.baseY : (b.y != null ? b.y : 0)));
      if (Number.isFinite(y0)) cy.push(y0);
    }
    const med = (a) => { const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
    // ★ 楼基高度的中位数 —— 相机 target 要落在这个高度上，
    //   否则相机在地形下面（实测：京都楼基在 y=61，target 写死 1.7 ⇒ 一片灰）。
    const groundY = cy.length ? med(cy) : 0;
    if (!cx.length) {
      const bb = bounds || { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
      const span = Math.max(20, Math.max(bb.maxX - bb.minX, bb.maxZ - bb.minZ));
      return { x: (bb.minX + bb.maxX) / 2, y: groundY + 1.7, z: (bb.minZ + bb.maxZ) / 2, r: span * 0.9, phi: 1.1, theta: 0.6 };
    }
    const x = med(cx), z = med(cz);
    // 用楼群的**全跨度**（min..max），不用 10%–90% 分位：
    //   分位跨度在密集核心里会算得很小，相机就钻进楼里了（实测过）。
    const spanX = Math.max(60, Math.max(...cx) - Math.min(...cx));
    const spanZ = Math.max(60, Math.max(...cz) - Math.min(...cz));
    let span = Math.max(spanX, spanZ);
    // ★ 2026-11-10：大范围时按**城市本体跨度**取景（不是楼群中位数的跨度）——
    //   楼群中位数可能偏在一角，用它的跨度会把相机拉得太近（实测上海）。
    const cb = plan && plan.cityBounds;
    if (cb) {
      const cSpan = Math.max(cb.maxX - cb.minX, cb.maxZ - cb.minZ);
      if (cSpan > span * 1.2) span = cSpan;
    }

    // ★ 2026-11-10：**把水系纳入构图**。
    //   上海黄浦区隔着一条黄浦江，之前取景 theta 固定 0.6 ⇒
    //   相机恰好背对江 ⇒ 打开场景**看不到这条江**（实测）。
    //   现在：有水 ⇒ 相机站到水那一侧、target 往江的方向偏一点，
    //   这样"城市 + 江"都在画面里。
    //   ★ 用 plan.waters（不是 this._cityState.plan.waters）——
    //     取景时 _cityState 还没赋值（实测：拿不到水系，偏移没生效）。
    const ws = plan && plan.waters;
    let theta = 0.6;
    let tx = x, tz = z;
    if (ws && ws.length) {
      let wcx = 0, wcz = 0, wn = 0;
      for (const w of ws) {
        for (const p of (w.ring || [])) { wcx += p.x; wcz += p.z; wn++; }
      }
      if (wn) {
        wcx /= wn; wcz /= wn;
        const dx = wcx - x, dz = wcz - z;
        const dist = Math.hypot(dx, dz);
        if (dist > 30) {
          const ux = dx / dist, uz = dz / dist;
          // target 往江的方向偏 30%（让江进画面）
          tx = x + ux * Math.min(dist * 0.3, 600);
          tz = z + uz * Math.min(dist * 0.3, 600);
          // ★ 相机站在**城市那一侧**，看向（偏向江的）target ⇒ 江和城市同框。
          //   相机位置 = target + r*(sinφ·sinθ, cosφ, sinφ·cosθ)
          //   要相机在 -dir 方向 ⇒ sinθ=-ux, cosθ=-uz
          //   （之前写成 +ux/+uz ⇒ 相机站到江那侧、看向城市 ⇒ 江在背后，看不见。实测）
          theta = Math.atan2(-ux, -uz);
        }
      }
    }

    return {
      x: tx, z: tz,
      y: groundY + 1.7,          // ★ 站在楼基上方 1.7m（人眼高）
      // 站到楼群外面斜俯视：一座街区刚好铺满画面
      // ★ 上限从 2200 提到 4200 —— 2.5km 范围的城市跨度 5400m，
      //   2200 的上限让相机站得太近、只看得到一角（实测上海）。
      r: Math.max(180, Math.min(4200, span * 1.15)),
      phi: 0.86,
      theta,
    };
  }

  /**
   * 挑一栋楼：优先**离得近**的里**底面最大**的那栋。
   * 找不到就在全城挑最大的（结果里会写明跳了多远）。
   */
  _pickBuilding(buildings, px, pz, maxDist) {
    const area = (b) => {
      if (b.ring) {
        const xs = b.ring.map((p) => p.x), zs = b.ring.map((p) => p.z);
        return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...zs) - Math.min(...zs));
      }
      return (b.w || 0) * (b.d || 0);
    };
    const centre = (b) => {
      if (b.ring) {
        let sx = 0, sz = 0;
        for (const p of b.ring) { sx += p.x; sz += p.z; }
        return { x: sx / b.ring.length, z: sz / b.ring.length };
      }
      return { x: b.x || 0, z: b.z || 0 };
    };
    let best = null, bestScore = -Infinity;
    let fallback = null, fallbackArea = -1;
    for (const b of buildings) {
      const a = area(b);
      if (a > fallbackArea) { fallbackArea = a; fallback = b; }
      const c = centre(b);
      const dist = Math.hypot(px - c.x, pz - c.z);
      if (dist > maxDist) continue;
      // 打分：面积越大越好，距离越近越好（面积按 1000m² 归一，避免压过距离）
      const score = Math.sqrt(a) * 1.6 - dist * 0.9;
      if (score > bestScore) { bestScore = score; best = b; }
    }
    return best || fallback;
  }

  /**
   * ★ 2026-11-08：**进到楼里**。
   *
   * 做什么：
   *   ① 在当前世界（city 的程序化楼 / osm 的真实楼）里找"脚下这栋"；
   *   ② 按它的底面与层高生成室内（地板/天花/带窗洞的外墙/带门洞的隔墙/家具/顶灯）；
   *   ③ 把机位搬进屋里 —— 站在房间中心，眼高 1.4m，轨道半径夹在房间内，
   *      这样既不会穿墙出去，又能绕着拍。
   *
   * 为什么不做"挖洞"：OSM 的楼是合并几何（几千栋一个 BufferGeometry），
   *   挖孔要重三角化整片街区；而"加一层室内壳"同样能看、能拍，代价接近零。
   *   室内壳内退一个墙厚，正好把原楼面挡在外面。
   */
  enterBuilding(spec = {}) {
    const st = this._cityState;
    const buildings = st && st.plan && st.plan.buildings ? st.plan.buildings : [];
    if (!buildings.length) {
      return { ok: false, error: '当前世界没有可进入的楼：先 wb_world_build(kind=city) 或 kind=osm' };
    }
    const px = Number.isFinite(spec.x) ? spec.x : this.target.x;
    const pz = Number.isFinite(spec.z) ? spec.z : this.target.z;

    let b = null;
    if (spec.building) {
      // ★ 换层时用：直接指定楼，跳过"重新挑一栋"（否则会挑到隔壁更大的楼）
      b = spec.building;
    } else if (Number.isInteger(spec.index) && buildings[spec.index]) b = buildings[spec.index];
    else {
      // 默认选**附近最大的那栋**，不是最近的那栋。
      //   真实街区里最近的可能是个 10m 宽的配电房，进去只有 1 间小屋；
      //   选大的才有像样的多房间室内可拍。
      b = this._pickBuilding(buildings, px, pz, spec.maxDist ?? 120);
    }
    if (!b) return { ok: false, error: '这个世界里没有可进入的建筑' };

    // 尺寸：osm 是任意多边形（取包围盒），city 是轴对齐盒子
    let w, d, hgt, cx, cz;
    if (b.ring) {
      const xs = b.ring.map((p) => p.x), zs = b.ring.map((p) => p.z);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minZ = Math.min(...zs), maxZ = Math.max(...zs);
      w = Math.max(2.6, maxX - minX); d = Math.max(2.6, maxZ - minZ);
      cx = (minX + maxX) / 2; cz = (minZ + maxZ) / 2;
      hgt = b.height || 8;
    } else {
      w = Math.max(2.6, b.w || 8); d = Math.max(2.6, b.d || 8);
      cx = b.x || 0; cz = b.z || 0;
      hgt = b.h || 3;
    }

    // 楼可能很高（OSM 有 200m 的），室内按**层高 3.1m** 分层（最多 8 层）
    const floorH = Math.max(2.6, Math.min(3.3, hgt > 5 ? 3.1 : hgt));
    // ★ 2026-11-09：上限 8 → 40（和 interior-plan.js 的 MAX_FLOORS 一致）。
    //   渲染层按当前层 ±1 裁剪，所以层数多了也不卡。
    const floors = Math.max(1, Math.min(40, Math.round(hgt / floorH)));
    // ★ 2026-11-10：floor = -1 ⇒ **总览模式**（一次画所有楼层 + 俯瞰机位）。
    const wantFloor = spec.floor === -1 ? -1
      : (Number.isInteger(spec.floor) ? Math.max(0, Math.min(floors - 1, spec.floor)) : 0);
    const overview = wantFloor < 0;

    let built;
    try {
      // ★ 2026-11-08：传**楼的总高** + 层数，不是"一层的高度"。
      //   之前传 h=floorH(3.1) → planInterior 按 3.1/3.1 算出只有 1 层（实测 floors=1）。
      built = buildInterior({
        w, d, h: hgt, floors, floor: wantFloor,
        x: cx, z: cz, seed: Math.round(cx * 31 + cz * 17),
      });
    } catch (e) {
      return { ok: false, error: '生成室内失败：' + String((e && e.message) || e) };
    }
    const planFloorH = built.plan.stats.floorH || floorH;

    this.clearInterior();
    this._interiorGroup = built.group;
    this.scene.add(this._interiorGroup);
    this._interior = {
      built,
      building: { x: cx, z: cz, w, d, h: hgt, floorH: planFloorH, floors: built.plan.stats.floors || floors },
      source: b,                          // ★ 原始楼记录（换层时复用）
      floor: wantFloor,
      savedCam: { r: this.sph.r, phi: this.sph.phi, theta: this.sph.theta, target: this.target.clone() },
    };

    // 机位进屋：目标落在**当前层最大的那间房**的中心（不是楼中心 —— 楼中心常在隔墙上），
    // 眼高 = 当前层地板 + 1.4m，轨道半径按房间尺寸夹住，既不穿墙又绕得开。
    //
    // ★ 2026-11-08：轨道半径还要再钳一道**天花板**。
    //   室内层高只有 3.1m，而 r·cos(phi) 是机位高出视点的高度 ——
    //   之前 r=9m、phi=1.32 直接把相机顶到 3.6m，穿到天花板上面去了（画面里只剩一片顶）。
    //   现在：phi 贴近水平（机位≈视高），再按"离天花板的余量"反解最大半径。
    const inner = built.plan.inner;
    const floorRooms = built.plan.rooms.filter((r) => r.floor === wantFloor);
    const room = (floorRooms.length ? floorRooms : built.plan.rooms)
      .reduce((a, r) => (r.area > (a ? a.area : -1) ? r : a), null);
    const tx = room ? room.cx : cx;
    const tz = room ? room.cz : cz;
    const baseY = room ? room.baseY : 0;
    const roomMin = room ? Math.min(room.w, room.d) : Math.min(inner.w, inner.d);
    const phi = 1.50;                                   // ≈水平 → 机位≈视高
    const eyeY = baseY + 1.4;
    const headroom = Math.max(0.15, baseY + planFloorH - 0.25 - eyeY);
    let r = Math.max(1.1, Math.min(roomMin * 0.46, 9));
    const rise = r * Math.cos(phi);
    if (rise > headroom) r = headroom / Math.cos(phi);

    // ★ 2026-11-10：**总览模式**（floor = -1）—— 站在**楼顶上方**俯视整栋楼。
    //   之前只有「当前层 ±1」，所以 40 层的楼看不到全貌（欠账项）。
    //
    //   ★ 机位要算准，不然会"站进楼里"（实测踩过）：
    //   相机位置 = target + r·(sinφ·sinθ, cosφ, sinφ·cosθ)
    //   · φ 小 ⇒ 相机接近**正上方**（垂直往下看）
    //   · 相机高度必须**高于楼顶**，否则近侧外墙把里面全挡住
    //     （实测：φ=1.05（30°仰角）+ r=147 ⇒ 相机在楼内 36m 处 ⇒ 只看到墙）
    if (overview) {
      const fH = planFloorH;
      const nFloors = (built.plan.stats.floors || floors);
      // ★ 2026-11-10：爆炸图之后，堆叠总高 = built.stats.explodedH
      const totalH = (built.stats && built.stats.explodedH) || Math.max(fH, nFloors * fH);
      const halfW = Math.max(w, d) * 0.5;                 // ★ 用**外轮廓**（不是 inner）
      // ★ 俯角 43°（距天顶）⇒ 低头看 47°。
      //   太陡（φ→0）就变成正上方俯视，**看不出层与层错开的分离**（实测）；
      //   太平（φ→1.05）又会被近侧挡住。47° 是轴测爆炸图的经典角度。
      const phi = 0.62;                                   // 低头看 54°（轴测爆炸图角度）
      const targetY = baseY + totalH * 0.42;
      // 相机高度：堆叠顶 + 60m 余量（保证视线越过最上层）
      const camY = baseY + totalH + 60;
      // 由相机高度反解 r：camY = targetY + r·cos(φ)
      let r = (camY - targetY) / Math.cos(phi);
      // ★ 按**包围球**把整个堆叠装进画面。
      //   之前只按水平楼面算距离 ⇒ 竖直方向（259m 的堆叠）溢出画面（实测：只看到中间几层）。
      const fovY = (this.camera && this.camera.fov ? this.camera.fov : 45) * Math.PI / 180;
      const R = 0.5 * Math.hypot(w, d, totalH);           // 堆叠包围球半径
      r = Math.max(r, R / Math.sin(fovY / 2));
      this.target.set(cx, targetY, cz);
      this.sph.r = Math.max(12, r);
      this.sph.phi = phi;
      this.sph.theta = 0.35;
      // ★ 远裁剪面要跟着放大（默认只有 400，r=460 时楼顶会被裁掉）
      if (this.camera && this.camera.far < r * 3) {
        this.camera.far = r * 3;
        this.camera.updateProjectionMatrix();
      }
      this._applyCamera();
      // ★ 把外壳楼藏起来 + 画外轮廓线框
      this._setExteriorShellHidden(true);
      this._addInteriorEnvelope(cx, cz, w, d, baseY, totalH);
      if (this.opts.onStatus) {
        this.opts.onStatus('室内总览：' + built.stats.rooms + ' 间 / ' + built.stats.floors
          + ' 层 / ' + built.stats.area + 'm²（全部楼层·爆炸图）');
      }
      return { ok: true, ...this.interiorInfo() };
    }

    this.target.set(tx, eyeY, tz);
    this.sph.r = r;
    this.sph.phi = phi;
    this.sph.theta = 0.35;
    this._applyCamera();
    // ★ 回到具体楼层 ⇒ 把外壳放回来 + 去掉总览线框
    this._setExteriorShellHidden(false);
    if (this._envelope) {
      if (this._envelope.parent) this._envelope.parent.remove(this._envelope);
      this._envelope = null;
    }

    if (this.opts.onStatus) {
      this.opts.onStatus('已进入室内：' + built.stats.rooms + ' 间 / ' + built.stats.floors + ' 层 / '
        + built.stats.area + 'm²（第 ' + (wantFloor + 1) + ' 层）');
    }
    return { ok: true, ...this.interiorInfo() };
  }

  /**
   * ★ 2026-11-08：换层（多层室内）。
   * 重建同一栋楼的室内，但机位落到新的一层。
   */
  changeFloor(floor) {
    if (!this._interior) return { ok: false, error: '当前不在室内' };
    const it = this._interior;
    const b = it.building;
    // ★ 2026-11-08：换层要留在**同一栋楼**里。
    //   之前只传 floor，enterBuilding 会按当前机位重新挑楼 → 挑到隔壁矮楼，
    //   结果"第 3 层"其实是另一栋楼的一层（实测 floors 从 8 掉到 1）。
    //   直接把原始楼记录传进去，跳过挑选。
    const maxF = Math.max(0, (b.floors || 1) - 1);
    const r = this.enterBuilding({
      building: it.source,
      floor: Math.max(0, Math.min(maxF, Number(floor) | 0)),
    });
    return r;
  }

  /**
   * ★ 2026-11-10：**总览模式时把外壳楼藏起来**。
   *
   * 为什么：从上面俯视时，先撞到的是那栋楼的**外壳楼顶**，
   *   室内被自己的外壳挡住 ⇒ 只看得到一片白墙（实测）。
   *   藏掉外壳，才能看到内部的楼层堆叠。
   *
   * @param {boolean} hidden true=藏
   */
  _setExteriorShellHidden(hidden) {
    const st = this._cityState;
    const hit = [];
    // OSM：合并成一个网格 osm-buildings
    if (st && st.meshes && st.meshes.buildings) { st.meshes.buildings.visible = !hidden; hit.push('meshes.buildings'); }
    // 程序化城市：city-buildings-chunk-N / city-<名>
    const root = st && (st.group || st.worldGroup);
    if (root && root.traverse) {
      root.traverse((o) => {
        if (!o.isMesh) return;
        const n = o.name || '';
        if (/buildings|^city-(lot|block|tower|house|office|shop)/i.test(n)) { o.visible = !hidden; hit.push(n); }
      });
    }
    this._exteriorHidden = !!hidden;
    return hit;
  }

  /**
   * ★ 2026-11-10：给总览画一个**外轮廓线框**（标示"这是这栋楼"）。
   * 藏了外壳之后没有参照物，得让人知道自己在看哪栋。
   */
  _addInteriorEnvelope(cx, cz, w, d, baseY, h) {
    if (this._envelope) {
      if (this._envelope.parent) this._envelope.parent.remove(this._envelope);
      this._envelope = null;
    }
    const geo = new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d));
    const mat = new THREE.LineBasicMaterial({ color: 0x3f6fa8, transparent: true, opacity: 0.9 });
    const box = new THREE.LineSegments(geo, mat);
    box.name = 'interior-envelope';
    box.position.set(cx, baseY + h / 2, cz);
    box.userData.pickable = false;
    this.scene.add(box);
    this._envelope = box;
    return box;
  }

  /** 退出室内，机位还原到进屋前 */
  exitBuilding() {
    if (!this._interior) return { ok: false, error: '当前不在室内' };
    const saved = this._interior.savedCam;
    this.clearInterior();
    // ★ 外壳要放回来 + 去掉总览线框
    this._setExteriorShellHidden(false);
    if (this._envelope) {
      if (this._envelope.parent) this._envelope.parent.remove(this._envelope);
      this._envelope = null;
    }
    if (saved) {
      this.sph.r = saved.r; this.sph.phi = saved.phi; this.sph.theta = saved.theta;
      this.target.copy(saved.target);
      this._applyCamera();
    }
    if (this.opts.onStatus) this.opts.onStatus('已退出室内');
    return { ok: true, inside: false };
  }

  clearInterior() {
    if (!this._interiorGroup) { this._interior = null; return; }
    this.scene.remove(this._interiorGroup);
    this._clearGroup(this._interiorGroup);
    this._interiorGroup = null;
    this._interior = null;
  }

  /**
   * 当前世界里可进入的楼清单（按底面积从大到小排）。
   * 有了它就能"点序号进屋"，而不是靠猜脚下哪栋。
   */
  buildingList(limit = 60) {
    const st = this._cityState;
    const buildings = st && st.plan && st.plan.buildings ? st.plan.buildings : [];
    const rows = [];
    for (let i = 0; i < buildings.length; i++) {
      const b = buildings[i];
      let w, d, hgt, cx, cz, kind = null, name = null;
      if (b.ring) {
        const xs = b.ring.map((p) => p.x), zs = b.ring.map((p) => p.z);
        const minX = Math.min(...xs), maxX = Math.max(...xs);
        const minZ = Math.min(...zs), maxZ = Math.max(...zs);
        w = Math.max(2.6, maxX - minX); d = Math.max(2.6, maxZ - minZ);
        cx = (minX + maxX) / 2; cz = (minZ + maxZ) / 2;
        hgt = b.height || 8;
        kind = b.kind || null; name = b.name || null;
      } else {
        w = Math.max(2.6, b.w || 8); d = Math.max(2.6, b.d || 8);
        cx = b.x || 0; cz = b.z || 0;
        hgt = b.h || 3;
        kind = b.kind || null;
      }
      rows.push({
        index: i, x: +cx.toFixed(1), z: +cz.toFixed(1),
        w: +w.toFixed(1), d: +d.toFixed(1), h: +hgt.toFixed(1),
        area: +(w * d).toFixed(0), kind, name,
      });
    }
    rows.sort((a, b2) => b2.area - a.area);
    return {
      count: rows.length,
      world: st && st.plan ? st.plan.kind : null,
      buildings: rows.slice(0, limit),
    };
  }

  /** 室内体检数据（给 wb_building_info / UI） */
  interiorInfo() {
    const it = this._interior;
    if (!it) return { inside: false };
    const p = it.built.plan;
    return {
      inside: true,
      building: it.building,
      floor: it.floor || 0,
      floors: it.building.floors || 1,
      // ★ 2026-11-10：总览模式标记（floor = -1）
      overview: it.floor < 0,
      rooms: p.rooms.map((r) => ({
        id: r.id, kind: r.kind, floor: r.floor,
        cx: +r.cx.toFixed(2), cz: +r.cz.toFixed(2),
        w: +r.w.toFixed(2), d: +r.d.toFixed(2), area: +r.area.toFixed(1),
        baseY: +r.baseY.toFixed(2),
      })),
      stats: p.stats,
      lights: p.lights.length,
      stairs: (p.stairs || []).length,
      furniture: p.furniture.map((f) => ({ kind: f.kind, x: +f.x.toFixed(2), z: +f.z.toFixed(2), floor: f.floor })),
      camera: {
        r: +this.sph.r.toFixed(2), phi: +this.sph.phi.toFixed(2), theta: +this.sph.theta.toFixed(2),
        eyeY: +(this.camera.position.y).toFixed(2),
      },
    };
  }

  /**
   * ★ 2026-11-08：当前世界的体检数据（给 wb_world_info / UI 用）。
   * 普通预设环境返回 world:null；生成型世界（city / 未来的 osm）返回规模与 LOD 状态。
   */
  worldInfo() {
    const st = this._cityState;
    const p = st && st.plan;
    return {
      env: this.envId,
      envName: (window.WB_ENVIRONMENTS || []).reduce((n, e) => (e.id === this.envId ? e.name : n), this.envId),
      size: this.envSize,
      factor: this.envScale || 1,
      worldSize: p ? p.size : null,
      // ★ 2026-11-08 加固：城市 plan 与真实世界(OSM) plan 的字段**不一样**
      //   （城市有 pitch/chunks/lots，OSM 没有），
      //   这里全部走可选链，之前直接 p.pitch.toFixed(1) 会让真实世界整个崩掉。
      world: p ? {
        kind: p.kind,
        size: p.size,
        lots: p.stats.lots ?? null,
        buildings: p.stats.buildings ?? 0,
        roads: p.stats.roads ?? 0,
        props: p.stats.props ?? 0,
        chunks: p.stats.activeChunks ?? (Array.isArray(p.chunks) ? p.chunks.length : null),
        tallest: Number.isFinite(p.stats.tallest) ? +p.stats.tallest.toFixed(1) : null,
        pitch: Number.isFinite(p.pitch) ? +p.pitch.toFixed(1) : null,
        waters: p.stats.waters ?? 0,
        greens: p.stats.greens ?? 0,
        trees: p.stats.trees ?? 0,
        attribution: p.attribution || this.osmAttribution || null,
      } : null,
      lod: st ? (st._lod || 'full') : null,
      drawCalls: st && st.meshes ? Object.keys(st.meshes).length + 1 : null,
      // ★ 2026-11-08：分块裁剪的实测数字（给 wb_world_info 和自检用）
      totalChunks: p ? (Array.isArray(p.chunks) ? p.chunks.length : null) : null,
      visibleChunks: st ? (st._visibleChunks ?? null) : null,
      cullRange: st ? (st._cullRange ?? null) : null,
      interior: this._interior ? this.interiorInfo() : null,
    };
  }

  // ---------- v0.4：灯光 / 环境参数（右侧「环境」面板） ----------
  /** 按 lightOpts 重新布置太阳、色温、阴影柔和度、半球光、雾 */
  applyLighting() {
    const o = this.lightOpts;
    const az = ((o.azimuth || 0) * Math.PI) / 180;
    const el = ((o.elevation || 0) * Math.PI) / 180;
    // ★ 2026-11-08：太阳方向存成单位向量，位置**相对 target** 算。
    //   这样大世界里阴影相机永远贴着主体走（见 _animate 的"动态阴影"），
    //   而不是固定罩在原点 ±32m 的小方格里。
    const k = this.envScale || 1;
    const d = 30 * k;
    const dir = new THREE.Vector3(
      Math.sin(az) * Math.cos(el),
      Math.max(0.06, Math.sin(el)),
      Math.cos(az) * Math.cos(el)
    ).normalize();
    this._sunDir = dir;
    const anchor = this.target || new THREE.Vector3(0, 0, 0);
    this.sun.position.set(
      anchor.x + dir.x * d,
      anchor.y + Math.max(1.5 * k, dir.y * d),
      anchor.z + dir.z * d
    );
    this.sun.intensity = o.on ? (o.intensity || 0) : 0;
    this.sun.color.setHex(kelvinToColor(o.kelvin));
    if (this.sun.shadow) this.sun.shadow.radius = 0.2 + (o.shadowSoft || 0) * 5;
    if (this.hemi) this.hemi.intensity = o.hemi == null ? 0.95 : o.hemi;
    if (o.fog) {
      const bg = this.scene.background && this.scene.background.isColor
        ? this.scene.background.getHex() : 0xeceae4;
      const prev = this._envFog || [bg, 30, 70];
      this.scene.fog = new THREE.Fog(prev[0], prev[1], prev[2]);
    } else {
      this.scene.fog = null;
    }
    // ★ 2026-11-09：CSM 开着的话，把太阳参数同步给 cascade 的灯
    try {
      const csm = window.__ovfCsm;
      if (csm && csm.syncCsmLight) csm.syncCsmLight(this);
    } catch (_) { /* 忽略 */ }
    return this;
  }

  /** 外部（面板）改灯光：merge 后立即生效，返回当前值 */
  setLight(patch) {
    Object.assign(this.lightOpts, patch || {});
    this.applyLighting();
    return JSON.parse(JSON.stringify(this.lightOpts));
  }

  getLight() {
    return JSON.parse(JSON.stringify(this.lightOpts));
  }
  _clearGroup(g) {
    while (g.children.length) {
      const c = g.children[0];
      g.remove(c);
      c.traverse(n => {
        if (n.geometry) n.geometry.dispose();
        // ★ 2026-11-08：材质也释放。生成型世界每次换档都会建新材质，
        //   只放几何会在反复切档时把显存越吃越多。
        if (n.material) {
          (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => {
            if (m && m.dispose) m.dispose();
          });
        }
        if (n.isInstancedMesh && n.instanceColor) n.instanceColor = null;
      });
    }
    // 换了环境 ⇒ 旧世界的 LOD 状态作废
    if (g === this.envGroup) { this._cityState = null; this._citySize = 0; }
  }

  // ---------- 资产 ----------
  addAsset(assetId) {
    const def = window.WB_ASSETS.find(a => a.id === assetId);
    if (!def) return null;
    const g = def.make();
    // 放在相机目标前方（距离按场地档位放大，否则 large 档里新物体贴在脚底下看不见）
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.target).setY(0).normalize();
    const p = new THREE.Vector3().copy(this.target).addScaledVector(dir, 4.5 * (this.envScale || 1));
    p.x = Math.round(p.x * 2) / 2; p.z = Math.round(p.z * 2) / 2;
    p.y = 0;
    g.position.copy(p);
    this.assetGroup.add(g);
    const rec = { instanceId: crypto.randomUUID(), assetId: assetId, group: g };
    this.objects.push(rec);
    // v1.2：新放的对象一律先落到地面（按包围盒底部对齐 y=0），不再悬浮
    this.dropToGround(rec);
    // v68：新放的对象自动避开已有物体（确定性去重叠，不是物理引擎）
    this.solveLayout({ movers: [rec.instanceId], clearance: 0.02 });
    this.select(rec);
    if (this.opts.onStatus) this.opts.onStatus('已放置「' + def.name + '」，拖动可移动');
    return rec;
  }

  /**
   * ★ 2026-11-08：**拖拉拽放置**。
   *
   * 以前点资产就"自动放到相机前方"，位置由系统定 —— 想要的其实是"我自己放"。
   * 现在：点一下资产 → 进入放置模式 →
   *   · 物体跟着鼠标在地面上走（半透明幽灵）
   *   · 左键一点 → 定在那儿
   *   · Esc / 右键 → 取消，物体移除
   */
  beginPlace(assetId) {
    this.cancelPlace();
    const def = (window.WB_ASSETS || []).find((a) => a.id === assetId);
    if (!def) return null;
    const g = def.make();
    // 幽灵材质：半透明 + 不投阴影
    g.traverse((n) => {
      if (!n.isMesh || !n.material) return;
      n.material = Array.isArray(n.material)
        ? n.material.map((m) => { const c = m.clone(); c.transparent = true; c.opacity = 0.5; c.depthWrite = false; return c; })
        : (() => { const c = n.material.clone(); c.transparent = true; c.opacity = 0.5; c.depthWrite = false; return c; })();
      n.castShadow = false;
    });
    this.assetGroup.add(g);
    const rec = { instanceId: crypto.randomUUID(), assetId, group: g, placing: true };
    this.objects.push(rec);
    this._placing = rec;
    this.select(rec);
    this._placeBind();
    if (this.opts.onStatus) this.opts.onStatus('移动鼠标选位置，左键放下 · Esc 取消');
    return rec;
  }

  /** 鼠标移动 → 物体跟着走 */
  _placeMove(clientX, clientY) {
    const rec = this._placing;
    if (!rec) return;
    const el = this.renderer.domElement;
    const r = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    // 先打环境地面（真实世界的地形），打不到就退回 y=0 平面
    let hit = null;
    const envList = [...(this.envGroup ? this.envGroup.children : [])];
    if (envList.length) {
      const hs = ray.intersectObjects(envList, true);
      for (const h of hs) { if (h.object.visible) { hit = h; break; } }
    }
    if (!hit) {
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const p = new THREE.Vector3();
      if (ray.ray.intersectPlane(plane, p)) hit = { point: p };
    }
    if (!hit) return;
    const p = hit.point;
    p.x = Math.round(p.x * 2) / 2; p.z = Math.round(p.z * 2) / 2;
    rec.group.position.x = p.x;
    rec.group.position.z = p.z;
    rec.group.position.y = 0;
    this.dropToGround(rec);
    this._updateRotRing && this._updateRotRing();
  }

  /** 结束放置（commit=true 留下，false 移除） */
  endPlace(commit = true) {
    const rec = this._placing;
    if (!rec) return false;
    this._placing = null;
    if (this._placeCleanup) { this._placeCleanup(); this._placeCleanup = null; }
    if (!commit) {
      const i = this.objects.indexOf(rec);
      if (i >= 0) this.objects.splice(i, 1);
      this.assetGroup.remove(rec.group);
      rec.group.traverse((n) => { if (n.geometry) n.geometry.dispose(); });
      if (this.selected === rec) this.select(null);
      if (this.opts.onStatus) this.opts.onStatus('已取消放置');
      return false;
    }
    rec.placing = false;
    // 落地 + 去重叠
    this.dropToGround(rec);
    this.solveLayout({ movers: [rec.instanceId], clearance: 0.02 });
    this.select(rec);
    if (this.opts.onStatus) this.opts.onStatus('已放置「' + ((window.WB_ASSETS.find((a) => a.id === rec.assetId) || {}).name || rec.assetId) + '」');
    return true;
  }

  cancelPlace() {
    if (this._placing) this.endPlace(false);
  }

  _placeBind() {
    const el = this.renderer.domElement;
    const move = (ev) => this._placeMove(ev.clientX, ev.clientY);
    // 捕获阶段 + stopPropagation：拦掉原本的 pointerdown（不然会变成拖动/转视角）
    const down = (ev) => {
      if (ev.button !== 0) return;
      ev.stopPropagation();
      ev.preventDefault();
      this.endPlace(true);
    };
    const ctx = (ev) => { ev.stopPropagation(); this.endPlace(false); };
    const key = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); this.endPlace(false); } };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', down, true);
    el.addEventListener('contextmenu', ctx, true);
    window.addEventListener('keydown', key, true);
    this._placeCleanup = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerdown', down, true);
      el.removeEventListener('contextmenu', ctx, true);
      window.removeEventListener('keydown', key, true);
    };
  }

  /**
   * ★ 2026-11-08：给**任意** Object3D 渲染一张缩略图（离屏，256px）。
   * 用途：资产库的卡片缩略图（模型/场景模型）。
   * 之前卡片上只能显示「模型/场景」几个字，库里有什么根本认不出来。
   *
   * @param {THREE.Object3D} obj  要拍的物体（会被克隆，不动原件）
   * @param {number} size         边长（像素）
   * @returns {string} dataURL
   */
  renderThumbOf(obj, size = 256) {
    // 真正的实现见 js/thumb.js（跟入口页共用同一个 renderer，避免多开 GL 上下文）
    if (!obj) return null;
    if (!this._thumbMod) {
      try {
        // 同步 require 不了 ES module —— 用已经加载过的全局入口
        this._thumbMod = window.__ovfThumb;
      } catch (_) { this._thumbMod = null; }
    }
    if (this._thumbMod && this._thumbMod.renderThumbOf) return this._thumbMod.renderThumbOf(obj, size);
    // 兜底：自己渲一张（逻辑与 thumb.js 一致）
    return this._renderThumbFallback(obj, size);
  }

  _renderThumbFallback(obj, size = 256) {
    let r;
    try {
      r = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      r.setPixelRatio(1);
      r.setSize(size, size, false);
    } catch (_) { return null; }
    const sc = new THREE.Scene();
    sc.background = new THREE.Color(0xefece4);
    const cam = new THREE.PerspectiveCamera(30, 1, 0.05, 400);
    cam.position.set(5, 4.2, 5); cam.lookAt(0, 0, 0);
    sc.add(new THREE.HemisphereLight(0xffffff, 0xb8b0a0, 1.25));
    const key = new THREE.DirectionalLight(0xfff6e8, 1.35); key.position.set(6, 10, 6); sc.add(key);
    const fill = new THREE.DirectionalLight(0xdce8ff, 0.45); fill.position.set(-6, 4, -4); sc.add(fill);
    const clone = obj.clone(true);
    const wrap = new THREE.Group();
    wrap.add(clone);
    sc.add(wrap);
    const b = new THREE.Box3().setFromObject(clone);
    const s3 = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
    const k = 2.0 / Math.max(s3.x, s3.y, s3.z, 0.001);
    wrap.scale.setScalar(k);
    wrap.position.set(-c.x * k, -c.y * k, -c.z * k);
    wrap.updateMatrixWorld(true);
    let url = null;
    try { r.render(sc, cam); url = r.domElement.toDataURL('image/png'); } catch (_) { url = null; }
    sc.remove(wrap);
    // ★ 不要 dispose geometry —— clone 跟原物体共享，会把场景里的模型毁掉
    r.dispose();
    return url;
  }

  /**
   * ★ 2026-11-08：把选中的物体**导出成 GLB 并存进资产库**。
   * （右键菜单「添加到资产」用）
   */
  async exportSelectedToLibrary(name, category = 'prop') {
    const rec = this.selected;
    if (!rec) return { ok: false, error: '先选中一个物体' };
    const gltf = await import('./vendor/GLTFExporter.js?v=76');
    const buf = await new gltf.GLTFExporter().parseAsync(rec.group, { binary: true, onlyVisible: true });
    const bytes = new Uint8Array(buf);
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    const b64 = btoa(bin);
    const clean = String(name || rec.assetId || '模型').replace(/\.[^.]+$/, '');
    const fileName = clean + '.glb';
    const r = await fetch('http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/library/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // displayName = 给人看的名字（「树」「人」），name = 文件名（「树.glb」）
      body: JSON.stringify({ name: fileName, displayName: clean, base64: b64, category, source: 'scene-export' }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) return { ok: false, error: (j && j.error) || ('HTTP ' + r.status) };

    // ★ 2026-11-08：顺手渲一张缩略图一起存（否则卡片上只有文字，认不出是什么）
    let thumb = null;
    try { thumb = this.renderThumbOf(rec.group, 256); } catch (_) { thumb = null; }
    if (thumb) {
      try {
        const tr = await fetch('http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/library/thumb/' + encodeURIComponent(j.id), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data: thumb }),
        });
        const tj = await tr.json();
        if (!tj.ok) thumb = null;
      } catch (_) { thumb = null; }
    }
    return { ok: true, id: j.id, name: j.name, bytes: j.bytes, thumb: !!thumb };
  }

  /**
   * ★ 2026-11-09：给外部模型建**分件索引**并回报服务端。
   * 失败不影响使用（只是没有分件列表）。
   */
  async _indexPartsOf(assetId, root) {
    if (!assetId || !root) return null;
    try {
      const mod = await import('./parts.js?v=76');
      const parts = mod.indexParts(root);
      if (!parts.length) return null;
      // 已经在库里了就别重复上报
      if (this._partsIndexed && this._partsIndexed[assetId]) return parts;
      await mod.reportParts(assetId, parts);
      this._partsIndexed = this._partsIndexed || {};
      this._partsIndexed[assetId] = true;
      return parts;
    } catch (_) { return null; }
  }

  /**
   * ★ 2026-11-09：只从资产库模型里取**某一个分件**放进场景
   *   （"精准 copy 某个地方的某个物体"）
   *
   * @param {string} assetId   资产库 id
   * @param {number} partIndex 分件序号
   * @param {object} instance  { p, q, scale }
   */
  async beginPlaceExternalPart(asset, partIndex, instance = {}) {
    const url = asset.file_url || asset.url;
    if (!url) return null;
    const mod = await import('./parts.js?v=76');
    const part = await mod.loadPartFromUrl(url, partIndex);
    if (!part) return null;
    const group = new THREE.Group();
    group.add(part);
    group.position.fromArray(instance.p || [0, 0, 0]);
    group.scale.fromArray(instance.scale || [1, 1, 1]);
    // 幽灵材质
    group.traverse((n) => {
      if (!n.isMesh || !n.material) return;
      n.material = Array.isArray(n.material)
        ? n.material.map((m) => { const c = m.clone(); c.transparent = true; c.opacity = 0.5; c.depthWrite = false; return c; })
        : (() => { const c = n.material.clone(); c.transparent = true; c.opacity = 0.5; c.depthWrite = false; return c; })();
      n.castShadow = false;
    });
    this.cancelPlace();
    this.assetGroup.add(group);
    const rec = {
      instanceId: crypto.randomUUID(),
      assetId: 'external:' + asset.id + '#part' + partIndex,
      externalAsset: { id: asset.id, name: asset.name || asset.id, file_url: url, partIndex },
      group, placing: true,
    };
    this.objects.push(rec);
    this._placing = rec;
    this.select(rec);
    return rec;
  }

  /**
   * ★ 2026-11-09：外部模型（资产库里的 GLB）进入**拖拉拽放置**模式。
   * 和内置资产一样：物体跟鼠标走，左键放下。
   */
  async beginPlaceExternal(asset, instance = {}) {
    const url = asset.file_url || asset.url;
    const gltf = await new GLTFLoader().loadAsync(url);
    const group = new THREE.Group();
    group.add(gltf.scene);
    group.position.fromArray(instance.p || [0, 0, 0]);
    group.scale.fromArray(instance.scale || [1, 1, 1]);
    // ★ 2026-11-09：建**分件索引**（"精准 copy 某个地方的某个物体"）
    //   一个教室 GLB 里有几百个 mesh（桌/椅/黑板/窗），
    //   索引之后就能只拿其中某一个。
    this._indexPartsOf(asset.id, gltf.scene);
    // 幽灵材质：半透明 + 不投阴影
    group.traverse((n) => {
      if (!n.isMesh || !n.material) return;
      n.material = Array.isArray(n.material)
        ? n.material.map((m) => { const c = m.clone(); c.transparent = true; c.opacity = 0.5; c.depthWrite = false; return c; })
        : (() => { const c = n.material.clone(); c.transparent = true; c.opacity = 0.5; c.depthWrite = false; return c; })();
      n.castShadow = false;
    });
    this.cancelPlace();
    this.assetGroup.add(group);
    const rec = { instanceId: crypto.randomUUID(), assetId: 'external:' + asset.id, externalAsset: { id: asset.id, name: asset.name || asset.id, file_url: url }, group, placing: true };
    this.objects.push(rec);
    this._placing = rec;
    this.select(rec);
    this._placeBind();
    if (this.opts.onStatus) this.opts.onStatus('移动鼠标选位置，左键放下 · Esc 取消');
    return rec;
  }

  /** Add a registered GLB without changing its original size or floor anchor. */
  async addExternalAsset(asset, instance = {}) {
    // ★ 2026-11-10：**端口不能写死 8765**。
    //   VideoForge 的 sidecar 每次启动端口都可能变（实测 52056 / 8798）。
    //   之前这里写死 base='http://127.0.0.1:8765' ⇒ 相对 file_url 被解析到
    //   一个**没有服务**的端口 ⇒ 导入外部模型必然 "Failed to fetch"（实测踩到）。
    //   现在用 studio-endpoint.js 解析出来的真实地址。
    const raw = asset.file_url || asset.url || ('/api/studio/assets/' + encodeURIComponent(asset.id) + '/file');
    let url;
    if (/^https?:\/\//i.test(String(raw))) {
      url = String(raw);
    } else {
      const mod = await import('./studio-endpoint.js?v=77');
      await mod.resolveStudioBase();
      url = mod.absStudioUrl(raw);
    }
    const gltf = await new GLTFLoader().loadAsync(url);
    const group = new THREE.Group();
    group.add(gltf.scene);
    group.position.fromArray(instance.p || [0, 0, 0]);
    if (instance.q) group.quaternion.fromArray(instance.q);
    group.scale.fromArray(instance.scale || [1, 1, 1]);
    const rec = { instanceId: instance.instanceId || crypto.randomUUID(), assetId: 'external:' + asset.id,
      externalAsset: { id: asset.id, name: asset.name || asset.id, file_url: url, sha256: asset.sha256 || '' }, group };
    this.assetGroup.add(group); this.objects.push(rec); this.select(rec);
    // v68：导入的模型自动避开已有物体
    this.solveLayout({ movers: [rec.instanceId], clearance: 0.02 });
    return rec;
  }

  duplicateAsset(rec = this.selected) {
    if (!rec) return null;
    const group = rec.group.clone(true);
    group.traverse(n => { if (n.geometry) n.geometry = n.geometry.clone(); if (n.material) n.material = Array.isArray(n.material) ? n.material.map(m => m.clone()) : n.material.clone(); });
    const copy = { ...rec, instanceId: crypto.randomUUID(), group };
    this.assetGroup.add(group); this.objects.push(copy); this.select(copy);
    return copy;
  }

  /** v1.2 落地：把对象包围盒底部对齐到地面（y=0） */
  dropToGround(rec) {
    const r = rec || this.selected;
    if (!r || !r.group) return null;
    r.group.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(r.group);
    if (!isFinite(box.min.y)) return null;
    r.group.position.y += -box.min.y;
    r.group.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(r.group);
    this.select(r);
    return {
      y: +r.group.position.y.toFixed(3),
      bottom: +b2.min.y.toFixed(3),
      height: +(b2.max.y - b2.min.y).toFixed(3),
    };
  }

  /**
   * v68 · 确定性布局求解器：把互相穿插的物体在**水平面**上分开。
   *
   * 为什么不是刚体物理引擎（cannon/ammo/rapier）：
   *   ① 白膜链路要求页（Y-up）与 Blender（Z-up）逐帧一致；物理的时间步、
   *      迭代顺序、浮点误差会引入不可复现偏差 → 取景断言会飘。
   *   ② 规范场景 schema/1 不含物理，导出只认**显式刚体轨道**；模拟出来的位姿
   *      根本没法写进规范 JSON。
   *   ③ Blender 端是 workbench 白膜引擎 + 显式轨道，动力学不参与渲染。
   *   ④ 产品定位是本地离线零依赖，拖一个 wasm 物理库进来跟这条冲突。
   * 而"两个物体不重叠"是真需求 —— 那是**布局**问题，不是动力学问题。
   *
   * 做法：世界 AABB → 只在水平面(X/Z)判重叠 → 沿最小穿透轴(MTV)互推 →
   *      迭代收敛。只改 position，不改几何 ⇒ Blender 端天然一致、可复现。
   *      垂直方向**不**判重叠（人坐沙发上、桌上放杯子是合法的）。
   *
   * opts:
   *   clearance     最小间隙（米，默认 0.02）
   *   iterations    最大迭代（默认 24）
   *   instanceIds   只在这些对象之间解（默认全部）
   *   movers        只移动这些对象，其余当作障碍（默认都可动）
   *   anchored      钉住不动的 instanceId 数组
   *   axes          'horizontal'（默认）| 'all'
   *   margin        额外边界留白（米）
   */
  solveLayout(opts = {}) {
    const clearance = Number(opts.clearance ?? 0.02);
    const iterations = Math.max(1, Math.min(120, Number(opts.iterations ?? 24)));
    const axes = opts.axes === 'all' ? 'all' : 'horizontal';
    const anchored = new Set(opts.anchored || []);
    const only = Array.isArray(opts.instanceIds) && opts.instanceIds.length ? new Set(opts.instanceIds) : null;
    const moverSet = Array.isArray(opts.movers) && opts.movers.length ? new Set(opts.movers) : null;
    const canMove = (rec) => !moverSet || moverSet.has(rec.instanceId);

    const list = (this.objects || []).filter(r => {
      if (!r || !r.group) return false;
      if (only && !only.has(r.instanceId)) return false;
      return true;
    });
    if (list.length < 2) return { ok: false, objects: list.length, moved: 0, pairs: [], reason: '场景里少于两个物体，没得解' };

    const boxes = new Map();
    const boxOf = (rec) => {
      let b = boxes.get(rec.instanceId);
      if (!b) {
        rec.group.updateMatrixWorld(true);
        b = new THREE.Box3().setFromObject(rec.group);
        if (!isFinite(b.min.x) || !isFinite(b.max.x)) b = null;
        boxes.set(rec.instanceId, b);
      }
      return b;
    };
    const pinned = (rec) => anchored.has(rec.instanceId);

    const pairs = [];
    const startPos = new Map(list.map(r => [r.instanceId, r.group.position.clone()]));
    let moves = 0, iters = 0;

    for (let it = 0; it < iterations; it++) {
      iters = it + 1;
      boxes.clear();
      let any = false;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const A = list[i], B = list[j];
          const ba = boxOf(A), bb = boxOf(B);
          if (!ba || !bb) continue;
          // 水平面重叠量
          const ox = Math.min(ba.max.x, bb.max.x) - Math.max(ba.min.x, bb.min.x);
          const oz = Math.min(ba.max.z, bb.max.z) - Math.max(ba.min.z, bb.min.z);
          const oy = axes === 'all'
            ? Math.min(ba.max.y, bb.max.y) - Math.max(ba.min.y, bb.min.y) : -1;
          if (ox <= 0 || oz <= 0) continue;
          if (axes === 'all' && oy <= 0) continue;
          any = true;
          // 最小平移向量：沿穿透最浅的轴推开
          let axis = 'x', pen = ox;
          if (oz < pen) { axis = 'z'; pen = oz; }
          if (axes === 'all' && oy >= 0 && oy < pen) { axis = 'y'; pen = oy; }
          const need = pen + clearance;
          const pa = pinned(A), pb = pinned(B);
          const ma = pa ? false : canMove(A), mb = pb ? false : canMove(B);
          if (!ma && !mb) continue;
          // 一个可动、一个是障碍 → 全推可动的；两个都可动 → 各推一半
          const wA = ma ? (mb ? 0.5 : 1) : 0, wB = mb ? (ma ? 0.5 : 1) : 0;
          // 往对方"背后"推：让两者沿轴分开
          const dir = (A.group.position[axis] <= B.group.position[axis]) ? -1 : 1;
          A.group.position[axis] += dir * need * wA;
          B.group.position[axis] -= dir * need * wB;
          boxes.clear();
          pairs.push({ a: A.instanceId, b: B.instanceId, axis, penetration: +pen.toFixed(3) });
        }
      }
      if (!any) break;
    }

    // 汇总位移
    const moved = [];
    for (const rec of list) {
      const s = startPos.get(rec.instanceId);
      const d = rec.group.position.clone().sub(s);
      if (Math.abs(d.x) > 1e-4 || Math.abs(d.z) > 1e-4 || Math.abs(d.y) > 1e-4) {
        moved.push({
          instanceId: rec.instanceId,
          assetId: rec.assetId,
          from: [+s.x.toFixed(3), +s.y.toFixed(3), +s.z.toFixed(3)],
          to: [+rec.group.position.x.toFixed(3), +rec.group.position.y.toFixed(3), +rec.group.position.z.toFixed(3)],
          delta: [+d.x.toFixed(3), +d.y.toFixed(3), +d.z.toFixed(3)],
        });
      }
    }
    moves = moved.length;
    if (moves && this.opts.onTransform) moved.forEach(m => {
      const rec = list.find(r => r.instanceId === m.instanceId);
      rec && this.opts.onTransform(rec);
    });
    if (this.opts.onStatus) {
      this.opts.onStatus(moves ? ('已分开 ' + moves + ' 个穿插物体（' + pairs.length + ' 对）') : '没有发现穿插');
    }
    return {
      ok: true,
      objects: list.length,
      moved: moves,
      iterations: iters,
      clearance,
      pairs: pairs.slice(0, 40),
      moved_detail: moved,
    };
  }

  select(rec) {
    this.selected = rec || null;
    if (rec && !rec.home) rec.home = { p: rec.group.position.clone(), q: rec.group.quaternion.clone() };
    this.selection = rec ? [rec] : [];
    if (!rec) this.pickMesh = null;
    this.selHelper.visible = !!rec;
    if (rec) {
      const b = new THREE.Box3().setFromObject(rec.group);
      const size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
      this.selHelper.scale.set(Math.max(size.x, 0.3) * 1.08, Math.max(size.y, 0.3) * 1.08, Math.max(size.z, 0.3) * 1.08);
      this.selHelper.position.copy(c);
      this.selBox.copy(b);
    }
    this._updateRotRing && this._updateRotRing();
    if (this.opts.onSelect) this.opts.onSelect(rec);
  }

  /** v65：Ctrl/Cmd + 点击 = 多选（累加/取消）；不进入拖拽 */
  toggleSelect(rec) {
    if (!rec) return;
    this.selection = this.selection || [];
    const i = this.selection.indexOf(rec);
    if (i >= 0) this.selection.splice(i, 1);
    else this.selection.push(rec);
    this.selected = this.selection[this.selection.length - 1] || null;
    if (!this.selected) this.pickMesh = null;
    this._updateSelBoxes();
    if (this.selected) {
      const b = new THREE.Box3().setFromObject(this.selected.group);
      this.selBox.copy(b);
    }
    this._updateRotRing && this._updateRotRing();
    if (this.opts.onSelect) this.opts.onSelect(this.selected);
    if (this.opts.onStatus) this.opts.onStatus('已选 ' + this.selection.length + ' 个（Ctrl+点击继续加选，右键可组合）');
  }

  _updateSelBoxes() {
    this._selBoxes = this._selBoxes || [];
    this._selBoxes.forEach(h => { try { this.scene.remove(h); h.geometry.dispose(); } catch (_) {} });
    this._selBoxes = [];
    this._extraHelpers = (this._extraHelpers || []).filter(h => !this._selBoxes.includes(h));
    const list = (this.selection && this.selection.length > 1) ? this.selection : [];
    for (const rec of list) {
      const box = new THREE.BoxHelper(rec.group, 0x8fb0d6);
      box.material.depthTest = false;
      box.renderOrder = 998;
      this.scene.add(box);
      this._selBoxes.push(box);
      this._extraHelpers.push(box);
    }
  }

  /** v67：复位到初始水平位姿（位置 + 朝向） */
  resetSelected() {
    const rec = this.selected;
    if (!rec) return false;
    if (!rec.home) return false;
    rec.group.position.copy(rec.home.p);
    rec.group.quaternion.copy(rec.home.q);
    this._updateRotRing && this._updateRotRing();
    if (this.opts.onStatus) this.opts.onStatus('已复位到初始位置');
    if (this.opts.onTransform) this.opts.onTransform(rec);
    return true;
  }

  /** v65：把当前多选（≥2）组合成一个可整体选中的物体 */
  groupSelected() {
    const list = (this.selection || []).filter(r => r && r.group);
    if (list.length < 2) return 0;
    const g = new THREE.Group();
    g.name = 'group_' + Date.now().toString(36);
    this.assetGroup.add(g);
    for (const rec of list) {
      g.attach(rec.group);                       // 保留世界位姿
      const i = this.objects.indexOf(rec);
      if (i >= 0) this.objects.splice(i, 1);
    }
    const nr = { instanceId: crypto.randomUUID(), assetId: 'group:' + list.length, group: g, fromGroup: true };
    this.objects.push(nr);
    this._updateSelBoxes();
    this.select(nr);
    if (this.opts.onStatus) this.opts.onStatus('已组合 ' + list.length + ' 个物体（右键可解开）');
    return list.length;
  }

  /** v62：选中物中间的旋转环（水平环拖 = 绕 Y 转；Shift+拖 = 绕 X 俯仰） */
  _ensureRotRing() {
    if (this.rotRing) return this.rotRing;
    const geo = new THREE.TorusGeometry(1, 0.028, 8, 72);
    const mat = new THREE.MeshBasicMaterial({ color: 0xd4882a, depthTest: false, transparent: true, opacity: 0.92 });
    const ring = new THREE.Mesh(geo, mat);
    ring.rotation.x = Math.PI / 2;
    ring.renderOrder = 999;
    ring.visible = false;
    ring.userData.rotGizmo = true;
    this.scene.add(ring);
    this._extraHelpers = this._extraHelpers || [];
    this._extraHelpers.push(ring);
    this.rotRing = ring;

    // v64：竖直环（绕 X 轴俯仰），拖它前倾/后仰
    const geoV = new THREE.TorusGeometry(1, 0.028, 8, 72);
    const matV = new THREE.MeshBasicMaterial({ color: 0x8fb0d6, depthTest: false, transparent: true, opacity: 0.9 });
    const ringV = new THREE.Mesh(geoV, matV);
    // 竖直环：默认平面 XY（正对前视角，看起来是一圈竖着的环），拖动 = 绕 Z 轴左右倾斜
    ringV.rotation.y = 0;
    ringV.renderOrder = 999;
    ringV.visible = false;
    ringV.userData.rotGizmo = true;
    ringV.userData.axis = 'z';
    ring.userData.axis = 'y';
    this.scene.add(ringV);
    this._extraHelpers.push(ringV);
    this.rotRingV = ringV;
    return ring;
  }

  _updateRotRing() {
    const ring = this._ensureRotRing();
    if (!this.selected) { ring.visible = false; if (this.rotRingV) this.rotRingV.visible = false; return; }
    const b = new THREE.Box3().setFromObject(this.selected.group);
    const c = b.getCenter(new THREE.Vector3());
    const size = b.getSize(new THREE.Vector3());
    // 水平环（琥珀）：贴在物体底部、水平放置 —— 像唱机转盘，拖它左右转
    const rH = Math.max(size.x, size.z) * 0.55 + 0.12;
    ring.position.set(c.x, c.y, c.z);
    ring.scale.set(rH, rH, 1);
    ring.visible = true;
    // 竖直环（蓝）：同样过包围盒中心 —— 两环在直径中心交叉，便于抓取
    if (this.rotRingV) {
      const rV = Math.max(size.x, size.y) * 0.55 + 0.12;
      this.rotRingV.position.set(c.x, c.y, c.z);
      this.rotRingV.scale.set(rV, rV, 1);
      this.rotRingV.visible = true;
    }
    this._rotCenter = c;
  }

  /** v64：屏幕点 → 命中的物体 record（没命中返回 null；环境物体不接管，仅用于右键菜单判断） */
  objectAt(clientX, clientY) {
    const el = this.renderer.domElement;
    const r = el.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const list = [...this.assetGroup.children];
    if (this.rotRing && this.rotRing.visible) list.push(this.rotRing);
    if (this.rotRingV && this.rotRingV.visible) list.push(this.rotRingV);
    const hits = ray.intersectObjects(list, true);
    for (const h of hits) {
      if (h.object === this.rotRing || h.object === this.rotRingV) continue;
      let p = h.object;
      while (p && p.parent && p.parent !== this.assetGroup) p = p.parent;
      const rec = this.objects.find(o => o.group === p);
      if (rec) return { rec, mesh: h.object };
    }
    return null;
  }

  /** v64：向下穿过单链包装，找到真正的"部件层" */
  _partRoot(rec) {
    let root = rec.group;
    let kids = [...root.children];
    let guard = 0;
    while (kids.length === 1 && kids[0].children && kids[0].children.length >= 1 && guard++ < 5) {
      root = kids[0];
      kids = [...root.children];
    }
    return { root, kids };
  }

  partCount(rec) { return rec ? this._partRoot(rec).kids.length : 0; }

  /** v64：解开组合 —— 把选中组里的每个子物体拆成独立可选中物体（保留世界位姿） */
  ungroupSelected() {
    const rec = this.selected;
    if (!rec) return 0;
    const { root, kids } = this._partRoot(rec);
    if (kids.length < 2) return 0;
    kids.forEach(k => {
      this.assetGroup.attach(k);                       // 保留世界矩阵
      this.objects.push({ instanceId: crypto.randomUUID(), assetId: (rec.assetId || 'group') + '/part', group: k, fromUngroup: true });
    });
    const i = this.objects.indexOf(rec);
    if (i >= 0) this.objects.splice(i, 1);
    this.assetGroup.remove(rec.group);
    this.select(null);
    if (this.opts.onStatus) this.opts.onStatus('已解开组合：' + kids.length + ' 个物体');
    return kids.length;
  }

  deleteSelected() {
    if (!this.selected) return;
    const i = this.objects.indexOf(this.selected);
    if (i >= 0) this.objects.splice(i, 1);
    this.assetGroup.remove(this.selected.group);
    this.selected.group.traverse(n => { if (n.geometry) n.geometry.dispose(); });
    this.select(null);
    if (this.opts.onStatus) this.opts.onStatus('已删除');
  }
  // 变换（检查器调用）
  setTransform(prop, v) {
    if (!this.selected) return;
    const g = this.selected.group;
    // v0.5：吸附开启时位置对齐 0.5 m 网格（与顶栏「吸附」联动）
    const snapPos = (n) => (this.snap ? Math.round(Number(n) * 2) / 2 : Number(n));
    if (prop === 'x') g.position.x = snapPos(v);
    else if (prop === 'y') g.position.y = Math.max(0, snapPos(v));
    else if (prop === 'z') g.position.z = snapPos(v);
    else if (prop === 'ry') g.rotation.y = v * Math.PI / 180;
    else if (prop === 'scale') g.scale.setScalar(v);
    this.select(this.selected);
  }
  setColor(hex, opts = {}) {
    if (!this.selected) return;
    // v62：默认只给「点中的那一块」上色（按材质槽保留其它部分颜色）；opts.all = 整件
    let root = this.selected.group;
    if (!opts.all) {
      const pm = this.pickMesh;
      if (pm && this.selected.group.getObjectById && this.selected.group.getObjectById(pm.id)) root = pm;
    }
    root.traverse(n => {
      if (n.isMesh && n.material) {
        const paint = (m) => { const c = m.clone(); if (c.color) c.color.set(hex); return c; };
        n.material = Array.isArray(n.material) ? n.material.map(paint) : paint(n.material);
      }
    });
    if (!opts.all) this.selected.color = hex;
  }

  /**
   * ★ 2026-11-08：应用一个材质预设（可复用材质库）。
   * @param {object} m {color, roughness, metalness, emissive, emissiveIntensity, transparent, opacity}
   * @param {object} opts {all: true 时整件上色，否则只给点中的那一块}
   */
  applyMaterial(m, opts = {}) {
    if (!m) return { ok: false, error: '没有材质数据' };
    const rec = this.selected;
    if (!rec) return { ok: false, error: '先选中一个对象' };
    let root = rec.group;
    if (!opts.all) {
      const pm = this.pickMesh;
      if (pm && rec.group.getObjectById && rec.group.getObjectById(pm.id)) root = pm;
    }
    const hex = m.color || '#cccccc';
    const rough = Number.isFinite(m.roughness) ? m.roughness : 0.85;
    const metal = Number.isFinite(m.metalness) ? m.metalness : 0;
    const emis = m.emissive || null;
    const emisI = Number.isFinite(m.emissiveIntensity) ? m.emissiveIntensity : 1;
    const transp = !!m.transparent;
    const op = Number.isFinite(m.opacity) ? m.opacity : 1;
    let touched = 0;
    root.traverse((n) => {
      if (!n.isMesh || !n.material) return;
      const paint = (mat) => {
        const c = mat.clone();
        if (c.color) c.color.set(hex);
        if ('roughness' in c) c.roughness = rough;
        if ('metalness' in c) c.metalness = metal;
        if (emis && 'emissive' in c) { c.emissive.set(emis); c.emissiveIntensity = emisI; }
        if ('transparent' in c) { c.transparent = transp; c.opacity = op; }
        // ★ 2026-11-08：标一下"这是用户自己设的材质"。
        //   成片预览的"真实感"会尊重它，不会偷偷换掉（real-look.js 的 isCustom 靠这个判断）。
        c.userData = Object.assign({}, c.userData, { ovfCustom: true });
        c.needsUpdate = true;
        return c;
      };
      n.material = Array.isArray(n.material) ? n.material.map(paint) : paint(n.material);
      touched++;
    });
    rec.material = { color: hex, roughness: rough, metalness: metal, emissive: emis, emissiveIntensity: emisI, transparent: transp, opacity: op };
    return { ok: true, touched, material: rec.material };
  }

  /** 读当前选中对象的材质（存材质库用） */
  captureMaterial() {
    const rec = this.selected;
    if (!rec) return { error: '先选中一个对象' };
    if (rec.material) return { material: rec.material };
    // 没设过就从前两个 mesh 的材质里取个大概
    let found = null;
    rec.group.traverse((n) => {
      if (found || !n.isMesh || !n.material) return;
      const m = Array.isArray(n.material) ? n.material[0] : n.material;
      if (!m) return;
      found = {
        color: m.color ? '#' + m.color.getHexString() : '#cccccc',
        roughness: m.roughness ?? 0.85,
        metalness: m.metalness ?? 0,
        emissive: m.emissive ? '#' + m.emissive.getHexString() : null,
        emissiveIntensity: m.emissiveIntensity ?? 1,
      };
    });
    return found ? { material: found } : { error: '这个对象没有可读的材质' };
  }

  /** 应用一个灯光预设（可复用灯光库） */
  applyLightPreset(l) {
    if (!l) return { ok: false, error: '没有灯光数据' };
    if (this.lightOpts) {
      for (const k of ['azimuth', 'elevation', 'kelvin', 'intensity', 'hemi', 'shadowSoft']) {
        if (Number.isFinite(l[k])) this.lightOpts[k] = l[k];
      }
    }
    this.applyLighting();
    return { ok: true, light: { ...this.lightOpts } };
  }

  /** 读当前灯光（存灯光库用） */
  captureLight() {
    if (!this.lightOpts) return { error: '没有灯光状态' };
    const o = this.lightOpts;
    return {
      light: {
        azimuth: o.azimuth, elevation: o.elevation, kelvin: o.kelvin,
        intensity: o.intensity, hemi: o.hemi, shadowSoft: o.shadowSoft,
      },
    };
  }

  /** 彩色模型：给整件随机/按槽分配颜色，用于快速做"彩色白膜"对照（不破坏原有材质） */
  paintParts() {
    if (!this.selected) return 0;
    const palette = [0xd9c7a3, 0xc9b18b, 0xb08d57, 0x8fac96, 0x8fb0d6, 0xd6a58f];
    let i = 0;
    this.selected.group.traverse(n => {
      if (!n.isMesh || !n.material) return;
      const paint = (m) => {
        const c = m.clone();
        if (c.color) c.color.set(palette[(i++) % palette.length]);
        // ★ 2026-11-08：也是"用户自己设的材质" → 成片预览的"真实感"会尊重它
        c.userData = Object.assign({}, c.userData, { ovfCustom: true });
        return c;
      };
      n.material = Array.isArray(n.material) ? n.material.map(paint) : paint(n.material);
    });
    return i;
  }

  // ---------- 相机 ----------
  setShotSize(id) {
    const s = SHOT_SIZES.find(x => x.id === id);
    if (!s) return;
    // ★ 2026-11-08：景别半径是绝对米数，要跟着场地档位放大，
    //   否则 large 档点「全景」还是贴在墙根（r=24m 在 2400m 的场地里等于特写）。
    this._animateCam({ r: s.r * (this.envScale || 1) });
  }
  saveCam() {
    const n = this.cams.length + 1;
    this.cams.push({
      name: '机位' + n,
      p: [this.camera.position.x, this.camera.position.y, this.camera.position.z],
      t: [this.target.x, this.target.y, this.target.z]
    });
    if (this.opts.onCams) this.opts.onCams(this.cams);
    if (this.opts.onStatus) this.opts.onStatus('已保存机位' + n);
  }
  gotoCam(i) {
    const c = this.cams[i];
    if (!c) return;
    this._animateCam({
      r: Math.hypot(c.p[0] - c.t[0], c.p[1] - c.t[1], c.p[2] - c.t[2]),
      phi: Math.acos(Math.max(-1, Math.min(1, (c.p[1] - c.t[1]) / Math.max(0.01, Math.hypot(c.p[0] - c.t[0], c.p[1] - c.t[1], c.p[2] - c.t[2]))))),
      theta: Math.atan2(c.p[0] - c.t[0], c.p[2] - c.t[2]),
      t: new THREE.Vector3(c.t[0], c.t[1], c.t[2])
    });
  }
  _animateCam(to) {
    const from = { r: this.sph.r, phi: this.sph.phi, theta: this.sph.theta, t: this.target.clone() };
    // v0.2 修复上游缺陷：setShotSize() 只传 { r }，旧实现把缺省的 phi/theta 拿去插值，
    // 得到 NaN → camera.position 全 NaN → 3D 画面整体消失（点「全景/中景/近景/特写」必现）。
    // 缺省值一律回落到当前值。
    const toR = Number.isFinite(to.r) ? to.r : from.r;
    const toPhi = Number.isFinite(to.phi) ? to.phi : from.phi;
    const toTheta = Number.isFinite(to.theta) ? to.theta : from.theta;
    const t0 = performance.now(), dur = 650;
    const step = () => {
      if (this.disposed) return;
      const k = Math.min(1, (performance.now() - t0) / dur);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      this.sph.r = from.r + (toR - from.r) * e;
      this.sph.phi = from.phi + (toPhi - from.phi) * e;
      this.sph.theta = from.theta + (toTheta - from.theta) * e;
      if (to.t) this.target.lerpVectors(from.t, to.t, e);
      this._applyCamera();
      if (k < 1) requestAnimationFrame(step);
      else this.camAnim = null;
    };
    if (this.camAnim) cancelAnimationFrame(this.camAnim);
    this.camAnim = requestAnimationFrame(step);
  }

  // ---------- 相机关键帧接口（时间线用 · 只读快照 / 无动画置位） ----------
  // ---------- v0.5：后期 / 吸附 / 灯光辅助 ----------
  /** 曝光（ACES 色调映射，1 = 正常） */
  setExposure(v) {
    const e = Math.max(0.1, Math.min(3, Number(v) || 1));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = e;
    this.exposure = e;
    return e;
  }

  /** 吸附：0.5 米网格（作用在 inspector 的数值变换上；拖拽由 topbar 层做吸附提示） */
  setSnap(on) { this.snap = !!on; return this.snap; }

  /** v0.8 拖拽模式：free（默认·相机平面三轴）| ground（贴地 XZ）| y（只调高度） */
  setDragMode(m) {
    this.dragMode = (m === 'ground' || m === 'y') ? m : 'free';
    return this.dragMode;
  }

  /** v0.9 全景背景（吸取自「3D 导演台」的全景导入）：等距圆柱贴图做背景 + 环境光照 */
  setPanorama(url) {
    this.panoramaUrl = url;
    return new Promise((resolve, reject) => {
      try {
        new THREE.TextureLoader().load(url, (tex) => {
          tex.mapping = THREE.EquirectangularReflectionMapping;
          tex.colorSpace = THREE.SRGBColorSpace;
          this.scene.background = tex;
          this.scene.environment = tex;
          this._panorama = tex;
          resolve(true);
        }, undefined, (err) => {
          // ★ 2026-11-10：three.js 的 onError 给的是 **ErrorEvent**，不是 Error。
          //   直接 reject 出去的话，上层 `String(e.message)` 拿不到东西，
          //   用户看到的是"[object Event]"（实测踩到）⇒ 这里包成可读的 Error。
          const detail = (err && (err.message || err.type)) || String(err || '未知原因');
          reject(new Error('全景图加载失败：' + detail));
        });
      } catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  clearPanorama() {
    this.panoramaUrl = null;
    this._panorama = null;
    this.scene.environment = null;
    this.scene.background = new THREE.Color(0xeceae4);
  }

  /** v0.9 阵列复制（吸取自「3D 导演台」的群众阵列）：以选中对象为原型铺 cols×rows 网格 */
  arrayDuplicate(cols, rows, spacing) {
    const rec = this.selected;
    if (!rec) return 0;
    const c = Math.max(1, Math.min(20, cols | 0 || 3));
    const r = Math.max(1, Math.min(20, rows | 0 || 2));
    const gap = Number(spacing) > 0 ? Number(spacing) : 1.4;
    const origin = rec.group.position.clone();
    const baseRot = rec.group.rotation.y;
    const baseScale = rec.group.scale.x;
    const color = rec.color;
    let n = 0;
    for (let i = 0; i < c; i++) {
      for (let j = 0; j < r; j++) {
        if (i === 0 && j === 0) continue;      // 原型本身不动
        if (n >= 60) break;
        const before = this.objects.length;
        this.duplicateAsset(rec);
        if (this.objects.length === before) continue;
        const g = this.objects[this.objects.length - 1].group;
        g.position.set(
          origin.x + (i - (c - 1) / 2) * gap,
          origin.y,
          origin.z + (j - (r - 1) / 2) * gap
        );
        g.rotation.y = baseRot;
        g.scale.setScalar(baseScale);
        if (color) this.setColor(color, this.objects[this.objects.length - 1]);
        n++;
      }
    }
    return n;
  }

  /**
   * 调色（后处理）：对比 / 饱和 / 暗角。
   * 实时预览走 canvas 的 CSS filter + 叠层；导出在 captureThumb 里用 2D canvas 复算，
   * 保证「所见 = 所出」。
   */
  setColorGrade(opts) {
    this.grade = Object.assign({ contrast: 1, saturation: 1, vignette: 0 }, this.grade || {}, opts || {});
    const cv = this.renderer.domElement;
    if (this.grade.contrast === 1 && this.grade.saturation === 1) cv.style.filter = '';
    else cv.style.filter = 'contrast(' + this.grade.contrast + ') saturate(' + this.grade.saturation + ')';
    const vp = cv.parentElement;
    if (vp) {
      let ov = vp.querySelector('.pf-vignette');
      if (!ov) {
        ov = document.createElement('div');
        ov.className = 'pf-vignette';
        vp.appendChild(ov);
      }
      ov.style.opacity = String(this.grade.vignette);
    }
    return Object.assign({}, this.grade);
  }

  getColorGrade() {
    return Object.assign({ contrast: 1, saturation: 1, vignette: 0 }, this.grade || {});
  }

  /** v1.5 成片开关（预览与导出共用一条管线，见 grade-pipeline.js） */
  setFilmLook(opts) {
    const d = { on: true, bloom: 0.3, grain: 0.085, letterbox: '2.39', warmth: 1 };
    this.film = Object.assign(d, this.film || {}, opts || {});
    // clamps
    this.film.bloom = Math.max(0, Math.min(1, Number(this.film.bloom)));
    this.film.grain = Math.max(0, Math.min(1, Number(this.film.grain)));
    this.film.warmth = Math.max(0, Math.min(1, Number(this.film.warmth)));
    if (this.film.letterbox === 'off' || this.film.letterbox === 'none') this.film.letterbox = null;
    return this.getFilmLook();
  }

  getFilmLook() {
    return Object.assign({ on: true, bloom: 0.3, grain: 0.085, letterbox: '2.39', warmth: 1 }, this.film || {});
  }

  /** 灯光辅助线（DirectionalLightHelper + HemisphereLightHelper） */
  setLightHelpers(on) {
    if (on && !this._lightHelperGroup) {
      const g = new THREE.Group();
      g.add(new THREE.DirectionalLightHelper(this.sun, 3, 0xd4b68a));
      g.add(new THREE.HemisphereLightHelper(this.hemi, 2, 0x8fac96));
      this.scene.add(g);
      this._lightHelperGroup = g;
    }
    if (this._lightHelperGroup) this._lightHelperGroup.visible = !!on;
    return !!on;
  }

  // ---------- 相机关键帧接口（时间线用 · 只读快照 / 无动画置位） ----------
  // 时间线的每一帧镜头都以「轨道相机参数」为唯一真相：
  //   sph.{r,phi,theta} + target + camera.fov
  // 与上面 _animateCam(to) 的区别：这里的两个方法都不启动补间，
  // 一帧到位。补间（含 theta 最短弧）由 timeline.js 的纯函数负责，
  // 这样插值数学可以脱离 three.js 单独测试。
  /** v1.7 镜头预演用：暂存 / 还原自由机位 */
  saveCam() {
    this._savedCam = this.captureCam();
    return this._savedCam;
  }

  restoreCam() {
    if (!this._savedCam) return false;
    const c = this._savedCam;
    this._savedCam = null;
    return this.applyCamState(c);
  }

  /** v1.8 设备机位（手机 / 无人机）：场景里放一台带镜头的设备，可直接用它出图/出片 */
  addDeviceCam(kind, opts) {
    const o = opts || {};
    const isDrone = kind === 'drone';
    const g = new THREE.Group();

    const mat = new THREE.MeshStandardMaterial({ color: isDrone ? 0x3a3733 : 0x6b655c, roughness: 0.55, metalness: 0.15 });
    if (isDrone) {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.1, 0.34), mat);
      g.add(body);
      for (let i = 0; i < 4; i++) {
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.03, 0.05), mat);
        arm.rotation.y = Math.PI / 4 + (i * Math.PI) / 2;
        arm.position.y = 0.02;
        g.add(arm);
        const rotor = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.01, 16), new THREE.MeshStandardMaterial({ color: 0xd8d2c6, roughness: 0.8 }));
        rotor.position.set(Math.cos(Math.PI / 4 + (i * Math.PI) / 2) * 0.28, 0.05, Math.sin(Math.PI / 4 + (i * Math.PI) / 2) * 0.28);
        g.add(rotor);
      }
      const lens = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), new THREE.MeshStandardMaterial({ color: 0x14120f, roughness: 0.25 }));
      lens.position.set(0, -0.04, 0.18);
      g.add(lens);
    } else {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.155, 0.012), mat);
      g.add(body);
      const screen = new THREE.Mesh(new THREE.BoxGeometry(0.062, 0.13, 0.002), new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.2, emissive: 0x101418, emissiveIntensity: 0.6 }));
      screen.position.z = 0.008;
      g.add(screen);
      const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.008, 12), new THREE.MeshStandardMaterial({ color: 0x0e0d0b, roughness: 0.3 }));
      lens.rotation.x = Math.PI / 2;
      lens.position.set(0.022, 0.055, -0.01);
      g.add(lens);
    }

    const fov = Number(o.fov) || (isDrone ? 50 : 62);
    const cam = new THREE.PerspectiveCamera(fov, 16 / 9, 0.05, 500);
    cam.name = 'cam-' + kind;
    // 镜头放在机身前方一点，避免拍到自己的机壳
    cam.position.set(0, isDrone ? -0.06 : 0.05, isDrone ? 0.2 : -0.02);
    g.add(cam);

    g.position.set(
      Number(o.x) || 0,
      Number(o.y) || (isDrone ? 2.4 : 1.45),
      Number(o.z) || 0
    );

    this.assetGroup.add(g);
    const lookAt = new THREE.Vector3(
      o.lookX == null ? 0 : Number(o.lookX),
      o.lookY == null ? 1 : Number(o.lookY),
      o.lookZ == null ? 0 : Number(o.lookZ)
    );
    const rec = {
      id: 'dev_' + kind + '_' + Date.now().toString(36),
      device: kind, group: g, cam, lookAt, fov, base: g.position.clone(),
    };
    this.devices = this.devices || [];
    this.devices.push(rec);
    this.updateDevice(rec);
    if (this.opts.onStatus) this.opts.onStatus('已添加' + (isDrone ? '无人机' : '手机') + '机位，可在「机位」面板里出图/出片');
    return rec;
  }

  /** 让设备镜头始终看向目标点（瞄准后跟拍时可随时改 lookAt） */
  updateDevice(rec) {
    if (!rec || !rec.cam) return null;
    rec.cam.aspect = rec.aspect || 16 / 9;
    rec.cam.fov = rec.fov || rec.cam.fov;
    rec.cam.updateProjectionMatrix();
    if (typeof rec.yaw === 'number' || typeof rec.pitch === 'number') {
      // 自由朝向：yaw 绕 Y、pitch 抬头低头，换算成一个正前方目标点
      const yaw = Number(rec.yaw || 0) * Math.PI / 180;
      const pitch = Number(rec.pitch || 0) * Math.PI / 180;
      const p = rec.group.position;
      rec.lookAt.set(
        p.x + Math.sin(yaw) * Math.cos(pitch) * 20,
        p.y + Math.sin(pitch) * 20,
        p.z + Math.cos(yaw) * Math.cos(pitch) * 20
      );
    }
    rec.cam.lookAt(rec.lookAt);
    // v2.5：绕自身视线翻转（手机横过来拍那种）
    if (Number(rec.roll)) {
      rec.cam.rotateZ(Number(rec.roll) * Math.PI / 180);
    }
    return rec;
  }

  /** v2.3：自由调整机位（位置 / 水平角 yaw / 俯仰 pitch / 焦距 fov） */
  setDeviceAim(id, opts) {
    const rec = this.deviceById(id);
    if (!rec) return null;
    const o = opts || {};
    if (typeof o.x === 'number' || typeof o.y === 'number' || typeof o.z === 'number') {
      rec.group.position.set(
        typeof o.x === 'number' ? o.x : rec.group.position.x,
        typeof o.y === 'number' ? o.y : rec.group.position.y,
        typeof o.z === 'number' ? o.z : rec.group.position.z
      );
      rec.base = rec.group.position.clone();
    }
    if (typeof o.yaw === 'number') rec.yaw = o.yaw;
    if (typeof o.pitch === 'number') rec.pitch = Math.max(-89, Math.min(89, o.pitch));
    if (typeof o.roll === 'number') rec.roll = o.roll;
    if (typeof o.fov === 'number') { rec.fov = Math.max(8, Math.min(120, o.fov)); rec.cam.fov = rec.fov; }
    // 让「对准目标」也能反推 yaw/pitch，方便来回切
    this.updateDevice(rec);
    return {
      id: rec.id, pos: rec.group.position.toArray().map(n => +n.toFixed(2)),
      yaw: rec.yaw == null ? null : +Number(rec.yaw).toFixed(1),
      pitch: rec.pitch == null ? null : +Number(rec.pitch).toFixed(1),
      roll: rec.roll == null ? 0 : +Number(rec.roll).toFixed(1),
      fov: rec.cam.fov,
    };
  }

  /** 把设备对准某个世界点（默认对准当前选中物体中心） */
  aimDeviceAt(id, target) {
    const rec = this.deviceById(id);
    if (!rec) return null;
    let tp = target;
    if (!tp) {
      const sel = this.selected;
      if (sel) {
        const b = new THREE.Box3().setFromObject(sel.group);
        tp = b.getCenter(new THREE.Vector3());
      } else {
        tp = new THREE.Vector3(0, 1, 0);
      }
    }
    const p = rec.group.position;
    const dx = tp.x - p.x, dy = tp.y - p.y, dz = tp.z - p.z;
    const yaw = Math.atan2(dx, dz) * 180 / Math.PI;
    const pitch = Math.atan2(dy, Math.hypot(dx, dz)) * 180 / Math.PI;
    rec.yaw = +yaw.toFixed(1);
    rec.pitch = +pitch.toFixed(1);
    this.updateDevice(rec);
    return { id: rec.id, yaw: rec.yaw, pitch: rec.pitch, look: [tp.x, tp.y, tp.z].map(n => +n.toFixed(2)) };
  }

  listDevices() {
    return (this.devices || []).map(d => ({
      id: d.id, device: d.device,
      pos: d.group.position.toArray().map(n => +n.toFixed(2)),
      look: d.lookAt.toArray().map(n => +n.toFixed(2)),
      fov: d.cam.fov,
      yaw: d.yaw == null ? null : +Number(d.yaw).toFixed(1),
      pitch: d.pitch == null ? null : +Number(d.pitch).toFixed(1),
      roll: +(Number(d.roll) || 0).toFixed(1),
    }));
  }

  removeDevice(id) {
    const i = (this.devices || []).findIndex(d => d.id === id);
    if (i < 0) return false;
    const d = this.devices[i];
    this.assetGroup.remove(d.group);
    this.devices.splice(i, 1);
    return true;
  }

  /** v2.4：聚焦某台设备机位（视口里显示黄铜高亮框，可左键拖位置 / 右键转角度） */
  focusDevice(id) {
    const d = this.deviceById(id);
    this.aimDevice = d ? id : null;
    if (d) {
      if (!this.devHelper) {
        this.devHelper = new THREE.BoxHelper(d.group, 0xb08d57);
        this.devHelper.material.depthTest = false;
        this.devHelper.renderOrder = 997;
        this.scene.add(this.devHelper);
      }
      this.devHelper.setFromObject(d.group);
      this.devHelper.visible = true;
      // ★ 2026-11-08 22:45：**选中设备不再自动接管小窗**。
      //   之前 v49 的行为是"选中哪台，小窗就看哪台" —— 结果小窗变成无人机的航拍，
      //   跟 3D VIEW 完全不是一个视角（用户反馈：成片预览比 3D view 远得多）。
      //   现在小窗**默认永远跟主相机**；想看设备视角，去设备面板点「视角」按钮。
      try {
        if (this.opts && this.opts.onDeviceFocus) this.opts.onDeviceFocus(d);
        window.dispatchEvent(new CustomEvent('wb-device-focus', { detail: { id: d.id, device: d.device } }));
      } catch (_) {}
    } else if (this.devHelper) {
      this.devHelper.visible = false;
    }
    return !!d;
  }

  deviceById(id) {
    return (this.devices || []).find(d => d.id === id) || null;
  }

  /**
   * v2.1：出片/外部视角时隐藏"编辑器专属"的东西
   *   网格、选中框、灯光辅助线、设备机位本体（等于摄影机不该入镜）
   * 返回 restore()，用完必须调，保证编辑视图原样恢复。
   */
  hideEditorHelpers(opts) {
    const o = opts || {};
    const targets = [];
    const add = (obj) => { if (obj) targets.push({ obj, vis: obj.visible }); };
    if (o.grid !== false) add(this.grid);
    if (o.selection !== false) add(this.selHelper);
    if (o.lights !== false) add(this._lightHelperGroup);
    if (o.devices !== false) (this.devices || []).forEach(d => add(d.group));
    if (o.helpers !== false) (this._extraHelpers || []).forEach(h => add(h));
    if (o.devHelper !== false && this.devHelper) add(this.devHelper);
    targets.forEach(t => { try { t.obj.visible = false; } catch (_) {} });
    return () => targets.forEach(t => { try { t.obj.visible = t.vis; } catch (_) {} });
  }

  /**
   * ★ 2026-11-08：如果「成片预览」开着真实感，**出图也用同一套外观**。
   * @returns {Function|null} restore（调用后还原）
   */
  _applyRealLookIfOn() {
    const RL = window.__ovfRealLook;
    if (!RL || !RL.isReal()) return null;
    try {
      return RL.applyCurrent(this.scene, this, this.renderer);
    } catch (_) { return null; }
  }

  /** 用任意相机渲染一张图（不带调色，交给上层过成片管线） */
  renderFromCamera(cam, w, h) {
    w = w || 1280; h = h || 720;
    const old = this.renderer.getSize(new THREE.Vector2());
    const oldAspect = cam.aspect;
    this.renderer.setSize(w, h, false);
    cam.aspect = w / h;
    cam.updateProjectionMatrix();
    const restore = this.hideEditorHelpers();
    // ★ 出图也套真实感（同 captureThumb）
    const restoreReal = this._applyRealLookIfOn();
    this.renderer.render(this.scene, cam);
    if (restoreReal) restoreReal();
    const url = this.renderer.domElement.toDataURL('image/png');
    restore();
    this.renderer.setSize(old.x, old.y, false);
    cam.aspect = oldAspect;
    cam.updateProjectionMatrix();
    this.camera.aspect = old.x / old.y;
    this.camera.updateProjectionMatrix();
    return url;
  }

  captureCam() {
    return {
      r: this.sph.r,
      phi: this.sph.phi,
      theta: this.sph.theta,
      t: [this.target.x, this.target.y, this.target.z],
      fov: this.camera.fov,
      // 位置冗余存一份只读快照，便于外部（导出/对比）不装 three 也能读
      p: [this.camera.position.x, this.camera.position.y, this.camera.position.z]
    };
  }

  applyCamState(cs) {
    if (!cs) return false;
    // 打断可能正在跑的机位补间，否则它会在下一帧把时间线刚设好的姿态覆盖掉
    if (this.camAnim) { cancelAnimationFrame(this.camAnim); this.camAnim = null; }
    if (typeof cs.r === 'number' && isFinite(cs.r)) this.sph.r = Math.max(0.01, cs.r);
    if (typeof cs.phi === 'number' && isFinite(cs.phi)) {
      // 只夹到数学安全区（避免 sin(phi)=0 处位置退化），不夹轨道操作范围
      this.sph.phi = Math.max(0.0001, Math.min(Math.PI - 0.0001, cs.phi));
    }
    if (typeof cs.theta === 'number' && isFinite(cs.theta)) this.sph.theta = cs.theta;
    if (cs.t && cs.t.length >= 3) {
      this.target.set(+cs.t[0] || 0, +cs.t[1] || 0, +cs.t[2] || 0);
    }
    if (typeof cs.fov === 'number' && isFinite(cs.fov)) {
      this.camera.fov = Math.max(1, Math.min(179, cs.fov));
      this.camera.updateProjectionMatrix();
    }
    this._applyCamera();
    return true;
  }

  // ---------- v0.7：WASD 飞行（W/S 前后 · A/D 平移 · Q/E 升降 · Shift 加速） ----------
  _bindFlyKeys() {
    this._keys = new Set();
    const typing = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'
      || el.tagName === 'SELECT' || el.isContentEditable);
    const keyOf = (e) => {
      const k = (e.key || '').toLowerCase();
      if (k === 'w' || k === 'a' || k === 's' || k === 'd' || k === 'q' || k === 'e') return k;
      if (k === 'shift') return 'shift';
      return null;
    };
    this._onFlyDown = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (typing(e.target)) return;
      const view = document.getElementById('view-editor');
      if (!view || view.hidden) return;
      const k = keyOf(e);
      if (!k) return;
      this._keys.add(k);
      if (k !== 'shift') e.preventDefault();
    };
    this._onFlyUp = (e) => {
      const k = keyOf(e);
      if (k) this._keys.delete(k);
    };
    this._onFlyBlur = () => { if (this._keys) this._keys.clear(); };
    window.addEventListener('keydown', this._onFlyDown);
    window.addEventListener('keyup', this._onFlyUp);
    window.addEventListener('blur', this._onFlyBlur);

    const step = () => {
      if (this.disposed) return;
      this._flyRaf = requestAnimationFrame(step);
      const k = this._keys;
      if (!k || !k.size) return;
      const view = document.getElementById('view-editor');
      if (!view || view.hidden) return;
      const speed = (k.has('shift') ? 2.2 : 1) * Math.max(0.6, this.sph.r * 0.06);
      const fw = new THREE.Vector3().subVectors(this.target, this.camera.position).setY(0);
      if (fw.lengthSq() < 1e-6) fw.set(0, 0, -1);
      fw.normalize();
      const rt = new THREE.Vector3(-fw.z, 0, fw.x);   // 右手方向
      const mv = new THREE.Vector3();
      if (k.has('w')) mv.add(fw);
      if (k.has('s')) mv.sub(fw);
      if (k.has('d')) mv.add(rt);
      if (k.has('a')) mv.sub(rt);
      if (k.has('e')) mv.y += 1;
      if (k.has('q')) mv.y -= 1;
      if (mv.lengthSq() < 1e-6) return;
      mv.normalize().multiplyScalar(speed * 0.05);
      this.target.add(mv);
      if (this.target.y < 0.2) this.target.y = 0.2;
      this._applyCamera();
    };
    this._flyRaf = requestAnimationFrame(step);
  }

  /** v0.8 自由拖拽的核心：把屏幕像素位移换算成相机右/上方向的世界位移 */
  moveByScreenDelta(group, dx, dy) {
    if (!group) return;
    const dist = this.camera.position.distanceTo(group.position);
    const fovRad = (this.camera.fov * Math.PI) / 180;
    const h = this.renderer.domElement.clientHeight || this.container.clientHeight || 900;
    const worldPerPx = (2 * dist * Math.tan(fovRad / 2)) / Math.max(1, h);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    group.position.addScaledVector(right, dx * worldPerPx);
    group.position.addScaledVector(up, -dy * worldPerPx);
    group.position.y = Math.max(-0.6, group.position.y);
    return group.position;
  }

  // ---------- 事件 ----------
  _initEvents() {
    const el = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    const ptr = new THREE.Vector2();
    let mode = null, lastX = 0, lastY = 0, moved = 0;
    let rotStart = null;   // v62 旋转环拖拽起点
    const dragPlane = new THREE.Plane();
    const freePlane = new THREE.Plane();
    let dragMode = 'ground';
    let dragDevice = null;
    let dragStartY = 0;
    let dragStartMouseY = 0;
    const hitOff = new THREE.Vector3();
    const freeOff = new THREE.Vector3();

    const setPtr = e => {
      const r = el.getBoundingClientRect();
      ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ptr, this.camera);
    };
    // v62：可拾取 = 场景资产 + 旋转环 + 环境自带物体（可被接管成普通物体）
    const pickables = () => {
      const list = [...this.assetGroup.children];
      if (this.rotRing && this.rotRing.visible) list.push(this.rotRing);
      if (this.rotRingV && this.rotRingV.visible) list.push(this.rotRingV);
      list.push(...this.envGroup.children);
      return list;
    };
    // ★ 2026-10-26（用户：「容易点到地板难以操作」）：
    //   标了 userData.pickable=false 的（地板/路面/人行道）**不允许被鼠标选中，
    //   也不允许被"接管成普通物体"** —— 以前点一下地板，整块地面变成一个可选中、
    //   可拖动、可删除的大物件，之后视角和选中全乱。
    //   只禁鼠标；agent 走 instanceId 寻址（studio-agent.js / studio-bridge.js），
    //   照样能改地板，不受影响。
    const pickable = (obj) => {
      let p = obj;
      while (p) {
        if (p.userData && p.userData.pickable === false) return false;
        p = p.parent;
      }
      return true;
    };

    el.addEventListener('pointerdown', e => {
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* 合成事件没有真实 pointer，忽略 */ }
      moved = 0; lastX = e.clientX; lastY = e.clientY;
      setPtr(e);
      const hits = ray.intersectObjects(pickables(), true).filter(h => pickable(h.object));
      // v62：先看旋转环（选中物中间的环）
      const ringHit = hits.find(h => h.object === this.rotRing || h.object === this.rotRingV);
      if (ringHit && this.selected) {
        mode = ringHit.object === this.rotRingV ? 'rotate-z' : 'rotate-y';
        rotStart = { x: e.clientX, y: e.clientY, q: this.selected.group.quaternion.clone() };
        return;
      }
      // v2.4：设备机位可以在视口里直接拖（左键移动 / 右键转向）
      if (hits.length) {
        let dg = null;
        for (const h of hits) {
          let p = h.object;
          while (p && p.parent && p.parent !== this.assetGroup) p = p.parent;
          const found = (this.devices || []).find(d => d.group === p);
          if (found) { dg = found; break; }
        }
        if (dg) {
          this.focusDevice(dg.id);
          dragDevice = dg;
          mode = e.button === 2 ? 'dev-aim' : 'dev-move';
          dragStartY = dg.group.position.y;
          dragStartMouseY = e.clientY;
          dragPlane.set(new THREE.Vector3(0, 1, 0), -dg.group.position.y);
          const pt0 = new THREE.Vector3();
          if (ray.ray.intersectPlane(dragPlane, pt0)) hitOff.subVectors(dg.group.position, pt0);
          return;
        }
      }
      if (e.button === 0 && hits.length) {
        let rec = null;
        for (const h of hits) {
          let p = h.object;
          while (p.parent && p.parent !== this.assetGroup) p = p.parent;
          rec = this.objects.find(o => o.group === p);
          if (rec) break;
        }
        if (!rec) {
          // v62：点到的是环境自带物体（墙/地/桌…）→ 接管成普通物体，可选中/移动/旋转/删除
          // ★ 2026-10-26：地板（userData.pickable=false）**不接管** ——
          //   接管一次就多出一个"能拖能删的大地面"，用户后面再也点不准东西。
          for (const h of hits) {
            let p = h.object;
            while (p && p.parent && p.parent !== this.envGroup) p = p.parent;
            if (p && p.parent === this.envGroup && p.userData && p.userData.pickable === false) continue;
            if (p && p.parent === this.envGroup) {
              this.assetGroup.attach(p);
              const nr = { instanceId: crypto.randomUUID(), assetId: 'env:' + (p.name || 'part'), group: p, envPart: true };
              this.objects.push(nr);
              rec = nr;
              this.pickMesh = h.object;
              break;
            }
          }
        }
        if (rec && (e.ctrlKey || e.metaKey)) {
          mode = 'multiselect';           // 占位，避免窗口兜底再合成一次 pointerdown
          this.toggleSelect(rec);
          return;
        }
        if (rec) {
          this.pickMesh = (hits.find(h => {
            let p = h.object;
            while (p && p.parent && p.parent !== this.assetGroup) p = p.parent;
            return p === rec.group;
          }) || {}).object || null;
          this.select(rec);
          mode = 'move';
          // v0.7 自由拖拽：
          //   默认 —— 贴地平面（XZ）
          //   按住 Shift —— 只动高度（Y）
          //   按住 Alt   —— 自由（相机朝向平面，三轴都能动）
          dragMode = this.dragMode || 'free';
          dragPlane.set(new THREE.Vector3(0, 1, 0), -rec.group.position.y);
          const n = this.camera.getWorldDirection(new THREE.Vector3()).negate();
          freePlane.setFromNormalAndCoplanarPoint(n, rec.group.position);
          const pt = new THREE.Vector3();
          if (ray.ray.intersectPlane(dragPlane, pt)) hitOff.subVectors(rec.group.position, pt);
          const ptF = new THREE.Vector3();
          if (ray.ray.intersectPlane(freePlane, ptF)) freeOff.subVectors(rec.group.position, ptF);
          dragStartY = rec.group.position.y;
          dragStartMouseY = e.clientY;
          return;
        }
      }
      mode = (e.button === 2 || e.shiftKey) ? 'pan' : 'orbit';
    });
    el.addEventListener('pointermove', e => {
      if (this._dbg) this._dbg.moves++;
      if (!mode) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = e.clientX; lastY = e.clientY;
      if ((mode === 'rotate' || mode === 'rotate-y' || mode === 'rotate-z') && this.selected) {
        const g = this.selected.group;
        if (mode === 'rotate-z') g.rotateZ(dx * 0.01);       // 竖直环：左右倾斜（绕 Z）
        else if (mode === 'rotate-y') g.rotateY(dx * 0.01);  // 水平环：左右转（绕 Y）
        else if (e.shiftKey) g.rotateX(dy * 0.01);
        else g.rotateY(dx * 0.01);
        this._updateRotRing && this._updateRotRing();
        return;
      }
      if (mode === 'orbit') {
        this.sph.theta -= dx * 0.005;
        this.sph.phi = Math.max(0.12, Math.min(1.52, this.sph.phi - dy * 0.005));
        this._applyCamera();
      } else if (mode === 'pan') {
        const s = this.sph.r * 0.0016;
        const fw = new THREE.Vector3().subVectors(this.target, this.camera.position).setY(0).normalize();
        const rt = new THREE.Vector3(fw.z, 0, -fw.x);
        this.target.addScaledVector(rt, -dx * s).addScaledVector(fw, dy * s);
        this._applyCamera();
      } else if (mode === 'dev-move' && dragDevice) {
        setPtr(e);
        if (e.shiftKey) {
          // Shift：贴地移动（只改 XZ，保持高度）
          const pt = new THREE.Vector3();
          dragPlane.set(new THREE.Vector3(0, 1, 0), -dragDevice.group.position.y);
          if (ray.ray.intersectPlane(dragPlane, pt)) {
            const next = pt.add(hitOff);
            dragDevice.group.position.x = next.x;
            dragDevice.group.position.z = next.z;
          }
        } else {
          // 默认：相机平面三轴自由移动（想放多高放多高）
          this.moveByScreenDelta(dragDevice.group, dx, dy);
          dragDevice.group.position.y = Math.max(0, dragDevice.group.position.y);
        }
        dragDevice.base = dragDevice.group.position.clone();
        this.updateDevice(dragDevice);
        if (this.devHelper) this.devHelper.setFromObject(dragDevice.group);
        if (this.opts.onDeviceChange) this.opts.onDeviceChange(dragDevice);
      } else if (mode === 'dev-aim' && dragDevice) {
        if (e.altKey) {
          // Alt：绕视线翻转（roll）
          dragDevice.roll = Math.max(-180, Math.min(180, (Number(dragDevice.roll) || 0) + dx * 0.6));
        } else {
          dragDevice.yaw = (Number(dragDevice.yaw) || 0) - dx * 0.35;
          dragDevice.pitch = Math.max(-89, Math.min(89, (Number(dragDevice.pitch) || 0) - dy * 0.3));
        }
        this.updateDevice(dragDevice);
        if (this.opts.onDeviceChange) this.opts.onDeviceChange(dragDevice);
      } else if (mode === 'move' && this.selected) {
        setPtr(e);
        const g = this.selected.group;
        // v0.8：拖拽模式在**拖动过程中**动态判定（之前只在按下那一刻看修饰键，
        // 用户先拖再按 Shift 就失效了，表现为"只能平面位移、不能上下动"）
        const effective = e.shiftKey ? 'y' : (e.altKey ? 'ground' : (this.dragMode || 'free'));
        if (this._dbg) { this._dbg.eff = effective; this._dbg.dx = dx; this._dbg.dy = dy; this._dbg.mode = mode; }
        if (effective === 'y') {
          // 只动高度：屏幕 dy → 世界高度（按当前轨道半径缩放，手感稳定）
          const k = this.sph.r * 0.0042;
          g.position.y = Math.max(-0.6, dragStartY + (dragStartMouseY - e.clientY) * k);
        } else if (effective === 'free') {
          // 自由：屏幕位移 → 世界位移（沿相机右/上轴，按物体深度换算像素→米）
          // 不用射线求交：透视相机正对物体时射线常与拖拽平面近乎平行，会"拖不动"
          this.moveByScreenDelta(g, dx, dy);
        } else {
          const pt = new THREE.Vector3();
          if (ray.ray.intersectPlane(dragPlane, pt)) {
            const next = pt.add(hitOff);
            // 吸附开启时对齐 0.5 m 网格
            if (this.snap) {
              next.x = Math.round(next.x * 2) / 2;
              next.z = Math.round(next.z * 2) / 2;
            }
            g.position.copy(next);
          }
        }
        this.select(this.selected);
      }
    });
    const endPtr = e => {
      if (mode === 'rotate' || mode === 'rotate-y' || mode === 'rotate-z') {
        rotStart = null;
        this._updateRotRing && this._updateRotRing();
        if (this.opts.onStatus) this.opts.onStatus('已旋转');
      }
      if (mode === 'move' && moved < 4) { /* 单击不撤销 */ }
      if (mode === 'orbit' && moved < 4) {
        setPtr(e);
        const hits = ray.intersectObjects(pickables(), true);
        if (!hits.length) this.select(null);
      }
      mode = null;
      dragDevice = null;
      this._updateRotRing && this._updateRotRing();
    };
    el.addEventListener('pointerup', endPtr);
    el.addEventListener('pointercancel', () => { mode = null; });

    // v0.8 兜底：无头浏览器 / CDP 注入的鼠标事件有时不在 canvas 上触发 pointerdown
    // （表现为"选中了但拖不动"）。窗口捕获层再补一次合成事件，保证按下即进入拖拽/旋转。
    window.addEventListener('pointerdown', (e) => {
      if (mode || e.button !== 0) return;
      // v65：真实落在 canvas 上的事件会被 canvas 自己的监听处理，这里不要再合成一次（否则 Ctrl+点击会被加选又取消）
      if (e.target && e.target.tagName === 'CANVAS') return;
      if (!el.contains(e.target) && e.target !== el) return;
      const synth = new PointerEvent('pointerdown', {
        bubbles: false, cancelable: true, clientX: e.clientX, clientY: e.clientY,
        button: 0, buttons: 1, pointerId: e.pointerId || 1, pointerType: 'mouse', isPrimary: true,
      });
      el.dispatchEvent(synth);
    }, true);
    el.addEventListener('contextmenu', e => e.preventDefault());
    el.addEventListener('wheel', e => {
      e.preventDefault();
      this.sph.r = Math.max(2.2, Math.min(90, this.sph.r * (1 + Math.sign(e.deltaY) * 0.09)));
      this._applyCamera();
    }, { passive: false });

    this._onResize = () => {
      if (this.disposed || !this.container.clientWidth) return;
      this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    };
    window.addEventListener('resize', this._onResize);
    // v0.2：容器尺寸变化也要跟随（底部时间线折叠/展开会改可用高度，
    // 只监听 window resize 会漏掉，canvas 保持旧尺寸会盖住底部工具栏）
    if (typeof ResizeObserver !== 'undefined') {
      this._ro = new ResizeObserver(() => this._onResize());
      this._ro.observe(this.container);
    }
  }

  // ---------- 序列化 ----------
  serialize() {
    return {
      v: 2, env: this.envId, externalEnvironment: !!this.externalEnvironment,
      // 场地尺寸档位（地图大小是设置，不是写死）：老场景没有这个字段 → 读回来是 small
      size: this.envSize || (window.WB_DEFAULT_SCENE_SIZE || 'small'),
      objects: this.objects.map(o => ({
        id: o.assetId,
        instanceId: o.instanceId || (o.instanceId = crypto.randomUUID()),
        externalAsset: o.externalAsset || null,
        // ★ 2026-11-09：手动指定的 PBR 贴图（右键「套 PBR 材质」）
        pbrId: o.pbrId || null,
        p: o.group.position.toArray(),
        q: o.group.quaternion.toArray(),
        scale: o.group.scale.toArray(),
        ry: +(o.group.rotation.y * 180 / Math.PI).toFixed(1),
        s: +o.group.scale.x.toFixed(3),
        c: o.color || null
      })),
      cams: this.cams,
      light: this.getLight(), grade: this.getColorGrade(), film: this.getFilmLook(),
      camera: this.captureCam(), panorama: this.panoramaUrl || null,
      studioTracks: this.studioTracks || null, studioRender: this.studioRender || null,
      trackMeta: this._trackMeta || null,
      studioSceneId: this.studioSceneId || null, studioRevision: this.studioRevision || 0,
      devices: (this.devices || []).map(d => ({ id: d.id, device: d.device, pos: d.group.position.toArray(),
        look: d.lookAt.toArray(), fov: d.cam.fov, yaw: d.yaw ?? null, pitch: d.pitch ?? null, roll: d.roll || 0 }))
    };
  }
  async loadScene(json) {
    for (const device of [...(this.devices || [])]) this.removeDevice(device.id);
    this.loadEnv(json.env || 'room', { size: json.size });
    if (json.externalEnvironment) { this._clearGroup(this.envGroup); this.externalEnvironment = true; }
    this._clearGroup(this.assetGroup);
    this.objects = [];
    for (const o of (json.objects || [])) {
      if (o.externalAsset) {
        await this.addExternalAsset(o.externalAsset, o);
        // ★ 2026-11-09：外部模型也要恢复手动指定的 PBR
        const er = this.objects[this.objects.length - 1];
        if (er && o.pbrId) er.pbrId = o.pbrId;
        continue;
      }
      const def = window.WB_ASSETS.find(a => a.id === o.id);
      if (!def) continue;
      const g = def.make();
      g.position.set(o.p[0], o.p[1], o.p[2]);
      g.rotation.y = (o.ry || 0) * Math.PI / 180;
      g.scale.setScalar(o.s || 1);
      if (o.q) g.quaternion.fromArray(o.q);
      if (o.scale) g.scale.fromArray(o.scale);
      if (o.c) g.traverse(n => {
        if (n.isMesh && n.material) { n.material = n.material.clone(); n.material.color.set(o.c); }
      });
      this.assetGroup.add(g);
      this.objects.push({
        instanceId: o.instanceId || crypto.randomUUID(), assetId: o.id, group: g, color: o.c,
        pbrId: o.pbrId || null,
      });
    }
    this.cams = (json.cams || []).map(c => ({ name: c.name, p: c.p, t: c.t }));
    if (this.opts.onCams) this.opts.onCams(this.cams);
    if (json.light) this.setLight(json.light);
    if (json.grade) this.setColorGrade(json.grade);
    if (json.film) this.setFilmLook(json.film);
    if (json.camera) this.applyCamState(json.camera);
    this.studioTracks = json.studioTracks || null;
    this._trackMeta = json.trackMeta || null;
    this.studioRender = json.studioRender || null;
    this.studioSceneId = json.studioSceneId || null;
    this.studioRevision = json.studioRevision || 0;
    if (json.panorama) await this.setPanorama(json.panorama); else this.clearPanorama();
    for (const device of (json.devices || [])) {
      const restored = this.addDeviceCam(device.device || 'phone', { x: device.pos[0], y: device.pos[1], z: device.pos[2],
        lookX: device.look[0], lookY: device.look[1], lookZ: device.look[2] });
      restored.id = device.id;
      this.setDeviceAim(restored.id, { x: device.pos[0], y: device.pos[1], z: device.pos[2], yaw: device.yaw, pitch: device.pitch, roll: device.roll, fov: device.fov });
    }
    this.select(null);
  }

  // ---------- 截图 ----------
  captureThumb(w, h) {
    w = w || 480; h = h || 270;
    const old = this.renderer.getSize(new THREE.Vector2());
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // v47：出图时隐藏编辑器专属辅助（网格/选中框/灯光线/设备本体），否则效果图里会带橙色选中框
    const restoreHelpers = this.hideEditorHelpers ? this.hideEditorHelpers() : null;
    // ★ 2026-11-08：**出图也套上「成片预览」那套真实感**（HDRI + 材质 + 色泽 + 光线）。
    //   之前只有小窗是真实效果、出的图还是白膜 —— 预览和成片对不上，等于白做。
    //   渲染期间临时换材质/背景/灯光，渲完立刻还原（主视口不受影响）。
    const restoreReal = this._applyRealLookIfOn();
    this.renderer.render(this.scene, this.camera);
    if (restoreReal) restoreReal();
    if (restoreHelpers) restoreHelpers();
    let url;
    const FG = window.FilmGrade;
    const film = this.getFilmLook();
    const RL = window.__ovfRealLook;
    // ★ 真实感开着 → **一定走成片管线**（不然关了成片开关，真实感的调色就丢了）
    const realOn = !!(RL && RL.isReal());
    if (!FG || (film.on === false && !realOn)) {
      const g = this.getColorGrade();
      url = this.renderer.domElement.toDataURL('image/jpeg', 0.82);
      if (g.contrast !== 1 || g.saturation !== 1 || g.vignette > 0) {
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        const ctx = tmp.getContext('2d');
        ctx.filter = 'contrast(' + g.contrast + ') saturate(' + g.saturation + ')';
        ctx.drawImage(this.renderer.domElement, 0, 0, w, h);
        if (g.vignette > 0) {
          ctx.filter = 'none';
          const grad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.24, w / 2, h / 2, Math.max(w, h) * 0.72);
          grad.addColorStop(0, 'rgba(0,0,0,0)');
          grad.addColorStop(1, 'rgba(0,0,0,' + (0.85 * g.vignette).toFixed(3) + ')');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, w, h);
        }
        url = tmp.toDataURL('image/jpeg', 0.92);
      }
    } else {
      // v1.5：导出走与小窗同一条成片管线（调色/辉光/暖冷/暗角/颗粒/遮幅）
      const tmp = document.createElement('canvas');
      tmp.width = w; tmp.height = h;
      const ctx = tmp.getContext('2d');
      // ★ 2026-11-08：真实感开着时，**调色也用外观里的那一份** ——
      //   不然小窗一套调色、出的图另一套，预览和成片对不上。
      const opts = realOn
        ? Object.assign({}, FG.fromEditor(this), RL.gradeForLook(RL.getLook()))
        : FG.fromEditor(this);
      FG.apply(ctx, this.renderer.domElement, w, h, opts);
      url = tmp.toDataURL('image/jpeg', 0.92);
    }
    this.renderer.setSize(old.x, old.y, false);
    this.camera.aspect = old.x / old.y;
    this.camera.updateProjectionMatrix();
    return url;
  }

  /**
   * ★ 2026-11-08：自适应像素比。
   *   大世界（xxl / OSM 街区）在弱机上会被像素填充率拖死。
   *   这里按最近 45 帧的平均帧时长把 devicePixelRatio 在 0.75×~2× 之间调，
   *   掉到 26ms 以下再往回提 —— 只动分辨率，不动几何，用户看到的是"变清晰/变流畅"。
   *   `this._autoQuality = false` 可以整体关掉。
   */
  _trackPerf(now) {
    if (this._autoQuality === false) return;
    if (this._perfLast == null) { this._perfLast = now; return; }
    const dt = now - this._perfLast;
    this._perfLast = now;
    if (!Number.isFinite(dt) || dt <= 0 || dt > 400) return;   // 切后台/断点不计
    this._perfAcc = (this._perfAcc || []).concat(dt).slice(-45);
    if (this._perfAcc.length < 45) return;
    const avg = this._perfAcc.reduce((a, b) => a + b, 0) / this._perfAcc.length;
    this._perfAcc = [];
    const cap = Math.min(window.devicePixelRatio || 1, 2);
    const pr = this.renderer.getPixelRatio();
    let next = pr;
    if (avg > 26 && pr > 0.76) next = Math.max(0.75, pr * 0.85);
    else if (avg < 15 && pr < cap - 0.01) next = Math.min(cap, pr * 1.1);
    if (Math.abs(next - pr) < 0.01) return;
    this.renderer.setPixelRatio(next);
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
  }

  // ---------- 主循环 ----------
  _animate() {
    if (this.disposed) return;
    this._raf = requestAnimationFrame(() => this._animate());
    this._trackPerf(performance.now());
    if (this.aimDevice && this.devHelper) {
      const dv = this.deviceById(this.aimDevice);
      if (dv) this.devHelper.setFromObject(dv.group);
    }
    if (this.selected) {
      const b = new THREE.Box3().setFromObject(this.selected.group);
      const size = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
      this.selHelper.position.copy(c);
      this.selHelper.scale.set(Math.max(size.x, 0.3) * 1.08, Math.max(size.y, 0.3) * 1.08, Math.max(size.z, 0.3) * 1.08);
    }
    // ★ 2026-11-08：生成型世界（city / osm）按相机距离裁道具，
    //   远看只留楼，近看才长树和灯。普通预设环境 _cityState 为 null，零开销。
    if (this._cityState) {
      updateCityLod(this._cityState, this.camera.position, this._citySize || 1);
      // 分块裁剪：只留目标附近 range 圈内的块（阴影相机也跟着 target，不会丢影子）
      const cs = (this._cityState.plan && this._cityState.plan.chunkSize) || 1;
      const camDist = Math.hypot(this.camera.position.x - this.target.x, this.camera.position.z - this.target.z);
      const range = Math.max(2, Math.min(6, Math.ceil(camDist / cs) + 2));
      applyChunkCulling(this._cityState, this.target, range);
    }
    // ★ 2026-11-08：动态阴影 —— 太阳与阴影相机每帧贴着 target，
    //   大世界里影子只覆盖"主体周围"，分辨率全部用在看得见的地方。
    if (this.sun && this._sunDir) {
      const k = this.envScale || 1;
      const d = 30 * k;
      this.sun.position.set(
        this.target.x + this._sunDir.x * d,
        this.target.y + Math.max(1.5 * k, this._sunDir.y * d),
        this.target.z + this._sunDir.z * d
      );
      this.sun.target.position.copy(this.target);
      this.sun.target.updateMatrixWorld();
    }
    // ★ 2026-11-09：CSM（级联阴影）—— 相机动了要重算各 cascade 的阴影相机
    try {
      const csm = window.__ovfCsm;
      if (csm && csm.updateCsm) csm.updateCsm(this);
    } catch (_) { /* 忽略 */ }
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * ★ 2026-11-09：给**选中物体**指定 PBR 贴图（手动逐个指定）。
   *   id = null → 恢复「按部位自动分配」。
   */
  setObjectPbr(id) {
    const rec = this.selected;
    if (!rec) return { ok: false, error: '先选中一个物体' };
    if (id) rec.pbrId = String(id);
    else delete rec.pbrId;
    // 立刻重渲一次小窗，用户马上能看到
    try { if (window.__studioPip && window.__studioPip.refresh) window.__studioPip.refresh(); } catch (_) {}
    return { ok: true, pbrId: rec.pbrId || null };
  }

  /**
   * ★ 2026-11-10：当前世界在 (x,z) 处的**地面高度**（page Y-up）。
   *
   * 为什么需要：真实世界(OSM) 是**起伏地形** —— 京都的楼基在 y=61，
   * 而新摆的模型默认落在 y=0 ⇒ **埋在地里 61 米**。
   * 放模型前先问这个函数，把 y 落到地面上。
   *
   * @returns {number} 地面高度（没有 OSM 世界时返回 0）
   */
  groundHeightAt(x, z) {
    const built = this._cityState;
    if (!built || !built.group) return 0;
    // ① 楼基高度（最准：楼就在那）
    const bs = (built.plan && built.plan.buildings) || [];
    let best = null, bestD = Infinity;
    for (const b of bs) {
      let bx = b.x, bz = b.z;
      if (b.ring && b.ring.length) {
        let sx = 0, sz = 0;
        for (const p of b.ring) { sx += p.x; sz += p.z; }
        bx = sx / b.ring.length; bz = sz / b.ring.length;
      }
      if (!Number.isFinite(bx) || !Number.isFinite(bz)) continue;
      const d = (bx - x) * (bx - x) + (bz - z) * (bz - z);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (best && bestD < 400 * 400) {
      const y0 = Number(best.y0 != null ? best.y0 : (best.baseY != null ? best.baseY : (best.y != null ? best.y : 0)));
      if (Number.isFinite(y0)) return y0;
    }
    // ② 退回到地形网格采样
    const t = built.terrain || (built.plan && built.plan.terrain);
    if (t && Array.isArray(t.grid) && t.grid.length) {
      const res = t.res || Math.round(Math.sqrt(t.grid.length));
      const size = t.size || (built.plan && built.plan.size) || 1000;
      const half = size / 2;
      const u = Math.max(0, Math.min(res - 1, Math.round(((x + half) / size) * (res - 1))));
      const v = Math.max(0, Math.min(res - 1, Math.round(((z + half) / size) * (res - 1))));
      const val = t.grid[v * res + u];
      if (Number.isFinite(val)) return val;
    }
    return 0;
  }

  /**
   * ★ 2026-11-09：开/关**级联阴影**（CSM）。
   * 大世界里远处没影子、或者单张 2048² 阴影图糊成一团时用。
   */
  async setCsm(on, opt = {}) {
    const mod = window.__ovfCsm;
    if (!mod) return { ok: false, error: 'CSM 模块没加载' };
    if (!on) {
      const done = mod.disableCsm(this);
      return { ok: true, on: false, removed: done };
    }
    try {
      await mod.enableCsm(this, opt);
      if (this._sunDir) mod.syncCsmLight(this);
      return { ok: true, on: true, cascades: (this.csm && this.csm.cascades) || 3 };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  /** 当前场景的材质要不要补 CSM 支持（换环境/加载世界后调用） */
  _csmSetupAll() {
    try {
      const mod = window.__ovfCsm;
      if (mod && mod.setupAll) mod.setupAll(this);
    } catch (_) { /* 忽略 */ }
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this._raf);
    cancelAnimationFrame(this._flyRaf);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('keydown', this._onFlyDown);
    window.removeEventListener('keyup', this._onFlyUp);
    window.removeEventListener('blur', this._onFlyBlur);
    if (this._ro) { this._ro.disconnect(); this._ro = null; }
    this.clearInterior();
    this._clearGroup(this.assetGroup);
    this._clearGroup(this.envGroup);
    this.renderer.dispose();
    if (this.renderer.domElement.parentNode) this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
  }
}

export const EDITOR_SHOT_SIZES = SHOT_SIZES;

/* 离屏渲染全部资产缩略图（等距视角，黏土白模） */
EditorApp.makeAssetThumbs = function (size) {
  size = size || 96;
  if (window.__WB_THUMBS) return Promise.resolve(window.__WB_THUMBS);
  return new Promise(resolve => {
    const r = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    r.setSize(size, size);
    r.shadowMap.enabled = false;
    const sc = new THREE.Scene();
    const cam = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
    cam.position.set(6, 5, 6); cam.lookAt(0, 1, 0);
    sc.add(new THREE.HemisphereLight(0xffffff, 0xd8d2c4, 1.15));
    const dl = new THREE.DirectionalLight(0xfff6e8, 1.1);
    dl.position.set(8, 14, 6); sc.add(dl);
    const out = {};
    const list = window.WB_ASSETS;
    let i = 0;
    const next = () => {
      if (i >= list.length) {
        r.dispose();
        window.__WB_THUMBS = out;
        return resolve(out);
      }
      const def = list[i++];
      const g = def.make();
      const b = new THREE.Box3().setFromObject(g);
      const sz = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3());
      const k = 2.4 / Math.max(sz.x, sz.y, sz.z, 0.001);
      g.scale.setScalar(k);
      g.position.sub(c.multiplyScalar(k));
      sc.add(g);
      r.render(sc, cam);
      out[def.id] = r.domElement.toDataURL('image/png');
      sc.remove(g);
      g.traverse(n => { if (n.geometry) n.geometry.dispose(); });
      setTimeout(next, 0);   // 让出主线程，防卡 UI
    };
    next();
  });
};
