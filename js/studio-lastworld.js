/* ============================================================================
 * js/studio-lastworld.js —— ★「打开就是上次的地方」
 *
 * 问题（2026-11-10 用户反馈）：
 *   花力气调出了上海黄浦区 7990 栋真实楼，**关掉再打开却是"空房间"**。
 *   ⇒ 做过的真实世界等于白做。
 *
 * 做法：
 *   ① 载入真实世界后，把 { lat, lng, radius, name, attribution } 记到 localStorage
 *   ② 启动时自动恢复（本地缓存 ⇒ 0.5 秒，不用等 Overpass）
 *   ③ 入口页给「继续上次：上海黄浦区」一个直达卡片
 *
 * 为什么放 localStorage 而不是磁盘：
 *   这个是"上次在哪"的**指针**，很小；真正的世界数据在桥的 osm-cache 里（磁盘），
 *   所以关网页不丢世界（bridge 的缓存是 7 天）。
 * ========================================================================== */
const KEY = 'wb-last-world-v1';
const RECENT_KEY = 'wb-recent-worlds-v1';

function read(key, dflt) {
  try { return JSON.parse(localStorage.getItem(key) || '') || dflt; }
  catch (_) { return dflt; }
}
function write(key, val) {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) { /* 隐私模式忽略 */ }
}

/** 记下"上次的地方" */
export function rememberWorld(spec) {
  if (!spec || !Number.isFinite(spec.lat) || !Number.isFinite(spec.lng)) return;
  const rec = {
    lat: spec.lat, lng: spec.lng,
    radius: spec.radius || 600,
    name: spec.name || `${spec.lat.toFixed(4)}, ${spec.lng.toFixed(4)}`,
    attribution: spec.attribution || '© OpenStreetMap contributors',
    at: Date.now(),
  };
  // ★ 2026-11-10：**同坐标时保留已有的名字**。
  //   有些路径（比如 Agent 直接 wb_world_build）拿不到城市名 ⇒ 只能写坐标。
  //   如果让它直接覆盖，入口页就会从「继续上次：上海黄浦区」退化成
  //   「继续上次：31.2304, 121.4737」（实测踩到）。
  const old = read(KEY, null);
  if (old && Math.abs(old.lat - rec.lat) < 1e-4 && Math.abs(old.lng - rec.lng) < 1e-4) {
    const oldNamed = old.name && !/^[-0-9.]+, [-0-9.]+$/.test(old.name);
    const newNamed = rec.name && !/^[-0-9.]+, [-0-9.]+$/.test(rec.name);
    if (oldNamed && !newNamed) rec.name = old.name;
    if (old.attribution && !spec.attribution) rec.attribution = old.attribution;
  }
  write(KEY, rec);
  // 最近列表（最多 8 个，按时间倒序）
  const list = read(RECENT_KEY, []).filter((x) => !(Math.abs(x.lat - rec.lat) < 1e-4 && Math.abs(x.lng - rec.lng) < 1e-4));
  list.unshift(rec);
  write(RECENT_KEY, list.slice(0, 8));
}

/** 上次的地方（没有就 null） */
export function lastWorld() {
  return read(KEY, null);
}

/** 最近去过的地方 */
export function recentWorlds() {
  return read(RECENT_KEY, []);
}

/** 忘掉（"换个新地方"时用） */
export function forgetWorld() {
  try { localStorage.removeItem(KEY); } catch (_) {}
}

/**
 * 载入一个世界（自动走桥的服务端工具 → 页面侧建几何）。
 *
 * @param {object} spec { lat, lng, radius, name }
 * @returns {Promise<object>} { ok, error, stats, name }
 */
export async function loadWorld(spec) {
  if (!spec || !Number.isFinite(spec.lat)) return { ok: false, error: '没有地点信息' };
  const BRIDGE = () => (location.port === '8802' || location.port === '8803'
    ? `${location.protocol}//${location.hostname}:8787` : 'http://127.0.0.1:8787');
  let jb;
  try {
    const res = await fetch(`${BRIDGE()}/tool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'wb_world_build',
        args: {
          kind: 'osm', lat: spec.lat, lng: spec.lng, radius: spec.radius || 600,
          // ★ 2026-11-10：把城市名带下去（入口页要显示「继续上次：上海黄浦区」）
          name: spec.name || null,
        },
      }),
    });
    jb = await res.json();
  } catch (e) {
    return { ok: false, error: '连不上本地服务（桥没起？）' };
  }
  if (!jb || !jb.ok) return { ok: false, error: (jb && jb.error) || '抓取失败' };
  // ★ 2026-11-10：桥的 /tool 返回是**顶层结构**（{ok,key,url,stats,page,terrain}），
  //   没有 data 包装（之前读 jb.data ⇒ undefined ⇒ "缺少 url"）。
  const d = (jb && jb.data) || jb || {};
  // ★ 桥在服务端流程里**已经调页面侧建好几何了**（pageCall('world.osm')）⇒ 不用再建一次
  let built = !!(jb.page && jb.page.ok === true);
  if (!built) {
    const r2 = await window.WB_AGENT.run('world.osm', {
      url: d.url, attribution: d.attribution,
    });
    if (r2 && r2.error) return { ok: false, error: r2.error };
    built = true;
  }
  const stats = d.stats || {};
  rememberWorld({
    lat: spec.lat, lng: spec.lng, radius: spec.radius || 600,
    name: spec.name || '真实世界', attribution: d.attribution,
  });
  return { ok: true, stats, name: spec.name, url: d.url };
}

/* 暴露给页面（入口页要用） */
window.__ovfLastWorld = { rememberWorld, lastWorld, recentWorlds, forgetWorld, loadWorld };
