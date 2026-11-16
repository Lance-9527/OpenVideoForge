# AI 操作协议（AGENT-PROTOCOL）

> 产品形态：**AI 操作 + 用户操作** 并存。
> 所有能力都是一条具名指令；页面内面板、外部 Agent（MCP / HTTP）走同一套指令与同一份实现。

---

## 1. 三条通路

```
① 人在页面里发指令     右最侧「AI 指令」窗 → 本地关键词解析 → 指令总线
② 外部 Agent 经 HTTP    POST http://127.0.0.1:8787/cmd  {name,args}
③ 外部 Agent 经 MCP     node server/agent-bridge.mjs --mcp（stdio, JSON-RPC）
                          ↓ 两条外部通路都落到同一座桥
                      桥 → SSE → 浏览器页面执行 → 结果回传
```

页面侧总线：`window.WB_AGENT.run(name, args) → {ok, data|error}`；`window.WB_AGENT.commands()` 列出全部指令。
桥不在线时，① 照常可用（纯本地）。

## 2. 启动

```bat
:: 页面（必须 http://）
cd product
python -m http.server 8802

:: 桥（可选；Agent 需要时）
node server/agent-bridge.mjs            :: http://127.0.0.1:8787
node server/agent-bridge.mjs --mcp      :: 同时提供 MCP stdio（给 Agent 平台）
```

健康检查：`GET http://127.0.0.1:8787/health` → `{ok, page:true|false, pending}`

## 3. HTTP 示例

```powershell
$b = '{"name":"asset.add","args":{"asset":"轿车","x":2,"z":-1}}'
Invoke-WebRequest 'http://127.0.0.1:8787/cmd' -Method POST -Body $b -ContentType 'application/json'
# → {"ok":true,"data":{"assetId":"car-sedan","pos":[2,0,-1]}}
```

## 4. MCP 工具（stdio）

> ⚠ **2026-10-26 更正**：本节早先写的"19 个工具"已过期。桥现在暴露 **71 个** `wb_*` 工具
> （以 `tools/list` 实抓为准）。完整清单见 [`docs/AGENT-PROTOCOL.md`](./AGENT-PROTOCOL.md)；
> 实战打法则见配套的 learned skill `openvideoforge-whitebox-mcp`。
>
> 最早那 19 个仍在：`wb_state` `wb_scene_new` `wb_env_load` `wb_add_asset` `wb_transform`
> `wb_delete_selected` `wb_array` `wb_light` `wb_grade` `wb_shot_add` `wb_shot_list` `wb_play` `wb_stop`
> `wb_camera` `wb_render` `wb_panorama` `wb_scene_save` `wb_scene_list` `wb_storyboard` `wb_raw`
>
> 之后新增的（节选，按用途分组）：
>
> | 用途 | 工具 |
> |---|---|
> | 一条命令跑完整条流水线 | `wb_handoff`（上传GLB→导入→生成轨迹→提交Blender→盯进度→下载产物）、`wb_handoff_check`（交接前体检） |
> | 3D 场景 / 模型 | `wb_asset_upload` `wb_asset_import` `wb_instance_set` `wb_drop` `wb_asset_list` `wb_scene_export` `wb_scene_load` `wb_env_size` |
> | 运动轨迹 | `wb_track_set` `wb_track_orbit` `wb_track_preview` |
> | Blender 渲染 | `wb_render_submit` `wb_render_status` `wb_render_cancel` `wb_render_bind` `wb_render_save` `wb_render_frames` `wb_caps` |
> | 设备机位 | `wb_device_add` `wb_device_aim` `wb_device_look` `wb_device_list` `wb_device_shoot` |
> | 沉淀 / 复用 | `wb_asset_deposit` `wb_previz_list` `wb_previz_import_model` `wb_previz_import_scene` |

协议方法：`initialize` / `notifications/initialized` / `tools/list` / `tools/call` / `ping`（逐行 JSON，零依赖）。

客户端配置示例（Claude Desktop / DSH / 任意 MCP 客户端）：

```json
{
  "mcpServers": {
    "whitebox-workbench": {
      "command": "node",
      "args": ["D:/KnowledgeVault/projects/cinemap-teardown/product/server/agent-bridge.mjs", "--mcp"]
    }
  }
}
```

> 前提：页面已打开并切到编辑器（桥检测 `page:false` 时所有调用会返回「没有页面连接」）。

## 5. 指令清单（底层，24 条）

| 指令 | 参数 | 返回 |
|---|---|---|
| `state.get` | — | 视图/环境/对象数/选中/灯光/调色/镜头/总时长/拖拽模式 |
| `scene.new` | `{env}` | 新建并进入编辑器 |
| `scene.list` / `scene.open` `{id}` / `scene.save` `{title}` | — | 场景库 |
| `env.load` | `{env: room\|street\|temple\|office\|wild\|studio}` | 当前环境 |
| `asset.add` | `{asset\|id, x,y,z,ry,scale}`（asset 可中文名） | `{assetId,pos}` |
| `asset.transform` | `{x,y,z,ry,scale}`（作用于选中） | `{pos,ry}` |
| `asset.delete` | — | `{deleted}` |
| `asset.color` | `{color:'#rrggbb'}` | `{color}` |
| `asset.array` | `{cols,rows,gap}` | `{added}` |
| `light.set` | `{on,azimuth,elevation,kelvin,intensity,shadowSoft,hemi,fog}` | 灯光状态 |
| `light.preset` | `{name:'正午'\|'黄昏'\|'夜景'\|'影棚'\|'侧光'}` | 灯光状态 |
| `grade.set` | `{exposure,contrast,saturation,vignette}` | 调色状态 |
| `shot.add` | `{label,duration}` | `{shot,total}` |
| `shot.list` | — | 镜头 + 起止时间 |
| `shot.play` / `shot.stop` | — | 播放状态 |
| `camera.set` | `{r,phi,theta,tx,ty,tz,fov}` | 机位快照 |
| `render` | `{w,h,returnBase64}` | 下载 / base64 |
| `panorama.set` | `{url}` | 全景背景 |
| `dragmode.set` | `{mode:'free'\|'ground'\|'y'}` | 拖拽模式 |
| `storyboard.open` | — | 打开分镜表 |
| `help` | — | 指令名列表 |

## 6. 人在面板里的自然语言（本地解析，不联网）

支持：`加一个站立的人` `加一辆汽车` `换黄昏光` `换环境 神庙` `加 3 秒镜头` `播放` `停止`
`渲染 1920x1080` `删除` `阵列` `保存` `分镜表` `帮助`，或直接发 JSON：
`{"cmd":"light.preset","args":{"name":"夜景"}}`。
解析失败时会提示可用说法；面板同时显示每条指令的结构化返回（Agent 与人是同一份反馈）。

## 7. 已验证（本次实测）

> 下表是**早期**（19 工具时）的实测记录；工具数与清单已按上面 §4 更新。
> 当前可复核的：`node tests/smoke.mjs`（桥 + 页面联通）、`node tests/mcp-handshake.mjs`
> （握手 + tools/list + tools/call 通路，当前 **52 个工具**）。

```
GET  /health                     → {"ok":true,"page":true}
POST /cmd scene.new              → {"ok":true,"data":{"opening":true,"env":"room"}}
POST /cmd asset.add  站立的人     → {"ok":true,"data":{"assetId":"person-stand","pos":[0,0,1]}}
POST /cmd light.preset 黄昏       → {"ok":true,"data":{"azimuth":250,"kelvin":2600,...}}
POST /cmd shot.add   4s          → {"ok":true,"data":{"shot":{"label":"测试镜头","duration":4},"total":4}}
POST /cmd state.get              → objects:1 / shots:1 / dragMode:"free"

MCP stdio:
initialize → protocolVersion 2024-11-05
tools/list → 19 tools（现已 52）
tools/call wb_add_asset 轿车 x=2 z=1 → {"assetId":"car-sedan","pos":[2,0,-1]}
tools/call wb_shot_add  MCP 镜头 3s   → {"total":7}
```

面板实测：点「AI 指令」→ 输入「加一辆汽车」→ 日志显示用户行 + 结构化结果（见 `docs/screens/shot-agent-run.png`）。
