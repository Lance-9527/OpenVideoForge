# 多镜头时间线 + 镜头运动 · 设计与接入说明

> 模块：`product/js/timeline.js`（新）+ `product/css/timeline.css`（新）+ `product/js/editor.js`（只追加 2 个方法）
> 定位：把「摆机位」升级成「能做分镜」——一串镜头卡片，播放时在相邻镜头之间做推/拉/摇/移/跟的运动。
> 底座：白膜工作台 Whitebox Workbench（MIT），视觉贴 Cinemap 的浅色导演台 + 黄铜高亮。

---

## 1. 交付物

| 文件 | 状态 | 说明 |
|---|---|---|
| `product/js/timeline.js` | 新增 | 时间线模块。**不 import three**，插值是纯数值运算，可在 Node 直接单测 |
| `product/css/timeline.css` | 新增 | 只含 `.tl-*` 与 `#wb-timeline` 选择器；由 JS 自动注入，**不需要改 index.html** |
| `product/js/editor.js` | 只追加 | 在 `_applyCamera()` 之后新增 `captureCam()` / `applyCamState(cs)`，未改动任何既有行 |
| `product/docs/timeline.test.mjs` | 新增 | 75 条断言，无 DOM / 无 three / 无浏览器 |
| `product/docs/timeline.md` | 本文件 | API 契约 + 算法 + 快捷键 + 与 app.js 的接法 + 实测输出 |

改动范围严格不越界：**没有碰** `index.html`、`js/app.js`、`js/assetlib.js`、`js/player.js`、`css/workbench.css`、`css/cinemap.css`、`raw/**`、顶层 `docs/**`。

> 并行改动提示：写这份文档时，`js/app.js`（`timeline` 接线）与 `index.html` 正被 Lead/其他同事修改，所以 §7 记录的是「复核当时」的行号与代码形状；`timeline.js`/`editor.js`/`timeline.css` 三个文件只有我写。

---

## 2. 数据契约

### 2.1 镜头模型（`getShots()` 的返回值，可直接 JSON 持久化）

```jsonc
{
  "id": "sh_m3k2a1_1",        // 字符串，创建时生成，稳定不变
  "label": "镜头 1",           // ≤ 24 字，可双击改名
  "duration": 3,               // 秒，[0.1, 120]，默认 3
  "cam": {
    "r": 16,                   // 轨道半径（推拉）
    "phi": 1.05,               // 俯仰角（弧度，0=正上方，π/2=水平）
    "theta": 0.85,             // 水平角（弧度，可无限累加 → 插值走最短弧）
    "t": [0, 1.2, 0],          // 目标点 [x,y,z]（世界坐标，米）
    "fov": 45                  // 垂直视场角（度，变焦）
  },
  "ease": "inout"              // 'inout' | 'linear'
}
```

**时间语义**（重要，决定「时长」是什么意思）：

```
镜头 i 占据时间 [start_i, start_i + duration_i)
   ├ 在这段时间内，相机从 镜头 i 的姿态 → 镜头 i+1 的姿态（用镜头 i 的 ease）
   └ 最后一张镜头的 duration 是「定格停留」时间（不再运动）

总时长 = Σ duration_i
起点：  start_i = duration_0 + … + duration_{i-1}
例：时长 2 / 3 / 4 → 总 9s，起点 0 / 2 / 5；[0,2) 做 1→2 的运动，[2,5) 做 2→3，[5,9) 定格在 3
```

### 2.2 与 editor 的契约（时间线只认这三个方法）

| 方法 | 方向 | 说明 |
|---|---|---|
| `editor.captureCam()` | 读 | 返回 `{r, phi, theta, t:[x,y,z], fov, p:[x,y,z]}`。`p` 是冗余的位置快照，方便外部不装 three 也能读 |
| `editor.applyCamState(cs)` | 写 | 一次到位（**无补间**）：写 `sph` / `target` / `camera.fov` 后 `updateProjectionMatrix()` + `_applyCamera()`。会 `cancelAnimationFrame(this.camAnim)` 打断正在跑的机位补间 |
| `editor.captureThumb(w,h)` | 读（可选） | 生成镜头缩略图；缺失或抛错时降级为序号占位块 |

> `applyCamState` 只在时间线播放/seek 时被调用；用户点机位书签仍然是原来的 `_animateCam` 650ms 补间，两者不会互相改写（时间线每帧都会重新写入，播放期间由时间线持有相机——这是有意行为）。

### 2.3 缩略图不进模型

`captureThumb()` 返回的 dataURL 单张约 8–15 KB。若塞进镜头模型，20 个镜头≈300 KB，会撑爆 `localStorage`（`store.js` 里存全部场景）。因此：

- 缩略图只活在 `Timeline._thumbs`（`Map<id, dataURL>`），**会话内有效**；
- 需要持久化的宿主可以用 `getThumbs()` 取走另存，或干脆不存（重载后显示编号占位，视觉上是有意的空态）；
- `getShots()` 只返回 5 个字段，不含缩略图。

---

## 3. API

### 3.1 一步挂载（推荐）

```js
import { mountTimeline } from './timeline.js';

const tl = mountTimeline({
  editor,                    // EditorApp 实例
  shots: rec.data.shots || [],   // 载入已有分镜（可省略）
  onChange: (shots) => { /* 宿主自己持久化 */ },
  collapsed: false,          // 可选：初始折叠
  host: null                 // 可选：默认自动找 #view-editor，再退 document.body
});
```

`mountTimeline` 会：注入 `css/timeline.css` → 建 DOM → 挂到宿主末尾 → 载入 shots。**不需要改 index.html。**

### 3.2 `class Timeline`

| 成员 | 签名 | 说明 |
|---|---|---|
| 构造 | `new Timeline({ editor, onChange, collapsed })` | 不触碰 DOM，可在 Node 里直接用来测数据层 |
| `mount` | `mount(hostEl?)` | 建 DOM 并挂载；重复调用会摘掉旧键盘监听再挂 |
| `destroy` | `destroy()` | 停 rAF、摘键盘监听、移除 DOM、清空 shots（可重复调用） |
| 读 | `getShots()` | **深拷贝**，外部改不到内部 |
| 读 | `getThumbs()` | `{id: dataURL}` 副本 |
| 写 | `setShots(shots, thumbs?)` | 规整后整体替换；**不触发 onChange**（避免载入回环） |
| 增 | `addShotFromCamera()` | 抓当前相机为新镜头（默认 3s，名称「镜头 N」），返回该镜头副本 |
| 改 | `updateShot(id, patch)` | patch 支持 `label` / `duration` / `cam` / `ease`，全部做范围校验 |
| 删 | `removeShot(id)` | 返回 boolean |
| 排序 | `moveShot(from, to)` | 返回 boolean；越界 false |
| 选中 | `selectShot(id, opts?)` | `opts.seek === false` 时只选中不跳时间 |
| 播放 | `play()` / `pause()` / `stop()` / `toggle()` | `stop()` = 暂停 + 回 0 + 应用第 1 帧姿态 |
| 定位 | `seek(sec)` | 夹到 `[0, total]`；播放中 seek 会重算时基，不打断播放 |
| 查询 | `totalDuration()` / `get isPlaying` | — |
| 折叠 | `toggleCollapse()` | 返回新的折叠态 |

所有用户级改动（add/update/remove/move、时长输入提交）都会调用 `onChange(getShots())` 一次；`onChange` 抛错会被 `try/catch` 吞掉并 `console.error`，不会中断 UI。

### 3.3 导出的纯函数（可单独复用 / 已单测）

```js
clamp(v, lo, hi)
easeInOutCubic(k)            // 0→0, 0.5→0.5, 1→1
easeValue(k, ease)           // 'linear' | 其他一律按 inout
shortestAngleDelta(from, to) // 折算到 (-π, π]
lerp(a, b, k)
lerpAngle(from, to, k)       // 最短弧角度插值
normalizeCam(cam)            // NaN/缺字段/越界兜底
interpCam(a, b, k, ease)     // 两姿态插值
normalizeShot(shot, index)
shotsTotalDuration(shots)
shotStartTime(shots, index)
sampleShots(shots, time)     // → {cam, index, local, from, to, shot, atEnd} | null
formatTime(sec)              // → "0:03.4"
DEFAULT_SHOT_DURATION = 3, MIN_SHOT_DURATION = 0.1, MAX_SHOT_DURATION = 120
```

浏览器里还会挂一份 `window.WB_TIMELINE = { Timeline, mountTimeline, sampleShots, interpCam, … }`，方便宿主不写 import 时也能从控制台/内联脚本用。

---

## 4. 插值算法

### 4.1 分量策略

| 分量 | 插值 | 理由 |
|---|---|---|
| `r` | 线性 | 推/拉 |
| `phi` | 线性 | 俯仰，范围窄（轨道操作限制在 0.12–1.52 rad） |
| `theta` | **最短弧** | 水平环绕会无限累加，线性插值会「绕远路 / 甩镜头」 |
| `t`（3 分量） | 线性 | 跟移 |
| `fov` | 线性 | 变焦（Dolly Zoom 靠 r 与 fov 反向变化自然产生） |
| `ease` | `inout` 用 `easeInOutCubic`，`linear` 直通 | 两端加减速，中段匀速 |

### 4.2 最短弧的取法

```js
export function shortestAngleDelta(from, to) {
  let d = (to - from) % TAU;
  if (d >  Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;   // 正好 ±π 时统一取 +π，保证确定性
  return d;
}
```

- `3.0 → -3.0`：线性会走 `-6`（绕 343°），最短弧走 `+0.2832`（跨过 ±π）✅ 已单测
- `0 → 2π`：走 `0`（不转一圈）✅
- `10π → 0`：归一化后仍在 `(-π, π]` 内 ✅
- 末值 `theta` 不保证数值等于目标值（可能差 `2πk`），但**角度等价**；`applyCamState` 直接写回也无碍，因为 `_applyCamera()` 用的是 `sin/cos`

### 4.3 缓动导数（用于连续性判据）

`easeInOutCubic` 在 `k=0.5` 处导数 = **3**（即峰值速度是平均速度的 3 倍）。这决定了播放时单帧最大位移的理论上界：

```
每帧最大位移 ≈ 3 × (该段各分量跨度之和) / 段时长 × dt
```

`timeline.test.mjs` 第 8 组就是拿这个**可推导的上界**去卡实测值（实测 0.196 ≤ 上界 0.198），而不是拍脑袋设阈值。

### 4.4 播放循环

```js
_tick = () => {
  const t = this._timeOffset + (now() - this._playStart) / 1000;  // 时基不累加，无漂移
  this._time = Math.min(t, total);
  this._applyAt(this._time);            // sampleShots → editor.applyCamState
  if (this._time >= total) { playing = false; update(); return; }
  this._raf = requestAnimationFrame(this._tick);
};
```

- 用「起始时间戳 + 偏移」而不是 `+= dt`，避免长时间播放的时间漂移；
- 每帧只重写相机与进度条，**不重建 DOM**（卡片结构只在增删改排序时重建）；
- `requestAnimationFrame` 句柄统一在 `_cancelRaf()` 里取消，`destroy()` / `pause()` / `stop()` 都走它。

---

## 5. UI 结构

```
#wb-timeline.tl-root                  ← flex 子项，挂在 #view-editor 末尾（.ed-bottom 之下）
├─ .tl-bar                            ← 36px 工具条
│   ├─ button.tl-collapse  ▾/▸        ← 折叠（aria-expanded）
│   ├─ .tl-title           分镜时间线
│   ├─ .tl-now             ▸ 当前镜头名（aria-live="polite"）
│   ├─ .tl-sum             N 个镜头 · 总时长 0:09.0
│   ├─ .tl-transport       ▶ ⏸ ■
│   └─ .tl-scrub-wrap
│       ├─ input.tl-scrub[type=range] ← 可拖 scrub，播放中也可拖
│       └─ .tl-time        0:03.4 / 0:09.0
└─ .tl-body                          ← 展开 152px / 折叠 0（CSS max-height 过渡）
    └─ .tl-track[role=list]
        ├─ .tl-card[role=listitem][tabindex=0]   每张：
        │   ├─ .tl-idx        01
        │   ├─ .tl-thumb      缩略图（无图时显示编号占位）
        │   ├─ .tl-name       双击 → 变 input.tl-name-edit
        │   ├─ input.tl-dur   + .tl-unit "s"
        │   └─ .tl-ops        ◀ ▶ ✕
        └─ button.tl-add      ＋ 加镜头
```

状态类：`.tl-card.tl-selected`（用户选中，黄铜描边+外发光）、`.tl-card.tl-active`（播放头所在，顶部 2px 黄铜条）、`.tl-root.tl-playing`、`.tl-root.tl-collapsed`。

视觉对齐 Cinemap：颜色全部走 `#view-editor` 已有的 `--ed-*` 变量（`--ed-accent: #c8891a` 正好是 Cinemap 的黄铜色），并在 `:root` 上给同名 `--tl-*` 兜底。选择器全部以 `.tl-` / `#wb-timeline` 为前缀，**不会影响 workbench.css 的任何既有样式**。

---

## 6. 快捷键与无障碍

| 键 | 条件 | 行为 |
|---|---|---|
| `Space` | 在编辑视图内，焦点不在 `input/textarea/select/contenteditable`，无 ⌘/Ctrl/Alt，无打开中的 `#modal` | 播放 / 暂停 |
| `←` | 同上 | 上一镜头（NLE 习惯：不在本镜头开头时先退回本镜头开头） |
| `→` | 同上 | 下一镜头 |
| `Enter` | 焦点在某张卡片上 | 定位到该镜头 |
| 双击名称 | — | 行内改名（回车确认 / Esc 取消；Esc 已 `stopPropagation`，不会触发 app.js「返回入口」） |

兼容性核对（`js/app.js:867-882` 既有键盘处理）：`Space` 只在 `state.view === 'library'` 且 player 存在时被接管 → 编辑视图内不冲突；`Escape` 在 `INPUT` 上会提前 return → 改名框安全；`Delete/Backspace` 删除选中资产与时间线无关。

无障碍：
- 所有按钮有 `title` + `aria-label`；播放键 `aria-pressed`；折叠键 `aria-expanded`；
- 卡片 `role="listitem"` + `tabindex="0"`，Enter 可定位；
- 进度条是原生 `input[type=range]`（可键盘操作，`aria-label="时间轴进度"`）；
- 当前镜头名在 `aria-live="polite"` 区域，边播边报；
- `:focus-visible` 全部有可见描边；`prefers-reduced-motion` 下关闭过渡。

---

## 7. 与 app.js 的接法（**已由 Lead 接入，以下为现状记录**）

> 本节是写文档时对 `js/app.js`（他人负责）的**只读复核**：接入代码已存在，且与我给的契约一致。
> 行号取自复核当时的 `app.js`（999 行）；该文件仍在被并行修改，行号可能漂移，按代码特征搜更稳。

### 7.1 实际接入点

| 位置 | 代码 | 说明 |
|---|---|---|
| `js/app.js:10` | `import { mountTimeline } from './timeline.js';` | 唯一的 import |
| `js/app.js:27` | `let timeline = null;` | 模块级实例 |
| `js/app.js:189` | `if (timeline) { timeline.destroy(); timeline = null; }` | 进编辑器先销毁旧的（摘掉键盘监听） |
| `js/app.js:217-221` | `timeline = mountTimeline({ editor, shots: (editorRec && editorRec.shots) \|\| [], onChange: (shots) => { if (editorRec) editorRec.shots = shots; } })` | 挂载；shots 存在**场景记录顶层** `editorRec.shots`，不塞进 `editor.serialize()` |
| `js/app.js:226` | `closeEditor()` 里同样 `destroy()` | 退出即清理 |
| `js/app.js:248` | `if (timeline) editorRec.shots = timeline.getShots();` | 保存时把分镜写回场景记录 |
| `js/app.js:296-301` | `const shots = timeline ? timeline.getShots() : []; … openStoryboard({ shots, renderShot, meta })` | 分镜导出（接触表/清单/PNG 序列）由别人的 `storyboard.js` 消费 |
| `js/app.js:266-277` | `const prev = editor.captureCam(); editor.applyCamState(shot.cam); … editor.applyCamState(prev);` | 导出时逐镜头切机位抓图再还原——**正是 §2.2 的两个契约方法** |

`editor.serialize()` **没有**改动（仍返回 `{v, env, objects, cams}`），所以旧场景文件、旧存档完全兼容；`loadScene()` 只读 `env/objects/cams`，多出的 `shots` 键会被忽略。分镜跟着场景记录走（`editorRec.shots`），随 `persist()` 一起进 `localStorage`：

```jsonc
// state.scenes[i]（store.js 持久化）
{ "id": "sc_…", "type": "native", "title": "…",
  "data": { "v": 1, "env": "room", "objects": [...], "cams": [...] },   // ← editor.serialize()，不含 shots
  "shots": [ { "id": "sh_…", "label": "镜头 1", "duration": 3,
               "cam": { "r": 16, "phi": 1.05, "theta": 0.85, "t": [0,1.2,0], "fov": 45 },
               "ease": "inout" } ],
  "thumb": "data:image/jpeg;…", "createdAt": 0 }
```

体积：每镜头约 130 B JSON → 20 镜头 ≈ 2.6 KB，可以放心进 `localStorage`；缩略图**不进**（见 §2.3）。

### 7.2 ⚠ 待修：脏检查看不到分镜改动

`js/app.js:916` 的返回拦截是：

```js
if (editor && JSON.stringify(editor.serialize()) !== lastSavedJSON) saveEditor();
```

`editor.serialize()` 不含 shots，而 shots 存在 `editorRec.shots` → **只动时间线（加/删/改镜头、改时长）不会触发自动保存**，点「返回入口」时会静默丢掉分镜改动（物体/机位改动仍正常触发）。

最小修法（改一行，属于 app.js 负责人）：

```js
const dirty = JSON.stringify(editor.serialize()) + '|' + JSON.stringify(timeline ? timeline.getShots() : []);
if (editor && dirty !== lastSavedJSON) saveEditor();
```

并把 `app.js:222` / `app.js:251` 的基准同步改成同一个拼接形式。本轮我只产出 `timeline.js`/`editor.js`/`timeline.css`/`docs`，未改 `app.js`（禁改），所以这条留给 Lead 或 app.js 负责人。


---

## 8. 自测

### 8.1 语法检查

`node --check` 对 `.js` 会按 CommonJS 解析（遇到 `import/export` 直接报错），所以先把两份文件复制成 `.mjs` 再 check：

```powershell
Copy-Item js\timeline.js "$env:TEMP\wbcheck\timeline.mjs" -Force
Copy-Item js\editor.js   "$env:TEMP\wbcheck\editor.mjs"   -Force
node --check "$env:TEMP\wbcheck\timeline.mjs"
node --check "$env:TEMP\wbcheck\editor.mjs"
```

实测输出：

```
timeline.js check exit=0
editor.js check exit=0
```

> 也验证过等价写法 `Get-Content -Raw js\timeline.js | node --input-type=module --check`，但 PowerShell 管道会把 UTF-8 中文按 GBK 重编码，报出假的中文语法错误——**不要用管道**，用上面的 `.mjs` 副本。

### 8.2 单元测试

```powershell
node product\docs\timeline.test.mjs
```

实测输出（75 通过 / 0 失败，`EXIT=0`）：

```
=== timeline.test.mjs ===

1. 基础数学
  ✓ clamp(5,0,3) = 3   实际 3
  ✓ clamp(-1,0,3) = 0   实际 0
  ✓ lerp(10,20,0.25) = 12.5   实际 12.5
  ✓ easeInOutCubic(0) = 0   实际 0
  ✓ easeInOutCubic(0.5) = 0.5   实际 0.5
  ✓ easeInOutCubic(1) = 1   实际 1
  ✓ easeInOutCubic 单调不降（101 采样）
  ✓ easeValue(k,"linear") 不做缓动   实际 0.25
  ✓ easeValue(k,"inout") 走三次缓动   实际 0.0625

2. theta 最短弧（环绕）
  ✓ 普通区间 0.2→2.0 直接取差值 1.8   delta=1.8
  ✓ 跨 ±π：3.0→-3.0 取 +0.2832（不是 -6.0）   delta=0.2832  (TAU-6=0.2832)
  ✓ 反向：-3.0→3.0 取 -0.2832   delta=-0.2832  (6-TAU=-0.2832)
  ✓ 正好 π：0→π 取 +π   delta=3.1416
  ✓ 正好 -π：0→-π 确定性取 +π   delta=3.1416
  ✓ 绕整圈：0→2π 取 0   delta=0
  ✓ 多圈累加：10π→0 也归一化到 (-π,π]   delta=0
  ✓ lerpAngle 中点 = π 附近（跨 ±π 走短边）   mid=3.1416（≈π）

3. interpCam：t=0 / 中值 / 末值
  A = {r:20, phi:1, theta:0.2, t:[0,1.2,0], fov:45}
  B = {r:8, phi:1.3, theta:2, t:[3,2,1], fov:30}
  k=0    → {r:20, phi:1, theta:0.2, t:[0,1.2,0], fov:45}
  k=0.5  → {r:14, phi:1.15, theta:1.1, t:[1.5,1.6,0.5], fov:37.5}
  k=1    → {r:8, phi:1.3, theta:2, t:[3,2,1], fov:30}
  ✓ k=0 精确等于 A（r/phi/theta/t/fov）
  ✓ k=0.5 落在几何中点（ease 中点 = 0.5）
  ✓ k=1 精确等于 B
  k=0.5（linear）→ {r:14, phi:1.15, theta:1.1, t:[1.5,1.6,0.5], fov:37.5}
  ✓ linear 与 inout 在中点重合（三次缓动中点 = 0.5）
  k=0.25 → inout r=19.25 · linear r=17
  ✓ k=0.25 时 inout 慢于 linear（缓入）
  跨 ±π 末值 theta = 3.2832（与 -3.0 的角度差 0）
  ✓ 跨 ±π 的末值在角度上等于目标值
  ✓ interpCam 对非法输入有兜底（NaN → 默认值）

4. 总时长与镜头起点
  镜头时长 2 + 3 + 4 → 总时长 9s；起点 0 / 2 / 5s
  ✓ 总时长 = 9
  ✓ 空数组总时长 = 0
  ✓ 起点：0 / 2 / 5
  ✓ 起点越界被夹取

5. sampleShots 时间采样（t=0 / 中值 / 末值 / 定格）
  t=0.0 → idx=0 local=0 {r:24, phi:1.05, theta:0, t:[0,1.2,0], fov:45}
  t=1.0 → idx=0 local=0.5 {r:18.5, phi:1.1, theta:0.4, t:[0.5,1.3,0], fov:42.5}
  t=2.0 → idx=1 local=0 {r:13, phi:1.15, theta:0.8, t:[1,1.4,0], fov:40}
  t=6.5 → idx=2 local=0.375 {r:4, phi:1.25, theta:1.6, t:[2,1.5,0.5], fov:30}
  t=9.0 → idx=2 local=1 atEnd=true {r:4, phi:1.25, theta:1.6, t:[2,1.5,0.5], fov:30}
  t=99  → idx=2 local=1 atEnd=true（越界夹到末尾）
  t=-5  → idx=0 local=0（负值夹到 0）
  ✓ t=0：镜头 0、local=0、相机 = 镜头0 姿态
  ✓ t=1：镜头 0 的 50%（2s 段的中点）
  ✓ t=1：相机 = A→B 的中点（r 24→13 ⇒ 18.5）   r=18.5
  ✓ t=2：正好切到镜头 1、local=0、相机 = 镜头1 姿态
  ✓ t=6.5：最后一个镜头（5s 起）local=0.375   local=0.375
  ✓ 最后一个镜头是定格：t=6.5 相机 = 镜头2 姿态（fov 30）
  ✓ t=9 = 末尾：atEnd=true、停在镜头 2
  ✓ t=99 越界夹取到末尾
  ✓ t=-5 负值夹到 0
  ✓ 空镜头数组返回 null
  ✓ 只有 1 个镜头：时长内保持该姿态
  ✓ 只有 1 个镜头：到末尾 atEnd=true

6. 规整与格式化
  极端输入 → {"label":"镜头 1","duration":0.1,"cam":{"r":0.01,"phi":0.0001,"theta":1,"t":[1,0,3],"fov":1}}
  ✓ 时长下限夹到 0.1
  ✓ 空名称回落「镜头 1」
  ✓ r 取正、phi 夹进安全区、fov 夹到 ≥1
  ✓ 时长上限夹到 120
  ✓ 未知 ease → inout
  ✓ 缺 id 自动补
  ✓ formatTime(0) = 0:00.0   实际 0:00.0
  ✓ formatTime(3.4) = 0:03.4   实际 0:03.4
  ✓ formatTime(65.2) = 1:05.2   实际 1:05.2
  ✓ formatTime(-3) 不为负   实际 0:00.0
  ✓ normalizeCam 默认值：r16 phi1.05 fov45

7. Timeline 数据层（假 editor，无 DOM）
  3 次 addShotFromCamera → ids=…_1, …_2, …_3，onChange 触发 3 次
  ✓ 加镜头返回完整模型 {id,label,duration,cam,ease}
  ✓ 抓到的是当前相机（第 1 帧 theta=3.0, fov=45）
  ✓ 默认时长 3s × 3 = 9s   实际 9
  ✓ onChange 每次加镜头都触发（3 次）   实际 3
  seek(0)    → time=0 editor.sph.r=24（= 镜头1 的 24）
  seek(4.5)  → time=4.5 lastCam={r:8, phi:1.25, theta:-2.7, t:[2.5,1.45,1], fov:31.5}
  seek(999)  → time=9（夹到总时长）lastCam={r:4, phi:1.3, theta:-2.4, t:[3,1.5,1], fov:28}
  ✓ seek(0) 把镜头 1 姿态写进 editor
  ✓ seek(999) 夹到总时长 9
  ✓ seek 到末尾 = 镜头 3 姿态
  ✓ seek 中点落在镜头 2 的段内（4.5 ∈ [3,6)）
  镜头1→2 段中点（t=1.5）theta = 3.1416（应跨 ±π，≈3.1416，而不是绕 0）
  ✓ 镜头1→2 的 theta 走最短弧（≈±π，而不是绕 0）   θ=3.1416
  该段 t=2.5 theta = 3.2779（朝 -3.0 收敛中，等价角距还剩 0.0052）
  ✓ getShots() 返回深拷贝，外部改动不影响内部
  把第 3 个镜头时长 3→5：总时长 9 → 11，名称 → 特写
  ✓ updateShot 改时长后总时长 = 11
  ✓ updateShot 改名生效
  ✓ updateShot 时长下限保护（-3 → 0.1）
  moveShot(0→2)：_1,_2,_3 → _2,_3,_1
  ✓ moveShot 把第 1 个移到末尾
  ✓ moveShot 越界返回 false
  removeShot → 3 → 2 个镜头
  ✓ removeShot 数量 -1
  ✓ removeShot 未知 id 返回 false
  ✓ 初始 isPlaying = false
  ✓ totalDuration() 是数字
  ✓ stop() 后时间归零
  ✓ 空时间线 play() 返回 false
  ✓ destroy() 后可安全重复调用

8. 采样连续性（播放不会跳帧）
  0→9s 均匀 901 采样（dt=0.01s）：相邻采样最大姿态跳变 0.196 @t=1s
  理论上界 3×span/dur×dt = 0.198（easeInOutCubic 中点导数 3）
  ✓ 采样连续：实测最大跳变 ≤ 理论速度上界（无段边界断裂）   实测 0.196 / 上界 0.198
  ✓ 播放不会出现「瞬移」级跳变（< 2× 上界）   实测 0.196

结果：75 通过 / 0 失败
```

### 8.3 测试覆盖了什么

- **验收要求的三点全覆盖**：`t=0` / 中值 / 末值（第 3 组 interpCam + 第 5 组 sampleShots）、theta 最短弧（第 2 组 8 条 + 第 7 组真实跨 ±π 段落）、总时长（第 4 组 + 第 7 组改时长后重算）；
- 数据层在**无 DOM**下跑通（第 7 组用假 editor 走完 add → seek → update → move → remove → destroy 全链路，并验证 `applyCamState` 真被调用）；
- 连续性用可推导的速度上界判断（第 8 组），不是魔法阈值；
- 边界：空数组 / 单镜头 / 负时间 / 超时长 / NaN / 空名称 / 未知 ease / 越界 move / 未知 id remove / 重复 destroy。

---

## 9. 已知限制 / 未做项

1. **没在浏览器里跑过**（任务要求：共享 Chromium 归 Lead 统一截图）。所以「CSS 实际观感、拖拽手感、真 WebGL 相机跟手」这三项需要 Lead 在浏览器里验收。
2. **缩略图不持久化**（§2.3 的体积权衡）。重载场景后卡片显示序号占位；若产品上必须保留缩略图，建议单独存 IndexedDB，而不是塞进场景 JSON。
3. **镜头之间只有一种转场**（直接插值运动），没有硬切（cut）。硬切可以用 `ease:'linear'` + 极短时长（0.1s）近似，但不是真正的瞬时切换；要真 cut 需要给 shot 加 `cut:true` 字段并在 `sampleShots` 里跳过插值——留给下一轮。
4. **不能拖拽排序**，只有 ◀/▶ 按钮（刻意选择：按钮天然可键盘操作，符合无障碍要求；拖拽会引入 pointer 事件与 workbench 的资产拖拽冲突风险）。
5. **播放不驱动录屏/导出**。真正的「出片」需要把帧序列交给 `export.js`/`player.js`（别人在写），本模块只负责把相机按时送到位。
6. **`applyCamState` 会打断进行中的机位补间**（`camAnim`）。如果未来要在播放时同时保留「点机位书签」的平滑过渡，需要把两者统一到一个相机调度器里。
7. **`phi` 只做数学安全夹取**（0.0001–π-0.0001），没有夹到轨道操作的 0.12–1.52。手工构造/导入的极端 `phi` 会造成接近顶视/底视的构图，这属于数据问题不是 bug。
8. **返回拦截的脏检查看不到分镜改动**（`js/app.js:916` 只比 `editor.serialize()`）。只改时间线不会自动保存，详见 §7.2 的一行修法。该文件不归我改。

---

## 10. 与其它模块的边界

| 模块 | 关系 |
|---|---|
| `js/editor.js` | 我只追加了 `captureCam()` / `applyCamState()` 两个方法；相机仍归它拥有 |
| `js/app.js` | 接线方。已按 §7 接入；脏检查留了一个待修点 |
| `js/storyboard.js` / `js/export.js` | 消费 `timeline.getShots()` 做接触表/清单/PNG 序列导出；我**没有**改它们，也没在它们里面调用时间线 |
| `js/player.js` | 无关（它播的是导入的 AI 视频/HTML 场景，不是轨道相机） |
| `css/workbench.css` | 完全不动；我的样式全在 `timeline.css`，选择器前缀 `.tl-` / `#wb-timeline`，并复用 `--ed-*` 变量 |
| `store.js` | 无直接依赖；分镜随场景记录 `editorRec.shots` 一起被 `persist()` 存进 `localStorage` |
