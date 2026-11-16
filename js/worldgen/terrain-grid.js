/* ============================================================================
 * js/worldgen/terrain-grid.js —— 地形高程网格（纯数学，可单测，不依赖 three）
 *
 * 网格约定（server/terrain.mjs 产的）：
 *   { size, step, minX, minZ, values[size*size], minH, maxH }
 *   values[j*size + i] ↔ 世界坐标 x = minX + (i+0.5)*step, z = minZ + (j+0.5)*step
 *   （行优先：j 沿 Z，i 沿 X）
 * ========================================================================== */

/** 建一个采样器：给任意 (x,z) 返回高程（超出范围用边缘值，不炸） */
export function makeSampler(grid) {
  if (!grid || !Array.isArray(grid.values) || !grid.values.length) return null;
  const n = grid.size;
  const step = grid.step;
  const minX = grid.minX, minZ = grid.minZ;
  const v = grid.values;
  const at = (i, j) => {
    const ii = Math.max(0, Math.min(n - 1, i));
    const jj = Math.max(0, Math.min(n - 1, j));
    return v[jj * n + ii];
  };
  return function heightAt(x, z) {
    const fx = (x - minX) / step - 0.5;
    const fz = (z - minZ) / step - 0.5;
    const i0 = Math.floor(fx), j0 = Math.floor(fz);
    const tx = fx - i0, tz = fz - j0;
    const h00 = at(i0, j0), h10 = at(i0 + 1, j0);
    const h01 = at(i0, j0 + 1), h11 = at(i0 + 1, j0 + 1);
    return (h00 * (1 - tx) * (1 - tz)) + (h10 * tx * (1 - tz))
      + (h01 * (1 - tx) * tz) + (h11 * tx * tz);
  };
}

/**
 * ★ 2026-11-10：去掉高程网格里的**孤立尖峰**。
 *
 * 起因：AWS terrarium 瓦片偶尔有单点噪声。实测上海黄浦区 600m：
 *   地形中位数 8m（上海平原，正确），但边缘冒出一个 59m 的孤立凸起
 *   ⇒ 平地上凭空多一座"山"（实测截图里右上角那座）。
 *
 * 做法：**只削离群点** —— 某格点比 3×3 邻域中位数高出/低于阈值时拉回邻域中位数。
 *   真正的大山（邻域整体都高）不会被削掉。
 *
 * @param {object} grid {size, values, ...}
 * @param {number} threshold 阈值（米）
 * @returns {object} 新网格（带 despiked 计数）
 */
export function despike(grid, threshold = 12) {
  const n = grid && grid.size;
  const v = grid && grid.values;
  if (!n || !Array.isArray(v) || !v.length) return grid;
  const out = v.slice();
  const med = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  let fixed = 0;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const cur = v[idx];
      if (!Number.isFinite(cur)) { out[idx] = 0; fixed++; continue; }
      const nb = [];
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
          const h = v[jj * n + ii];
          if (Number.isFinite(h)) nb.push(h);
        }
      }
      if (nb.length < 3) continue;
      const m = med(nb);
      if (Math.abs(cur - m) > threshold) { out[idx] = m; fixed++; }
    }
  }
  return { ...grid, values: out, despiked: fixed };
}

/**
 * ★ 2026-11-10：分位数裁剪 —— 处理**区域性**的高程噪声。
 *
 * despike 只能削孤立点；如果是一小片区域都高（比如 DEM 瓦片在这一带整体偏了），
 * 邻域中位数也高 ⇒ 削不掉。
 *
 * 规则（保守，避免削掉真山）：
 *   ① 只有当 max - p50 > 40 米（整体动态范围异常大）才考虑
 *   ② 只有当超过 p95*1.5 的点**占比 < 8%** 才裁（少数派才动）
 *   ③ 裁到 p95
 *
 * 实测：上海黄浦区 600m —— p50=8, p95=25, max=59 ⇒ 59 是少数派 ⇒ 裁到 25
 *       京都 300m —— max=825（真山），p95 远高于 max*0.6 ⇒ 不裁
 */
export function clipOutliers(grid, opts = {}) {
  const v = grid && grid.values;
  const n = grid && grid.size;
  if (!n || !Array.isArray(v) || !v.length) return grid;
  const minRange = opts.minRange ?? 40;
  const maxShare = opts.maxShare ?? 0.08;
  const sorted = v.filter((h) => Number.isFinite(h)).sort((a, b) => a - b);
  if (sorted.length < 16) return grid;
  // ★ 分位数索引要用 (n-1)*p，不是 n*p ——
  //   floor(n*p) 会**跨进下一组**（实测：64 个点里 60 个 8 + 4 个 59，
  //   floor(64*0.95)=60 ⇒ 取到 59 ⇒ p95 反而是异常值）。
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))];
  const p50 = q(0.5), p95 = q(0.95), max = sorted[sorted.length - 1];
  if (!(max - p50 > minRange)) return grid;
  const cut = p95 * 1.5;
  const over = v.filter((h) => Number.isFinite(h) && h > cut).length;
  if (!over || over / v.length > maxShare) return grid;
  const out = v.map((h) => (Number.isFinite(h) && h > p95 ? p95 : h));
  return { ...grid, values: out, clipped: over, clipTo: p95 };
}

/** 网格统计：最小/最大/平均高程 */
export function gridStats(grid) {
  if (!grid || !Array.isArray(grid.values) || !grid.values.length) return null;
  let min = Infinity, max = -Infinity, sum = 0;
  for (const h of grid.values) {
    if (!Number.isFinite(h)) continue;
    if (h < min) min = h;
    if (h > max) max = h;
    sum += h;
  }
  const n = grid.values.length || 1;
  return { min, max, avg: sum / n, relief: max - min };
}
