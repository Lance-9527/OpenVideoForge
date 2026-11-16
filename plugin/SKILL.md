# SKILL · whitebox-workbench（白膜预演工作台）

> 给 Agent 的操作手册。三句话：**Agent 造 → 工作台排 → Blender 渲**。
> 工具名都以 `wb_` 开头；页面里的人也能同时操作，Agent 的改动会实时出现在页面上。

## 0. 判断要不要用它

- 要"白膜/预演/分镜/电商棚拍/运镜"这类**几何+镜头**的视频 → 用它
- 要照片级材质/真实光影 → 不是它的活（它是白膜 previz）

## 1. 接入检查（30 秒）

1. `wb_state` 能返回 `{view, coordinates:"THREE_Y_UP_METERS", instances:[...]}` → 页面已连上；
2. 返回 `{ok:false,error:"没有页面连接"}` → 让人打开页面（`npx whitebox-workbench open`）；
3. 可选：`wb_render_status` 能通 → Blender 渲染服务也在线。

## 2. 造（Agent 负责）

需要新道具时，用 Blender 导出 GLB：

- 单位**米**，`transform_apply`，物体原点落地（底部 y=0）
- 导出 `export_format="GLB"`
- 然后 `wb_asset_upload { path: "<输出目录>\\prop.glb" }` 登记进工作台资产库

> 已有资产：`wb_asset_list`（people / vehicles / buildings / nature / props）。

## 3. 排（工作台负责，Agent 下指令）

```text
wb_scene_new { env: "room" }                       # 空房间/棚拍/城市…
wb_asset_upload / wb_asset_add { asset: "桌子", x, z }
wb_instance_set { instance_id, position:[x,y,z], quaternion:[x,y,z,w], scale:[1,1,1] }   # Z-up！
wb_light { preset: "影棚" } 或 { azimuth, elevation, kelvin, intensity, shadowSoft }
wb_grade { contrast, saturation, vignette, bloom, grain, letterbox: "off" }
wb_camera { r, phi, theta, tx, ty, tz, fov }       # 球坐标机位
wb_track_set { camera: { keys:[...] }, object_tracks:[...] }   # 逐帧轨迹（Z-up）
```

坐标：页面是 **Y-up**，工具入参（instance_set / camera.keys / object_tracks）是 **Z-up**，
换算 `(x,y,z)→(x,-z,y)`。帧数 `frame_count = seconds × fps`，keys 从 frame 0 起。

## 4. 渲（两种）

| 目的 | 命令 | 产物 |
|---|---|---|
| 快速效果图 | `wb_render { w: 1920, h: 1080 }` | JPG 落输出目录 |
| 成片（Blender） | `wb_render_submit { seconds, fps, width, height }` → `wb_render_status { job_id }` 轮询 → `wb_render_save { job_id, prefix }` | MP4 + 首帧 PNG（带 sha256） |
| 一条龙（推荐） | `wb_handoff { glb_path, seconds, fps, width, height, turns }` | 上传→导入→轨迹→渲染→下载，返回 steps |

## 5. 验收（必须过）

- `wb_handoff_check` → `issues: []`
- 任务 `status === "succeeded"` 且 `manifest.validation.passed === true`（解码帧数、0 外部调用）
- 产物路径在输出目录（`wb_out_dir` 可查），文件大小 > 0
- 页面上能同时看到 HUD 进度与产物按钮（人和 Agent 看同一份真相）

## 6. 常见坑

| 现象 | 原因 | 处理 |
|---|---|---|
| `请先打开场景编辑器` | 页面停在入口/隐藏副本 | 让人切到编辑器；桥已按"可见+聚焦"路由 |
| 模型躺倒/比例怪 | 单位或坐标错 | GLB 米制 + 落地；用 `wb_instance_set` 改位姿 |
| `轨迹帧超出渲染帧数` | keys 比 frame_count 长 | 用 `wb_handoff` 统一生成，或先 `wb_handoff_check` |
| 排队不动 | VideoForge 单 worker 被前一个卡住 | 取消僵住任务（`wb_render_cancel`） |
| 成片里没有无人机视角 | 设备轨迹仅页面预览 | 用 `wb_camera_keys` 把机位写成主相机轨迹 |