# 示例：电商棚拍（沙发）一条龙

前提：`npx whitebox-workbench open`（页面开着）+ VideoForge（8765，可选）。

## 1) Agent 侧造沙发（Blender）

```bash
blender -b -P agent-side/make_sofa.py
# 产物：<输出目录>\_agent\sofa_home.glb（米制，12 网格）
```

## 2) 建棚 + 打光（MCP 工具，按顺序）

```jsonc
wb_scene_new      { "env": "room" }
wb_light          { "preset": "影棚" }
wb_light          { "azimuth": 148, "elevation": 30, "kelvin": 4700, "intensity": 1.25, "shadowSoft": 0.7 }
wb_grade          { "contrast": 1.06, "saturation": 1.05, "vignette": 0.2, "bloom": 0.22, "letterbox": "off" }
wb_asset_upload   { "path": "<输出目录>\\_agent\\sofa_home.glb" }   // → asset_id
wb_asset_add      { "asset": "桌子", "x": 2.2, "z": 0.4 }
wb_camera         { "r": 4.6, "phi": 1.22, "theta": 0.6, "tx": 0, "ty": 0.42, "tz": 0.2, "fov": 36 }
```

## 3) 效果图

```jsonc
wb_render { "w": 1920, "h": 1080 }
// → 输出目录：白膜_1920x1080_<ts>.jpg
```

## 4) 运镜 + 成片

```jsonc
// 机位轨迹（Z-up，注视沙发中心）
wb_track_set {
  "camera": { "keys": [/* 每帧 {frame, position:[x,y,z], target:[x,y,z], vertical_fov:36} */] },
  "fps": 24, "seconds": 5
}
wb_render_submit { "seconds": 5, "fps": 24, "width": 1280, "height": 720 }   // → job_id
wb_render_status { "job_id": "job_xxx" }        // 轮询到 succeeded
wb_render_save   { "job_id": "job_xxx", "prefix": "沙发演示" }
// → 沙发演示_xxx_mp4.mp4 + 沙发演示_xxx_png.png
```

## 5) 验收

```jsonc
wb_handoff_check { "seconds": 5, "fps": 24, "width": 1280, "height": 720 }
// 期望：{ "ok": true, "issues": [] }
```

## 页面里人怎么操作（同一份数据）

1. 选中目标（主相机 / 物体 / 手机·无人机）
2. 「画轨迹」按住左键画线（或多段），「编辑关键帧」拖手柄微调
3. 时间线里拖条改时间顺序、拖两端改起止、点 ×N 改速度；「总时长」随意填
4. 「🎬 拍成片」→ HUD 显示帧级进度 → 完成后自动落盘