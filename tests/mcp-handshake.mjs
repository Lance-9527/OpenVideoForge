#!/usr/bin/env node
/* ==========================================================================
 * tests/mcp-handshake.mjs —— MCP stdio 冒烟测试（不依赖页面/Blender）
 *
 * 起一个隔离的桥（端口 8799，产物目录用临时目录），走 JSON-RPC：
 *   initialize → notifications/initialized → tools/list → tools/call(wb_state)
 * 断言：协议版本、工具数 ≥ 30、关键工具存在、调用返回 ok。
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8799;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'wbwb-test-'));

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'agent-bridge.mjs'), '--mcp', '--port', String(PORT), '--out', OUT], {
  cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'],
});

const pending = new Map();
const rl = createInterface({ input: child.stdout });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s.startsWith('{')) return;
  let msg; try { msg = JSON.parse(s); } catch (_) { return; }
  if (msg.id != null && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
let stderr = '';
child.stderr.on('data', (d) => { stderr += d.toString(); });

const send = (id, method, params) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('等待超时: ' + method)), 15000);
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});

const fail = (msg) => { console.error('✗ ' + msg); try { child.kill(); } catch (_) {} process.exit(1); };
const ok = (msg) => console.log('✓ ' + msg);

try {
  const init = await send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'wbwb-test', version: '0' } });
  if (init.result?.protocolVersion !== '2024-11-05') fail('initialize 协议版本异常: ' + JSON.stringify(init.result));
  ok('initialize · ' + init.result.serverInfo.name + '@' + init.result.serverInfo.version);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await send(2, 'tools/list', {});
  const tools = list.result?.tools || [];
  if (tools.length < 30) fail('工具数不足: ' + tools.length);
  const names = new Set(tools.map(t => t.name));
  for (const need of ['wb_state', 'wb_asset_upload', 'wb_handoff', 'wb_render_save', 'wb_render_frames', 'wb_scene_new']) {
    if (!names.has(need)) fail('缺少工具: ' + need);
  }
  ok('tools/list · ' + tools.length + ' 个工具，关键工具齐全');

  const call = await send(3, 'tools/call', { name: 'wb_state', arguments: {} });
  const text = call.result?.content?.[0]?.text || '';
  // 允许 isError（没开页面时 wb_state 必然 false），只要有结构化返回就算通路 OK
  if (!call.result) fail('tools/call 没有 result: ' + text.slice(0, 200));
  const data = JSON.parse(text);
  // 没开页面时 wb_state 会返回 ok:false（isError:true），只要 JSON 结构对就说明 tools/call 通链路正常
  if (typeof data.ok !== 'boolean') fail('tools/call 返回不是合法 JSON: ' + text.slice(0, 200));
  ok('tools/call(wb_state) · 通路正常（ok=' + data.ok + '）');

  try { child.kill(); } catch (_) {}
  console.log('\nMCP 冒烟测试通过（' + tools.length + ' 工具）');
  process.exit(0);
} catch (e) {
  fail(e.message + (stderr ? '\n桥 stderr:\n' + stderr.slice(0, 800) : ''));
}
