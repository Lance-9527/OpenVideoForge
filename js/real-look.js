/* ============================================================================
 * js/real-look.js —— 「真实感」外观（**只作用于成片预览小窗，不是全局**）
 *
 * 用户的原话（2026-11-08 21:00）：
 *   「『成品预览』的『渲染』不是保存当前视角图片的意思，是学酷家乐的
 *     赋予这个**成片预览视图（不是全局）**材质色泽光线什么的，
 *     让它变成类似真实看到的视觉效果」
 *   「尝试点击『渲染』后把成片预览视图变成真实世界肉眼看到的效果（接近真实的五彩斑斓）」
 *
 * ⇒ 设计要点：
 *   1. **不动主视口**。建模视图继续用白膜（改模型时本来就该看形体）。
 *      只有右上角那个「成片预览」小窗变成真实效果。
 *   2. 做法：PIP 用的是**独立渲染器 + 同一个 scene**。
 *      所以在 `prev.render(scene, cam)` 这一句**前后**临时换掉
 *      背景 / 环境光 / 太阳 / 材质，渲完立刻还原 ——
 *      这中间没有 await，主视口的 RAF 根本插不进来，所以**主视口绝对看不到**。
 *   3. 「五彩斑斓」靠三件事：
 *      · 天空渐变（蓝→暖白）当背景 —— 一眼从"灰盒子"变成" outdoors"
 *      · 每个物体按类别给**真实感材质**（树=叶绿+干棕、车=漆面红/银、人=肤色…）
 *      · PMREM 环境贴图 + ACES + 提亮曝光 —— 金属/陶瓷有反射
 * ========================================================================== */

/* ── 真实感材质表：按资产 id ─────────────────────────────────────────── */
export const PHOTO_MATS = {
  // 自然
  'tree':        { color: '#4f7d3a', rough: 0.86, metal: 0 },
  'palm':        { color: '#5b8c3f', rough: 0.84, metal: 0 },
  'rock':        { color: '#8a8f96', rough: 0.92, metal: 0 },
  'bush':        { color: '#4a7a3c', rough: 0.9, metal: 0 },
  'grass':       { color: '#6f9b46', rough: 0.92, metal: 0 },
  // 人
  'person-stand': { color: '#4a6f8f', rough: 0.7, metal: 0 },
  'person-sit':   { color: '#8f5a4a', rough: 0.7, metal: 0 },
  'person-pair':  { color: '#5a7f5f', rough: 0.7, metal: 0 },
  'crowd-3':      { color: '#6b7f9a', rough: 0.72, metal: 0 },
  'crowd-5':      { color: '#7a8fa8', rough: 0.72, metal: 0 },
  // 载具
  'car-sedan':  { color: '#b8352f', rough: 0.24, metal: 0.55 },
  'car-truck':  { color: '#2f4f7a', rough: 0.42, metal: 0.4 },
  'bike':       { color: '#2c2f36', rough: 0.35, metal: 0.7 },
  // 建筑
  'wall':       { color: '#d9d2c4', rough: 0.9, metal: 0 },
  'room-box':   { color: '#e2ddd2', rough: 0.88, metal: 0 },
  'house':      { color: '#e8e0cf', rough: 0.86, metal: 0 },
  'tower':      { color: '#c9c4bb', rough: 0.8, metal: 0.08 },
  'tent':       { color: '#c25b4a', rough: 0.85, metal: 0 },
  'pavilion':   { color: '#a8753f', rough: 0.72, metal: 0 },
  'column':     { color: '#d5cfc2', rough: 0.78, metal: 0 },
  'temple-gate':{ color: '#cdbfa3', rough: 0.8, metal: 0 },
  'pyramid':    { color: '#d8c49a', rough: 0.85, metal: 0 },
  // 道具
  'streetlamp': { color: '#3a3f47', rough: 0.4, metal: 0.6 },
  'table':      { color: '#a9763f', rough: 0.55, metal: 0.05 },
  'chair':      { color: '#b07c46', rough: 0.55, metal: 0.05 },
  'crate':      { color: '#b9904f', rough: 0.8, metal: 0 },
  'bench':      { color: '#8f6a3d', rough: 0.62, metal: 0.05 },
  'hydrant':    { color: '#c0392b', rough: 0.45, metal: 0.3 },
  'fence':      { color: '#8e949c', rough: 0.5, metal: 0.55 },
  'boat':       { color: '#2f6f8f', rough: 0.35, metal: 0.2 },
  'sphinx':     { color: '#c9b183', rough: 0.82, metal: 0 },
  'obelisk':    { color: '#b8ac93', rough: 0.8, metal: 0 },
  'statue':     { color: '#d5cdb8', rough: 0.55, metal: 0.12 },
  'trash':      { color: '#5b6570', rough: 0.5, metal: 0.5 },
  'mailbox':    { color: '#2f6fa8', rough: 0.4, metal: 0.45 },
  'billboard':  { color: '#3c424c', rough: 0.45, metal: 0.35 },
  'container':  { color: '#b8562f', rough: 0.6, metal: 0.35 },
  'planter':    { color: '#b5714a', rough: 0.78, metal: 0 },
  'parasol':    { color: '#e0b23c', rough: 0.7, metal: 0 },
};

/**
 * ★ 部件级配色：同一个资产里，不同部件给不同颜色。
 *   内置资产是"一个资产 = 几个没名字的 mesh"（树干是圆柱、树冠是球），
 *   光给整个资产一个颜色，树就是一团绿 —— 分部件才有真实感。
 *   规则按**几何类型**匹配（资产里的网格没名字）。
 */
export const PHOTO_PARTS = {
  'tree':        { CylinderGeometry: '#6b4b32', SphereGeometry: '#4f7d3a' },
  'palm':        { CylinderGeometry: '#8a6a45', ConeGeometry: '#5b8c3f', SphereGeometry: '#6b4b32' },
  'bush':        { SphereGeometry: '#4a7a3c' },
  'rock':        { SphereGeometry: '#8a8f96' },
  'grass':       { ConeGeometry: '#6f9b46' },
  'person-stand':{ SphereGeometry: '#e8b896', CylinderGeometry: '#4a6f8f', BoxGeometry: '#3f6280' },
  'person-sit':  { SphereGeometry: '#e8b896', CylinderGeometry: '#8f5a4a', BoxGeometry: '#7a4c3e' },
  'person-pair': { SphereGeometry: '#e0aa88', CylinderGeometry: '#5a7f5f', BoxGeometry: '#4d6f52' },
  'crowd-3':     { SphereGeometry: '#e8b896', CylinderGeometry: '#6b7f9a' },
  'crowd-5':     { SphereGeometry: '#e8b896', CylinderGeometry: '#7a8fa8' },
  'car-sedan':   { CylinderGeometry: '#26282c', SphereGeometry: '#a8cede', BoxGeometry: '#b8352f' },
  'car-truck':   { CylinderGeometry: '#26282c', SphereGeometry: '#a8cede', BoxGeometry: '#2f4f7a' },
  'bike':        { CylinderGeometry: '#26282c', TorusGeometry: '#1c1e22' },
  'hydrant':     { CylinderGeometry: '#c0392b' },
  'streetlamp':  { CylinderGeometry: '#3a3f47' },
  'table':       { BoxGeometry: '#a9763f', CylinderGeometry: '#8a6338' },
  'chair':       { BoxGeometry: '#b07c46', CylinderGeometry: '#96683a' },
  'bench':       { BoxGeometry: '#8f6a3d', CylinderGeometry: '#4a4d52' },
  'crate':       { BoxGeometry: '#b9904f' },
  'parasol':     { CylinderGeometry: '#a9803a', ConeGeometry: '#e0b23c' },
  'planter':     { CylinderGeometry: '#b5714a' },
  'trash':       { CylinderGeometry: '#5b6570' },
  'mailbox':     { CylinderGeometry: '#2f6fa8' },
  'fence':       { CylinderGeometry: '#8e949c' },
  'boat':        { BoxGeometry: '#2f6f8f' },
  'column':      { CylinderGeometry: '#d5cfc2' },
};

/** 兜底调色板：按名字哈希取一个不难看的颜色（保证"五彩斑斓"而不是一片灰） */
const FALLBACK = [
  '#c96f4a', '#4f86a8', '#7ba05b', '#c9a94f', '#8a6fa8', '#4a9a8f',
  '#b8524f', '#5f7fb8', '#a08a4f', '#7f9a5f', '#9a5f8f', '#4f8f9a',
];
export function fallbackColor(key) {
  let h = 0;
  const s = String(key || 'x');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return FALLBACK[h % FALLBACK.length];
}

/* ── 天空 ────────────────────────────────────────────────────────────── */
/**
 * 画一张天空渐变（CanvasTexture）。
 * 上帝蓝 → 地平线暖白，是"户外真实"最强的视觉线索。
 */
export function makeSkyTexture(THREE, opt = {}) {
  const top = opt.top || '#4a86d6';
  const mid = opt.mid || '#a8c8e8';
  const bottom = opt.bottom || '#f0e6d4';
  const c = document.createElement('canvas');
  c.width = 4; c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createLinearGradient(0, 0, 0, 256);
  grd.addColorStop(0, top);
  grd.addColorStop(0.55, mid);
  grd.addColorStop(1, bottom);
  g.fillStyle = grd;
  g.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** 由天空图生成 PMREM 环境贴图（金属/陶瓷的反射来源） */
export function makeEnvTexture(THREE, renderer, skyTex) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(skyTex).texture;
  pmrem.dispose();
  return env;
}

/* ── 环境（地面/墙/路/楼）上色 ────────────────────────────────────────── */
/** 环境网格的"真实感"配色（role 用来查程序化贴图） */
const ENV_COLORS = {
  ground:  { role: 'ground',   color: '#6f8f52', rough: 0.95, metal: 0 },    // 草地
  road:    { role: 'road',     color: '#4a4d52', rough: 0.88, metal: 0.05 }, // 沥青
  lane:    { role: 'lane',     color: '#e6e3d8', rough: 0.8, metal: 0 },
  sidewalk:{ role: 'sidewalk', color: '#b8b4a8', rough: 0.9, metal: 0 },
  wood:    { role: 'wood',     color: '#a9763f', rough: 0.6, metal: 0.03 },   // 木地板/桌面
  wall:    { role: 'wall',     color: '#e6dfd2', rough: 0.88, metal: 0 },
  building:{ role: 'building', color: '#cfc8b8', rough: 0.82, metal: 0.06 },
  green:   { role: 'green',    color: '#5c8a43', rough: 0.92, metal: 0 },
  water:   { role: 'water',    color: '#3f7fa8', rough: 0.12, metal: 0.15 },
  terrain: { role: 'terrain',  color: '#7d8f5a', rough: 0.95, metal: 0 },
  interior:{ role: 'interior', color: '#e2dbcd', rough: 0.85, metal: 0 },
  neutral: { role: 'neutral',  color: '#cfc9bb', rough: 0.85, metal: 0.03 },
};

/**
 * 判断一个环境网格是什么（地面 / 墙 / 路 / 桌面 …）。
 * 环境里大部分网格**没有名字**（scenes.js 的 box()/cyl() 不命名），
 * 所以这里用**名字优先 + 几何尺寸兜底**来分类。
 * @returns {{role:string, color:string, rough:number, metal:number}}
 */
export function classifyEnvMesh(node) {
  const n = String(node.name || '').toLowerCase();
  if (n.startsWith('floor')) {
    if (n.includes('road')) return ENV_COLORS.road;
    if (n.includes('lane')) return ENV_COLORS.lane;
    if (n.includes('sidewalk')) return ENV_COLORS.sidewalk;
    if (n.includes('room') || n.includes('office')) return ENV_COLORS.wood;
    return ENV_COLORS.ground;
  }
  if (n.includes('road')) return ENV_COLORS.road;
  if (n.includes('building')) return ENV_COLORS.building;
  if (n.includes('green')) return ENV_COLORS.green;
  if (n.includes('water')) return ENV_COLORS.water;
  if (n.includes('terrain')) return ENV_COLORS.terrain;
  if (n.includes('interior')) return ENV_COLORS.interior;
  if (n.includes('tree')) return ENV_COLORS.green;
  if (n.includes('prop')) return ENV_COLORS.neutral;

  // ── 没名字的：用几何尺寸猜
  let bb = null;
  try {
    node.geometry.computeBoundingBox();
    bb = node.geometry.boundingBox;
  } catch (_) { bb = null; }
  if (!bb) return ENV_COLORS.neutral;
  const sx = bb.max.x - bb.min.x, sy = bb.max.y - bb.min.y, sz = bb.max.z - bb.min.z;
  // 竖起来的大板 → 墙
  if (sy > 2.2 && (sx > 4 || sz > 4) && Math.max(sx, sz) > sy * 1.2) return ENV_COLORS.wall;
  // 薄板 → 桌面/台面/地面
  if (sy < 0.45 && (sx > 1.6 || sz > 1.6)) return ENV_COLORS.wood;
  // 很扁很大的 → 地面
  if (sy < 0.5 && Math.max(sx, sz) > 8) return ENV_COLORS.ground;
  return ENV_COLORS.neutral;
}

/* ── 材质替换 ────────────────────────────────────────────────────────── */
function isCustom(mat) {
  return !!(mat && mat.userData && mat.userData.ovfCustom);
}

/**
 * 给一个 mesh 换"真实感"材质。
 * @returns {Function} 还原函数
 */
function swapMaterial(THREE, node, desc) {
  const old = node.material;
  if (!old || isCustom(old)) return null;   // 用户自己改过的材质 → 尊重用户
  const make = (m) => {
    const c = new THREE.MeshStandardMaterial({
      color: new THREE.Color(desc.color || '#cccccc'),
      roughness: Number.isFinite(desc.rough) ? desc.rough : 0.75,
      metalness: Number.isFinite(desc.metal) ? desc.metal : 0.05,
      side: m.side,
      transparent: m.transparent,
      opacity: m.opacity,
    });    if (m.map) c.map = m.map;
    if (m.vertexColors) c.vertexColors = true;
    return c;
  };
  node.material = Array.isArray(old) ? old.map(make) : make(old);
  return () => { node.material = old; };
}

/**
 * ★ 核心：**在预览渲染期间**临时换掉整个场景的外观，渲完还原。
 *
 * @param {THREE} THREE
 * @param {object} scene   编辑器的 scene
 * @param {object} editor  编辑器实例（拿 objects / sun / hemi / envGroup）
 * @param {object} look    { sky, light, material, grade }
 * @param {object} renderer 用于 PMREM 的渲染器（PIP 的 prev）
 * @param {object} env     HDRI 环境贴图 { env, background }（可空）
 * @returns {Function} restore
 */
/**
 * ★ 2026-11-09：临时材质也要装 **CSM（级联阴影）** 支持。
 *   applyRealLook 每次都新建材质 —— 不补 setupMaterial 的话，
 *   这些材质没有 USE_CSM define ⇒ 预览里阴影会突然消失。
 */
function csmSetup(mat) {
  try {
    const m = window.__ovfCsm;
    if (m && m.setupMaterialSafe && window.__wb && window.__wb.editor) m.setupMaterialSafe(window.__wb.editor, mat);
  } catch (_) { /* 忽略 */ }
  return mat;
}

export function applyRealLook(THREE, scene, editor, look, renderer, env) {
  const restores = [];
  const L = look || {};

  // 1) 背景 + 环境
  const oldBg = scene.background;
  const oldEnv = scene.environment;
  const oldFog = scene.fog;
  if (env && env.env) {
    // ★ 有 HDRI：用它当环境贴图（反射/间接光的来源）
    //   背景是否也用它，由 look.hdriBg 决定 ——
    //   室内场景配户外 HDRI 会"浮在草地上"，所以给用户一个开关。
    scene.environment = env.env;
    if (L.hdriBg === false) {
      // 只当环境光：背景保留程序化天空
      try {
        const sky = makeSkyTexture(THREE, L.sky || {});
        scene.background = sky;
        restores.push(() => { scene.background = oldBg; sky.dispose && sky.dispose(); });
      } catch (_) { scene.background = oldBg; }
    } else {
      scene.background = env.background || env.env;
    }
    restores.push(() => { scene.background = oldBg; scene.environment = oldEnv; });
  } else {
    try {
      const sky = makeSkyTexture(THREE, L.sky || {});
      scene.background = sky;
      restores.push(() => { scene.background = oldBg; sky.dispose && sky.dispose(); });
      try {
        const envTex = makeEnvTexture(THREE, renderer, sky);
        scene.environment = envTex;
        restores.push(() => { scene.environment = oldEnv; envTex.dispose && envTex.dispose(); });
      } catch (_) { /* PMREM 失败就算了，不影响其它效果 */ }
    } catch (_) { /* 背景换不了就跳过 */ }
  }
  if (L.sky && L.sky.fog !== false) {
    // 远处淡出 —— 大世界纵深
    const fc = new THREE.Color((L.sky.bottom) || '#f0e6d4');
    scene.fog = new THREE.Fog(fc.getHex(), 60, 900);
    restores.push(() => { scene.fog = oldFog; });
  }

  // 2) 太阳：暖一点、亮一点
  const sun = editor && editor.sun;
  if (sun && L.light) {
    const oldI = sun.intensity, oldC = sun.color.clone();
    if (Number.isFinite(L.light.intensity)) sun.intensity = L.light.intensity;
    if (L.light.color) sun.color.set(L.light.color);
    restores.push(() => { sun.intensity = oldI; sun.color.copy(oldC); });
  }
  // 3) 半球光：天蓝补光（真实感的关键 —— 阴影里不是死黑，是天蓝）
  const hemi = editor && editor.hemi;
  if (hemi && L.light) {
    const oldI = hemi.intensity, oldS = hemi.color.clone(), oldG = hemi.groundColor.clone();
    if (Number.isFinite(L.light.hemi)) hemi.intensity = L.light.hemi;
    if (L.light.skyColor) hemi.color.set(L.light.skyColor);
    if (L.light.groundColor) hemi.groundColor.set(L.light.groundColor);
    restores.push(() => { hemi.intensity = oldI; hemi.color.copy(oldS); hemi.groundColor.copy(oldG); });
  }

  // 4) 物体材质：按类别给"真实感"
  const mats = L.material || {};
  const objs = (editor && editor.objects) || [];
  // ★ 探针：这次套用到底命中了几个 PBR 材质（别靠肉眼看图猜）
  let pbrHits = 0, procHits = 0, plainHits = 0;
  for (const rec of objs) {
    const g = rec.group;
    if (!g) continue;
    const key = rec.assetId || '';
    const base = PHOTO_MATS[key] || { color: fallbackColor(key || rec.instanceId), rough: 0.7, metal: 0.05 };
    const parts = PHOTO_PARTS[key] || null;
    const desc = {
      color: mats.color && mats.useColor ? mats.color : base.color,
      rough: Number.isFinite(mats.roughness) ? mats.roughness : base.rough,
      metal: Number.isFinite(mats.metalness) ? mats.metalness : base.metal,
    };
    g.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      // 部件级配色（树干棕 / 树冠绿…）—— 只在没统一指定颜色时生效
      let d = desc;
      if (parts && !(mats.color && mats.useColor)) {
        const gt = node.geometry && node.geometry.type;
        const pc = parts[gt];
        if (pc) d = Object.assign({}, desc, { color: pc });
      }
      // ★ 2026-11-09：内置资产（树/人/车）也能上**真实 PBR 贴图**
      //   —— 之前它们只有纯色 + 部件配色，看着还是"塑料玩具"。
      //   按类别取对应的 PBR 材质：树冠→草/树叶，人→布料，车→金属/漆面。
      if (pbrSets && L.pbr && L.pbr.on && !mats.useColor) {
        // ★ 用户手动指定的优先（右键「套 PBR 材质…」）——
        //   这样**外部导入的 GLB** 也能换成真实 PBR 贴图。
        let set = null;
        if (rec.pbrId && pbrSets.byId && pbrSets.byId[rec.pbrId]) {
          set = pbrSets.byId[rec.pbrId];
        } else {
          const pr = PBR_FOR_OBJECT[key];
          set = pr ? (pbrSets[pr] || pbrSets.neutral) : null;
        }
        if (set && set.map) {
          try {
            const mat = new THREE.MeshStandardMaterial({
              color: new THREE.Color(d.color),
              roughness: d.rough,
              metalness: d.metal,
              side: node.material.side,
            });
            // 贴图当"细节"叠在部件色上：mix(底色, 贴图色, strength)
            pbrPatch(mat, set, 0.6, 0.35, d.color);
            csmSetup(mat);
            const old = node.material;
            node.material = mat;
            restores.push(() => { node.material = old; mat.dispose(); });
            pbrHits++;
            return;
          } catch (_) { /* 失败就退回纯色 */ }
        }
      }
      const r = swapMaterial(THREE, node, d);
      if (r) restores.push(r);
    });
  }

  // 5) **环境**（地面/墙/路/楼）也要上色 ——
  //    不然天空是蓝的、地面还是白的，一眼假。
  const envG = editor && editor.envGroup;
  if (envG && envG.traverse) {
    const useProc = !!(L.proc && L.proc.on);
    // ★ 2026-11-09：真实 **PBR 贴图**（ambientCG CC0）优先于程序化假纹理
    //   —— 贴图组是**预先加载好的**（preparePbr），因为 applyRealLook 是同步的。
    //
    //   ★ 这里**不能**再写 `const pbrSets = L.pbr && L.pbr.sets ? ... : null`：
    //     那会**遮蔽**模块级的 pbrSets，而 PIP 的渲染路径
    //     （studio-pip.js → applyRealLook(..., look, ...)）传的 look 里**没有** sets
    //     —— 结果 PBR 分支永远走不到（实测：探针 pbr 命中 0 个）。
    //     现在统一用模块级的 pbrSets（由 preparePbr 设置）。
    envG.traverse((node) => {
      if (!node.isMesh || !node.material) return;
      const desc = classifyEnvMesh(node);
      let d = desc;
      // 用户自己设过材质的，尊重用户，不覆盖
      if (node.material && node.material.userData && node.material.userData.ovfCustom) return;

      // ★ PBR 优先
      if (pbrSets && L.pbr && L.pbr.on) {
        const role = desc.role;
        const set = pbrSets[role] || pbrSets.neutral;
        if (set && set.map) {
          try {
            const mat = new THREE.MeshStandardMaterial({
              color: 0xffffff,
              roughness: desc.rough == null ? 0.9 : desc.rough,
              metalness: desc.metal == null ? 0 : desc.metal,
              side: node.material.side,
            });
            pbrPatch(mat, set, PBR_SCALE[role] || 0.35, desc.metal ? 0.4 : 1.0);
            csmSetup(mat);
            const old = node.material;
            node.material = mat;
            restores.push(() => { node.material = old; mat.dispose(); });
            pbrHits++;
            return;
          } catch (_) { /* 失败就退回程序化 */ }
        }
      }

      // 三平面程序化材质：按角色贴对应的程序化贴图
      //   （不需要 UV —— 项目里的几何体基本没 UV）
      if (useProc) {
        const pr = PROC_BY_ROLE[desc.role] || PROC_BY_ROLE.neutral;
        try {
          const tex = makeProcTexture(THREE, pr.kind);
          const mat = new THREE.MeshStandardMaterial({
            color: new THREE.Color(pr.color),
            roughness: desc.rough, metalness: desc.metal,
            side: node.material.side,
          });
          triplanarPatch(THREE, mat, tex, pr.scale, pr.strength, pr.tint == null ? 1 : pr.tint);
          csmSetup(mat);
          const old = node.material;
          node.material = mat;
          restores.push(() => { node.material = old; mat.dispose(); });
          procHits++;
          return;
        } catch (_) { /* 贴图生成失败就退回纯色 */ }
      }
      const r = swapMaterial(THREE, node, d);
      if (r) restores.push(r);
      if (r) plainHits++;
    });
  }

  // 探针挂到 window，测试里直接读
  window.__ovfLookProbe = { pbr: pbrHits, proc: procHits, plain: plainHits };

  return () => { for (let i = restores.length - 1; i >= 0; i--) { try { restores[i](); } catch (_) {} } };
}

/**
 * ★ 2026-11-08：HDRI 环境贴图（本地素材库，Poly Haven CC0）。
 *
 * 这是"真实感"里**最关键的一块**：
 *   · 环境反射 —— 金属/水/玻璃立刻像那么回事（纯色材质做不到）
 *   · 间接光   —— 阴影不再是死黑，是被天空染过的颜色
 *   · 对所有材质生效、**不需要 UV** —— 正好补上 PBR 贴图库够不着的地方
 *
 * 这里只负责**把 .hdr 解码成纹理**；PMREM（把全景图压成环境贴图）
 * 需要一个渲染器，由 studio-pip.js 用它自己的小渲染器做。
 */
import * as THREE from 'three';
import { RGBELoader } from './vendor/RGBELoader.js?v=76';
import { makeProcTexture, triplanarPatch, PROC_BY_ROLE } from './proc-mat.js?v=76';
import { pbrPatch, loadPbrTextures } from './pbr-mat.js?v=76';

/** 各角色的 PBR 贴图重复次数（米为单位） */
const PBR_SCALE = {
  ground: 0.12, road: 0.10, wall: 0.18, floor: 0.25,
  roof: 0.16, building: 0.14, sidewalk: 0.16, neutral: 0.20,
};

/** ★ PBR 贴图组（纹理对象，只在内存里 —— 不能序列化） */
let pbrSets = null;

/**
 * ★ 内置资产 → 用哪种 PBR 材质。
 *   键是**实际存在的资产 id**（见 js/assetlib.js 的 WB_ASSETS）。
 *   树冠→草/叶、树干→木、人→布、车→金属、房子→墙…
 */
const PBR_FOR_OBJECT = {
  // 植物
  tree: 'ground', bush: 'ground', palm: 'ground', grass: 'ground',
  // 人
  'person-stand': 'neutral', 'person-sit': 'neutral', 'person-pair': 'neutral',
  'crowd-3': 'neutral', 'crowd-5': 'neutral',
  // 车
  'car-sedan': 'building', 'car-truck': 'building', bike: 'building', boat: 'building',
  // 木制品
  bench: 'floor', table: 'floor', chair: 'floor', crate: 'floor',
  // 建筑
  house: 'wall', pavilion: 'wall', temple: 'wall', 'temple-gate': 'wall',
  tower: 'wall', pyramid: 'wall', column: 'wall', wall: 'wall',
  'room-box': 'wall', tent: 'neutral',
  // 金属/器械
  fence: 'building', hydrant: 'building', streetlamp: 'building',
  // 石
  rock: 'wall',
};

/**
 * ★ 2026-11-09：把本地 PBR 素材按角色装好，交给 applyRealLook。
 *   applyRealLook 是**同步**的，所以贴图必须先加载好。
 * @param {object} map  { role → pbrId }  （没给就按角色自动挑）
 * @returns {Promise<object>} { role → texSet }
 */
export async function preparePbr(map) {
  const idx = await (await import('./pbr-mat.js?v=76')).pbrList();
  if (!idx.length) return null;
  const byRole = {};
  const byId = {};
  for (const it of idx) {
    if (it.role && !byRole[it.role]) byRole[it.role] = it;
    byId[it.id] = it;
  }
  const want = map && typeof map === 'object' ? map : {};
  const sets = {};
  // ★ byId：所有用到的材质都加载一份，好让「手动指定」能按 id 取
  for (const it of idx) {
    const id = it.id;
    if (sets.__loaded && sets.__loaded[id]) continue;
    const set = await loadPbrTextures(id);
    if (set && set.map) {
      sets.__loaded = sets.__loaded || {};
      sets.__loaded[id] = set;
    }
  }
  for (const role of Object.keys(PBR_SCALE)) {
    const id = want[role] || (byRole[role] && byRole[role].id);
    if (!id) continue;
    const set = (sets.__loaded && sets.__loaded[id]) || await loadPbrTextures(id);
    if (set && set.map) sets[role] = set;
  }
  // 兜底：没有对应角色的，用第一个可用的
  if (!sets.neutral) {
    const first = idx[0];
    if (first) {
      const set = (sets.__loaded && sets.__loaded[first.id]) || await loadPbrTextures(first.id);
      if (set && set.map) sets.neutral = set;
    }
  }
  sets.byId = sets.__loaded || {};
  delete sets.__loaded;
  pbrSets = Object.keys(sets).length ? sets : null;
  return pbrSets;
}

const hdriCache = new Map();   // id → DataTexture（**可以**跨 renderer 复用：每个 GL 上下文各自上传一份）
let loader = null;

/**
 * ★ PMREM 的输出（WebGLRenderTarget）**绑定在创建它的 GL 上下文里**，
 *   换个 renderer 用会渲染不出来。所以按 renderer 分别缓存。
 */
const envCache = new WeakMap();   // renderer → Map(id → {env, background})

export async function loadHdriTexture(id) {
  if (!id) return null;
  if (hdriCache.has(id)) return hdriCache.get(id);
  if (!loader) loader = new RGBELoader();
  const url = 'http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/hdri/file/' + encodeURIComponent(id);
  const tex = await new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, () => reject(new Error('HDRI 加载失败：' + id)));
  });
  hdriCache.set(id, tex);
  return tex;
}

/**
 * 取某个 renderer 的 PMREM 环境贴图（现算现缓存）。
 * @param {THREE.WebGLRenderer} renderer
 * @param {string} id  HDRI id
 */
export function getEnvFor(renderer, id) {
  if (!id || !renderer) return null;
  let m = envCache.get(renderer);
  if (!m) { m = new Map(); envCache.set(renderer, m); }
  if (m.has(id)) return m.get(id);
  const tex = hdriCache.get(id);
  if (!tex) return null;
  try {
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const env = pmrem.fromEquirectangular(tex).texture;
    pmrem.dispose();
    const item = { env, background: tex };
    m.set(id, item);
    return item;
  } catch (_) { return null; }
}

/* ── 外观状态（**单一数据源**，PIP 和出图共用） ──────────────────────── */
/* 注意：lookState 惰性初始化 —— defaultLook() 依赖文件后面的 REAL_LOOK_PRESETS，
 *   在模块顶层直接调用会撞 TDZ（ReferenceError）。 */
let lookState = null;
let realOn = false;

export function getLook() {
  if (!lookState) lookState = defaultLook();
  return lookState;
}
export function setLook(l) {
  lookState = Object.assign({}, getLook(), l || {});
  return lookState;
}
export function isReal() { return realOn; }
export function setReal(v) { realOn = !!v; return realOn; }

/**
 * ★ 用当前外观给**某个 renderer 的渲染过程**套上真实感，渲完还原。
 * 出图（captureThumb / renderFromCamera）和成片预览共用这一条。
 * @returns {Function|null} restore
 */
export function applyCurrent(scene, editor, renderer) {
  if (!realOn) return null;
  const look = lookState;
  const env = look.hdri ? getEnvFor(renderer, look.hdri) : null;
  // ★ PBR 贴图组是**纹理对象**，不能进 localStorage —— 放模块内存（pbrSets）里。
  //   ★ 而且**必须看开关**：不然关掉 PBR 贴图组还在，就会一直生效（实测：关了和开着出图一模一样）。
  const pbrOn = !!(look.pbr && look.pbr.on);
  try {
    const restore = applyRealLook(THREE, scene, editor, look, renderer, env);
    // 探针：这次套用命中了多少个 PBR 材质（测试直接读这个，别靠看图猜）
    window.__ovfLookProbe = Object.assign({ pbrOn: pbrOn, hasSets: !!pbrSets }, window.__ovfLookProbe || {});
    return restore;
  } catch (_) { return null; }
}

/** 取 HDRI 清单（给面板用） */
export async function fetchHdriList() {
  try {
    const r = await fetch('http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/hdri/list');
    const j = await r.json();
    return (j && j.items) || [];
  } catch (_) { return []; }
}

/**
 * 出图时的调色参数（和 PIP 用同一份 look.grade）。
 * PIP 里算过一次，这里给出同样的公式，保证**预览和成片一致**。
 */
export function gradeForLook(look) {
  const lg = (look && look.grade) || {};
  return {
    contrast: Number(lg.contrast != null ? lg.contrast : 1),
    saturation: Number(lg.saturation != null ? lg.saturation : 1) * (1 + Number(lg.vibrance || 0) * 0.55),
    vignette: Number(lg.vignette != null ? lg.vignette : 0),
    warmth: Math.max(0, Math.min(1, 0.45 + Number(lg.warm || 0) * 3.2)),
    bloom: 0.42,
    letterbox: null,
  };
}

// 暴露给 editor.js（出图管线要用同一套外观 + 调色）
window.__ovfRealLook = {
  getLook, setLook, isReal, setReal, getEnvFor,
  applyCurrent, applyRealLook, gradeForLook, fetchHdriList, loadHdriTexture,
  preparePbr,
};
/* ── 外观预设 ────────────────────────────────────────────────────────── */
export const REAL_LOOK_PRESETS = [
  {
    id: 'daylight', name: '晴天户外',
    sky: { top: '#3f7fd0', mid: '#9cc2e6', bottom: '#f2e8d6' },
    light: { intensity: 2.0, color: '#fff2dc', hemi: 0.9, skyColor: '#9cc2e6', groundColor: '#b09a78' },
    material: { roughness: 0.78, metalness: 0.04, useColor: false },
    grade: { contrast: 1.06, saturation: 1.22, vibrance: 0.35, vignette: 0.22, warm: 0.06 },
    exposure: 1.05,
  },
  {
    id: 'golden', name: '黄昏金光',
    sky: { top: '#2f5f9e', mid: '#e0a886', bottom: '#ffcf8f' },
    light: { intensity: 2.2, color: '#ffbe72', hemi: 0.6, skyColor: '#7f9fd0', groundColor: '#8a6a44' },
    material: { roughness: 0.66, metalness: 0.06, useColor: false },
    grade: { contrast: 1.08, saturation: 1.3, vibrance: 0.45, vignette: 0.3, warm: 0.16 },
    exposure: 1.12,
  },
  {
    id: 'overcast', name: '阴天柔光',
    sky: { top: '#9aa8b4', mid: '#c2ccd4', bottom: '#dfe2e0' },
    light: { intensity: 1.15, color: '#eef2f6', hemi: 1.5, skyColor: '#c2ccd4', groundColor: '#8e8a82' },
    material: { roughness: 0.82, metalness: 0.02, useColor: false },
    grade: { contrast: 1.0, saturation: 1.05, vibrance: 0.15, vignette: 0.12, warm: -0.02 },
    exposure: 1.0,
  },
  {
    id: 'showroom', name: '影棚硬光',
    sky: { top: '#1a1c22', mid: '#2e323c', bottom: '#4a4e58' },
    light: { intensity: 2.6, color: '#fff6ea', hemi: 0.28, skyColor: '#5a6070', groundColor: '#3a3a3a' },
    material: { roughness: 0.32, metalness: 0.25, useColor: false },
    grade: { contrast: 1.12, saturation: 1.18, vibrance: 0.3, vignette: 0.38, warm: 0.04 },
    exposure: 1.15,
  },
  {
    id: 'night', name: '夜晚霓虹',
    sky: { top: '#070a16', mid: '#141a33', bottom: '#2a2340' },
    light: { intensity: 0.42, color: '#b9c8ff', hemi: 0.55, skyColor: '#2f3a63', groundColor: '#141821' },
    material: { roughness: 0.4, metalness: 0.3, useColor: false },
    grade: { contrast: 1.16, saturation: 1.35, vibrance: 0.5, vignette: 0.45, warm: -0.05 },
    exposure: 1.3,
  },
];

/** 默认外观 */
export function defaultLook() {
  const p = REAL_LOOK_PRESETS[0];
  return JSON.parse(JSON.stringify({
    preset: p.id,
    sky: p.sky,
    light: p.light,
    material: p.material,
    grade: p.grade,
    exposure: p.exposure,
    hdri: null,
    hdriBg: true,      // HDRI 是否也当背景
    proc: { on: false },// 程序化三平面材质
  }));
}
