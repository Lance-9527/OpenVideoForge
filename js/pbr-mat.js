/* ============================================================================
 * js/pbr-mat.js —— 真实 **PBR 贴图** 材质（ambientCG CC0）
 *
 * ★ 2026-11-09：之前"真实感"用的是**程序化假纹理**（canvas 画的）——
 *   看着像那么回事，但不是真照片。现在把 **ambientCG 的真 PBR 贴图**
 *   接进来（CC0 = 公共领域，随便用）。
 *
 * 为什么能接进去：
 *   我们的世界几何**大多没有 UV**（程序化生成的楼、路、地）。
 *   所以用**三平面投影**（world-space）：按法线方向在 XZ/YZ/XY 三个平面上采样，
 *   按法线权重混合 —— **不需要 UV**。
 *
 * 贴图集（每个材质包）：
 *   Color（albedo）· NormalGL · Roughness · AmbientOcclusion · Displacement
 * ========================================================================== */
import * as THREE from 'three';

const BRIDGE = () => 'http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787);

/* ── 素材清单 ───────────────────────────────────────────────────────── */
let pbrIndex = null;          // { items: [...] }
const texCache = new Map();   // key → { map, normalMap, roughnessMap, aoMap, ... }

/** 拉 PBR 素材清单 */
export async function loadPbrIndex() {
  if (pbrIndex) return pbrIndex;
  try {
    const r = await fetch(BRIDGE() + '/pbr/list');
    const j = await r.json();
    pbrIndex = j || { items: [] };
  } catch (_) { pbrIndex = { items: [] }; }
  return pbrIndex;
}

/** 取某个材质的贴图组（浏览器会缓存） */
export async function loadPbrTextures(id) {
  if (texCache.has(id)) return texCache.get(id);
  const idx = await loadPbrIndex();
  const rec = (idx.items || []).find((i) => i.id === id);
  if (!rec) return null;

  const loader = new THREE.TextureLoader();
  const base = BRIDGE() + '/pbr/file/' + encodeURIComponent(id) + '/';
  const load = (file, srgb) => new Promise((resolve) => {
    if (!file) { resolve(null); return; }
    loader.load(base + encodeURIComponent(file), (t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 8;
      if (srgb) t.colorSpace = THREE.SRGBColorSpace;
      resolve(t);
    }, undefined, () => resolve(null));
  });

  const set = {
    map: await load(rec.maps && rec.maps.albedo, true),
    normalMap: await load(rec.maps && rec.maps.normal, false),
    roughnessMap: await load(rec.maps && rec.maps.roughness, false),
    aoMap: await load(rec.maps && rec.maps.ao, false),
    displacementMap: await load(rec.maps && rec.maps.displacement, false),
    id: rec.id,
    name: rec.name,
    label: rec.label,
  };
  texCache.set(id, set);
  return set;
}

/* ── 三平面 PBR 注入 ────────────────────────────────────────────────── */

/**
 * 把一个材质改成**三平面 PBR**。
 *
 * 做三件事（都用 onBeforeCompile 注入，不改 three.js 源码）：
 *   ① albedo：按世界坐标三平面采样（不需要 UV）
 *   ② 法线：把贴图法线转成世界法线再按三平面混合（让凹凸真的立体）
 *   ③ 粗糙度：同样三平面采样
 *
 * @param {THREE.Material} mat
 * @param {object} texSet  loadPbrTextures 的返回
 * @param {number} scale   贴图重复次数（1 = 一个单位贴一次）
 * @param {number} strength 凹凸强度
 * @param {string} [tint]  底色（部件色）
 * @param {number} [tintMix] 0 = 纯贴图；1 = 底色主导（贴图只留细节）
 */
export function pbrPatch(mat, texSet, scale = 1, strength = 1, tint = null, tintMix = 0) {
  if (!mat || !texSet || !texSet.map) return mat;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader) => {
    if (prev) prev(shader);
    shader.uniforms.uOvPbrScale = { value: scale };
    shader.uniforms.uOvBumpStrength = { value: strength };
    shader.uniforms.uOvTintMix = { value: tintMix };
    shader.uniforms.uOvHasNormal = { value: texSet.normalMap ? 1 : 0 };
    shader.uniforms.uOvHasRough = { value: texSet.roughnessMap ? 1 : 0 };
    if (texSet.normalMap) shader.uniforms.uOvNormalMap = { value: texSet.normalMap };
    if (texSet.roughnessMap) shader.uniforms.uOvRoughMap = { value: texSet.roughnessMap };

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vOvPbrPos;
        varying vec3 vOvPbrNrm;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 ovWp = modelMatrix * vec4( transformed, 1.0 );
        vOvPbrPos = ovWp.xyz;
        vOvPbrNrm = normalize( mat3( modelMatrix ) * objectNormal );`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uOvPbrScale;
        uniform float uOvBumpStrength;
        uniform float uOvTintMix;
        uniform float uOvHasNormal;
        uniform float uOvHasRough;
        uniform sampler2D uOvNormalMap;
        uniform sampler2D uOvRoughMap;
        varying vec3 vOvPbrPos;
        varying vec3 vOvPbrNrm;

        // 三平面采样：按法线权重在三个平面上采
        vec4 ovTriplanar( sampler2D tex, vec3 p, vec3 n, float s ) {
          vec3 w = pow( abs( n ), vec3( 4.0 ) );
          w /= max( w.x + w.y + w.z, 1e-4 );
          vec4 cx = texture2D( tex, p.zy * s );
          vec4 cy = texture2D( tex, p.xz * s );
          vec4 cz = texture2D( tex, p.xy * s );
          return cx * w.x + cy * w.y + cz * w.z;
        }`)
      .replace('#include <map_fragment>', `
        vec4 ovTex = ovTriplanar( map, vOvPbrPos, normalize( vOvPbrNrm ), uOvPbrScale );
        // tintMix: 0 = 纯贴图；1 = 底色主导（贴图只留细节）
        vec3 ovBase = diffuseColor.rgb;
        vec3 ovTexRgb = ovTex.rgb;
        diffuseColor.rgb = mix( ovTexRgb, ovTexRgb * ovBase * 1.7, uOvTintMix );`)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness;
        #if defined( USE_ROUGHNESSMAP ) || 1
        if ( uOvHasRough > 0.5 ) {
          vec4 ovR = ovTriplanar( uOvRoughMap, vOvPbrPos, normalize( vOvPbrNrm ), uOvPbrScale );
          roughnessFactor = roughness * ovR.g;
        }
        #endif`)
      .replace('#include <normal_fragment_maps>', `
        #include <normal_fragment_maps>
        if ( uOvHasNormal > 0.5 ) {
          vec3 ovN = normalize( vOvPbrNrm );
          vec4 ovNT = ovTriplanar( uOvNormalMap, vOvPbrPos, ovN, uOvPbrScale );
          vec3 ovT = ovNT.xyz * 2.0 - 1.0;
          // 切线空间 → 世界空间（无 UV，用三平面近似的正交基）
          vec3 ovUp = abs( ovN.y ) < 0.99 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
          vec3 ovT1 = normalize( cross( ovUp, ovN ) );
          vec3 ovT2 = cross( ovN, ovT1 );
          vec3 ovWN = normalize( ovT1 * ovT.x + ovT2 * ovT.y + ovN * ovT.z );
          normal = normalize( mix( normal, ovWN, uOvBumpStrength ) );
        }`);
  };
  mat.needsUpdate = true;
  // 让 three.js 知道要采 map（否则 map_fragment 可能被剔除）
  if (!mat.map) { mat.map = texSet.map; }
  return mat;
}

/**
 * 按角色名挑一个 PBR 材质（比如 'ground' → 草地质感）。
 * @returns {object|null} { id, name, label }
 */
export async function pickPbrForRole(role, preferId) {
  const idx = await loadPbrIndex();
  const items = idx.items || [];
  if (preferId) {
    const hit = items.find((i) => i.id === preferId);
    if (hit) return hit;
  }
  const byRole = items.find((i) => i.role === role);
  return byRole || items[0] || null;
}

/** 素材清单（给 UI 用） */
export async function pbrList() {
  const idx = await loadPbrIndex();
  return idx.items || [];
}
