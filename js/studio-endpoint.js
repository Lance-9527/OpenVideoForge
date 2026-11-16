/* ============================================================================
 * js/studio-endpoint.js —— ★ VideoForge 服务地址（**不写死端口**）
 *
 * 为什么要有这个文件（2026-11-10）：
 *   openVideoForge 里有 **8 个模块**把 VideoForge 的地址写成了
 *   `http://127.0.0.1:8765`（老版端口）。
 *   但新版 sidecar **每次启动端口都可能变**（实测 52056 / 8798），
 *   写死 ⇒ 所有跨模块访问（资产下载、渲染监控、白膜库、交接…）全断，
 *   页面侧表现为 "Failed to fetch"，而且**没有任何提示**。
 *
 * 做法：统一向**桥**要真实地址（桥已经在扫日志找端口了 ⇒ wb_caps.url），
 *       缓存在模块级；页面启动时先 resolve 一次。
 * ========================================================================== */

const FALLBACK = 'http://127.0.0.1:8765';
let base = FALLBACK;
let resolvedAt = 0;

/** 当前已知的 VideoForge 根地址（不含 /api/studio） */
export function studioBase() { return base; }

/** 直接设置（拿到地址时用） */
export function setStudioBase(u) {
  if (u) {
    const s = String(u).trim().replace(/\/+$/, '');
    if (s) { base = s; resolvedAt = Date.now(); }
  }
  return base;
}

/**
 * 向桥问真实地址（桥会扫 sidecar 日志找端口）。
 * @param {boolean} force 忽略 30 秒缓存
 */
export async function resolveStudioBase(force = false) {
  if (!force && resolvedAt && Date.now() - resolvedAt < 30000) return base;
  try {
    const r = await fetch('http://127.0.0.1:' + (window.WB_BRIDGE_PORT || 8787) + '/tool', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'wb_caps', args: {} }),
    });
    const j = await r.json();
    const u = j && j.data && j.data.url;
    if (u) setStudioBase(u);
  } catch (_) { /* 桥没起就先用兜底 */ }
  resolvedAt = Date.now();
  // 让别的模块（如 studio-bridge.js）也能拿到
  try { window.__ovfStudioBase = base; } catch (_) {}
  return base;
}

/**
 * 把路径变成绝对 URL。
 * @param {string} p 绝对地址直接返回；相对地址用当前 base 拼
 */
export function absStudioUrl(p) {
  if (!p) return p;
  const s = String(p);
  if (/^https?:\/\//i.test(s)) return s;
  return base + (s.startsWith('/') ? s : '/' + s);
}

/** VideoForge 的 API 前缀（…/api/studio） */
export function studioApi() { return base + '/api/studio'; }
