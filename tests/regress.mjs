#!/usr/bin/env node
/* ============================================================================
 * tests/regress.mjs —— 这一轮（第十二轮）修掉的 bug 的**源码不变式**回归
 *
 * 这些 bug 有一个共同特点：**不报错，只是"点了没反应"**，
 * 光靠跑正常流程测不出来，所以这里直接断言源码里的关键写法还在。
 *
 * 覆盖：
 *   ① `$()` 的默认参数对 null 无效 → 17 个 studio 模块统一改成 `(root || document)`
 *   ② `shootBrowser` 的相机没同步主相机 → 录出来一片白
 *   ③ `restoreFromUrl` 不开编辑器 → 分享链接打开后什么都没还原
 *   ④ Blender 端口写死 8765 → 改成多端口探测
 *   ⑤ HDRI 分辨率各选各的图 → 同槽位必须复用同一张
 *   ⑥ 室内层数上限 8 → 40 + 渲染按层裁剪
 *   ⑦ `esc` 未定义 → 「套 PBR 材质」选择器直接抛 ReferenceError
 * ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

let pass = 0, fail = 0;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  ✓', n); }
  else { fail++; console.log('  ✗', n, extra === undefined ? '' : '→ ' + JSON.stringify(extra)); }
};
const group = (t) => console.log('\n' + t);

const read = (p) => {
  const f = path.resolve(p);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

/* ── ① `$()` 的 null 陷阱 ─────────────────────────────────────────── */
group('1. $() 的 null 陷阱（17 个 studio 模块）');
{
  const files = fs.readdirSync('js').filter((f) => f.endsWith('.js'));
  const bad = [];
  let checked = 0;
  for (const f of files) {
    const s = read(path.join('js', f));
    const m = s.match(/const \$ = \((sel|s), (root|r)( = document)?\) =>/);
    if (!m) continue;
    checked++;
    // 必须是 `(root || document)` 形式，不能是默认参数形式
    if (!/=> \(?(root|r)\s*\|\|\s*document\)?\./.test(s)) bad.push(f);
  }
  ok('★ 所有 $ 定义都用了 `(root || document)`', bad.length === 0, bad);
  console.log(`    检查了 ${checked} 个模块`);
  // 具体点名几个最常出问题的
  for (const f of ['studio-tracks.js', 'studio-topbar.js', 'studio-assetlibrary.js', 'app.js']) {
    const s = read(path.join('js', f));
    ok(`★ ${f} 的 $ 防空`, /\(r\s*\|\|\s*document\)|\(root\s*\|\|\s*document\)/.test(s), f);
  }
}

/* ── ② shootBrowser 的相机同步 ────────────────────────────────────── */
group('2. 浏览器录制的相机同步（白片 bug）');
{
  const s = read('js/studio-tracks.js');
  ok('★ shootBrowser 里把主相机同步到录制相机',
    /cam\.position\.copy\(e\.camera\.position\)/.test(s), '找不到 cam.position.copy(e.camera.position)');
  ok('★ 也同步了 quaternion', /cam\.quaternion\.copy\(e\.camera\.quaternion\)/.test(s));
  ok('★ 更新了投影矩阵', /cam\.updateProjectionMatrix\(\)/.test(s));
  ok('★ 录制时套了真实感', /applyCurrent\(e\.scene, e, renderer\)/.test(s));
}

/* ── ③ 分享链接自动开编辑器 ───────────────────────────────────────── */
group('3. 分享链接还原（编辑器默认不开）');
{
  const s = read('js/studio-presets.js');
  ok('★ restoreFromUrl 会自己 openEditor',
    /openEditor\(\{\s*env:\s*'room'\s*\}\)/.test(s), '找不到 openEditor 调用');
  ok('★ 等编辑器的循环加长到 90 次（12s → 18s）', /for \(let i = 0; i < 90; i\+\+\)/.test(s));
  ok('★ 还原后切到编辑器视图', /switchView\('editor'\)/.test(s));
}

/* ── ④ Blender 多端口探测 ─────────────────────────────────────────── */
group('4. Blender 侧车端口不写死');
{
  const s = read('server/agent-bridge.mjs');
  ok('★ 探测多个端口', /STUDIO_PORTS/.test(s) && /8798/.test(s));
  ok('★ 有 probeStudio()', /async function probeStudio\(\)/.test(s));
  ok('★ studioGet/studioPost 用动态 base', /async function studioBaseUrl\(\)/.test(s));
  ok('★ 分清 service_up 和 blender',
    /service_up/.test(s) && /blender_available/.test(s));
  ok('★ 没 Blender 时给提示', /hint/.test(s) && /浏览器录制/.test(s));
}

/* ── ⑤ HDRI 同槽位同图 ────────────────────────────────────────────── */
group('5. HDRI 同槽位必须复用同一张图');
{
  const s = read('tools/fetch-hdri.mjs');
  ok('★ 有「复用同一张」逻辑', /复用同一张/.test(s));
  ok('★ 复用分支在选新图之前', s.indexOf('existing') < s.indexOf('const pick = ranked[0].a'), '复用分支位置不对');
  const h = read('server/hdri.mjs');
  ok('★ 服务端按最高分辨率暴露', /resRank/.test(h));
  ok('★ 同一 id 的多分辨率取最高', /sort\(\(a, b\) => rank\(b\.res\) - rank\(a\.res\)\)/.test(h));
}

/* ── ⑥ 室内多层 + 按层裁剪 ────────────────────────────────────────── */
group('6. 室内多层');
{
  const p = read('js/worldgen/interior-plan.js');
  const i = read('js/worldgen/interior.js');
  ok('★ 层数上限 40', /MAX_FLOORS = 40/.test(p));
  ok('★ plan 里带 floorH', /floorH,/.test(p));
  ok('★ 渲染按层裁剪（当前层 ±1，总览模式除外）', /const RANGE = ALL \? Infinity : 1/.test(i) && /inRange/.test(i));
  ok('★ 裁剪函数被用上了', /if \(!inRange\(f\.y\)\) continue;/.test(i));
}

/* ── ⑦ esc 未定义 ─────────────────────────────────────────────────── */
group('7. 右键菜单的 HTML 转义');
{
  const s = read('js/studio-ctxmenu.js');
  ok('★ esc 有定义', /const esc = \(s\) =>/.test(s));
  ok('★ 有「套 PBR 材质」菜单项', /data-act="setPbr"/.test(s));
  ok('★ 有 setPbrForSelected 实现', /async function setPbrForSelected/.test(s));
}

/* ── ⑧ 逐物体 PBR ─────────────────────────────────────────────────── */
group('8. 逐物体指定 PBR');
{
  const e = read('js/editor.js');
  const r = read('js/real-look.js');
  ok('★ editor 有 setObjectPbr', /setObjectPbr\(id\)/.test(e));
  ok('★ 存档里保存 pbrId', /pbrId: o\.pbrId \|\| null/.test(e));
  ok('★ 读档时恢复 pbrId', /pbrId: o\.pbrId \|\| null,/.test(e) && /er\.pbrId = o\.pbrId/.test(e));
  ok('★ 渲染时手动指定优先', /rec\.pbrId && pbrSets\.byId/.test(r));
  ok('★ preparePbr 提供 byId 索引', /sets\.byId/.test(r));
}

/* ── ⑨ CSM 集成 ───────────────────────────────────────────────────── */
group('9. CSM 级联阴影');
{
  const s = read('js/studio-csm.js');
  const e = read('js/editor.js');
  ok('★ 有 CSM 模块', /export async function enableCsm/.test(s));
  ok('★ setupMaterial 保留原有 onBeforeCompile', /if \(prev\) prev\(shader, renderer\)/.test(s));
  ok('★ editor 有 setCsm', /async setCsm\(on, opt = \{\}\)/.test(e));
  ok('★ 每帧更新 cascade', /updateCsm\(this\)/.test(e));
  ok('★ vendor 里的 CSM 是官方 addon', fs.existsSync('js/vendor/csm/CSM.js'));
}

/* ── ⑩ 端口不写死（VideoForge sidecar 端口随机） ───────────────────── */
group('10. VideoForge 端口不能写死（这一轮最大的坑）');
{
  const endpoint = read('js/studio-endpoint.js');
  ok('★ 有统一的地址解析模块', /export function studioBase/.test(endpoint) && /export async function resolveStudioBase/.test(endpoint));
  ok('★ 桥认 VIDEOFORGE_DATA_DIR（数据目录）', /VIDEOFORGE_DATA_DIR/.test(read('server/agent-bridge.mjs')));
  // 所有直接访问 VideoForge 的模块都必须用 studio-endpoint
  const mods = ['studio-handoff.js', 'studio-previz.js', 'studio-revisions.js', 'studio-shot.js',
    'studio-myassets.js', 'studio-render-monitor.js', 'studio-bridge.js'];
  const hard = [];
  for (const f of mods) {
    const s = read(path.join('js', f));
    if (/127\.0\.0\.1:8765/.test(s) && !/FALLBACK/.test(s.split('127.0.0.1:8765')[0].slice(-40))) {
      // 允许注释和 FALLBACK 常量，其余算硬编码
      const hits = s.split('\n').filter((l) => /127\.0\.0\.1:8765/.test(l) && !/^\s*(\*|\/\/)/.test(l) && !/FALLBACK/.test(l));
      if (hits.length) hard.push({ f, hits: hits.slice(0, 2) });
    }
    if (!/studio-endpoint\.js/.test(s)) hard.push({ f, hits: ['没引 studio-endpoint.js'] });
  }
  ok('★ 7 个模块都走统一地址解析', hard.length === 0, hard);
  // editor.js 导入外部模型时不能再写死 8765
  const e = read('js/editor.js');
  ok('★ addExternalAsset 用动态地址', /studio-endpoint\.js/.test(e) && !/new URL\(asset\.file_url[^)]*8765/.test(e));
  // 桥里 previz 的数据目录
  const b = read('server/agent-bridge.mjs');
  ok('★ 桥的 vfStudioDir 认数据目录', /VIDEOFORGE_DATA_DIR/.test(b) && /function vfStudioDir/.test(b));
  ok('★ 桥的 renderFrames 不写死 AppData', !/LOCALAPPDATA[^)]*'VideoForge', 'data', 'studio_bridge', 'jobs'/.test(b));
}

/* ── ⑪ 桥不能被单个工具打挂 ───────────────────────────────────────── */
group('11. 一个工具抛异常不能打死整个桥');
{
  const b = read('server/agent-bridge.mjs');
  ok('★ callTool 有全局 try/catch 兜底', /async function callTool\(name, args = \{\}\)\s*\{\s*try\s*\{[\s\S]{0,200}callToolInner/.test(b));
  ok('★ 兜底返回友好错误而不是让进程死', /执行失败：/.test(b));
  ok('★ studioGet 对 404 不抛', /r\.status === 404/.test(b));
  ok('★ studioGet 允许没有 code 的响应', /j\.code !== undefined/.test(b));
  ok('★ splat 路径不重复 /api/studio', !/studioPost\('\/api\/studio\/splat/.test(b));
  ok('★ 布尔参数显式解析', /function boolArg/.test(b));
  ok('★ camera_keys 空数组不走 setTrack', /Array\.isArray\(args\.camera_keys\) && args\.camera_keys\.length/.test(b));
}

/* ── ⑫ 真实城市：取景 + Blender 渲染 ──────────────────────────────── */
group('12. 真实城市复刻（取景 + Blender 能渲染）');
{
  const e = read('js/editor.js');
  const osm = read('js/worldgen/osm.js');
  const sb = read('js/studio-bridge.js');
  ok('★ 楼基高度写回原对象', /it\.baseY = baseY/.test(osm));
  ok('★ 取景带楼基高度', /y: groundY \+ 1\.7/.test(e));
  ok('★ target 用取景出来的高度', /framing\.y != null \? framing\.y : 1\.7/.test(e));
  ok('★ 有 groundHeightAt 落地高度', /groundHeightAt\(x, z\)/.test(e));
  ok('★ 环境实例 id 不用 environment', /add\(asset,'world',e\.envGroup\)/.test(sb));
  ok('★ 注释解释了为什么', /大场景跳过环境盒子/.test(sb));
}

/* ── ⑬ 真实世界的还原度（「有多少给多少」） ─────────────────────────── */
group('13. 真实世界还原度');
{
  const p = read('js/worldgen/osm-parse.js');
  const o = read('js/worldgen/osm.js');
  const e = read('js/editor.js');
  const s = read('server/osm.mjs');
  ok('★ 楼上限提到 30000（原来 4000 会截断）', /maxBuildings = opts\.maxBuildings \?\? 30000/.test(p));
  ok('★ 道路上限也提到 30000', /maxRoads = opts\.maxRoads \?\? 30000/.test(p));
  ok('★ 支持 relation 多边形建筑', /el\.type === 'relation'/.test(p) && /via: 'relation'/.test(p));
  ok('★ relation 的多个 outer 要拆开', /outerGroups/.test(p));
  ok('★ isWater 认 waterway=river（黄浦江是线不是面）', /tags\.waterway === 'river'/.test(p));
  ok('★ 线状水体加宽成带（ribbonRing）', /export function ribbonRing/.test(p) && /WATER_WIDTH/.test(p));
  ok('★ 长线要断开（relation 成员横跨几十公里）', /2000/.test(p) && /finishBand/.test(p));
  ok('★ 按 bbox 裁剪越界要素', /opts\.bbox/.test(p) && /inGeo/.test(p));
  ok('★ 服务端把 bbox 传给 normalizeOsm', /bbox: bboxFromLatLng/.test(s));
  ok('★ 按面积推建筑高度（OSM 大多没 height/levels）', /export function inferHeightByArea/.test(p) && /inferHeightByArea\(area, tags\)/.test(p));
  ok('★ 水面是水平面（flatPolygons 支持每个 item 自己的 y）', /Number\.isFinite\(it\.y\) \? it\.y : y/.test(o));
  ok('★ 地形在水域下挖低（造江床）', /carveTerrainUnderWater/.test(o) && /pointInPolygon/.test(o));
  ok('★ 地形范围按城市本体（cityBounds）', /world\.cityBounds \|\| b/.test(o));
  ok('★ 产出 cityBounds（不含远郊道路）', /cityBounds: cb/.test(p));
  ok('★ 雾按 citySize（否则远景被雾吃掉）', /world\.citySize/.test(e));
  ok('★ 取景把水系纳入构图', /plan && plan\.waters/.test(e));
  ok('★ 相机距离上限提到 4200', /Math\.min\(4200, span \* 1\.15\)/.test(e));
  ok('★ raw 缓存可复用（改解析规则不用重抓）', /reusedRaw/.test(s) && /rawPath/.test(s));
  ok('★ force=重算 / refetch=重抓 两个语义分开', /refetch/.test(s) && /o\.refetch/.test(s));
}

/* ── ⑭ VideoForge 后端自动拉起（不用手动开 PowerShell） ───────────────── */
group('14. VideoForge 后端自动拉起');
{
  const a = read('server/vf-autostart.mjs');
  const b = read('server/agent-bridge.mjs');
  ok('★ 有自动拉起模块', /export async function startVideoForge/.test(a));
  ok('★ 能找 sidecar backend', /findBackendDir/.test(a) && /main\.py/.test(a));
  ok('★ 能找带 fastapi/uvicorn 的 Python', /findPython/.test(a));
  ok('★ 能找 Blender', /findBlender/.test(a));
  ok('★ detached 拉起（桥关了它还活着）', /detached: true/.test(a));
  ok('★ 已在跑就复用，不重复拉', /already: true/.test(a) && /studioAlive/.test(a));
  ok('★ 桥启动时调用', /vf-autostart/.test(b) && /autostartVideoForge/.test(b));
  ok('★ 拉不起来不影响桥（降级）', /不影响使用/.test(b));
}

/* ── ⑮ 室内总览（爆炸图） ────────────────────────────────────────────── */
group('15. 室内总览');
{
  const i = read('js/worldgen/interior.js');
  const e = read('js/editor.js');
  const s = read('js/studio-agent.js');
  const br = read('server/agent-bridge.mjs');
  ok('★ floor=-1 ⇒ 总览模式', /curFloor < 0/.test(i) && /const ALL = curFloor < 0/.test(i));
  ok('★ 总览画全部楼层', /if \(ALL\) return true/.test(i));
  ok('★ 总览不画天花板', /if \(!ALL\)/.test(i));
  ok('★ 总览是**爆炸图**（每层错开）', /explode|GAP/.test(i) && /lift\(/.test(i));
  ok('★ 总览跳过最高层地板（不然盖住顶层）', /f\.y >= topFloorY/.test(i));
  ok('★ 相机按包围球取景（不然溢出画面）', /Math\.hypot\(w, d, totalH\)/.test(e));
  ok('★ 远裁剪面跟着放大', /camera\.far < r \* 3/.test(e));
  ok('★ 总览藏起外壳楼', /_setExteriorShellHidden/.test(e) && /meshes\.buildings/.test(e));
  ok('★ 总览画外轮廓线框', /_addInteriorEnvelope/.test(e));
  ok('★ 回到具体楼层会把外壳放回来', /_setExteriorShellHidden\(false\)/.test(e));
  ok('★ 页面指令 building.overview', /'building\.overview'/.test(s));
  ok('★ MCP 工具 wb_building_overview', /wb_building_overview/.test(br));
  ok('★ building.floor 支持 -1', /f === -1/.test(s));
}

/* ── ⑯ 「打开就是上次的地方」（用户反馈：打开却是空房间） ─────────────── */
group('16. 打开就是上次的地方');
{
  const lw = read('js/studio-lastworld.js');
  const ap = read('js/app.js');
  const ag = read('js/studio-agent.js');
  const ci = read('js/studio-city.js');
  const html = read('index.html');
  ok('★ 有 studio-lastworld 模块', /rememberWorld/.test(lw) && /lastWorld/.test(lw) && /loadWorld/.test(lw));
  ok('★ 入口页有「继续上次」卡片', /enCardLast/.test(html) && /enCardLast/.test(ap));
  ok('★ 载入世界时会记住（页面指令里）', /__ovfLastWorld/.test(ag));
  ok('★ 城市面板也会记住（带城市名）', /__ovfLastWorld/.test(ci));
  ok('★ 启动自动恢复', /autoRestoreLastWorld/.test(ap));
  ok('★ 记住的字段够用（坐标/半径/名字）', /lat: spec\.lat/.test(lw) && /radius/.test(lw) && /name/.test(lw));
}

/* ── ⑰ 录制路径不能只靠 rAF（后台页面 rAF 会被饿死） ─────────────────── */
group('17. rAF 兜底');
{
  const v = read('js/studio-video.js');
  const t = read('js/studio-tracks.js');
  const d = read('js/studio-device.js');
  ok('★ 视频导出有 setTimeout 兜底', /setTimeout\(once, 16\)/.test(v));
  ok('★ 浏览器录制（轨迹）有 setTimeout 兜底', /setTimeout\(once, 16\)/.test(t));
  ok('★ 设备实拍有 setTimeout 兜底', /setTimeout\(once, 16\)/.test(d));
}

console.log(`\n${fail ? '✗' : '✓'} regress: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
