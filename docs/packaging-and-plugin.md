# 打包与分发方案：白膜工作台 → Agent 插件 / MCP Server

> 状态：**方案稿，未执行**（不发布 npm、不建 GitHub 仓库、不动远端）。
> 目标：让任何支持 MCP 的 Agent（DSH / Claude Code / Cursor / 自研）用一条配置接入本产品，
> 同时保留"人也能直接开网页用"的形态。

---

## 一、先说结论（三层拆开卖）

| 层 | 交付物 | 是否必需 | 备注 |
|---|---|---|---|
| **L1 工作台页面** | `product/` 静态站点（零构建，ES module + three.js r160 本地镜像） | 必需 | 双击/任意静态服务器即可打开 |
| **L2 桥 + MCP** | `server/agent-bridge.mjs`（Node ≥18，**零第三方依赖**） | 必需（Agent 接入靠它） | 同时是 HTTP API + MCP stdio server + 输出落盘 |
| **L3 渲染器** | VideoForge 服务（8765，Blender 4.2.1） | 可选 | 没有它也能用页面渲染出图；有它才能出高质量 MP4 |

打包成一个 npm 包 `whitebox-workbench`，三个 bin 子命令：

```bash
npx whitebox-workbench open      # 起静态服务 + 桥，自动开浏览器
npx whitebox-workbench mcp       # 只起 MCP（stdio），给 Agent 用
npx whitebox-workbench serve     # 只起 HTTP（无 GUI 场景 / 远程）
```

---

## 二、仓库结构（开源版）

```
whitebox-workbench/
├─ package.json                 # bin: wbwb → bin/cli.mjs；engines.node >= 18
├─ LICENSE                      # MIT（本项目代码）
├─ THIRD-PARTY-NOTICES.md       # three.js r160 (MIT)、GLTFLoader/Exporter (MIT)
├─ README.md                    # 3 张图 + 30 秒上手 + 工具表 + 截图
├─ bin/cli.mjs                  # serve / mcp / open 三个子命令
├─ product/                     # 静态站点（原样保留，无构建）
│  ├─ index.html                # ?v=NN 版本串在打包时统一注入
│  ├─ js/ css/ vendor/
│  └─ docs/                     # 协议、截图、示例
├─ server/
│  ├─ agent-bridge.mjs          # HTTP + SSE + MCP stdio（35 个 wb_* 工具）
│  └─ mcp-entry.mjs             # 纯 stdio 入口（不依赖 HTTP 端口占用）
├─ examples/
│  ├─ sofa_home.glb             # 示例资产（自建，无版权问题）
│  ├─ room_studio.json          # 示例场景（场景 + 灯光 + 相机轨迹）
│  └─ e2e-demo.md               # 复现"电商棚拍沙发"的命令清单
├─ tests/
│  ├─ unit/                     # 纯函数：坐标转换、轨迹采样、时间窗映射
│  ├─ smoke.mjs                 # 起服务 → 上传 GLB → 出 1 帧（无 Blender 时跳过）
│  └─ fixtures/
└─ .github/workflows/ci.yml     # node --check + tests + 可选 e2e
```

---

## 三、MCP 形态（Agent 怎么接）

### 3.1 配置片段（通用）

```jsonc
// .mcp.json / claude_desktop_config.json / DSH mcp 配置
{
  "mcpServers": {
    "whitebox-workbench": {
      "command": "npx",
      "args": ["-y", "whitebox-workbench", "mcp"],
      "env": {
        "WBWB_OUT_DIR": "<输出目录>",   // 产物目录（可配置）
        "WBWB_PORT": "8787",
        "WBWB_VF_URL": "http://127.0.0.1:8765"   // 可选：VideoForge
      }
    }
  }
}
```

### 3.2 工具面（35 个，按职责分组）

| 组 | 工具 | 用途 |
|---|---|---|
| 场景 | `wb_state` `wb_scene_new` `wb_env_load` `wb_scene_save/load` | 建/存/读场景 |
| 资产 | `wb_asset_add` `wb_asset_list` `wb_asset_upload` `wb_asset_delete` | 加/传模型 |
| 摆放 | `wb_instance_set` `wb_place` `wb_drop` `wb_transform` `wb_delete` | 摆位 |
| 灯光/后处理 | `wb_light` `wb_grade` `wb_exposure` | 打光、调色 |
| 相机 | `wb_camera` `wb_camera_keys` `wb_camera_save/restore` | 机位 |
| 轨迹 | `wb_track_set` `wb_track_orbit` `wb_track_preview` `wb_track_info` | 运镜/物体轨迹 |
| 出图/出片 | `wb_render` `wb_render_submit` `wb_render_status` `wb_render_cancel` `wb_render_watch` `wb_render_frames` `wb_render_save` | 页面出图 / Blender 出片 / 帧级进度 / 下载 |
| 一条龙 | `wb_handoff` `wb_handoff_check` | Agent 造 GLB → 自动排 → 渲 → 落盘 |
| 输出 | `wb_out_dir` `wb_open_out` | 输出目录 |

> 工具契约文档：`docs/agent-protocol.md`（入参/返回/错误码/坐标系），
> 打包时把这份文档放 README 的 "MCP" 一节链接出去。

### 3.3 坐标与单位（必须写进工具描述）

- 页面：右手 **Y-up**、米制（`wb_state` 返回这个）
- 规范场景 / Blender：右手 **Z-up**、米制（`wb_instance_set`、`camera.keys` 用这个）
- 换算：`(x,y,z)_web → (x,-z,y)_canonical`
- 帧数：`frame_count = seconds × fps`；相机 keys 必须从 frame 0 起、末帧 < frame_count

---

## 四、Agent 插件形态（比 MCP 再多一层"会用的说明书"）

MCP 只给工具，Agent 仍不知道怎么干活。所以再发一个 **skill / plugin**：

```
plugins/whitebox-workbench/
├─ plugin.json          # name/version/description/tools/mcp server 引用
├─ SKILL.md             # 工作流：造 → 排 → 渲 → 验收（含 3 个可复制的命令序列）
└─ examples/
   ├─ ecommerce-sofa.md # 电商棚拍：建棚→灯光→沙发→机位→出图→出片
   └─ previz-scene.md   # 预演：摆位→轨迹→时间线→拍成片
```

**plugin.json（示意）**

```jsonc
{
  "name": "whitebox-workbench",
  "version": "1.0.0",
  "description": "白膜预演工作台：建模交给 Blender，排片交给它，出片交给 Blender 渲染",
  "mcp": { "command": "npx", "args": ["-y", "whitebox-workbench", "mcp"] },
  "skills": ["SKILL.md"],
  "requires": { "node": ">=18", "optional": ["VideoForge 8765", "Blender 4.2"] }
}
```

**SKILL.md 的核心三段（给 Agent 的操作守则）**

1. **造**：需要新道具 → 用 Blender 导出 GLB（米制、落地），然后 `wb_asset_upload`；
2. **排**：`wb_scene_new` → `wb_asset_add`/`wb_instance_set` → `wb_light` → `wb_camera` → `wb_track_set`；
3. **渲**：`wb_render`（快速效果图）或 `wb_render_submit`→`wb_render_status`→`wb_render_save`（成片）；
   验收标准：`validation.passed === true` + 产物落进输出目录 + `wb_handoff_check` 无 issues。

---

## 五、开源发布清单（暂不执行）

### 5.1 许可与合规

- 本项目代码：**MIT**（`LICENSE`）
- 第三方：three.js r160 / GLTFLoader / GLTFExporter 均为 MIT → `THIRD-PARTY-NOTICES.md` 保留版权头
- 示例资产（沙发 GLB、房间场景）：自建，无第三方版权
- 不含 VideoForge 的任何代码；文档里只写"需要本地渲染服务"，不捆绑
- 截图里不出现个人路径/用户名（发布前统一替换成相对说明）

### 5.2 安全与隐私

- 服务**只绑 127.0.0.1**（默认），不监听公网
- 无遥测、无外部网络调用（渲染校验里已有 `network_calls: 0` 指标）
- 输出目录由 `WBWB_OUT_DIR` 配置，默认不写系统目录
- 上传接口限制 200MB、只接受 GLB/PNG/JPG/MP4

### 5.3 发布前必须补的

| 项 | 现状 | 动作 |
|---|---|---|
| 单测 | 只有 `node --check` + 手工 e2e | 补 `tests/unit`：坐标转换、轨迹采样、时间窗映射 |
| CI | 无 | GitHub Actions：node 18/20/22 × `node --check` + tests |
| 版本号注入 | `?v=54` 手改 | 打包脚本统一注入 `__WB_VERSION__` |
| 示例复现 | 散在会话里 | 写成 `examples/e2e-demo.md` 命令清单 |
| 文档 | README 中文为主 | 补英文 README（开源受众） |
| 演示素材 | 有 MP4/PNG | 压成 10s GIF 放 README 顶部 |

### 5.4 发布步骤（待你点头后再做）

1. `npm pack` → 本地 `npx ./whitebox-workbench-1.0.0.tgz mcp` 全流程自测
2. `git init` + 首次提交（剔除 `_agent/`、`*.log`、绝对路径）
3. GitHub 私有仓库 → 跑 CI → 转 public
4. `npm publish --access public`（或先发 GitHub Release 的 tarball）
5. 在 README 放 3 行接入示例 + 插件目录

---

## 六、版本与兼容

- 包版本：`1.x`（工具面稳定后封 1.0）
- 页面资源版本：`?v=NN` 只影响浏览器缓存，**不跟包版本绑定**，由构建注入
- MCP 协议：`protocol: 1`；工具增删记 `CHANGELOG.md`，破坏性变更走 `2.0`

---

## 七、里程碑

| 阶段 | 产出 | 预估 |
|---|---|---|
| M1 打包可用 | npm 包 + `mcp` 子命令 + 35 工具全通 | 0.5 天 |
| M2 插件可用 | plugin.json + SKILL.md + 2 个示例 | 0.5 天 |
| M3 可开源 | 单测 + CI + 英文 README + 演示 GIF | 1 天 |
| M4 发布 | GitHub public + npm publish | 0.5 天 |

---

## 八、已落地（2026-10-25，未发布）

| 项 | 文件 | 状态 |
|---|---|---|
| npm 包定义 | `package.json`（bin: `wbwb`，零依赖，engines node>=18） | ✅ |
| CLI | `bin/cli.mjs`：`open` / `serve` / `mcp`，含静态服务（目录穿越 + `package.json`/`bin`/`server`/`tests` 拒绝）、桥复用、浏览器打开 | ✅ |
| MCP 固定入口 | `server/mcp-entry.mjs`（等价 `agent-bridge.mjs --mcp`） | ✅ |
| MCP 配置样例 | `.mcp.json` | ✅ |
| Agent 插件 | `plugin/plugin.json` + `plugin/SKILL.md`（造→排→渲→验收 + 6 个常见坑） | ✅ |
| 示例 | `examples/e2e-demo.md`（电商棚拍沙发全流程命令） | ✅ |
| 许可 | `LICENSE`(MIT) + `THIRD-PARTY-NOTICES.md` | ✅ |
| 测试 | `tests/smoke.mjs`（页面/桥/安全/工具通路）、`tests/mcp-handshake.mjs`（initialize→tools/list→tools/call） | ✅ 全过 |
| 打包 | `npm pack` → `whitebox-workbench-0.9.0.tgz`（7.5 MB / 135 files） | ✅ |
| 包内自测 | 解包后 `bin/cli.mjs --help` 正常；`server/mcp-entry.mjs` 握手返回 46 工具；解包 serve 页面 200 | ✅ |

实测输出：

```
✓ help 输出正常
✓ 页面 200 · index.html 正常（13740 字节）
✓ 桥 /health · {"ok":true,"service":"videoforge-studio-bridge","protocol":1}
✓ 敏感路径被拒（穿越 403 / package 403 / bin 403）
✓ /tool 通路正常（wb_state ok=false）
CLI 冒烟测试通过

✓ initialize · whitebox-workbench@1.0.0
✓ tools/list · 46 个工具，关键工具齐全
✓ tools/call(wb_state) · 通路正常（ok=false）
MCP 冒烟测试通过（46 工具）

npm pack：whitebox-workbench-0.9.0.tgz（package size 7.7 MB，total files 135）
解包自测：init whitebox-workbench | tools 46 → exit 0
```

**仍未执行**：npm publish、git init、GitHub 建仓、任何远端推送。
## 九、无 Blender 模式（v58 已实现）

`L3 渲染器` 是**可选**的：页面启动时用桥的 `wb_caps` 探测 8765，
没探测到就把「拍成片」自动降级为**浏览器内置录制**（离屏渲染 + MediaRecorder + 成片调色），
产物同样落输出目录（`白膜_浏览器_<帧数>f.mp4`）。

对打包的影响：
- npm 包的 `requires` 里 VideoForge 标 optional（已标）；
- README/插件 SKILL 里明确"两种模式"和质量档位；
- 云端渲染（把 Blender 放服务端）暂不做，协议上预留：`wb_render_submit` 只依赖 HTTP 任务模型。