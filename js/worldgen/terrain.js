/* ============================================================================
 * js/worldgen/terrain.js —— 地形高程网格 → three.js 几何
 *
 * 真实世界不能是平的地面。这里把 server/terrain.mjs 抓到的 DEM 网格
 * 变成一张**起伏的地面**，并给楼/树一个"站在哪"的高度。
 *
 * 网格约定（server 侧产的）：
 *   { size, step, minX, minZ, values[size*size], minH, maxH }
 *   values[j*size + i] 对应世界坐标 x = minX + (i+0.5)*step, z = minZ + (j+0.5)*step
 *   （行优先：j 是 Z 方向，i 是 X 方向）
 * ========================================================================== */
import * as THREE from 'three';
import { makeSampler, despike, clipOutliers } from './terrain-grid.js?v=76';

export { makeSampler, despike, clipOutliers };

/** 建一个采样器：给任意 (x,z) 返回高程（超出范围用边缘值） */
export function makeSamplerLocal(grid) {
  return makeSampler(grid);
}

/**
 * 起伏的地面。
 * @param {object} grid  高程网格
 * @param {object} opts  { minX, minZ, width, depth, seg } 覆盖范围（世界坐标）
 * @returns {{mesh, sampler}}
 */
/**
 * ★ 2026-11-10：去掉高程网格里的**孤立尖峰**。
 *   （实现在 terrain-grid.js —— 纯数学，不依赖 three，好单测）
 *
 * 起因：AWS terrarium 瓦片偶尔有单点噪声。实测上海黄浦区 600m：
 *   地形中位数 8m（上海平原，正确），但边缘冒出一个 59m 的孤立凸起
 *   ⇒ 平地上凭空多一座"山"（实测截图里右上角那座）。
 *
 * 只削离群点 —— 某格点比 3×3 邻域中位数高出/低于阈值时拉回邻域中位数。
 * 真正的大山（邻域整体都高）不会被削掉。
 */
export function buildTerrain(grid, opts = {}) {
  // ★ 先清洗高程（楼的地基高度和地形用同一个 sampler ⇒ 保持一致，不会楼浮空）
  //   ① despike：削孤立尖峰（单点噪声）
  //   ② clipOutliers：削区域性噪声（少数派极端高），保护真实山体
  let g = despike(grid, opts.despikeThreshold);
  g = clipOutliers(g, opts.clipOpts);
  const sampler = makeSampler(g);
  if (!sampler) return null;
  const minX = opts.minX != null ? opts.minX : g.minX;
  const minZ = opts.minZ != null ? opts.minZ : g.minZ;
  const width = opts.width || (g.size * g.step);
  const depth = opts.depth || (g.size * g.step);
  const seg = Math.max(2, Math.min(256, opts.seg || g.size * 2));

  const geo = new THREE.PlaneGeometry(width, depth, seg, seg);
  geo.rotateX(-Math.PI / 2);                     // 变成 XZ 平面
  const pos = geo.attributes.position;
  const cx = minX + width / 2;
  const cz = minZ + depth / 2;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + cx;
    const z = pos.getZ(i) + cz;
    pos.setY(i, sampler(x, z));
    pos.setX(i, x);
    pos.setZ(i, z);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  geo.computeBoundingSphere();

  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
    color: opts.color != null ? opts.color : 0xc8c4b4,
    roughness: 0.98,
    metalness: 0,
  }));
  mesh.name = 'osm-terrain';
  mesh.receiveShadow = true;
  mesh.userData.pickable = false;
  mesh.userData.role = 'floor';
  return { mesh, sampler };
}
