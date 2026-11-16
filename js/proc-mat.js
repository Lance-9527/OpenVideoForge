/* ============================================================================
 * js/proc-mat.js —— 程序化材质 + 三平面投影（world-space triplanar）
 *
 * ★ 为什么不用 PBR 贴图库（2026-11-08 评估后的结论）：
 *   项目里的几何体**基本没有 UV** ——
 *     · 真实世界的楼：osm.js 的 extrudePolygons 是**手写 BufferGeometry**，没有 uv 属性
 *     · 城市楼：city.js 是 BoxGeometry 的 InstancedMesh，UV 是每面 0..1（贴上去满城重复）
 *     · 内置资产：球/盒/柱/锥，每面 0..1（贴树皮到球上 = 条纹）
 *     · 地面：PlaneGeometry，整张 0..1
 *   只有**导入的 GLB** 有正经 UV。
 *
 *   ⇒ 贴图库在当前项目几乎没有落点。
 *   ⇒ **三平面投影**绕开 UV：按世界坐标从三个方向采样同一张图，
 *     不管模型有没有 UV、贴上去都不会拉花，比例也天然一致（1 图元 = 1 米）。
 *
 * 附带好处：**零下载、零版权、零磁盘**。贴图是用 canvas 现场画出来的。
 * ========================================================================== */

/* ── 程序化贴图（canvas 现场生成） ───────────────────────────────────── */

/** 确定性伪随机（同一个 kind 每次画出来一样） */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function noiseFill(ctx, w, h, base, amp, seed, grain) {
  const r = rng(seed);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [br, bg, bb] = base;
  for (let i = 0; i < d.length; i += 4) {
    const n = (r() - 0.5) * amp + (grain ? (r() - 0.5) * grain : 0);
    d[i] = Math.max(0, Math.min(255, br + n));
    d[i + 1] = Math.max(0, Math.min(255, bg + n));
    d[i + 2] = Math.max(0, Math.min(255, bb + n));
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function hex2rgb(h) {
  const n = parseInt(String(h).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** 各 kinds 的画法 */
const DRAW = {
  brick(ctx, S) {
    ctx.fillStyle = '#9a8f80'; ctx.fillRect(0, 0, S, S);           // 灰缝
    const bh = S / 16, bw = S / 8;
    const r = rng(11);
    for (let row = 0; row < 16; row++) {
      const off = (row % 2) ? bw / 2 : 0;
      for (let col = -1; col < 9; col++) {
        const x = col * bw + off, y = row * bh;
        const t = r();
        const c = t < 0.18 ? '#8f4a38' : t < 0.42 ? '#a85a42' : t < 0.72 ? '#b5714a' : '#c08258';
        ctx.fillStyle = c;
        ctx.fillRect(x + 1.5, y + 1.5, bw - 3, bh - 3);
        // 砖面纹理
        ctx.fillStyle = 'rgba(0,0,0,0.07)';
        for (let k = 0; k < 5; k++) ctx.fillRect(x + 2 + r() * (bw - 6), y + 2 + r() * (bh - 6), 2 + r() * 4, 1.5);
      }
    }
    noiseFill(ctx, S, S, [150, 140, 125], 16, 3, 8);
  },
  concrete(ctx, S) {
    noiseFill(ctx, S, S, hex2rgb('#b9b4aa'), 26, 7, 10);
    const r = rng(21);
    ctx.globalAlpha = 0.16;
    for (let i = 0; i < 90; i++) {
      ctx.fillStyle = r() > 0.5 ? '#ffffff' : '#8d8880';
      const rr = 1 + r() * 3.5;
      ctx.beginPath(); ctx.arc(r() * S, r() * S, rr, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
  asphalt(ctx, S) {
    // ★ 沥青别画太黑 —— 深色材质在 ACES 下会压成一片死黑，纹理全看不见
    noiseFill(ctx, S, S, hex2rgb('#6a6d73'), 30, 5, 18);
    const r = rng(31);
    for (let i = 0; i < 1400; i++) {
      ctx.fillStyle = r() > 0.55 ? 'rgba(186,190,198,0.42)' : 'rgba(44,46,52,0.4)';
      ctx.fillRect(r() * S, r() * S, 1 + r() * 2.6, 1 + r() * 2.6);
    }
    // 几道裂纹
    ctx.strokeStyle = 'rgba(40,42,48,0.5)'; ctx.lineWidth = 1.6;
    for (let i = 0; i < 5; i++) {
      ctx.beginPath();
      let x = r() * S, y = r() * S;
      ctx.moveTo(x, y);
      for (let k = 0; k < 5; k++) { x += (r() - 0.5) * S * 0.3; y += (r() - 0.5) * S * 0.3; ctx.lineTo(x, y); }
      ctx.stroke();
    }
  },
  grass(ctx, S) {
    noiseFill(ctx, S, S, hex2rgb('#5f8a40'), 30, 13, 16);
    const r = rng(41);
    for (let i = 0; i < 1600; i++) {
      const g = r();
      ctx.strokeStyle = g > 0.62 ? 'rgba(126,168,74,0.5)' : 'rgba(56,92,34,0.45)';
      ctx.lineWidth = 1;
      const x = r() * S, y = r() * S;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + (r() - 0.5) * 4, y - 2 - r() * 4); ctx.stroke();
    }
  },
  wood(ctx, S) {
    const r = rng(53);
    ctx.fillStyle = '#a9763f'; ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 150; i++) {
      const y = r() * S;
      ctx.strokeStyle = `rgba(${90 + r() * 40},${60 + r() * 30},${30 + r() * 20},${0.12 + r() * 0.2})`;
      ctx.lineWidth = 0.6 + r() * 2.4;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(S * 0.3, y + (r() - 0.5) * 14, S * 0.7, y + (r() - 0.5) * 14, S, y + (r() - 0.5) * 8);
      ctx.stroke();
    }
    // 板缝
    ctx.strokeStyle = 'rgba(60,38,20,0.55)'; ctx.lineWidth = 2;
    for (let i = 1; i < 5; i++) { ctx.beginPath(); ctx.moveTo(0, S * i / 5); ctx.lineTo(S, S * i / 5); ctx.stroke(); }
  },
  woodplank(ctx, S) {
    const r = rng(67);
    ctx.fillStyle = '#b58a52'; ctx.fillRect(0, 0, S, S);
    const ph = S / 6;
    for (let i = 0; i < 6; i++) {
      const t = 0.8 + r() * 0.4;
      ctx.fillStyle = `rgb(${Math.min(255, 181 * t)},${Math.min(255, 138 * t)},${Math.min(255, 82 * t)})`;
      ctx.fillRect(0, i * ph, S, ph - 2);
      for (let k = 0; k < 26; k++) {
        ctx.strokeStyle = `rgba(90,60,30,${0.08 + r() * 0.14})`;
        ctx.lineWidth = 0.8 + r();
        const y = i * ph + r() * ph;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y + (r() - 0.5) * 5); ctx.stroke();
      }
    }
  },
  marble(ctx, S) {
    noiseFill(ctx, S, S, hex2rgb('#e8e4dc'), 12, 83, 4);
    const r = rng(97);
    for (let v = 0; v < 26; v++) {
      ctx.strokeStyle = `rgba(${120 + r() * 50},${118 + r() * 46},${112 + r() * 40},${0.18 + r() * 0.3})`;
      ctx.lineWidth = 0.7 + r() * 2.6;
      ctx.beginPath();
      let x = r() * S, y = r() * S;
      ctx.moveTo(x, y);
      for (let k = 0; k < 6; k++) {
        x += (r() - 0.5) * S * 0.4; y += (r() - 0.5) * S * 0.4;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  },
  sand(ctx, S) {
    noiseFill(ctx, S, S, hex2rgb('#cbb189'), 22, 101, 12);
    const r = rng(103);
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = r() > 0.5 ? 'rgba(210,190,150,0.3)' : 'rgba(140,118,84,0.25)';
      ctx.fillRect(r() * S, r() * S, 1 + r() * 1.8, 1 + r() * 1.8);
    }
  },
  metal(ctx, S) {
    const g = ctx.createLinearGradient(0, 0, 0, S);
    g.addColorStop(0, '#9aa2ab'); g.addColorStop(0.5, '#c3cad1'); g.addColorStop(1, '#8b939c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = 'rgba(60,66,74,0.4)'; ctx.lineWidth = 2;
    for (let i = 1; i < 10; i++) { ctx.beginPath(); ctx.moveTo(0, S * i / 10); ctx.lineTo(S, S * i / 10); ctx.stroke(); }
  },
  fabric(ctx, S) {
    noiseFill(ctx, S, S, hex2rgb('#8d8a83'), 18, 109, 20);
    ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
    for (let i = 0; i < S; i += 3) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, S); ctx.stroke(); }
  },
  plaster(ctx, S) {
    noiseFill(ctx, S, S, hex2rgb('#e6dfd2'), 14, 109, 8);
    const r = rng(111);
    ctx.globalAlpha = 0.1;
    for (let i = 0; i < 40; i++) {
      ctx.fillStyle = r() > 0.5 ? '#ffffff' : '#c9c2b4';
      ctx.beginPath(); ctx.arc(r() * S, r() * S, 2 + r() * 7, 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  },
  water(ctx, S) {
    const g = ctx.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, '#2f6f96'); g.addColorStop(0.5, '#4a8fb5'); g.addColorStop(1, '#2a6288');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
    const r = rng(127);
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 1.4;
    for (let i = 0; i < 40; i++) {
      const y = r() * S;
      ctx.beginPath(); ctx.moveTo(0, y);
      ctx.bezierCurveTo(S * 0.3, y + (r() - 0.5) * 18, S * 0.7, y + (r() - 0.5) * 18, S, y + (r() - 0.5) * 10);
      ctx.stroke();
    }
  },
};

export const PROC_KINDS = Object.keys(DRAW);

const texCache = new Map();

/** 生成一张程序化贴图（缓存） */
export function makeProcTexture(THREE, kind, size = 512) {
  const key = kind + '@' + size;
  if (texCache.has(key)) return texCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const fn = DRAW[kind] || DRAW.concrete;
  fn(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  texCache.set(key, tex);
  return tex;
}

/* ── 三平面投影注入 ─────────────────────────────────────────────────── */

/**
 * 给材质打上**世界坐标三平面投影**。
 *
 * 原理：不用模型 UV，而是拿片元在世界空间的坐标，分别投到 XZ / YZ / XY 三个平面上
 * 采样同一张图，再按法线的三个分量加权混合。
 *   ⇒ 不管模型有没有 UV，贴上去都不会拉花
 *   ⇒ 比例天然一致：scale = 0.25 意思是 1 张图铺 4 米
 *
 * @param {THREE.Material} mat  要改的材质（一般是新建的副本）
 * @param {THREE.Texture} tex  程序化贴图
 * @param {number} scale       每米重复次数的倒数（0.25 = 4 米一张）
 * @param {number} strength    与底色的混合强度 0..1
 */
export function triplanarPatch(THREE, mat, tex, scale = 0.25, strength = 1, tint = 1) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uOvTex = { value: tex };
    shader.uniforms.uOvScale = { value: scale };
    shader.uniforms.uOvStrength = { value: strength };
    shader.uniforms.uOvTint = { value: tint };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vOvWorldPos;
        varying vec3 vOvWorldNrm;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vOvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vOvWorldNrm = normalize(mat3(modelMatrix) * objectNormal);`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vOvWorldPos;
        varying vec3 vOvWorldNrm;
        uniform sampler2D uOvTex;
        uniform float uOvScale;
        uniform float uOvStrength;
        uniform float uOvTint;`)
      .replace('#include <map_fragment>', `
        {
          vec3 bw = pow(abs(normalize(vOvWorldNrm)), vec3(4.0));
          bw /= max(bw.x + bw.y + bw.z, 1e-4);
          vec3 wp = vOvWorldPos * uOvScale;
          vec4 tx = texture2D(uOvTex, wp.zy);
          vec4 ty = texture2D(uOvTex, wp.xz);
          vec4 tz = texture2D(uOvTex, wp.xy);
          vec4 tri = tx * bw.x + ty * bw.y + tz * bw.z;
          // ★ 贴图**直接当 albedo**（不是跟底色相乘）——
          //   相乘的话深色材质（比如沥青 #55585e × 深灰贴图）会被压两次，
          //   结果一整片死黑，什么纹理都看不出来。
          diffuseColor.rgb = mix(diffuseColor.rgb, tri.rgb * uOvTint, uOvStrength);
        }`);
  };
  // 让 three 认为材质需要重编译
  mat.customProgramCacheKey = () => 'ovf-triplanar';
  mat.needsUpdate = true;
  return mat;
}

/* ── 角色 → 程序化材质映射 ──────────────────────────────────────────── */
/**
 * 环境网格按角色的程序化贴图。
 * （角色判定在 real-look.js 的 classifyEnvMesh 里）
 */
export const PROC_BY_ROLE = {
  ground:   { kind: 'grass',    scale: 0.12, strength: 1,    tint: 1.0, color: '#7fa055' },
  road:     { kind: 'asphalt',  scale: 0.35, strength: 1,    tint: 1.0, color: '#6a6d73' },
  lane:     { kind: 'concrete', scale: 0.5,  strength: 0.9,  tint: 1.6, color: '#e6e3d8' },
  sidewalk: { kind: 'concrete', scale: 0.35, strength: 1,    tint: 1.0, color: '#bcb8ac' },
  wood:     { kind: 'woodplank', scale: 0.5, strength: 1,    tint: 1.0, color: '#b58a52' },
  wall:     { kind: 'plaster',  scale: 0.5,  strength: 0.85, tint: 1.0, color: '#e6dfd2' },
  building: { kind: 'brick',    scale: 0.22, strength: 1,    tint: 1.0, color: '#c9c2b4' },
  green:    { kind: 'grass',    scale: 0.18, strength: 1,    tint: 1.0, color: '#6f9b46' },
  water:    { kind: 'water',    scale: 0.2,  strength: 0.85, tint: 1.0, color: '#3f7fa8' },
  terrain:  { kind: 'grass',    scale: 0.09, strength: 0.95, tint: 1.0, color: '#7d8f5a' },
  interior: { kind: 'plaster',  scale: 0.5,  strength: 0.8,  tint: 1.0, color: '#e2dbcd' },
  neutral:  { kind: 'concrete', scale: 0.4,  strength: 0.9,  tint: 1.0, color: '#cfc9bb' },
};

