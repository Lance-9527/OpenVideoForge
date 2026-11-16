# 评估：白膜工作台 × 有 Blender 的 Agent，能否"很好地"协作出片

> 评估时间：2026-10-25 09:05–09:12
> 评估对象：`http://127.0.0.1:8802/index.html`（缓存版本 v30 → 本次改到 v32）
> 前置事实：昨天 Codex 已接入 VideoForge 本地服务（`127.0.0.1:8765/api/studio`），补齐 GLB 上传/实例/规范场景/轨迹/渲染/绑定。

---

## 一、结论（先说能不能）

**能跑通、且是真实 Blender 渲染**，不是示意：本机实测一条完整链路 3 秒级出 MP4。**但"合作得很好"还差三层**：

1. 还缺**一次真正的双向闭环**：Agent 用 Blender 造的东西，必须经 GLB 登记才能进工作台；工作台改完又要再导出——目前没有"来回改"的快捷路径；
2. 进度只是**任务级百分比**，没有帧级/阶段级，用户"知道在做"但不知道"做到哪一帧、卡在哪"；
3. 交互是**命令回执式**，不是对话式：用户看不到 Agent 的计划（为什么这么摆/这么运镜），也没有 A/B 对比。

---

## 二、实测证据（本次真跑，不是文档抄写）

### 1) 上传 GLB → 实例 → 轨迹 → Blender 渲染 → 产物

```
POST /api/studio/assets         test-bottle.glb  16500 B  sha256:196bd1af…
importAsset                     instance ace3f083-4830-447e-b573-cca764d5e40b
orbit {seconds:2}               camera_keys: 48（24fps × 2s）
render {seconds:2}              job_e863288d54ff4a38a260557146a4cfa5  → queued
status（轮询）                  succeeded，耗时约 3.06 s
manifest.blender_version        "4.2.1 LTS"
manifest.render                 640×360 / 24fps / 48 帧
manifest.validation             {passed:true, decoded_frames:48, network_calls:0, paid_api_calls:0}
outputs[0]                      first_frame PNG  293,030 B  sha256:76d02544…
outputs[1]                      video       MP4   82,545 B  sha256:6e56b9e7…
```

磁盘侧：`%LOCALAPPDATA%\VideoForge\data\studio_bridge\jobs\<job_id>\` 内有
`frames.mp4 / blender.log / input.json / job.json / manifest.json / samples.json / probe.json`。

### 2) MCP 面

`server/agent-bridge.mjs` 现暴露 **30 个 `wb_*` 工具**，其中 Blender 相关 11 个：
`wb_asset_import / wb_instance_set / wb_scene_export / wb_scene_load / wb_track_set / wb_track_orbit /
wb_track_preview / wb_render_submit / wb_render_status / wb_render_cancel / wb_render_bind`。
本次新增 `wb_render_watch`（把任务进度接到页面 HUD）。

### 3) 本次新增的"动态进程"（用户与 Agent 看同一份真相）

`js/studio-render-monitor.js` + `css/studio-render-monitor.css`：

- 页面提交渲染后**自动接管**（`studio-bridge.render()` → `WBRender.watch(job_id)`），也可被 Agent 用
  `wb_render_watch {job_id}` 或页面命令 `studio.render.watch` 手动接管；
- HUD 每 800ms 轮询，显示：阶段（排队/Blender 渲染中/完成/失败/取消）、百分比、已用时、分辨率·帧率·帧数·Blender 版本；
- 完成后直接给 `▸ 视频 MP4 / ▸ 首帧 PNG` 按钮 + `存盘`（落 `<输出目录>`，实测生成 `Blender白膜_job_8c20.mp4`）；
- 失败/取消可见；刷新页面后能恢复仍在跑的任务（localStorage + 重查）；
- 渲染期间**不锁界面**，用户可继续编辑（提交时已快照导出）。

实测截图：`docs/screens/shot-render-hud-progress.png`（18% / 1.6s / 可取消）、
`docs/screens/shot-render-hud-done.png`（100% / 640×360 / 24fps / 96 帧 / 4.2.1 LTS / 96 帧解码通过）。

---

## 三、失败机理（按发生概率排序）

1. **两套 Blender 通道并存，容易各干各的**
   产品走 VideoForge 内置 Blender 4.2.1（8765）；本会话 Agent 手上是 DSH blender addon（9876，当前未启动）。
   两边都能"渲染白膜"，但**不共享场景/资产/相机**。Agent 若用 addon 建模，产物必须导出 GLB 再 `wb_asset_import` 才能进工作台；
   反之产品里的场景要进 addon，得走 `wb_scene_export` 再写 Blender 脚本。没人强制走同一条路 → 交付物容易对不上。

2. **坐标语义双轨，静默错 90°**
   页面右手 Y-up；规范 JSON 右手 Z-up；`wb_state` 返回 **Y-up**，`wb_instance_set` 接收 **Z-up**。
   Agent 混用不会报错，只会发现"模型躺倒了"。

3. **进度粒度不足，长任务体验差**
   VideoForge 只给 `progress(0..1)`；没有"第 x/N 帧"、没有中间帧预览、失败只有 `error` 文本（细节在 `blender.log` 里，页面拿不到）。

4. **交互是回执式，不是协作式**
   AI 指令面板输出 JSON；没有"计划 → 执行 → 校验"的可读步骤流，也没有 revision 对比（同一场景多次改版无法并排看）。

5. **质量上限被白模照明锁死**
   Blender 侧是固定白膜照明 + 产品侧 `FilmGrade` 后处理（文档明说"不把网页后处理当最终电影调色"）。
   所以"超预期"要靠：几何/道具质量（Agent 建模）、运镜设计（轨道/关键帧）、构图（焦段/画幅）、后期（合成/调色/配乐）。当前无音频、无多机位剪辑、无字幕。

6. **外部依赖脆弱**
   VideoForge 是单独进程（本次 PID 6944）。它没起 → 全部 Blender 功能失效；Cross-machine 还要迁移它的资产目录。

---

## 四、建议的三步（按性价比）

1. **统一模型流水线并固化**：Agent(addon) 造模 → 导出 GLB → 自动 `wb_asset_import` → 摆位 → 轨道 → Blender 渲染 → HUD 存盘。
   写一份"总导演"示例脚本（一个 MCP 调用序列），把这条链固定成产品能力，而不是每次靠人拼。
2. **把进度做细**：从 `blender.log`/帧目录推"渲染 x/N 帧"，HUD 显示帧计数 + 最新一帧缩略图；失败时展示日志尾部 20 行。
3. **做"改一版"的对话式体验**：用户一句话 → Agent 产出结构化计划（steps）→ 逐条执行 → 每步可在 HUD/面板看到并与用户确认；支持 revision A/B 对比。

---

## 五、边界声明

- 本次只验证**链路与产物真实性**（Blender 4.2.1 实渲、48/96 帧解码通过、0 次外部/付费调用），**未做**成片质量主观评测；
- 未验证 VideoForge `bind`（绑定项目/分镜）到下游的真实消费方；
- 未启动 Blender addon 通道（9876），因此"addon 建模 ↔ 产品"的往返只给方案、未实测。
