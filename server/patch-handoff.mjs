#!/usr/bin/env node
/**
 * patch-handoff.mjs —— 给 agent-bridge 增加「Agent→工作台→Blender」无缝衔接层
 *   1) wb_asset_upload   磁盘 GLB 直接登记（Agent/Blender 产物无需浏览器选择）
 *   2) wb_handoff        一条命令跑完：上传→导入→轨迹→提交→盯进度→下载产物到输出目录
 *   3) wb_handoff_check  交接前的一致性体检（资产/实例/帧数/轨迹/坐标前提）
 *   4) POST /tool        直接调用任意 wb_* 工具（便于 CLI/agent 平台/自动化测试）
 * 幂等：重复执行不会重复插入（用标记字符串判断）。
 */
import fs from 'node:fs';

const FILE = 'server/agent-bridge.mjs';
let src = fs.readFileSync(FILE, 'utf8');
const MARK = '/* ==== HANDOFF LAYER v33 ==== */';
if (src.includes(MARK)) { console.log('already patched'); process.exit(0); }

/* ---------- 1) 注入路由：POST /tool ---------- */
const routeAnchor = `  if (req.url === '/cmd' && req.method === 'POST') {`;
if (!src.includes(routeAnchor)) throw new Error('route anchor missing');
src = src.replace(routeAnchor, `  // 直接调用任意 wb_* 工具（CLI / agent 平台 / 自动化测试用）
  if (req.url === '/tool' && req.method === 'POST') {
    readJson(req, async (body) => {
      const out = await callTool(body.name, body.args || {});
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }

${routeAnchor}`);

/* ---------- 2) 注入工具实现（放在 callTool 之前） ---------- */
const callAnchor = `async function callTool(name, args = {}) {`;
if (!src.includes(callAnchor)) throw new Error('callTool anchor missing');

const layer = `
${MARK}
const STUDIO_BASE = 'http://127.0.0.1:8765/api/studio';

function pageCall(name, args, timeoutMs = 30000) {
  return dispatch(name, args || {}, timeoutMs);
}

async function studioGet(path) {
  const r = await fetch(STUDIO_BASE + path, { signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  if (!r.ok || j.code !== '000000') throw new Error(j.detail?.message || j.detail || j.message || 'Blender 服务请求失败');
  return j.data;
}

/** 把磁盘上的 GLB 直接登记进 VideoForge（Agent/Blender 产物的入口） */
async function uploadAssetFromDisk(filePath, name) {
  try {
    const fsp = require('node:fs'), path = require('node:path');
    if (!filePath) return { ok: false, error: '缺少 path' };
    if (!fsp.existsSync(filePath)) return { ok: false, error: '文件不存在：' + filePath };
    const stat = fsp.statSync(filePath);
    if (stat.size > 200 * 1024 * 1024) return { ok: false, error: 'GLB 超过 200MB，请先减面' };
    const buf = fsp.readFileSync(filePath);
    const fname = String(name || path.basename(filePath)).replace(/["\\r\\n]/g, '_');
    const boundary = '----wbhandoff' + randomUUID().replace(/-/g, '');
    const head = Buffer.from('--' + boundary + '\\r\\nContent-Disposition: form-data; name="file"; filename="' + fname +
      '"\\r\\nContent-Type: model/gltf-binary\\r\\n\\r\\n');
    const tail = Buffer.from('\\r\\n--' + boundary + '--\\r\\n');
    const body = Buffer.concat([head, buf, tail]);
    const r = await fetch(STUDIO_BASE + '/assets', {
      method: 'POST',
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body,
      signal: AbortSignal.timeout(120000),
    });
    const j = await r.json();
    if (!r.ok || j.code !== '000000') return { ok: false, error: j.detail?.message || j.detail || j.message || '上传失败' };
    return { ok: true, data: { ...j.data, source_path: filePath, source_bytes: buf.length } };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 下载 Blender 产物到统一输出目录，返回本地绝对路径 */
async function downloadToOut(url, name) {
  try {
    const path = require('node:path'), fsp = require('node:fs');
    fsp.mkdirSync(OUT_DIR, { recursive: true });
    const abs = new URL(url, 'http://127.0.0.1:8765').href;
    const r = await fetch(abs, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) return { ok: false, error: '下载失败 HTTP ' + r.status };
    const buf = Buffer.from(await r.arrayBuffer());
    let target = path.join(OUT_DIR, String(name).replace(/[\\\\/:*?"<>|]/g, '_'));
    const ext = path.extname(target), base = target.slice(0, target.length - ext.length);
    let i = 1;
    while (fsp.existsSync(target)) target = base + '_' + (i++) + ext;
    fsp.writeFileSync(target, buf);
    return { ok: true, path: target, bytes: buf.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 一条命令跑完整条流水线（职责分工：Agent 造 → 工作台排 → VideoForge 渲）
 * args: { glb_path?|asset_id?, name?, seconds?, fps?, width?, height?, turns?, camera_keys?, fov?,
 *         prefix?, wait_ms?, poll_ms?, project_id?, shot_id?, download? }
 */
async function handoff(args = {}) {
  const steps = [];
  const t0 = Date.now();
  const render = {
    seconds: Number(args.seconds) || 3,
    fps: Number(args.fps) || 24,
    width: Number(args.width) || 640,
    height: Number(args.height) || 360,
  };
  let assetId = args.asset_id || '';
  let instanceId = '';

  if (!assetId) {
    if (!args.glb_path) return { ok: false, error: '需要 glb_path（Blender 导出的 .glb）或 asset_id', steps };
    const up = await uploadAssetFromDisk(args.glb_path, args.name);
    steps.push({ step: 'upload', ok: up.ok, asset_id: up.data?.id, bytes: up.data?.source_bytes, error: up.error });
    if (!up.ok) return { ok: false, error: up.error, steps };
    assetId = up.data.id;
  }

  const imp = await pageCall('studio.asset.import', { asset_id: assetId }, args.import_timeout_ms || 60000);
  steps.push({ step: 'import', ok: imp.ok, instance_id: imp.data?.instance_id, error: imp.error });
  if (!imp.ok) return { ok: false, error: imp.error, steps, asset_id: assetId };
  instanceId = imp.data?.instance_id;

  const trk = args.camera_keys
    ? await pageCall('studio.track.set', { camera: { keys: args.camera_keys, vertical_fov: Number(args.fov) || 45 }, render }, 60000)
    : await pageCall('studio.track.orbit', { ...render, turns: args.turns == null ? 1 : Number(args.turns) }, 60000);
  steps.push({ step: 'track', ok: trk.ok, detail: trk.ok ? trk.data : trk.error });
  if (!trk.ok) return { ok: false, error: trk.error, steps, asset_id: assetId, instance_id: instanceId };

  const sub = await pageCall('studio.render.submit', render, args.submit_timeout_ms || 120000);
  steps.push({ step: 'submit', ok: sub.ok, job_id: sub.data?.job_id, error: sub.error });
  if (!sub.ok) return { ok: false, error: sub.error, steps, asset_id: assetId, instance_id: instanceId };
  const jobId = sub.data.job_id;

  // 让页面 HUD 接管（用户能看到进度；失败也不影响后台任务）
  pageCall('studio.render.watch', { job_id: jobId }, 4000).catch(() => {});

  let state = null;
  const deadline = Date.now() + (Number(args.wait_ms) || 240000);
  const pollMs = Math.max(300, Number(args.poll_ms) || 900);
  while (Date.now() < deadline) {
    try { state = await studioGet('/renders/' + encodeURIComponent(jobId)); }
    catch (e) { steps.push({ step: 'poll', error: String(e.message || e) }); }
    if (state && ['succeeded', 'failed', 'cancelled'].includes(String(state.status))) break;
    steps.push({ step: 'poll', status: state?.status, progress: state?.progress });
    await new Promise(r => setTimeout(r, pollMs));
  }

  const files = [];
  if (state && state.status === 'succeeded') {
    for (const f of (state.manifest?.outputs || [])) {
      const ext = f.kind === 'video' ? '.mp4' : '.png';
      const label = f.kind === 'video' ? 'mp4' : (f.kind === 'first_frame' ? 'png' : f.kind);
      const name = (args.prefix || 'Blender白膜') + '_' + String(jobId).slice(4, 12) + '_' + label + ext;
      const saved = args.download === false ? { ok: true, path: null, bytes: f.bytes } : await downloadToOut(f.url, name);
      files.push({ kind: f.kind, bytes: f.bytes, sha256: f.sha256, path: saved.path || null, error: saved.error });
    }
  }

  const ok = !!state && state.status === 'succeeded';
  return {
    ok,
    data: {
      job_id: jobId,
      status: state?.status || 'unknown',
      progress: state?.progress,
      blender: state?.manifest?.blender_version,
      render: state?.manifest?.render,
      validation: state?.manifest?.validation,
      asset_id: assetId,
      instance_id: instanceId,
      files,
      out_dir: OUT_DIR,
      elapsed_ms: Date.now() - t0,
    },
    steps,
    error: ok ? undefined : (state?.error || '渲染未成功：' + (state?.status || 'timeout')),
  };
}

/** 交接体检：导出一次规范场景，检查资产登记/实例/帧数/轨迹/坐标前提 */
async function handoffCheck(args = {}) {
  const issues = [];
  const opt = { seconds: Number(args.seconds) || 3, fps: Number(args.fps) || 24, width: Number(args.width) || 640, height: Number(args.height) || 360 };
  const exp = await pageCall('studio.scene.export', opt, 120000);
  if (!exp.ok) return { ok: false, error: exp.error, issues: ['场景导出失败：' + exp.error] };
  const sc = exp.data && exp.data.scene ? exp.data.scene : exp.data;
  if (!sc || sc.schema !== 'videoforge.scene/1') issues.push('导出结果不是 videoforge.scene/1');
  const assets = sc?.assets || [], instances = sc?.instances || [], keys = sc?.camera?.keys || [];
  if (!assets.length) issues.push('没有登记资产（assets 为空）');
  if (!instances.length) issues.push('没有实例（instances 为空）');
  if (!(sc?.render?.frame_count > 0)) issues.push('render.frame_count 无效');
  if (!keys.length) issues.push('相机轨迹为空');
  if (keys.length && keys[0].frame !== 0) issues.push('轨迹不是从第 0 帧开始');
  const last = keys.length ? keys[keys.length - 1].frame : -1;
  if (keys.length && last >= (sc?.render?.frame_count || 0)) issues.push('轨迹帧 ' + last + ' 超出渲染帧数 ' + sc?.render?.frame_count);
  if (keys.some(k => !k.position || !k.target)) issues.push('关键帧缺 position/target');
  if (sc?.coordinates?.up !== 'Z') issues.push('坐标系不是 Z-up（规范要求右手 Z-up）');
  try {
    const reg = await studioGet('/assets');
    const ids = new Set((reg.assets || []).map(a => a.id));
    for (const a of assets) if (!ids.has(a.id)) issues.push('资产未在服务登记：' + a.id);
  } catch (e) { issues.push('资产服务不可用：' + e.message); }
  return {
    ok: issues.length === 0,
    data: { scene_id: sc?.scene_id, revision: sc?.revision, assets: assets.length, instances: instances.length, frames: sc?.render?.frame_count, keys: keys.length, coordinates: sc?.coordinates },
    issues,
  };
}
${MARK}
`;

src = src.replace(callAnchor, layer + callAnchor);

/* ---------- 3) callTool 里拦截三个新工具 ---------- */
const intercept = `async function callTool(name, args = {}) {
  // v33 交接层：磁盘 GLB 登记 / 一键流水线 / 交接体检
  if (name === 'wb_asset_upload') return uploadAssetFromDisk(args.path || args.glb_path, args.name);
  if (name === 'wb_handoff') return handoff(args);
  if (name === 'wb_handoff_check') return handoffCheck(args);
`;
src = src.replace(callAnchor, intercept);

/* ---------- 4) 注册 MCP 工具与描述 ---------- */
const toolAnchor = `})) TOOLS.push({name,description,schema:{type:'object',additionalProperties:true,properties:{}}});`;
src = src.replace(toolAnchor, `${toolAnchor}
TOOLS.push({
  name: 'wb_asset_upload',
  description: '把磁盘上的 GLB 直接登记进 Blender 服务（Agent/Blender 产物入口，无需浏览器选择文件）：path',
  schema: { type: 'object', properties: { path: { type: 'string' }, name: { type: 'string' } }, required: ['path'] },
});
TOOLS.push({
  name: 'wb_handoff',
  description: '一条命令跑完整条流水线：上传 GLB → 导入工作台 → 生成轨迹 → 提交 Blender → 盯进度 → 产物下载到输出目录。返回 job_id / 文件本地路径 / manifest 摘要 / 分步 steps',
  schema: { type: 'object', properties: {
    glb_path: { type: 'string' }, asset_id: { type: 'string' }, name: { type: 'string' },
    seconds: { type: 'number' }, fps: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
    turns: { type: 'number' }, camera_keys: { type: 'array' }, fov: { type: 'number' },
    prefix: { type: 'string' }, wait_ms: { type: 'number' }, poll_ms: { type: 'number' },
    project_id: { type: 'string' }, shot_id: { type: 'string' }, download: { type: 'boolean' },
  } },
});
TOOLS.push({
  name: 'wb_handoff_check',
  description: '交接前体检：导出规范场景并检查资产登记/实例/帧数/轨迹起点/坐标前提，返回 issues 列表',
  schema: { type: 'object', properties: { seconds: { type: 'number' }, fps: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } },
});`);

fs.writeFileSync(FILE, src);
console.log('handoff layer patched:', src.includes(MARK) ? 'ok' : 'FAILED');
