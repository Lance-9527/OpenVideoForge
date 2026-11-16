/* ============================================================================
 * tools/ovf-full-accept.mjs —— ★ 全功能面综合验收
 *
 * 目标：**117 个功能面逐个跑一遍**（60 个 MCP 工具 + 57 个页面指令），
 *       挂了就修，修完再跑，直到全绿。
 *
 * 做法：
 *   · 从 server/agent-bridge.mjs 的 TOOLS 定义里解析每个工具的 schema
 *   · 从 js/studio-agent.js 的注册表里解析每个页面指令的参数名
 *   · 按参数名猜一组合理默认值，逐个调用，记录 ok / error
 *   · 输出失败清单（带错误原文），供逐条修
 * ========================================================================== */
import { defaultOutDir } from '../server/paths.mjs';
import { CDP } from './cdp.mjs';
import fs from 'node:fs';

const cdp = await CDP.attach('index.html');
await cdp.send('Runtime.enable');
await cdp.send('Page.enable');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const rec = (kind, name, ok, err, ms) => {
  results.push({ kind, name, ok, err: err ? String(err).slice(0, 220) : null, ms });
  console.log(`  ${ok ? '✓' : '✗'} ${kind.padEnd(4)} ${name.padEnd(26)} ${ok ? ms + 'ms' : '→ ' + String(err).slice(0, 160)}`);
};

/* ── 准备：打开编辑器 + 一个干净场景 ─────────────────────────────── */
await cdp.eval(`
  if (window.__wb && window.__wb.openEditor) { try { await window.__wb.openEditor({ env:'street' }); } catch(e){} }
  const m = document.querySelector('#modal'); if (m) m.hidden = true;
  for (const id of ['#view-library','#view-entry']) { const e=document.querySelector(id); if(e) e.hidden = true; }
  const ed = document.querySelector('#view-editor'); if (ed) ed.hidden = false;
  if (window.__wb && window.__wb.switchView) window.__wb.switchView('editor');
  await new Promise(r=>setTimeout(r,3000));
  return true;
`);
await wait(2500);

/* ── 解析 MCP 工具 schema ──────────────────────────────────────────── */
const bridgeSrc = fs.readFileSync('server/agent-bridge.mjs', 'utf8');
const toolDefs = [];
{
  // 抓 `{ name: 'wb_x', description: '...', schema: { type:'object', properties:{...}, required:[...] } }`
  const re = /\{\s*name:\s*'(wb_[a-z0-9_.]+)'[\s\S]*?schema:\s*\{([\s\S]*?)\}\s*\}/g;
  let m;
  while ((m = re.exec(bridgeSrc))) {
    const props = {};
    const pm = /([a-z_][a-z0-9_]*)\s*:\s*\{\s*type:\s*'([^']+)'/gi;
    let p;
    while ((p = pm.exec(m[2]))) props[p[1]] = p[2];
    const req = (m[2].match(/required:\s*\[([^\]]*)\]/) || [, ''])[1]
      .split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    toolDefs.push({ name: m[1], props, required: req });
  }
}

/* ── 解析页面指令参数 ─────────────────────────────────────────────── */
const agentSrc = fs.readFileSync('js/studio-agent.js', 'utf8');
const cmdDefs = [];
{
  const re = /^\s*'([a-z][a-zA-Z0-9_.]+)':\s*(?:async\s*)?\(\s*\{([^}]*)\}\s*\)/gm;
  let m;
  while ((m = re.exec(agentSrc))) {
    const params = m[2].split(',').map((s) => s.split(':')[0].trim().split('=')[0].trim()).filter(Boolean);
    cmdDefs.push({ name: m[1], params });
  }
}

/* ── 参数猜测 ─────────────────────────────────────────────────────── */
const OUT = defaultOutDir();
/** 真实存在的资产 id（WB_ASSETS 里第一个） */
const REAL_ASSET = 'tree';
/** 真实存在的灯光预设（中文名！） */
const REAL_LIGHT = '正午';
/** 真实存在的预设 id（先存一个） */
let REAL_PRESET = null;
/** 真实存在的资产库条目 id */
let REAL_LIB = null;
/** 收件箱里真实存在的文件 */
let REAL_INBOX_FILE = null;
/** 真实存在的渲染任务 id */
let REAL_JOB = null;
/** 能加载的图片 URL（全景用） */
const REAL_IMAGE = 'https://cdn.polyhaven.com/asset_img/thumbs/kloppenheim_06.png?width=160';
function guessArgs(def) {
  const a = {};
  const keys = def.required && def.required.length ? def.required : Object.keys(def.props || {});
  for (const k of keys) {
    const t = (def.props || {})[k] || '';
    switch (k) {
      case 'name': case 'title': case 'label': a[k] = '验收测试'; break;
      case 'id': case 'asset_id': case 'assetId': a[k] = REAL_ASSET; break;
      case 'preset': a[k] = k === 'preset' && t.includes('enum') ? 'white_seamless' : REAL_LIGHT; break;
      case 'lat': a[k] = 35.0116; break;
      case 'lng': case 'lon': a[k] = 135.7681; break;
      case 'radius': a[k] = 200; break;
      case 'count': case 'n': case 'num': a[k] = 3; break;
      case 'seconds': a[k] = 1; break;
      case 'fps': a[k] = 12; break;
      case 'w': case 'width': a[k] = 640; break;
      case 'h': case 'height': a[k] = 360; break;
      case 'file': case 'path': case 'file_path': a[k] = REAL_INBOX_FILE || ''; break;
      case 'url': a[k] = REAL_IMAGE; break;
      case 'x': a[k] = 2; break;
      case 'y': a[k] = 0; break;
      case 'z': a[k] = 3; break;
      case 'r': case 'radius_m': a[k] = 20; break;
      case 'kind': a[k] = 'city'; break;
      case 'index': a[k] = 0; break;
      case 'floor': a[k] = 0; break;
      case 'frame': a[k] = 0; break;
      case 'on': case 'enabled': a[k] = true; break;
      case 'color': a[k] = '#8899aa'; break;
      case 'value': a[k] = 1; break;
      case 'cmd': a[k] = 'state.get'; break;
      case 'args': a[k] = {}; break;
      case 'shots': a[k] = []; break;
      case 'device_id': case 'deviceId': a[k] = 'dev1'; break;
      case 'tool': a[k] = 'get_scene'; break;
      case 'job_id': a[k] = 'job_none'; break;
      default:
        if (t.includes('number')) a[k] = 1;
        else if (t.includes('boolean')) a[k] = true;
        else if (t.includes('array')) a[k] = [];
        else a[k] = REAL_ASSET;
    }
  }
  // ★ camera_keys 这种"必须成数组"的参数不能瞎填字符串（会走错分支）
  if ('camera_keys' in a) { a.camera_keys = []; }
  if ('shots' in a) { a.shots = []; }
  return a;
}

/* ══════════ ① 页面指令 ══════════ */
console.log('\n════ 页面指令 (' + cmdDefs.length + ') ════');

/** 带重试的调用（失败重试一次：不少失败是时序问题，不是功能坏了） */
async function tryCall(kind, name, args) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    try {
      const r = await cdp.eval(`
        const r = await window.WB_AGENT.run(${JSON.stringify(name)}, ${JSON.stringify(args)});
        return { ok: !!(r && r.ok !== false), err: (r && r.error) || null };
      `);
      last = { ok: r.ok && !r.err, err: r.err || (r.ok ? null : 'returned ok=false'), ms: Date.now() - t0 };
    } catch (e) {
      last = { ok: false, err: e.message, ms: Date.now() - t0 };
    }
    if (last.ok) { rec(kind, name, true, null, last.ms); return last; }
    // 重试前补一下上下文
    await wait(600);
  }
  rec(kind, name, last.ok, last.err, last.ms);
  return last;
}
/** 准备上下文：选中一个**已加载完**的对象 + 加一个镜头 */
async function prepare() {
  await cdp.eval(`
    const e = window.__wb.editor;
    // ① 选一个**已有的、加载完**的对象（不新增，避免选到没加载完的）
    if (e.objects && e.objects.length) {
      const ready = e.objects.filter(o => o.group && o.group.children && o.group.children.length);
      if (ready.length) e.select(ready[ready.length - 1]);
      else e.select(e.objects[e.objects.length - 1]);
    }
    // ② 没有对象、或者选中对象已经不在场景里（切世界/进室内会换掉对象）才新增
    const stale = !e.selected || !(e.objects || []).includes(e.selected);
    if (stale) {
      try { e.addAsset('tree'); } catch(_) {}
      await new Promise(r=>setTimeout(r,1500));
      const ready = (e.objects||[]).filter(o => o.group && o.group.children && o.group.children.length);
      if (ready.length) e.select(ready[ready.length-1]);
      else if (e.objects && e.objects.length) e.select(e.objects[e.objects.length-1]);
    }
    // ③ 加一个镜头（video/export、render_batch 要用）
    const tl = window.__studioTimeline || window.__wbTimeline;
    const has = tl && tl.getShots && tl.getShots().length;
    if (!has) { try { await window.WB_AGENT.run('shot.add', { name:'验收镜头', duration:1 }); } catch(_) {} }
    return true;
  `);
  await wait(500);
}
for (const d of cmdDefs) {
  const args = guessArgs({ required: d.params, props: {} });
  // 专属修正
  if (d.name === 'light.preset') { args.name = REAL_LIGHT; args.preset = REAL_LIGHT; }
  if (d.name === 'world.osm') { args.url = 'http://127.0.0.1:8787/osm/world/35.01160_135.76810_300.json'; }
  if (d.name === 'panorama.set') { args.url = REAL_IMAGE; }
  if (d.name === 'device.add') { args.kind = 'phone'; args.x = 5; args.y = 1.7; args.z = 8; args.lookX = 0; args.lookY = 1; args.lookZ = 0; }
  if (d.name === 'device.aim') { args.yaw = 30; args.pitch = -10; args.fov = 50; }
  if (d.name === 'device.look') { args.target = [0, 1, 0]; }
  if (d.name === 'device.shoot') { args.type = 'image'; }
  if (/transform|delete|drop|array|save_material|video\.export/.test(d.name)) await prepare();
  if (/device\.aim|device\.look|device\.shoot/.test(d.name)) {
    // 每次都**重建**一个干净机位（前面 device.remove 可能把旧的删了）
    const did = await cdp.eval(`
      const e = window.__wb.editor;
      for (const d of (e.devices||[]).slice()) { try { e.removeDevice(d.id); } catch(_) {} }
      try { await window.WB_AGENT.run('device.add',{ kind:'phone', x:5, y:1.7, z:8, lookX:0, lookY:1, lookZ:0 }); } catch(_) {}
      await new Promise(r=>setTimeout(r,600));
      const d = (e.devices||[])[0];
      return d ? d.id : null;`);
    await wait(400);
    if (did) { args.id = did; }
  }
  const t0 = Date.now();
  tryCall('cmd', d.name, args);
  await wait(120);
}

/* ══════════ ② MCP 工具 ══════════ */
console.log('\n════ MCP 工具 (' + toolDefs.length + ') ════');

/* 先探测出真实的 id（预设 / 资产库 / 收件箱 / 设备 / 镜头），否则这些工具必然"找不到" */
const ids = await cdp.eval(`
  const B='http://127.0.0.1:8787/tool';
  const call = async (n,a={}) => { try { return await (await fetch(B,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:n,args:a})})).json(); } catch(e){ return {ok:false,error:String(e)}; } };
  // ★ 有些工具的返回是**顶层**（{ok, presets:[...]}），有些包在 data 里
  //   （这坑踩过：wb_world_build 的 stats 也在顶层）⇒ 两边都看。
  const pick = (j, keys) => {
    for (const src of [j, j && j.data]) {
      if (!src) continue;
      for (const k of keys) {
        if (Array.isArray(src[k])) return src[k];
        if (src[k] && typeof src[k] === 'object') {
          for (const k2 of ['items','files','list','presets','assets']) {
            if (Array.isArray(src[k][k2])) return src[k][k2];
          }
        }
      }
    }
    return [];
  };
  await call('wb_preset_save',{name:'验收预设'});
  const pl = await call('wb_preset_list',{});
  const presets = pick(pl, ['presets','items','list']);
  const ll = await call('wb_library_list',{});
  const libs = pick(ll, ['items','assets','list','library']);
  const ib = await call('wb_inbox_scan',{});
  const inbox = pick(ib, ['items','files','list']);
  const dl = await call('wb_device_list',{});
  const devs = pick(dl, ['devices','items','list']);
  const sl = await call('wb_shot_list',{});
  const shots = pick(sl, ['shots','items','list']);
  const al = await call('wb_asset_list',{});
  const assets = pick(al, ['assets','items','list']);
  // ★ VideoForge 侧的**受管资产**（wb_studio_render / handoff 要用）
  let vfAssets = [];
  try {
    const vr = await fetch('http://127.0.0.1:8798/api/studio/assets');
    const vj = await vr.json();
    vfAssets = (vj.data && vj.data.assets) || vj.assets || [];
  } catch(_){}
  // ★ previz 的真实 id（白膜模型 / 白膜场景）
  const pv = await call('wb_previz_list', {});
  const pvData = pv.data || pv;
  const pvModels = pvData.models || [];
  const pvScenes = pvData.scenes || [];

  // ★ 单独再存一个预设（给 rename 用 —— 前面 delete 会把第一个删掉）
  await call('wb_preset_save',{name:'验收预设2'});
  const pl2 = await call('wb_preset_list',{});
  const presets2 = pick(pl2, ['presets','items','list']);
  const p2 = presets2.find(p => (p.id||p.name) !== (presets[0] && (presets[0].id || presets[0].name)));
  return {
    presetId: presets[0] && (presets[0].id || presets[0].name),
    preset2Id: p2 && (p2.id || p2.name),
    previzModelId: pvModels[0] && pvModels[0].id,
    previzSceneId: pvScenes[0] && (pvScenes[0].scene_id || pvScenes[0].id),
    libId: libs[0] && (libs[0].id || libs[0].name),
    inboxFile: null,     // ← Node 侧扫（下面）
    devId: devs[0] && (devs[0].id || devs[0].name),
    shotId: shots[0] && (shots[0].id || shots[0].label),
    shotCount: shots.length,
    assetId: assets[0] && (assets[0].id || assets[0].name),
    vfAssetId: vfAssets[0] && vfAssets[0].id,
    glb: null,           // ← Node 侧扫（下面）
  };
`);

/* ── Node 侧扫磁盘（页面里没有 node:fs） ───────────────────────────── */
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const vfAssetsDir = `${path.join(defaultDataDir(), 'studio_bridge', 'assets')}`;
  if (fs.existsSync(vfAssetsDir)) {
    for (const d of fs.readdirSync(vfAssetsDir)) {
      const p = path.join(vfAssetsDir, d, 'model.glb');
      if (fs.existsSync(p)) { ids.glb = p; break; }
    }
  }
  const ibox = `${defaultOutDir()}\\外部素材收件箱`;
  if (fs.existsSync(ibox)) {
    const f = fs.readdirSync(ibox).find((x) => /\.(glb|gltf|png|jpe?g)$/i.test(x));
    if (f) ids.inboxFile = f;
  }
  console.log('  Node 侧扫到:', JSON.stringify({ glb: ids.glb, inboxFile: ids.inboxFile }));
}
console.log('  探测:', JSON.stringify(ids));
if (ids.presetId) REAL_PRESET = ids.presetId;
if (ids.libId) REAL_LIB = ids.libId;
if (ids.inboxFile) REAL_INBOX_FILE = ids.inboxFile;
const REAL_DEV = ids.devId || null;
const REAL_SHOT = ids.shotId || null;
const REAL_SCENE_ASSET = ids.assetId || REAL_ASSET;
const REAL_VF_ASSET = ids.vfAssetId || null;
const REAL_GLB = ids.glb || null;

/** 每个工具的**专属**参数（通用猜测靠不住：很多工具要真实 id / 真实枚举） */
function specificArgs(name, base) {
  const a = { ...base };
  switch (name) {
    case 'wb_preset_load': case 'wb_preset_delete':
      a.id = REAL_PRESET || a.id; a.preset = REAL_PRESET || a.preset; a.name = REAL_PRESET || a.name; break;
    case 'wb_library_remove': a.id = REAL_LIB || a.id; break;
    case 'wb_inbox_import': case 'wb_library_import_model':
      a.file = REAL_INBOX_FILE || a.file; a.path = REAL_INBOX_FILE || a.path;
      a.name = REAL_INBOX_FILE || a.name; break;
    case 'wb_render_batch': a.shots = REAL_SHOT ? [{ id: REAL_SHOT }] : [{ index: 0 }]; break;
    case 'wb_video': a.download = false; a.mode = 'white'; break;
    case 'wb_device_aim': case 'wb_device_look': case 'wb_device_shoot':
      a.id = REAL_DEV || a.id; a.device_id = REAL_DEV || a.device_id;
      a.yaw = 30; a.pitch = -10; a.fov = 50; a.target = [0, 1, 0]; a.type = 'image'; break;
    case 'wb_studio_render': a.asset_id = REAL_VF_ASSET || a.asset_id; a.w = 320; a.h = 320; a.frames = 2; a.samples = 32; break;
    case 'wb_asset_upload': {
      // 传真 GLB 路径（不是目录）
      const p = REAL_GLB;
      a.path = p; a.glb_path = p; break;
    }
    case 'wb_handoff': a.asset_id = REAL_VF_ASSET || a.asset_id; a.seconds = 1; a.fps = 8; a.width = 320; a.height = 320; a.use_page_track = false; a.wait_ms = 180000; a.poll_ms = 2000; break;
    case 'wb_previz_import_model': a.asset_id = ids.previzModelId || a.asset_id; a.id = ids.previzModelId || a.id; a.file = REAL_GLB || a.file; a.path = REAL_GLB || a.path; break;
    case 'wb_previz_import_scene': a.scene_id = ids.previzSceneId || a.scene_id; a.id = ids.previzSceneId || a.id; a.file = REAL_GLB || a.file; a.path = REAL_GLB || a.path; break;
    case 'wb_render_save': case 'wb_render_frames': a.job_id = ''; break;
    case 'wb_splat_results': delete a.id; break;
    case 'wb_light': a.preset = REAL_LIGHT; break;
    case 'wb_raw': a.cmd = 'state.get'; a.args = {}; break;
    case 'wb_world_build': a.kind = 'city'; break;
    case 'wb_splat_cmd': a.tool = 'get_scene'; break;
    case 'wb_preset_rename': a.id = ids.preset2Id || a.id; a.name = '验收预设改名'; a.note = ''; break;
  }
  return a;
}

for (const d of toolDefs) {
  const args = specificArgs(d.name, guessArgs(d));
  if (d.props && d.props.preset && !d.props.preset.enum) args.preset = REAL_LIGHT;
  if (args.id !== undefined && /preset/.test(d.name) && !/rename/.test(d.name)) args.id = REAL_PRESET || args.id;
  if (args.id !== undefined && /library_remove/.test(d.name)) args.id = REAL_LIB || args.id;
  if (args.file !== undefined) args.file = REAL_INBOX_FILE || args.file;
  // 需要上下文的先备好
  if (/transform|drop|array|save_material|delete_selected/.test(d.name)) await prepare();
  if (/^wb_video$|render_batch/.test(d.name)) await prepare();
  if (/building_floor|building_exit/.test(d.name)) {
    await cdp.eval(`
      const e=window.__wb.editor;
      try { await window.WB_AGENT.run('world.build',{kind:'city'}); } catch(_){}
      await new Promise(r=>setTimeout(r,2500));
      try { await window.WB_AGENT.run('building.enter',{}); } catch(_){}
      await new Promise(r=>setTimeout(r,1200));
      return true;`);
    await wait(600);
  }
  if (/device_aim|device_look|device_shoot/.test(d.name)) {
    const did = await cdp.eval(`
      const e = window.__wb.editor;
      for (const d of (e.devices||[]).slice()) { try { e.removeDevice(d.id); } catch(_) {} }
      try { await window.WB_AGENT.run('device.add',{ kind:'phone', x:5, y:1.7, z:8, lookX:0, lookY:1, lookZ:0 }); } catch(_) {}
      await new Promise(r=>setTimeout(r,600));
      const d = (e.devices||[])[0];
      return d ? d.id : null;`);
    await wait(400);
    if (did) { args.id = did; args.device_id = did; }
  }
  // render_save / render_frames 需要**真实 job_id** ⇒ 先跑一次渲染拿一个
  if (/render_save|render_frames/.test(d.name)) {
    if (!REAL_JOB) {
      const r = await cdp.eval(`
        const res = await window.WB_AGENT.run('studio.render.submit', { seconds:1, fps:8, width:320, height:320 });
        return (res && res.data && res.data.job_id) || null;`);
      REAL_JOB = r;
      if (REAL_JOB) {
        // 等它跑完
        for (let i = 0; i < 40; i++) {
          await wait(1500);
          const st = await cdp.eval(`
            const res = await window.WB_AGENT.run('studio.render.status', { job_id: ${JSON.stringify(REAL_JOB)} });
            const d = (res && res.data) || {};
            return d.status;`);
          if (st === 'succeeded' || st === 'failed') break;
        }
      }
    }
    if (REAL_JOB) args.job_id = REAL_JOB;
    else { rec('mcp', d.name, false, '没拿到 job_id（渲染没提交成功）'); continue; }
  }
  const t0 = Date.now();
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await cdp.eval(`
        const res = await fetch('http://127.0.0.1:8787/tool',{method:'POST',headers:{'Content-Type':'application/json'},
          body: JSON.stringify({name: ${JSON.stringify(d.name)}, args: ${JSON.stringify(args)}})});
        const j = await res.json();
        return { ok: j.ok === true, err: j.error || (j.data && j.data.error) || null };
      `);
      last = { ok: r.ok && !r.err, err: r.err || (r.ok ? null : 'ok=false') };
    } catch (e) {
      last = { ok: false, err: e.message };
    }
    if (last.ok) break;
    await wait(800);
  }
  rec('mcp', d.name, last.ok, last.err, Date.now() - t0);
  await wait(120);
}

/* ── 汇总 ─────────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.ok);
const byKind = {};
for (const r of results) {
  byKind[r.kind] = byKind[r.kind] || { pass: 0, fail: 0 };
  byKind[r.kind][r.ok ? 'pass' : 'fail']++;
}
console.log('\n════ 汇总 ════');
for (const [k, v] of Object.entries(byKind)) console.log(`  ${k}: ${v.pass} 通过 / ${v.fail} 失败`);
console.log(`  合计: ${results.length - failed.length} / ${results.length}`);

if (failed.length) {
  console.log('\n════ 失败清单 ════');
  const groups = {};
  for (const f of failed) {
    const key = (f.err || '').replace(/[0-9a-f]{8,}/g, 'X').slice(0, 90);
    (groups[key] ||= []).push(f.kind + ' ' + f.name);
  }
  for (const [k, v] of Object.entries(groups)) {
    console.log(`\n  【${v.length} 个】${k}`);
    console.log('    ' + v.join(', '));
  }
  fs.writeFileSync(`${defaultShotsDir()}\\ovf-full-accept.json`,
    JSON.stringify(results, null, 2), 'utf8');
  console.log('\n  详细记录: ovf-full-accept.json');
}

await cdp.close();
process.exit(failed.length ? 1 : 0);
