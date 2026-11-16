#!/usr/bin/env node
/** patch-frames-and-ab.mjs —— 桥侧：帧级进度工具 wb_render_frames（v35） */
import fs from 'node:fs';

const FILE = 'server/agent-bridge.mjs';
let src = fs.readFileSync(FILE, 'utf8');
const MARK = '/* ==== FRAME PROGRESS v35 ==== */';
if (src.includes(MARK)) { console.log('already patched'); process.exit(0); }

// 1) 实现
const callAnchor = `async function callTool(name, args = {}) {`;
if (!src.includes(callAnchor)) throw new Error('callTool anchor missing');
const impl = `
${MARK}
/** 帧级进度：直接扫 VideoForge 任务目录，返回已渲染帧数 + 最新帧 URL */
async function renderFrames(args = {}) {
  try {
    const path = require('node:path'), fsp = require('node:fs');
    const jobId = String(args.job_id || '');
    if (!jobId) return { ok: false, error: '缺少 job_id' };
    const base = path.join(process.env.LOCALAPPDATA || process.env.HOME || '.', 'VideoForge', 'data', 'studio_bridge', 'jobs', jobId);
    const framesDir = path.join(base, 'frames');
    let files = [];
    try { files = fsp.readdirSync(framesDir).filter(f => /^frame_\\d+\\.png$/.test(f)).sort(); } catch (_) { files = []; }
    const latest = files.length ? files[files.length - 1] : null;
    const idx = latest ? Number(latest.match(/(\\d+)/)[1]) : -1;
    const total = Number(args.total) || null;
    return {
      ok: true,
      data: {
        job_id: jobId,
        frames_dir: framesDir,
        count: files.length,
        latest_index: idx,
        total,
        latest_url: latest ? '/api/studio/renders/' + encodeURIComponent(jobId) + '/files/' + latest : null,
        latest_path: latest ? path.join(framesDir, latest) : null,
      },
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}
${MARK}
`;
src = src.replace(callAnchor, impl + callAnchor);

// 2) 拦截
src = src.replace(`async function callTool(name, args = {}) {
  // v33 交接层：磁盘 GLB 登记 / 一键流水线 / 交接体检`,
`async function callTool(name, args = {}) {
  // v35：帧级进度
  if (name === 'wb_render_frames') return renderFrames(args);
  // v33 交接层：磁盘 GLB 登记 / 一键流水线 / 交接体检`);

// 3) 注册工具
const anchor = `TOOLS.push({
  name: 'wb_asset_upload',`;
src = src.replace(anchor, `TOOLS.push({
  name: 'wb_render_frames',
  description: '帧级进度：扫任务目录返回已渲染帧数、最新帧索引与可直接显示的 PNG URL（job_id, 可选 total）',
  schema: { type: 'object', properties: { job_id: { type: 'string' }, total: { type: 'number' } }, required: ['job_id'] },
});
${anchor}`);

fs.writeFileSync(FILE, src);
console.log('frames tool patched:', src.includes('renderFrames') ? 'ok' : 'FAILED');
