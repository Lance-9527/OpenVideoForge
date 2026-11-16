# OpenVideoForge · 快速开始

> 一个"本地运行、数据不出机器"的白膜预演工作台：
> **Agent 造模型 → 工作台摆位/运镜/时间线 → Blender（可选）出成片**。

---

## 1. 启动（Windows 最简单）

双击 **`START.bat`**。

它会做三件事：
1. 检查 Node.js（没有会提示去 nodejs.org 装 18+）
2. 起页面服务（默认 `8802`）和本地桥（默认 `8787`）
3. 自动打开浏览器 `http://127.0.0.1:8802/index.html`

命令行等价写法：

```bash
node bin/cli.mjs open          # 起服务 + 开浏览器
node bin/cli.mjs serve         # 只起服务（无 GUI / 远程）
node bin/cli.mjs mcp           # 以 MCP stdio 服务（给 Agent 接入）
```

可选参数：`--port 8787`（桥）、`--static-port 8802`（页面）、`--out "<输出目录>"`（产物目录）。

---

## 2. 五分钟上手

1. 入口选一个**场景模板**（空房间 / 街道 / 影棚…）→ 进编辑器
2. 左侧「模型」加资产；「我的资产」是你导入的 GLB
3. 选中物体：拖它移动 · 拖**琥珀水平环**转圈 · 拖**蓝色竖直环**倾斜
4. 「轨迹」面板：选目标 → 画轨迹 → 时间线拖起止/速度 → **🎬 拍成片**
5. 产物落在输出目录（默认 `<输出目录>`）

---

## 3. 要不要装 Blender？

| | 不装 Blender | 装 Blender 4.2 + 渲染服务 |
|---|---|---|
| 出片方式 | 浏览器内置录制（实时） | 离线渲染（更清晰、带帧校验） |
| 入口 | 「🎬 拍成片」自动降级 | 面板「渲染器」显示 `Blender 在线` |
| 适合 | 预演确认 / 客户过稿 | 交付成片 |

面板会自动探测，不需要你手动切。

---

## 4. Agent 接入（MCP）

```jsonc
{
  "mcpServers": {
    "openvideoforge": {
      "command": "npx",
      "args": ["-y", "openvideoforge", "mcp"],
      "env": { "WBWB_OUT_DIR": "<输出目录>" }
    }
  }
}
```

或在本地直接：`node server/mcp-entry.mjs`（stdio MCP，47 个工具）。
Agent 操作手册见 `plugin/SKILL.md`。

---

## 5. 目录里有什么

```
START.bat              一键启动
bin/cli.mjs            命令行入口（open/serve/mcp）
index.html             页面（零构建）
js/ css/ assets/       前端代码与视频/logo
server/agent-bridge.mjs HTTP + SSE + MCP 桥
server/mcp-entry.mjs   MCP stdio 入口
plugin/                Agent 插件（plugin.json + SKILL.md）
examples/              示例（电商棚拍全流程）
docs/                  协议 / 打包 / 截图
tests/                 导入校验 / CLI 冒烟 / MCP 握手
agent-side/            Blender 建模脚本（沙发、门楼）
```

---

## 6. 常见问题

- **端口被占用**：`node bin/cli.mjs open --port 8788 --static-port 8803`
- **页面空白**：确认 Node 18+；开控制台看报错；`node tests/imports.mjs` 查模块导入
- **点「拍成片」没反应**：先画一条**机位轨迹**（轨迹面板 → 画机位轨迹）
- **产物在哪**：`<输出目录>`，或启动时 `--out` 指定
- **数据会上传吗**：不会。全部本机 localStorage + 本机 8765 资产库，无遥测

---

## 7. 许可

本项目代码 MIT（见 `LICENSE`）；three.js 等第三方许可见 `THIRD-PARTY-NOTICES.md`。