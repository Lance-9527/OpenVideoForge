/* ============================================================================
 * js/studio-csm.js —— 级联阴影（CSM）
 *
 * ★ 2026-11-09：解决「大世界远处没影子」的问题。
 *
 * 之前只有**一张** 2048² 阴影图，阴影相机 ±32m（large 档 ±640m）。
 * 640m 分到 2048² ⇒ 每个 texel 0.31m ⇒ 近处糊、远处够但浪费。
 *
 * CSM（three.js 官方 addon，MIT）把视锥按距离切成 3 段，
 * 每段一张阴影图 ⇒ 近处细、远处也覆盖。
 *
 * 关键约束（踩过的坑）：
 *   ① `csm.setupMaterial(mat)` 会**覆盖** mat.onBeforeCompile。
 *      我们的三平面 / PBR 材质也用 onBeforeCompile ⇒ 必须**包一层**保留。
 *   ② 材质是**临时创建**的（applyRealLook 每次新建）⇒ 每次都要补 setupMaterial，
 *      否则临时材质没有 CSM 阴影 ⇒ 预览里阴影突然消失。
 *   ③ CSMShader 会**全局替换** ShaderChunk.lights_fragment_begin ——
 *      但有 `#if defined(USE_CSM)` 守卫，没设 define 的材质不受影响。
 * ========================================================================== */
import * as THREE from 'three';

let CSMClass = null;

/** 懒加载 CSM 类（vendor 里是 three.js 官方 addon） */
async function loadCSM() {
  if (CSMClass) return CSMClass;
  const mod = await import('./vendor/csm/CSM.js?v=76');
  CSMClass = mod.CSM;
  return CSMClass;
}

/**
 * 在编辑器上装一套 CSM。
 * @param {object} editor  EditorApp 实例
 * @param {object} opt     { cascades, shadowMapSize, maxFar }
 * @returns {Promise<object|null>} csm
 */
export async function enableCsm(editor, opt = {}) {
  if (editor.csm) return editor.csm;
  const CSM = await loadCSM();
  const cam = editor.camera;
  const sun = editor.sun;
  if (!cam || !sun) return null;

  const dir = editor._sunDir ? editor._sunDir.clone()
    : new THREE.Vector3(0.4, -1, 0.3).normalize();

  const csm = new CSM({
    camera: cam,
    parent: editor.scene,
    cascades: opt.cascades || 3,
    maxFar: opt.maxFar || cam.far,
    shadowMapSize: opt.shadowMapSize || 2048,
    lightDirection: dir.clone().negate(),   // CSM 的 lightDirection 是「光来的方向」
    lightIntensity: sun.intensity || 1,
    lightNear: 1,
    lightFar: 4000,
    lightMargin: 200,
    fade: false,
  });

  editor.csm = csm;
  // 原 sun 让位（CSM 自己有 cascades 盏灯）
  editor._sunBackup = { visible: sun.visible, intensity: sun.intensity };
  sun.visible = false;
  editor._csmSetupAll();
  return csm;
}

/** 关掉 CSM，恢复原来的单光源 */
export function disableCsm(editor) {
  if (!editor || !editor.csm) return false;
  try { editor.csm.remove(); } catch (_) { /* 忽略 */ }
  try { editor.csm.dispose(); } catch (_) { /* 忽略 */ }
  editor.csm = null;
  if (editor.sun && editor._sunBackup) {
    editor.sun.visible = editor._sunBackup.visible;
    editor.sun.intensity = editor._sunBackup.intensity;
  }
  editor._sunBackup = null;
  // 材质上的 define 得去掉，否则还在走 CSM 分支（但灯没了 → 全黑）
  editor.scene.traverse((o) => {
    if (!o.material) return;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      if (m.defines && m.defines.USE_CSM) {
        delete m.defines.USE_CSM;
        delete m.defines.CSM_CASCADES;
        m.needsUpdate = true;
      }
    }
  });
  return true;
}

/**
 * 给材质装 CSM 支持（**保留已有的 onBeforeCompile**）。
 * @param {THREE.Material} mat
 */
export function setupMaterial(editor, mat) {
  if (!editor || !editor.csm || !mat) return mat;
  const prev = mat.onBeforeCompile;
  try { editor.csm.setupMaterial(mat); } catch (_) { return mat; }
  const csmCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = function (shader, renderer) {
    if (csmCompile) csmCompile(shader, renderer);
    // ★ 我们自己的 patch（三平面 / PBR）接在后面 —— 顺序不能反，
    //   否则 CSM 的 uniforms 加不进去。
    if (prev) prev(shader, renderer);
  };
  mat.needsUpdate = true;
  return mat;
}

/** 给场景里所有材质装 CSM（换环境/加载世界后要再跑一次） */
export function setupAll(editor) {
  if (!editor || !editor.csm) return;
  editor.scene.traverse((o) => {
    if (!o.material) return;
    if (Array.isArray(o.material)) o.material.forEach((m) => setupMaterial(editor, m));
    else setupMaterial(editor, o.material);
  });
}

/** 每帧更新（相机动了就要重算 cascade 的阴影相机） */
export function updateCsm(editor) {
  if (!editor || !editor.csm) return;
  try { editor.csm.update(); } catch (_) { /* 忽略 */ }
}

/** 太阳参数变了 → 同步给 CSM 的灯 */
export function syncCsmLight(editor) {
  if (!editor || !editor.csm || !editor.sun) return;
  const dir = editor._sunDir;
  if (dir) editor.csm.lightDirection = dir.clone().negate();
  editor.csm.lightIntensity = editor.sun.intensity || 0;
  for (const l of editor.csm.lights || []) {
    l.intensity = editor.sun.intensity || 0;
    if (editor.sun.color) l.color.copy(editor.sun.color);
  }
}

/**
 * ★ 临时材质（applyRealLook 每次都新建）也要装 CSM ——
 *   否则预览里那些材质没有 CSM 阴影 ⇒ 阴影突然消失。
 */
export function setupMaterialSafe(editor, mat) {
  try { return setupMaterial(editor, mat); } catch (_) { return mat; }
}

// 暴露给 editor.js / real-look.js
window.__ovfCsm = {
  enableCsm, disableCsm, setupMaterial, setupMaterialSafe, setupAll,
  updateCsm, syncCsmLight,
};
