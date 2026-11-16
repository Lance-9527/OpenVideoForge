# Blender 固定轨迹接入

版本：2026-10-25，前端缓存 v31。工作台可通过 VideoForge 本地 `/api/studio` 服务登记 GLB、保存规范场景、提交后台 Blender 渲染并绑定分镜。此接口不调用视频生成模型、不产生生成API费用。

## 页面操作

打开一个场景后，顶栏选择「Blender 接入」。导入 GLB 后可继续用视口和检查器摆位，原始模型尺寸与原点保持不变。保存场景与导出项目 JSON 将保留 GLB 登记信息、独立实例 ID、完整旋转/缩放、主相机、镜头时间线、灯光/调色、全景和设备机位。

可使用现有时间线轨迹，或点「生成完整环绕轨迹」。完整环绕用逐帧位置，保留一整圈而非最短弧。导出规范 JSON 会将内置环境/道具也登记为 GLB，避免 Blender 只得到用户导入模型而丢失布景。提交后显示任务状态；成功后提供白膜图片/视频文件链接。填写准确的 VideoForge 项目 ID 和分镜 ID 后，才使用「绑定已完成白膜」。

导出的项目 JSON 引用受管资产登记；它不内嵌 GLB 二进制。跨机器迁移须同时转移服务的资产目录，或者重新登记资产并更新引用。已登记资产缺失时会明确报错。

## 坐标与镜头

网页使用 Three.js 右手 Y-up；规范 JSON 使用米制、右手 Z-up。位置转换为 `(x,y,z) → (x,-z,y)`；四元数使用相同基变换；非均匀缩放的 Y/Z 分量交换。GLB 的资产轴转换交给 Three 与 Blender 的标准导入器，外层实例变换只转换一次。

`camera.keys` 逐帧保存位置、target、roll、可选 vertical_fov。默认从时间线的同一采样函数采样，渲染帧率与分辨率显式指定。MCP未指定时长时沿用时间线总时长；页面的时长输入为用户显式指定。完整环绕及手工轨迹通过显式 keys 保存，不依赖 theta 最短弧。

## MCP / 页面命令

| MCP 工具 | 页面命令 | 参数 |
|---|---|---|
| wb_asset_import | studio.asset.import | asset_id；文件先HTTP上传登记 |
| wb_instance_set | studio.instance.set | instance_id、position、quaternion XYZW、scale（规范Z-up） |
| wb_scene_export | studio.scene.export | width、height、fps、seconds 或 frame_count |
| wb_scene_load | studio.scene.load | scene_id、可选 revision，或 scene JSON |
| wb_track_set | studio.track.set | camera.keys、object_tracks（规范Z-up）；可附 render 保留帧率/尺寸/帧数 |
| wb_track_orbit | studio.track.orbit | fps、seconds/frame_count、turns |
| wb_track_preview | studio.track.preview | frame；稀疏关键帧按与Blender相同的线性/四元数插值采样，同时预览物体轨道 |
| wb_render_submit | studio.render.submit | scene 或导出选项，可附 project_id、shot_id |
| wb_render_status | studio.render.status | job_id |
| wb_render_cancel | studio.render.cancel | job_id |
| wb_render_bind | studio.render.bind | job_id、project_id、shot_id |

现有 `wb_raw` 可调用同名页面命令；页面控制台接口为 `window.WBStudio`。`wb_state` 现在返回明确实例ID及网页Y-up变换，`wb_instance_set` 则接受规范Z-up变换，二者不能混用坐标。标准GLB加载器/导出器采用 three@0.160.0，与当前本地 r160 内核一致；MIT许可及来源hash在 js/vendor 中。压缩纹理/Draco模型需要额外解码器，当前会报加载错误；可在Blender导出无压缩GLB使用。

## 已修复的基础问题

- 桥离线下载会保留Blob并实际调用浏览器下载回退；短时失败后会重探桥。
- 项目导出/导入包含 shots，不再丢镜头时间线。
- 主桥无页面连接立即报错，不向自己递归转发；指定不存在的页面不会转去另一个页面。
- 同类对象拥有不同instanceId，复制与阵列会创建新ID；外部GLB支持复制和完整变换存取。

## 本次验证与边界

真实r160 GLTFLoader解析1米GLB、GLTFExporter再导出并重载的尺度核验通过；18项本地回归通过，覆盖坐标/缩放、完整环绕、实例、GLB序列化重载、shots存取及离线下载。真实HTTP/MCP桥无页面0.01秒内返回失败；41个工具可列出。旧时间线75项和导出87项仍通过。

本页文档不是原生浏览器端到端或最终视频质量验收。宿主部署、实际渲染文件与VideoForge绑定、网页/Blender取景对照和真实视频模型评测由主任务整体验证。Blender白膜使用受管渲染器的白膜照明，不将网页后处理当作最终电影调色。
