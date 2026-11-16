#!/usr/bin/env node
/* ==========================================================================
 * server/mcp-entry.mjs —— 纯 MCP 入口
 *
 * 用途：给 MCP 客户端一个**固定路径**的启动文件，不必记 `--mcp` 参数。
 *   { "command": "node", "args": ["<repo>/server/mcp-entry.mjs"] }
 *
 * 行为：等价于 `node server/agent-bridge.mjs --mcp`
 *   · stdio = MCP 通道（JSON-RPC 2.0，逐行 JSON）
 *   · 同时监听本机 HTTP 端口（默认 8787），页面/工具共用同一份状态
 * ========================================================================== */
process.argv.push('--mcp');
await import('./agent-bridge.mjs');
