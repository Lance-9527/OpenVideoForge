/* ============================================================================
 * js/thumb.js —— 缩略图渲染（离屏 WebGL）
 *
 * ★ 2026-11-08：资产库的卡片以前只能显示「模型/场景/材质」几个字，
 *   库里到底有什么根本认不出来。这一轮补上缩略图。
 *
 * 为什么在页面里渲染：服务端（node）没有 WebGL，渲不了 3D。
 *   页面有 —— 所以流程是「页面渲染 → PNG → 送回服务端落盘」。
 *
 * 复用一个 renderer：每次 new WebGLRenderer 都新建一个 GL 上下文，
 *   开太多浏览器会卡（上限 16 个左右）。
 * ========================================================================== */
import * as THREE from 'three';

let renderer = null;
let scene = null;
let cam = null;
let lights = [];

function ensure() {
  if (renderer) return renderer;
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(1);
  renderer.shadowMap.enabled = false;
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0xefece4);
  cam = new THREE.PerspectiveCamera(30, 1, 0.05, 400);
  cam.position.set(5, 4.2, 5);
  cam.lookAt(0, 0, 0);
  const hemi = new THREE.HemisphereLight(0xffffff, 0xb8b0a0, 1.25);
  const key = new THREE.DirectionalLight(0xfff6e8, 1.35);
  key.position.set(6, 10, 6);
  const fill = new THREE.DirectionalLight(0xdce8ff, 0.45);
  fill.position.set(-6, 4, -4);
  scene.add(hemi, key, fill);
  lights = [hemi, key, fill];
  return renderer;
}

/**
 * 给一个 Object3D 渲染缩略图。
 * @param {THREE.Object3D} obj   要拍的物体（内部会克隆，不动原件）
 * @param {number} size          边长（像素）
 * @param {object} opt           { bg } 背景色
 * @returns {string|null} dataURL
 */
export function renderThumbOf(obj, size = 256, opt = {}) {
  if (!obj) return null;
  let r;
  try { r = ensure(); } catch (_) { return null; }
  if (!r) return null;
  r.setSize(size, size, false);
  if (opt.bg) scene.background = new THREE.Color(opt.bg);

  // ★ 用 wrapper 做缩放/居中，**不要**动 clone 自己的 position。
  //   GLB 导出的根节点常带 rotation / offset，直接 `clone.position.sub(center)`
  //   会在世界坐标系里减一个局部坐标 —— 结果就是"只拍到半个模型"
  //   （实测：轿车只露一角、树只露树冠）。
  const clone = obj.clone(true);
  const wrap = new THREE.Group();
  wrap.add(clone);
  scene.add(wrap);

  const b = new THREE.Box3().setFromObject(clone);
  const s = b.getSize(new THREE.Vector3());
  const c = b.getCenter(new THREE.Vector3());
  const k = 2.0 / Math.max(s.x, s.y, s.z, 0.001);
  wrap.scale.setScalar(k);
  // 缩放后包围盒中心 = wrap.position + k * c ⇒ 令 wrap.position = -k*c 即居中
  wrap.position.set(-c.x * k, -c.y * k, -c.z * k);
  wrap.updateMatrixWorld(true);

  let url = null;
  try {
    r.render(scene, cam);
    url = r.domElement.toDataURL('image/png');
  } catch (_) { url = null; }
  scene.remove(wrap);
  // ★ **不要 dispose geometry** —— clone(true) 与原物体共享 geometry，
  //   dispose 掉会把场景里那个模型毁掉（物体直接消失）。
  //   克隆出来的 mesh 只是从场景里摘掉，GPU 资源还归原物体，继续复用。
  return url;
}

/**
 * 渲染一个**资产库里的 GLB**的缩略图，并送回服务端落盘。
 * @param {string} id     资产库 id
 * @param {number} port   桥端口
 * @returns {Promise<boolean>} 有没有成功
 */
export async function renderThumbForLibrary(id, port = 8787) {
  if (!id) return false;
  const base = 'http://127.0.0.1:' + port;
  try {
    const { GLTFLoader } = await import('./vendor/GLTFLoader.js?v=76');
    const loader = new GLTFLoader();
    const url = base + '/library/file/' + encodeURIComponent(id);
    const gltf = await loader.loadAsync(url);
    const thumb = renderThumbOf(gltf.scene, 256);
    if (!thumb) return false;
    const r = await fetch(base + '/library/thumb/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: thumb }),
    });
    const j = await r.json();
    return !!(j && j.ok);
  } catch (e) {
    console.warn('[thumb] 生成失败', id, e && e.message);
    return false;
  }
}

/** 缩略图的 URL（资产库条目用）：服务端存的是相对路径，这里用 id 拼绝对地址 */
export function libraryThumbUrl(item, port = 8787) {
  if (!item || !item.thumb) return null;
  if (/^https?:/i.test(item.thumb)) return item.thumb;      // 已经是完整 URL
  if (/^data:/i.test(item.thumb)) return item.thumb;         // 内联 dataURL
  return 'http://127.0.0.1:' + port + '/library/thumb/' + encodeURIComponent(item.id);
}

// 暴露给 editor.js（它要渲「当前选中物体」的缩略图，共用同一个 renderer）
window.__ovfThumb = { renderThumbOf, renderThumbForLibrary, libraryThumbUrl };
