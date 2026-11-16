# 第三方许可声明（THIRD-PARTY-NOTICES）

本项目（OpenVideoForge）自身代码以 MIT 许可发布，见 `LICENSE`。
以下第三方组件随包分发，遵循各自许可：

## three.js r160

- 文件：
  - `assets/three.module.js`（three.js 核心 ESM 构建，文件头已含 MIT 许可声明）
  - `js/vendor/GLTFLoader.js`
  - `js/vendor/GLTFExporter.js`
  - `js/vendor/BufferGeometryUtils.js`
  - `js/vendor/TextureUtils.js`
  - `js/vendor/RGBELoader.js`
- 许可：MIT · Copyright © 2010-2023 three.js authors
- 全文：`js/vendor/THREE-LICENSE.txt`
- 来源与版本清单：`js/vendor/THREE-ADDONS-SOURCES.json`
  （addon 来自 `npm:three@0.160.0/examples/jsm`，改动仅为相对导入路径）

## Blender / glTF

- Blender 仅作为**外部渲染器**调用（由 VideoForge 客户端托管），不随本包分发；
  Blender 本身是 GPL 软件，但**未被链接进本项目**，仅以命令行方式调用。
- glTF/GLB 由 Blender 导出，格式规范归 Khronos Group（CC-BY 4.0 规范文本，不涉及代码分发）。

## OpenStreetMap 数据

- 本项目可抓取并缓存 OSM 数据（`© OpenStreetMap contributors`，ODbL）。
- **义务**：对外发布含 OSM 数据的作品时必须署名「© OpenStreetMap contributors」。
  归一化流程 `normalizeOsm()` 会把 attribution 留在 world 里，出片/导出时写进片尾或字幕。

## 字体

- `css/fonts.css` 引用的字体如为系统字体则不随包分发；若打包了字体文件，
  发布前需在此补充对应许可（SIL OFL / Apache 等）。

## 历史名称

本项目早期名为 `whitebox-workbench`，后更名为 OpenVideoForge；两者是同一份代码，
许可证与署名规则不变。
