# 分镜导出（storyboard export）

> 白膜工作台 · 从时间线镜头一键产出：**分镜接触表 PNG** / **镜头清单 JSON+CSV** / **PNG 序列**。
> 全本地、无网络、无三方依赖；抓图由调用方注入，本模块不碰相机。

- 状态：**已实现，纯函数自测 87 项全过**（Node 24.15.0）；浏览器内的 Canvas / 下载链路待 Lead 联调。
- 新增文件：`js/export.js`、`js/storyboard.js`、`docs/export.md`、`docs/export.test.mjs`
- 未改动任何既有文件（`app.js` / `editor.js` / `timeline.js` / `index.html` / `css/**` 一律没碰）。

---

## 1. 文件与职责

| 文件 | 职责 | 依赖 |
|---|---|---|
| `js/export.js` | 四个导出函数 + 全部纯函数（时间码 / 文件名 / 网格 / 清单序列化 / Canvas 绘制） | 零依赖；顶层不碰 DOM，Node 可直接测 |
| `js/storyboard.js` | 分镜预览模态：打开即顺序抓图，网格预览，底部四个导出按钮，ESC 关闭 | 只 import `./export.js`；样式全部内联 |
| `docs/export.test.mjs` | Node 端纯函数测试（87 项断言） | 仅 `node:fs` / `node:path` / `node:url`（测试专用） |
| `docs/export.md` | 本文档 | — |

设计取舍：**导出逻辑放 `export.js`、DOM 放 `storyboard.js`**，这样接触表/清单可以在没有模态的情况下被任意入口（工具栏按钮、右键菜单、批处理）复用；也让纯函数能脱离浏览器单测。

---

## 2. API 契约（Lead 按此接入）

### 2.1 `js/export.js`

```js
// ① 分镜接触表：一张 1600px 宽的网格 PNG，自动下载 <片名>_storyboard.png
export async function exportContactSheet({ shots, renderShot, meta, onProgress })
//   → { ok: true, count, failed, filename, width, height }

// ② 镜头清单 JSON：自动下载 <片名>_shots.json
export function exportShotListJSON(shots, meta)
//   → { ok: true, count, filename }

// ③ 镜头清单 CSV：UTF-8 BOM + CRLF，自动下载 <片名>_shots.csv（Excel 中文不乱码）
export function exportShotListCSV(shots, meta)
//   → { ok: true, count, filename }

// ④ PNG 序列：逐张自动下载 01_镜头名.png（张间隔 320ms）
export async function exportShotPack({ shots, renderShot, meta, onProgress, intervalMs = 320 })
//   → { ok, count, failed, files: string[] }
```

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `shots` | `Shot[]` | 是 | 镜头数组，见 §3 |
| `renderShot` | `(shot) => Promise<dataURL>` | ①④必填 | **抓图注入**。本模块不实现抓图；缺省时 `exportContactSheet` / `exportShotPack` 抛中文错误，②③ 不受影响 |
| `meta` | `{ title, subtitle, author, date }` | 否 | `title` 决定文件名与接触表标题；缺省「未命名分镜」；`date` 缺省今天（YYYY-MM-DD） |
| `onProgress` | `({phase,done,total,failed,label,filename}) => void` | 否 | ① 的 `phase='capture'`；④ 的 `phase='pack'`。回调抛异常不影响导出 |
| `intervalMs` | `number` | 否 | ④ 的下载间隔，内部夹在 **200–400ms**（默认 320） |

**失败语义**

- `renderShot` 单张失败 / 返回非字符串 → 该格用「抓图失败」占位格，计入 `failed`，**不中断整体**（①④）。
- ① 的返回值里 `failed` 是占位格数量；④ 里 `failed` 是跳过的张数，`ok` 只有在 `failed === 0` 时为 `true`。
- 非浏览器环境（Node）调用 ①④ 会抛 `… 只能在浏览器里运行`；②③ 依赖 `document` 下载，同样会抛，测试时改用纯函数（§7）。

### 2.2 `js/storyboard.js`

```js
export function openStoryboard({ shots, renderShot, meta, onExport })
//   → { close(), el, isOpen }   句柄：可程序化关闭
```

- 打开即**顺序**抓图（不能并发：`renderShot` 会切相机），抓到一张填一张；顶部/底部显示进度与失败数。
- 底部按钮：`导出接触表 PNG` / `导出镜头清单 JSON` / `导出 CSV` / `导出 PNG 序列` / `关闭`。
- 若未注入 `renderShot`：只有 JSON / CSV 可用，接触表与 PNG 序列按钮置灰，并在状态栏说明原因。
- `onExport` 在每个导出动作后回调一次：`{ kind: 'contact-sheet'|'shot-list-json'|'shot-list-csv'|'png-pack', ok, count, failed, filename, error? }`。
- 交互：`Esc` 关闭、点遮罩空白处关闭、`Tab` 在模态内循环（基本焦点陷阱）、关闭后焦点回到打开前的元素；`z-index: 9999`（高于 `.ed-inspect` 的 `z-index: 6`）；打开时锁定 `body` 滚动。
- 单例：重复调用会先关掉上一个，不会叠窗。
- 导出复用已抓好的缩略图（`Map<shot.id, dataURL>`），不会为了再导一次而重切相机；抓图失败的镜头在导出时会重试一次，仍失败则占位/计数。

---

## 3. 输入数据契约

```js
shot = {
  id:       string,                             // 唯一 id；缺省时内部补 shot_<序号>
  label:    string,                             // 镜头名，如「推近 · 主角特写」；缺省补「镜头 N」
  duration: number,                             // 秒；负数夹 0，字符串数字会被解析
  cam:      { r, phi, theta, t: [x, y, z], fov },// 机位，原样透传（导出清单里要它）
  ease:     string                              // 缓动名，原样透传；缺省 null
}
```

- `cam` 字段与 `editor.js` 的机位模型一致：球坐标 `r / phi / theta` + 目标点 `t` + `fov`；导出只做搬运，不解释。
- 输出的清单一律从 **1 开始编号**，`start/end` 由 `duration` 累加得出（秒，3 位小数）。

---

## 4. 与 timeline / editor 的接法（Lead 已在 `app.js` 接好）

`timeline.js` 的 `getShots()` 返回的镜头模型与本模块契约**完全一致**（见 `timeline.js:17-20`）：

```js
{ id, label, duration, cam: { r, phi, theta, t:[x,y,z], fov }, ease: 'inout' | 'linear' }
```

`app.js`（v0.2）里已经落地的接线，供核对：

```js
// app.js:11
import { openStoryboard } from './storyboard.js';

// app.js:268 附近的 renderShot —— 切机位、等两帧、抓图、还原
async function renderShot(shot) {
  if (!editor) throw new Error('编辑器未就绪');
  if (!shot || !shot.cam) throw new Error('镜头缺少 cam 数据');
  const prev = editor.captureCam();
  try {
    editor.applyCamState(shot.cam);
    await waitFrames(2);
    return editor.captureThumb(960, 540);   // JPEG dataURL
  } finally {
    editor.applyCamState(prev);             // 抓完还原，用户视角不跳
    await waitFrames(1);
  }
}

// app.js:295 附近 —— 顶栏「分镜表」按钮（不改 index.html）
function openEditorStoryboard() {
  const shots = timeline ? timeline.getShots() : [];
  if (!shots.length) { toast('时间线还没有镜头：先在底部时间线点「＋加镜头」', 'warn', 3600); return; }
  openStoryboard({ shots, renderShot, meta: exportMeta() });
}
```

接入要点：

1. **抓图串行安全**：本模块一次只调一个 `renderShot`；`app.js` 的实现会在抓图前存机位快照、抓完还原，所以整轮导出不会把用户视角留在最后一个镜头。
2. **JPEG 也行**：`editor.captureThumb()` 返回的是 JPEG dataURL。接触表直接解码绘制；PNG 序列会在下载前自动转成真正的 PNG 字节（见 §5.4）。
3. **`preserveDrawingBuffer`**：`editor.js` 用 `preserveDrawingBuffer: true` 创建 renderer，`toDataURL` 不会拿到空帧。
4. **放哪都行**：模态挂 `document.body`，不依赖 `#app` 结构；四个导出函数也可被别的入口（场景库工具栏、批处理）直接调用。
5. **调试钩子**：`app.js` 的 `window.__wb` 已暴露 `renderShot` / `openEditorStoryboard` / `exportMeta`。

---

## 5. 规则表

### 5.1 文件名

| 产物 | 命名 | 例子 |
|---|---|---|
| 接触表 | `<片名>_storyboard.png` | `屋顶追逐_storyboard.png` |
| 清单 JSON | `<片名>_shots.json` | `屋顶追逐_shots.json` |
| 清单 CSV | `<片名>_shots.csv` | `屋顶追逐_shots.csv` |
| 序列单张 | `<序号>_<镜头名>.png` | `01_推近-主角.png`、`012_拉远.png` |

安全化规则（`safeFileName`，全部实测见 §8）：

- 非法字符 `<>:"/\|?*` → `-`；控制符 → 空格；连续空白/横线收成一条；首尾横线、点、空白剔除；
- 中文原样保留；空名回退「未命名」；Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）前加 `_`；
- 最长 60 字（序列单张的镜头名截 40），超长截断且不留尾巴横线；
- 序号宽度由镜头总数决定，最少 2 位（12 个 → `01..12`；120 个 → `001..120`）。

### 5.2 时间码 `mm:ss.s`

- 先四舍五入到 0.1s 再拆分，所以 `9.96 → 00:10.0`、`59.97 → 01:00.0`，不会出现 `00:60.0`；
- 分钟不封顶（超过 99 分钟就是 `100:00.0`）；负数/非数字夹到 `00:00.0`。

### 5.3 接触表版式

| 项 | 值 |
|---|---|
| 画布宽 | 1600 CSS px（固定），2× 高 DPI 输出 |
| 内边距 / 格间距 | 24px / 18px |
| 列数 | 最多 4；镜头数 < 4 时列数 = 镜头数（不留空列） |
| 单格 | 16:9 缩略图（cover 裁剪，不变形）+ 编号徽标 + 镜头名 + 起止时间码 + 时长 |
| 页眉 | 片名（Fraunces → Georgia 衬线）+ 副标题/镜数/总时长 + 日期 + 金色分隔线 |
| 页脚 | 左「白膜工作台 · 分镜接触表」、右 日期 + 镜数 |
| 超高保护 | 画布单边超 16000px 时自动把 2× 降采样到上限内（Chrome canvas 上限约 16384） |

网格行列（`computeGrid`，实测）：`0→1×0`、`1→1×1`、`2→2×1`、`3→3×1`、`4→4×1`、`5→4×2`、`9→4×3`、`13→4×4`、`100→4×25`。

### 5.4 PNG 序列节流

- 张与张之间 **320ms**（夹在要求的 200–400ms，可用 `intervalMs` 覆盖）；
- 单张走 `dataURL → Blob → objectURL`，`<a download>` 触发后在 **10s** 才 `revokeObjectURL`（Chrome 过早 revoke 会取消下载）；
- 若 `renderShot` 返回的是 **JPEG** dataURL（抓图更快、体积更小），下载前会先在 Canvas 里转成 **PNG**，保证 `01_镜头名.png` 的扩展名与真实字节一致；
- 单张失败继续下一张，最后返回 `{ ok, count, failed, files }`。

### 5.5 CSV

列：`序号, 镜头名, 时长(s), 开始时间码, 结束时间码, 机位半径r, 方位角phi, 仰角theta, 目标X, 目标Y, 目标Z, 视场角fov, 缓动ease`。

- 文件首字节是 **UTF-8 BOM（U+FEFF）**——Excel 双击打开中文不乱码；
- **CRLF** 换行；含逗号/引号/换行的单元格按 RFC 4180 加引号、内部引号翻倍；
- `cam` 缺失时对应列留空。

### 5.6 镜头清单 JSON

```json
{
  "schema": "whitebox.storyboard/1",
  "generator": "白膜工作台 · 分镜导出",
  "title": "屋顶追逐",
  "subtitle": "第 2 版",
  "author": null,
  "exportedAt": "2026-10-24T02:14:05.123Z",
  "shotCount": 3,
  "totalDuration": 5.9,
  "shots": [
    { "index": 1, "id": "a", "label": "全景 · 推近", "duration": 2, "start": 0, "end": 2,
      "startTimecode": "00:00.0", "endTimecode": "00:02.0",
      "cam": { "r": 16, "phi": 1.05, "theta": 0.85, "t": [0, 1.2, 0], "fov": 45 },
      "ease": "easeInOut" }
  ]
}
```

契约要求字段 `{index,label,duration,start,end,cam,ease}` 全部在；另外附加 `id / startTimecode / endTimecode` 方便人读与外部工具对时间码，不影响解析。

---

## 6. 也可以单独用（导出之外的纯函数）

`export.js` 还导出了这些纯函数，供 timeline / 其它面板复用，也让测试不必碰浏览器：

`formatTimecode` · `safeFileName` · `computeGrid` · `buildShotRows` · `totalDuration` · `padIndex` · `computeSheetLayout` · `storyboardFileName` · `shotListFileName` · `packFileName` · `buildShotListPayload` · `buildCSV`，以及常量 `STORYBOARD_SCHEMA` / `SHEET_DEFAULTS` / `FONT_SERIF` / `FONT_SANS` / `FONT_MONO`。

---

## 7. 自测（命令 + 实测输出）

### 7.1 语法检查（验收项 a）

```bat
cd <其它项目目录>
cmd /c "node --input-type=module --check < js\export.js"
cmd /c "node --input-type=module --check < js\storyboard.js"
```

实测：

```
export.js syntax exit: 0
storyboard.js syntax exit: 0
```

> 为什么用 `cmd /c "... < 文件"`：PowerShell 把 `Get-Content | node` 的管道按 GBK 编码写进 node 的 stdin，中文会乱码并误报 `SyntaxError`；`cmd` 的 `<` 是原样字节重定向（本次两种方式都试过，PowerShell 需先设 `$OutputEncoding=[Text.UTF8Encoding]::new($false)` 才正常）。

### 7.2 纯函数测试（验收项 b）

```bat
node docs\export.test.mjs
```

实测退出码 **0**，共 **87 项断言，0 失败**（完整输出如下，原文粘贴）：

```text
1. formatTimecode —— 时间码 mm:ss.s
  ✓ 0 秒 → "00:00.0"
  ✓ 0.4 秒 → "00:00.4"
  ✓ 3 秒 → "00:03.0"
  ✓ 9.96 秒（进位到 10.0，不能出现 00:60.0） → "00:10.0"
  ✓ 59.97 秒（跨分钟） → "01:00.0"
  ✓ 65.43 秒 → "01:05.4"
  ✓ 125.04 秒 → "02:05.0"
  ✓ 600 秒 → "10:00.0"
  ✓ 负数夹到 0 → "00:00.0"
  ✓ 非数字兜底 → "00:00.0"

2. safeFileName —— 文件名安全化（保留中文，去掉各系统非法字符）
  ✓ 路径分隔符 / 冒号 / 问号 → "屋顶-追逐-第1镜"
  ✓ Windows 非法字符 <>:"\|?* → "a-b-c-d-e-f"
  ✓ 连续横线收成一条 → "A-B"
  ✓ 控制符换行变空格 → "第1镜 第二行"
  ✓ 空串走回退名 → "未命名"
  ✓ 纯空白走回退名 → "未命名"
  ✓ Windows 保留名加前缀 → "_CON"
  ✓ 首尾点/空白剔除 → "hidden"
  ✓ 超长截断（≤60） → 60
  ✓ 自定义回退名 → "镜头"

3. computeGrid —— 分镜网格行列
  ✓ 0 个镜头 → {"cols":1,"rows":0}
  ✓ 1 个镜头 → {"cols":1,"rows":1}
  ✓ 2 个镜头 → {"cols":2,"rows":1}
  ✓ 3 个镜头 → {"cols":3,"rows":1}
  ✓ 4 个镜头 → {"cols":4,"rows":1}
  ✓ 5 个镜头 → {"cols":4,"rows":2}
  ✓ 8 个镜头 → {"cols":4,"rows":2}
  ✓ 9 个镜头 → {"cols":4,"rows":3}
  ✓ 13 个镜头 → {"cols":4,"rows":4}
  ✓ 100 个镜头 → {"cols":4,"rows":25}

4. padIndex —— 序号补零
  ✓ 1/12 → "01"
  ✓ 12/12 → "12"
  ✓ 1/120 → "001"
  ✓ 7/1（最少 2 位） → "07"

5. buildShotRows / totalDuration —— 累计起止时间
  ✓ 行数 → 3
  ✓ 第 1 个镜头 index → 1
  ✓ 第 1 个镜头 start/end → [0,2]
  ✓ 第 2 个镜头 start/end → [2,5.5]
  ✓ 第 3 个镜头 start/end → [5.5,5.9]
  ✓ 缺 label 时补「镜头 N」 → "镜头 2"
  ✓ 缺 id 时补 shot_N → "shot_1"
  ✓ 有 id 时原样保留 → "a"
  ✓ cam 透传 → 16
  ✓ ease 透传 → "linear"
  ✓ 缺 ease 时为 null → null
  ✓ 总时长 → 5.9
  ✓ 空数组总时长 → 0

6. computeSheetLayout —— 接触表版式（1600px 宽 / 24px 内边距 / 4 列 / 16:9）
  ✓ 宽度固定 1600 → 1600
  ✓ 8 镜头 4 列 2 行 → [4,2]
  ✓ 格子宽 (1600-48-3×18)/4 → 374.5
  ✓ 缩略图高（16:9 取整） → 211
  ✓ 格子高 = 缩略图 + 标签区 → 269
  ✓ 整张高度（2 行） → 734
  ✓ 0 镜头高度（页眉 + 页脚） → 178
  ✓ 1 镜头只有 1 列 → [1,1]
  ✓ 1 镜头格子更宽 → 1552
  ✓ 9 镜头 3 行高度 → 1021

7. 导出文件名
  ✓ 接触表文件名 → "屋顶追逐-第1版_storyboard.png"
  ✓ 接触表文件名（无标题） → "未命名分镜_storyboard.png"
  ✓ 清单 JSON 文件名 → "广告片A_shots.json"
  ✓ 清单 CSV 文件名 → "广告片A_shots.csv"
  ✓ 序列单张文件名 → "01_推近-主角.png"
  ✓ 序列三位序号 → "012_拉远.png"

8. buildShotListPayload —— 镜头清单 JSON 结构
  ✓ schema → "whitebox.storyboard/1"
  ✓ shotCount → 3
  ✓ totalDuration → 5.9
  ✓ title → "屋顶追逐"
  ✓ subtitle → "第 2 版"
  ✓ 每镜头字段齐全 → ["cam","duration","ease","end","endTimecode","id","index","label","start","startTimecode"]
  ✓ 第 1 镜 startTimecode → "00:00.0"
  ✓ 第 2 镜 startTimecode → "00:02.0"
  ✓ 第 3 镜 endTimecode → "00:05.9"
  ✓ cam 原样保留 → {"r":16,"phi":1.05,"theta":0.85,"t":[0,1.2,0],"fov":45}

9. buildCSV —— UTF-8 BOM + CRLF + 转义
  ✓ 以 UTF-8 BOM 开头（Excel 中文不乱码） → U+FEFF
  ✓ 使用 CRLF 换行
  ✓ 表头含中文列名 → ﻿序号,镜头名,时长(s),开始时间码,结束时间码,机位半径r,方位角phi,仰角theta,目标X,目标Y,目标Z,视场角fov,缓动ease
  ✓ 数据行数（表头 + 3 镜头） → 4
  ✓ 时长保留 3 位小数
  ✓ 逗号/引号被正确转义
  ✓ 换行被引号包裹（合法 CSV 多行单元格）
  ✓ 空镜头只有表头 → 1
  ✓ cam 缺失时留空列 → ""

10. 边界行为
  ✓ shots 传 null 不炸 → 0
  ✓ shots 传 null 的 CSV 表头仍在 → 1
  ✓ duration 负数夹到 0 → 0
  ✓ duration 字符串转数字 → 2.5
  ✓ exportContactSheet 在 Node 里显性失败（需要浏览器）

────────────────────────────────────────────────────────────
结果：87 项断言全部通过，0 失败
```

> 测试用 `data:text/javascript;base64` 动态 import `js/export.js`：`product/` 没有 `package.json`（未声明 `type: module`），Node 会把 `js/export.js` 当 CJS 解析而报 `Unexpected token 'export'`。这样可以零改动、零构建地测 ESM 源码（测试文件里也写了原因）。

---

## 8. 已知限制 / 未做项

1. **浏览器链路未实测**：按任务约束不使用浏览器，`openStoryboard` 的 DOM/Canvas/下载路径只做了语法与纯逻辑验证，需 Lead 在真实页面里点一遍（重点看：抓图顺序、连续下载是否被 Chrome 拦截、模态焦点）。
2. **接触表不分页**：镜头很多时是一张很高的图（每 4 个镜头 +269px）。60 个镜头约 4300px 高，仍属可用；若后续要 A4 分页打印，需要再加分页逻辑（当前未做）。
3. **接触表中文依赖系统字体**：Canvas 不加载 webfont，标题 Fraunces 缺失时回退 Georgia/宋体，正文走系统 UI 字体；不同机器字形会有差异（不影响内容）。
4. **连续下载依赖浏览器策略**：320ms 是保守值；若用户浏览器设置了「每次下载都询问」或严格拦截多文件，PNG 序列可能只下到前几张，需要用户允许下载。JSON/CSV/接触表都是单次下载，不受影响。
5. **不做镜头编辑**：本模块只读 `shots`，不排序、不改时长、不重拍。若要在模态里拖拽换序，后续再加。
6. **不依赖 timeline.js 实现细节**：`timeline.js` 已落地（镜头模型见 §4，字段与本模块契约一致）；若以后字段改名，应在 `app.js` 接线处做映射，不建议改本模块。
7. **`exportShotPack` 的 `ok` 只在 0 失败时为 `true`**：若希望部分成功也算成功，接线处按 `count > 0` 判断即可。

---

## 9. 变更记录

| 日期 | 内容 |
|---|---|
| 2026-10-24 | 新增 `js/export.js`、`js/storyboard.js`、`docs/export.md`、`docs/export.test.mjs`；87 项纯函数断言通过；语法检查通过。 |
