/* ============================================================================
 * js/parts.js —— 模型**分件索引**（"精准 copy 某个地方的某个物体"）
 *
 * ★ 2026-11-09 用户的原话：
 *   「我们需要某个地方取景的时候，直接 copy 到咱们场景来就行」
 *   「甚至是需要某个地方的某个物体都可以直接**精准 copy**」
 *
 * 问题：导出来的 GLB（比如一整个教室）里有几百个 mesh ——
 *   桌子、椅子、黑板、窗、门、灯…… 之前只能整个模型一起放进场景，
 *   没法只拿其中一个。
 *
 * 做法：
 *   ① 加载 GLB 时遍历每个 mesh，记下 名字 / 包围盒 / 世界位置 / 颜色 / 面数
 *   ② 回报给服务端，存进 index.json（parts 字段）
 *   ③ 之后能：按名字搜 → 只把那一个分件放进场景 → 或者复制它
 *
 * 分件名可能重复（"Cube"、"Cube.001"…），
 * 所以每个分件还有个**序号**，定位时用序号最稳。
 * ========================================================================== */
import * as THREE from 'three';

const $ = (s, r) => (r || document).querySelector(s);
const BRIDGE = () => 'http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787);

/** 给一个 mesh 起个人类能读的名字（GLB 里常常是 "Cube.001" 这种） */
function niceName(node, idx) {
  let n = String(node.name || '').trim();
  if (!n) {
    // 往上找有名字的祖先
    let p = node.parent;
    while (p && p !== node.parent && !String(p.name || '').trim()) p = p.parent;
    n = (p && String(p.name || '').trim()) || '';
  }
  if (!n) n = '件' + (idx + 1);
  return n.slice(0, 80);
}

/**
 * 遍历一个已加载的 gltf.scene，产出分件清单。
 * @param {THREE.Object3D} root
 * @returns {Array} [{ i, name, size, pos, color, tris }]
 */
export function indexParts(root) {
  if (!root) return [];
  root.updateMatrixWorld(true);
  const out = [];
  let idx = 0;
  root.traverse((node) => {
    if (!node.isMesh) return;
    let bb = null;
    try {
      node.geometry.computeBoundingBox();
      bb = node.geometry.boundingBox;
    } catch (_) { bb = null; }
    if (!bb) return;
    // 世界包围盒（mesh 可能有非等比缩放/旋转）
    const wb = new THREE.Box3();
    const tmp = new THREE.Box3();
    const g = node.geometry;
    const pos = g.attributes && g.attributes.position;
    if (pos && pos.count) {
      const v = new THREE.Vector3();
      const step = Math.max(1, Math.floor(pos.count / 200));   // 抽样，够了
      for (let i = 0; i < pos.count; i += step) {
        v.fromBufferAttribute(pos, i);
        node.localToWorld(v);
        tmp.expandByPoint(v);
      }
      if (!tmp.isEmpty()) wb.copy(tmp);
    }
    if (wb.isEmpty()) {
      wb.copy(bb);
      node.localToWorld(wb.min); node.localToWorld(wb.max);
    }
    const size = wb.getSize(new THREE.Vector3());
    const pos2 = wb.getCenter(new THREE.Vector3());
    const mat = node.material;
    const m0 = Array.isArray(mat) ? mat[0] : mat;
    let color = '';
    if (m0 && m0.color) color = '#' + m0.color.getHexString();
    const tris = g.index ? Math.floor(g.index.count / 3) : Math.floor((g.attributes.position ? g.attributes.position.count : 0) / 3);
    out.push({
      i: idx,
      name: niceName(node, idx),
      size: [+size.x.toFixed(3), +size.y.toFixed(3), +size.z.toFixed(3)],
      pos: [+pos2.x.toFixed(3), +pos2.y.toFixed(3), +pos2.z.toFixed(3)],
      color,
      tris,
    });
    idx++;
  });
  return out;
}

/**
 * 把分件清单回报给服务端（存进 index.json 的 parts 字段）。
 */
export async function reportParts(id, parts) {
  if (!id || !parts || !parts.length) return false;
  try {
    const r = await fetch(BRIDGE() + '/library/parts/' + encodeURIComponent(id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts }),
    });
    const j = await r.json();
    return !!(j && j.ok);
  } catch (_) { return false; }
}

/**
 * 只从 GLB 里取出**某一个分件**，做成一个独立场景物件。
 * @param {THREE.Object3D} root  已加载的 gltf.scene
 * @param {number} partIndex     分件序号
 * @returns {THREE.Object3D|null}
 */
export function extractPart(root, partIndex) {
  if (!root) return null;
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((n) => { if (n.isMesh) meshes.push(n); });
  const node = meshes[partIndex];
  if (!node) return null;

  const wrap = new THREE.Group();
  const clone = node.clone(true);
  wrap.add(clone);
  // 把分件挪到原点（保留它相对整个模型的偏移？—— 不，挪到原点更符合"拿一个物体"）
  clone.position.set(0, 0, 0);
  clone.quaternion.identity();
  clone.scale.set(1, 1, 1);
  // 但要保留它相对**父级**的变换 —— 用相对矩阵还原
  const rel = new THREE.Matrix4();
  node.updateWorldMatrix(true, false);
  rel.copy(node.matrixWorld).invert();
  // 把克隆件放回原位置，再整体平移，让它的中心落到原点
  wrap.position.set(0, 0, 0);
  wrap.updateMatrixWorld(true);

  // 算分件中心并整体平移
  const bb = new THREE.Box3().setFromObject(wrap);
  if (!bb.isEmpty()) {
    const c = bb.getCenter(new THREE.Vector3());
    wrap.position.sub(c);
  }
  wrap.updateMatrixWorld(true);
  return wrap;
}

/** 从 GLB URL 加载并取出某个分件 */
export async function loadPartFromUrl(url, partIndex) {
  const { GLTFLoader } = await import('./vendor/GLTFLoader.js?v=76');
  const gltf = await new GLTFLoader().loadAsync(url);
  const part = extractPart(gltf.scene, partIndex);
  if (!part) throw new Error('分件 ' + partIndex + ' 不存在（模型里 mesh 数量对不上）');
  return part;
}

/* ── 资产库面板：分件展开 ────────────────────────────────────────────── */

/** 在资产库抽屉里，给模型卡片加分件展开按钮 */
export function renderPartList(item, onPick) {
  const parts = item.parts || [];
  if (!parts.length) return '';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const rows = parts.slice(0, 300).map((p) => `
    <button type="button" class="part-row" data-part="${p.i}" data-lib="${esc(item.id)}"
            title="大小 ${p.size.map((v) => v.toFixed(1)).join('×')}m · 位置 ${p.pos.map((v) => v.toFixed(1)).join(', ')}">
      <span class="part-dot" style="background:${esc(p.color || '#ccc')}"></span>
      <span class="part-name">${esc(p.name)}</span>
      <span class="part-size">${p.size.map((v) => v.toFixed(1)).join('×')}</span>
    </button>`).join('');
  return `<div class="part-list" data-parts="${esc(item.id)}">${rows}</div>`;
}
