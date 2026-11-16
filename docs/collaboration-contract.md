# 协作契约：Agent（造）× 工作台（排）× VideoForge（渲）

> 版本 2026-10-25 · 产品 v34 · 桥 v33 交接层
> 目的：把"能不能配合"变成"按契约配合"——每一方只做自己那件事，交接点只有一个命令。

---

## 一、职责分工（一个真相源一个owner）

| 环节 | 谁负责 | 产物 | 不做什么 |
|---|---|---|---|
| **建模 / 道具 / 材质** | **Agent（Blender addon 9876 或 headless）** | `.glb`（米制、Y-up 由标准导出器转换、原点在物体底部中心） | 不管相机、时间线、画幅 |
| **摆放 / 运镜 / 时长 / 画幅 / 后处理** | **白膜工作台**（人 + Agent 都通过同一套 `wb_*` 工具） | `videoforge.scene/1` 规范场景（Z-up）+ 逐帧相机 keys | 不建模、不自己渲染 |
| **渲染 / 编码 / 校验** | **VideoForge 服务（8765）→ Blender 4.2.1** | `frames.mp4` + `frame_000000.png` + manifest（sha256） | 不改场景语义、不做艺术判断 |
| **进度与交互** | **桥 + 页面 HUD** | 阶段/百分比/产物链接/存盘 | 不代替人做取舍 |

一句话：**Agent 造 → 工作台排 → VideoForge 渲 → HUD 让你看见**。

---

## 二、三条硬约定（违反必炸）

1. **坐标系**
   - 页面（Three.js）：右手 **Y-up**，米制。`wb_state` 返回 Y-up。
   - 规范场景 / Blender：右手 **Z-up**，米制。`wb_instance_set`、`wb_track_set` 接收 Z-up。
   - 转换公式固定：`(x,y,z)_web → (x,-z,y)_canonical`；四元数按同一基变换。**不要自己手算，用工具。**

2. **单位永远是米**。GLB 导出前 `transform_apply`；1 单位 = 1 米。否则渲染出来比例失真（门楼变牙签）。

3. **帧数是唯一时间真值**：`render.frame_count = seconds × fps`，相机 keys 必须 **从 frame 0 开始**且最后一帧 `< frame_count`。
   越界/不从 0 开始 → `wb_handoff_check` 会直接报 issue。

---

## 三、标准交接：一条命令

```
wb_handoff {
  glb_path: "<输出目录>\\arch_gate.glb",   // Agent 的 Blender 产物（也可给 asset_id 复用已登记资产）
  seconds: 2, fps: 24, width: 640, height: 360,
  turns: 1,                              // 环绕圈数；或给 camera_keys 走自定义轨迹
  prefix: "门楼"                          // 产物文件名前缀
}
```

内部顺序（全自动，返回 `steps` 可审计）：

```
upload(磁盘 GLB → VideoForge 资产登记)
  → import(页面导入为实例，拿到 instance_id)
  → track(orbit 或显式 camera_keys)
  → submit(Blender 后台任务，返回 job_id)
  → watch(页面 HUD 接管进度，人能看到)
  → poll(rendering 5%→50%→encoding 83%→succeeded)
  → download(MP4/PNG 落 <输出目录>，带 sha256)
```

**返回示例（实测）**：

```json
{ "ok": true,
  "data": { "job_id": "job_629a44a9...", "status": "succeeded",
            "blender": "4.2.1 LTS",
            "render": {"width":640,"height":360,"fps":24,"frame_count":48},
            "validation": {"passed":true,"decoded_frames":48,"network_calls":0,"paid_api_calls":0},
            "files": [
              {"kind":"first_frame","path":"<输出目录>\\门楼_629a44a9_png.png","bytes":302239},
              {"kind":"video","path":"<输出目录>\\门楼_629a44a9_mp4.mp4","bytes":139966}],
            "elapsed_ms": 3835 } }
```

交接前体检：`wb_handoff_check {seconds,fps,width,height}` → `{ok:true, data:{assets,instances,frames,keys,coordinates}, issues:[]}`。

---

## 四、工具边界（谁调什么）

| 用途 | 工具 | 归属 |
|---|---|---|
| Blender 建模/导出 GLB | addon 的 `blender_rt_*`（本机）或 headless 脚本 | Agent |
| GLB 磁盘登记 | `wb_asset_upload {path}` | 桥 |
| 场景摆放（Z-up） | `wb_instance_set` | 工作台 |
| 相机轨迹 | `wb_track_set` / `wb_track_orbit` / `wb_track_preview` | 工作台 |
| 一条龙 | **`wb_handoff`** | 桥 |
| 体检 | **`wb_handoff_check`** | 桥 |
| 单步渲染/查状态/取消/绑定 | `wb_render_submit/status/cancel/bind` | 工作台→VF |
| 进度 HUD | `wb_render_watch {job_id}` 或页面自动 | 桥→页面 |
| 页面自有人工操作 | 视口拖拽、检查器、时间线、分镜表、设备机位、片库 | 人 |

> HTTP 调试口：`POST http://127.0.0.1:8787/tool {name, args}` 直接调任意工具（等价 MCP `tools/call`）。

---

## 五、失败与回退

| 症状 | 判定 | 处置 |
|---|---|---|
| `请先打开场景编辑器` | 桥连到了"入口页/隐藏页" | 页面已按 **可见 + editor** 路由；确认目标页在编辑器视图 |
| `资产未在服务登记` | GLB 目录被清或跨机 | 重新 `wb_asset_upload`，再 `wb_scene_load` |
| 模型躺倒/比例怪 | 坐标或单位错 | 检查是否直接改了 `position` 而非走 `wb_instance_set`；GLB 是否 `transform_apply` |
| `轨迹帧超出渲染帧数` | keys 与 frame_count 不匹配 | 用 `wb_handoff` 统一生成，或先 `wb_handoff_check` |
| 渲染 failed | Blender 侧报错 | 看 `%LOCALAPPDATA%\VideoForge\data\studio_bridge\jobs\<id>\blender.log` |
| 桥无页面连接 | 页面没开/SSE 断 | 打开编辑器页；`GET /health` 确认 `page:true` |

---

## 六、验收口径（本契约的"合格"）

一次协作算合格，需同时满足：

1. `wb_handoff_check` → `issues: []`
2. `wb_handoff` 返回 `status: succeeded` 且 `validation.passed === true`
3. 产物落盘到输出目录（默认 `<输出目录>`）且 sha256 与 manifest 一致
4. 页面 HUD 在渲染期间显示进度、结束后给出可点击产物（用户可见）
5. `steps` 从 upload 到 poll 完整，缺一步即视为链路不全

---

## 七、本次实测记录（2026-10-25）

```
Agent 侧：blender_rt_headless 跑 make_arch_gate.py
          → arch_gate.glb 47,004 B，6 个网格，bbox 4.2×1.6×2.84 m（Z-up）
交接：    POST /tool wb_handoff {glb_path,...}
          upload ok(47,004B) → import ok(instance 8fe0704e…) → track ok(48 keys)
          → submit ok(job_629a44a9…) → poll 5%/12.8%/50.3%/83% → succeeded
产物：    <输出目录>\门楼_629a44a9_mp4.mp4  (139,966 B)
          <输出目录>\门楼_629a44a9_png.png  (302,239 B)
校验：    Blender 4.2.1 LTS · 48 帧解码通过 · 0 次外部调用
体检：    wb_handoff_check → issues: []，assets 2 / instances 2 / frames 48 / keys 48
```
