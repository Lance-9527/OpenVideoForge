# 白膜工作台 · Cinemap 视觉升级说明

> 归属：prod-design（task-8）· 只动视觉层，不动业务逻辑
> 基线：白膜工作台 / Whitebox Workbench（MIT）· 目标质感：cinemap.ai
> 文件：`product/css/fonts.css`（新）、`product/css/cinemap.css`（新）、
> `product/assets/fonts/*.woff2`（16 个，从 `raw/design/fonts/woff2/` 复制）、
> `product/index.html`（3 行新增）、本文档

---

## 0. 一句话结构

**`workbench.css` 一行没改。** 视觉换血靠两层：

1. **token 桥接**——把工作台原有的 18 个变量（`--bg0/--bg1/--text/--amber/...`）
   在同一个 `:root` 里重新指向 cinemap token。原文件里 400+ 处 `var(--bg1)` 这类引用
   因此**自动**换色，明暗两套也只需在 `html[data-theme="dark"]` 里换一次 token。
2. **外观覆盖**——原文件里硬编码的 `#0c1018` / `rgba(255,210,80,.45)` / `linear-gradient(...)`
   才逐条覆盖（全部集中在 `cinemap.css`，每处注明原因）。

另外还有第三条隐形的：**编辑器局部变量 `--ed-*` 也被桥接**，于是队友的
`css/timeline.css`（时间线模块，运行时注入）取 `var(--ed-panel)` 等值时就**自动**跟随本层主题，
不需要它改一行。

```
index.html
 ├─ css/workbench.css     原布局骨架（未改）
 ├─ css/fonts.css         本地 @font-face（Fraunces / Inter，latin + latin-ext）
 └─ css/cinemap.css       ← 本层：token + 覆盖
      ├─ :root                    亮色 token + 桥接
      ├─ html[data-theme="dark"]  After Dark token 翻转
      └─ 组件覆盖（255 个选择器/规则组）
```

---

## 1. Token 映射表（cinemap token → 工作台落点）

### 1.1 原色板（数值与 `raw/app/extracted/app.css` 的 `:root` 完全一致）

| cinemap token | 亮色值 | 本层桥接到 | 工作台里具体吃它的地方 |
|---|---|---|---|
| `--cream` | `#faf7f0` | `--bg1`、`--ed-panel` | `#library`、`#detail`、`#topbar`、`.ed-top`、`.ed-inspect`、`.ed-bottom`、`.btn` 底、卡片底 |
| `--cream-2` | `#f3efe4` | `--bg0`、`--bg2`、`--ed-bg` | `body`、`#viewport`、`.search`、`.lib-item:hover`、输入框底、`.ed-asset` |
| `--cream-3` | `#ebe4d2` | `--bg3` | 悬停/按下底、`.ed-shots` 段控槽、`.ed-back:hover` |
| `--ink` | `#1a1612` | `--text`、`--ed-text` | 正文、标题、`.btn.primary` 的底 |
| `--ink-2` | `#3a3228` | 直接引用 | 次级标题、`.btn`/`.op` 文字、`.d-meta-row .v` |
| `--ink-3` | `#5c5348` | `--text2`、`--ed-text2` | 次级正文、`label`、`.d-sub`、`.lib-sub` |
| `--ink-4` | `#847967` | 仅装饰/描边 | `.btn.ghost:hover` 描边（4.00:1，不承载小字） |
| `--brass` | `#b08d57` | `--teal`? 否 → `--accent-strong` | `.brand-logo` 描边、`.ctl-play` 边框、滑杆拇指、`.ed-rail` 菱形/active 条、`.ed-chip:hover` 边框 |
| `--brass-2` | `#8a6d40` | `--accent`（亮色） | 小字强调：`.lib-item.active .lib-title`、`.tier-A` 文字、`.lib-head` 序号、`.en-sec-head h2::before` |
| `--brass-light` | `#d4b68a` | 暗色 `--accent-strong` | 暗色焦点环、`.mine-badge.native` |
| `--jade` | `#6e8a75` | `--teal`（= `--jade-ink`，见 1.2） | `.ctl-ticks`、`.toast.ok` 左边线、`.tier-B` 底/边 |
| `--coral` | `#c2634e` | `--red`（= `--coral-ink`） | 危险按钮、`.toast.err`、`.rep.err`、`.d-loading.fail` |
| `--line` | `#d8cfbc` | `--line`、`--ed-line` | **全部 1px 发丝线**：栏分隔、卡片边、表格行、输入框 |
| `--line-2` | `#e8e1d0` | `--line2`、`--ed-line2` | 卡片内分隔、次级描边、滑块轨道 |
| `--pane-bg` | `#0a0907` | `--pane-bg`（**恒暗，两套主题同值**） | `.ed-viewport`（3D）、`.d-stage`、`.card-thumb`、`.lib-thumb`、`.env-prev`、`.mine-thumb` |

> 与原 cinemap 的**唯一有意偏离**：cinemap 的 `--pane-bg` 在亮色下等于 `--cream`（SVG 图纸）；
> 工作台的 pane 是 WebGL 白模视口，米色底会让白模糊在背景里，所以 `--pane-bg` 两套主题恒为 `#0a0907`。
> 这是"深色取景框 + 米色纸面外壳"的编辑台式观感，也是本产品要的"白模突出"。

### 1.2 派生语义 token（为什么不能直接用黄铜/玉绿原色）

cinemap 的 `--brass #b08d57` 在 `--cream` 上只有 **2.89:1**、`--jade` 3.53:1、`--coral` 3.78:1——
都不能承载小字（AA 要 4.5:1）。所以本层派生了一层**只在文字/Focus 环上使用**的加深版：

| 派生 token | 亮色 | 暗色 | 实测对比度 | 用途 |
|---|---|---|---|---|
| `--accent` | `#8a6d40` | `#d4b68a` | 4.52:1 / 9.73:1 | 强调小字、active 标题、序号 |
| `--accent-strong` | `#b08d57` | `#ead0a3` | 仅图形/大字号 | 描边、图标、装饰 |
| `--jade-ink` | `#4f6a56` | `#8fac96` | 5.56:1 / 7.63:1 | 状态文字、`.shot b` |
| `--coral-ink` | `#a04b37` | `#d97e69` | 5.52:1 / 6.40:1 | 危险/错误文字 |
| `--text-muted` | `#6d6353` | `#9c9179` | 5.51:1 / 6.04:1 | **替代 `--ink-4`** 承载 10–12px 说明文字 |
| `--focus-ring` | `#8a6d40` | `#ead0a3` | 4.52:1 / 12.59:1 | `:focus-visible` 2px 环 |

其余：`--brass-soft/line/glow`、`--jade-soft/line`、`--coral-soft/line` 是半透明强调（rgba 无法由 `var(--brass)` 推导色相，两套主题各写一次）；
`--pane-scrim-1/2/3`、`--shadow-thumb` 供 pane（深色视口）上的小标签使用。

---

## 2. 明暗两套完整值

### 2.1 亮色（默认，`html[data-theme="light"]` 或不设）

| token | 值 |
|---|---|
| `--cream` / `--cream-2` / `--cream-3` | `#faf7f0` / `#f3efe4` / `#ebe4d2` |
| `--ink` / `--ink-2` / `--ink-3` / `--ink-4` | `#1a1612` / `#3a3228` / `#5c5348` / `#847967` |
| `--brass` / `--brass-2` / `--brass-light` | `#b08d57` / `#8a6d40` / `#d4b68a` |
| `--jade` / `--coral` | `#6e8a75` / `#c2634e` |
| `--line` / `--line-2` | `#d8cfbc` / `#e8e1d0` |
| 派生 | `--accent #8a6d40`、`--jade-ink #4f6a56`、`--coral-ink #a04b37`、`--text-muted #6d6353` |
| 半透明 | `--brass-soft rgba(176,141,87,.10)`、`--brass-line rgba(176,141,87,.34)`、`--brass-glow rgba(176,141,87,.22)`、`--jade-soft rgba(110,138,117,.12)`、`--coral-soft rgba(194,99,78,.10)` |
| 遮罩 | `--scrim rgba(26,22,18,.42)`（模态）、`--scrim-soft rgba(250,247,240,.86)`（拖拽） |
| 阴影 | `--shadow-1 0 1px 2px rgba(26,22,18,.05)`、`--shadow-2 0 6px 20px rgba(26,22,18,.08)`、`--shadow-3 0 18px 48px rgba(26,22,18,.14)` |
| `--pane-bg` | `#0a0907`（不变） |

### 2.2 暗色 After Dark（`html[data-theme="dark"]`）

| token | 值 |
|---|---|
| `--cream` / `--cream-2` / `--cream-3` | `#14110d` / `#1d1916` / `#2a241e` |
| `--ink` / `--ink-2` / `--ink-3` / `--ink-4` | `#f3ecdb` / `#d4cab2` / `#a89d83` / `#847967` |
| `--brass` / `--brass-2` / `--brass-light` | `#d4b68a` / `#b08d57` / `#ead0a3` |
| `--jade` / `--coral` | `#8fac96` / `#d97e69` |
| `--line` / `--line-2` | `#2f2820` / `#25201a` |
| 派生 | `--accent #d4b68a`、`--accent-strong #ead0a3`、`--jade-ink #8fac96`、`--coral-ink #d97e69`、`--text-muted #9c9179`、`--focus-ring #ead0a3` |
| 半透明 | `--brass-soft rgba(212,182,138,.12)`、`--brass-line rgba(212,182,138,.34)`、`--brass-glow rgba(212,182,138,.26)`、`--jade-soft rgba(143,172,150,.14)`、`--coral-soft rgba(217,126,105,.14)` |
| 遮罩 | `--scrim rgba(0,0,0,.62)`、`--scrim-soft rgba(10,9,7,.82)` |
| 阴影 | `--shadow-1 0 1px 2px rgba(0,0,0,.4)`、`--shadow-2 0 6px 20px rgba(0,0,0,.5)`、`--shadow-3 0 18px 48px rgba(0,0,0,.62)` |
| `--pane-bg` | `#0a0907`（不变，外壳更暗后视口仍是"更深一档"） |

**切换方式**（不改 JS、不改 DOM 结构）：

```js
document.documentElement.dataset.theme = 'dark'   // 或 'light'
```

`index.html` 出厂的默认值是 `<html lang="zh-CN" data-theme="light">`。
所有颜色都走 token，散落的硬编码 hex/rgba 在 `cinemap.css` 里已清零
（只剩 7 处 `[fill="#ffd250"]` 这类**属性选择器**，它们是在选中原 HTML 内联 SVG 的 presentation attribute，不是颜色声明）。

---

## 3. 排版

### 3.1 字体族

| token | 栈 | 用在哪 |
|---|---|---|
| `--f-serif` | `'Fraunces', 'Source Han Serif SC', 'Noto Serif CJK SC', 'Songti SC', STSong, SimSun, Georgia, serif` | 品牌中文名、hero 标题、区块标题（20px）、面板/模态标题（16px）、卡片与场景名（14px）、`.ed-name` |
| `--f-sans` | `'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Segoe UI', sans-serif` | 正文、按钮、标签、数字、输入框 |
| `--f-mono` | `'Inter', 'Cascadia Mono', Consolas, monospace` | 覆盖原 `--mono`；cinemap 刻意不用等宽，数字靠 `tabular-nums` 对齐 |

**本地字体**：`css/fonts.css` 声明 16 个 `@font-face`（Fraunces 300/400/500/600 + Inter 300/400/500/600，
各 latin / latin-ext 两片），`src` 指向 `../assets/fonts/*.woff2`（共 1.04 MB，`wOF2` magic 已校验），
`font-display: swap`，`unicode-range` 与上游 `google-fonts-app.css` 一致。**零网络请求，可离线。**
上游没有抓 CJK 切片，中文按上面的栈回退到系统字体（思源宋/宋体、苹方/微软雅黑），这是预期行为。

### 3.2 字号阶梯（写进 `:root`，8 级）

| token | px | 行高 token | 行高 | 用在哪 |
|---|---|---|---|---|
| `--fs-2xs` | 11 | `--lh-body` | 1.55 | meta、序号、`.en-sec-tip`、`.lib-sub`、`.card-sub`、按钮辅助字 |
| `--fs-xs` | 12 | `--lh-body` | 1.55 | 控件文字、`.btn`/`.op`/`.ed-btn`、`.lib-title`、`.d-meta-row`、`.toast` |
| `--fs-sm` | 13 | `--lh-body` | 1.55 | **正文基准**（`body`）、`.en-sub` |
| `--fs-base` | 14 | `--lh-title` | 1.45 | 卡片标题、`.d-title`、`.ed-name`、`.env-name`、`.mine-title` |
| `--fs-md` | 16 | `--lh-title` | 1.45 | 面板/模态标题、`.en-card-text b`、`.empty-title` |
| `--fs-lg` | 20 | `--lh-snug` | 1.35 | 入口页区块标题 `.en-sec-head h2` |
| `--fs-xl` | 26 | `--lh-snug` | 1.35 | hero 标题下限（`clamp()` 的 min） |
| `--fs-2xl` | 34 | `--lh-tight` | 1.15 | hero 标题上限（`clamp(--fs-xl, 2.6vw, --fs-2xl)`） |

其他：`--ls-caps: .08em`（小号全大写标签）、`--ls-tight: -.01em`（大字号收紧）；
`:root` 上统一 `font-variant-numeric: tabular-nums`（时间码、计数、字段数值全部对齐）。

### 3.3 空间与形状

圆角 `--r-xs 2px` / `--r-sm 4px` / `--r-md 6px` / `--r-pill 999px`——卡片与面板一律 4–6px，
药丸只给 badge / chip / 滚动条。阴影只有三档且都很轻（亮色最大 `0 18px 48px @ .14`）。
线宽统一 `1px var(--line)`，卡片内部次级分隔用 `1px var(--line-2)`，原来是 `1px dashed rgba(30,38,53,.7)`（深蓝虚线）已替换。
动效 `--t-fast .2s / --t .26s / --t-slow .32s`，统一 `ease`。

---

## 4. 覆盖了哪些选择器

`cinemap.css` 共 **257 个唯一选择器/规则组**（含 `@media` 内）。按模块：

**基础（22）**：`:root`、`html[data-theme="dark"]`、`#view-editor`、`html`、`body`、`a`、`a:hover`、
`::selection`、`::-webkit-scrollbar`(-thumb/-thumb:hover/-track)、`*`、
`input/textarea/select`、`::placeholder`、`checkbox/radio/range`、`:where(...):focus-visible`（8 种控件统一焦点环）、
主题翻转过渡组（19 个元素的 background/color/border 一起过渡）。

**顶栏与品牌（9）**：`#topbar`、`.brand`、`.brand-text .cn`、`.brand-text .en`、`.brand-logo`、
`.brand-logo [stroke="#ffd250"]`、`.brand-logo [fill="#ffd250"]`、`.search`、`.search:hover`、`.search:focus-within`、
`.search input`、`.search input::placeholder`。

**按钮（20）**：`.btn`、`:hover`、`:active`、`.btn.primary`、`.btn.primary:hover`、`.btn.ghost`、`.btn.ghost:hover`、
`.btn.wide`、`.op`、`.op:hover`、`.op.primary`、`.op.primary:hover`、`.op.danger`、`.op.danger:hover`、
`.ed-btn`、`:hover`、`.ed-btn.primary`、`.ed-btn.primary:hover`、`.ed-btn.on`、`.ed-btn.danger`、`.ed-btn.danger:hover`。

**入口页（35）**：`#view-entry`、`#starfield`（+暗色）、`.en-top`、`.en-hero`、`.en-hero h1`、`.en-sub`、`.en-cards`、
`.en-card`、`:hover`、`.en-card.primary`、`.en-card.primary:hover`、`.en-card-icon`、`.en-card-text`、`.en-card-text b`、
`.en-card-text i`、`.en-scroll`、`.en-sec`、`.en-sec-head`、`.en-sec-head h2`、`.en-sec-head h2::before`（编号）、
`.en-sec-tip`、`.en-foot`、`.en-foot a`、`.en-foot a:hover`、`.en-mascot` + 5 条像素小人配色属性选择器、
`.env-grid`、`.env-card`、`.env-card:hover`、`.env-card .env-prev`、`.env-info`、`.env-name`、`.env-desc`、
`.mine-grid`、`.mine-card`、`.mine-card:hover`、`.mine-thumb`、`.mine-thumb .ph`、`.mine-badge`、`.mine-badge.native`、
`.mine-body`、`.mine-title`、`.mine-sub`、`.mine-empty`。

**场景库左栏（18）**：`#library`、`.lib-head`、`.lib-head > span:first-child::before`（"01" 序号）、`.lib-count`、
`.lib-ops button`(+hover)、`#sceneList`、`.lib-item`、`:hover`、`.lib-item.active`、`.lib-thumb`、`.lib-thumb-ph`、
`.lib-title`、`.lib-item.active .lib-title`、`.lib-sub`、`.tier`、`.tier-A`、`.tier-B`、`.lib-del`、`.lib-del:hover`、
`.lib-foot`、`.lib-empty`、`#stats`、`#stats b`。

**中央画布（11）**：`#viewport`、`#gridView`、`#gridCards`、`.grid-empty`、`.card`、`.card:hover`、`.card.active`、
`.card-thumb`、`.card-dur`、`.card-body`、`.card-title`、`.card.active .card-title`、`.card-sub`、
`#emptyHint` 系（`.empty-icon/.empty-title/.empty-sub`）、`#dropMask`、`.drop-box`、`.drop-icon`。

**详情面板（20）**：`#detail`、`.d-head`、`.d-title`、`.d-sub`、`.d-close`(+hover)、`.d-stage`、`.scene-frame`、
`.d-loading`(+`.fail`)、`.d-controls`、`.ctl-play`(+hover)、`.ctl-time`、`.ctl-track input[type=range]`（含 thumb / disabled）、
`.ctl-ticks i`、`.ctl-speed`(+hover)、`.ctl-icon`(+hover)、`.d-meta`、`.d-meta-row`、`.d-meta-row .k`、`.d-meta-row .v`、
`.shot-list`、`.shot`、`.shot b`、`.shot:hover`、`.d-ops`。

**Toast / 模态 / 报告（22）**：`#toasts` 系 `.toast`、`.toast.ok/.warn/.err`、`#modal`、`.modal-box`、`.modal-head`、
`.modal-head button`(+hover)、`#modalBody`、`.modal-loading`、`.modal-tip`、`.rep`、`.rep.ok/.err`、`.rep-head`、
`.rep-msg`、`.rep-warns`、`.spec-actions`、`.spec-pre`。

**编辑器（62）**：`.ed-top`、`.ed-back`(+hover)、`.ed-env-badge`、`.ed-name`(+`:hover`/`:focus`)、
`.ed-rail`、`.ed-rail::before`（黄铜菱形 mast）、`.ed-rail button`、`.ed-rail button::after`（01/02/03 序号）、
`:hover`、`.active`、`.active::after`、`.ed-drawer`、`.ed-drawer-head`(+input/input:focus/button/button:hover)、
`.ed-asset-grid`、`.ed-asset`(+hover)、`.ed-asset-name`、`.ed-asset-img`（app.js 新版把缩略图包了一层 span，补的盒模型）、`.ed-drawer-foot`、
**`.ed-viewport`、`.ed-viewport::before`（"3D · VIEW" pane label）、`.ed-vp-tip`**、
`.ed-inspect`、`.ed-ins-title`、`.ed-ins-title .swatch`、`.ed-ins-empty`、`.ed-field`、`.ed-field label`、
`.ed-field input[type=number]`(+focus)、`.ed-field .val`、`.ed-colors button`(+hover)、`.ed-ins-ops`、
`.ed-cam-list`、`.ed-cam-item`(+hover)、`.ed-cam-item .del`(+hover)、`.ed-bottom`、`.ed-chip`(+hover)、`.ed-chip.add`(+hover)、
`.ed-shots`、`.ed-shots button`(+hover)、`.ed-shots button.active`。

**@media（3 组）**：`(max-width: 900px)` 颜色/字号微调、`(pointer: coarse)` 全部交互元素 `min-height: 44px`、
`(prefers-reduced-motion: reduce)` 全站压到 `0.001ms`。

布局观感（布局规则仍由 `workbench.css` 负责，本层只调观感）：
编辑器已天然是 **左侧编号栏（38×40，竖排 01–0N）+ 中间深色画布 + 右侧检视卡片**，
场景库是 **左列表 + 中卡片网格 + 右详情**，三栏之间全是 1px `--line`；入口页是编号区块（01/02）+ 米色纸面。

---

## 5. 无障碍与动效（实测数据）

| 检查项 | 结果 |
|---|---|
| 正文 `--ink` on `--cream` | **16.81:1**（亮）/ **15.98:1**（暗） |
| 次级正文 `--ink-3` on `--cream` | **7.05:1**（亮）/ **7.00:1**（暗）✅ AA |
| `--ink-3` on `--cream-3` | 5.94:1 / 5.71:1 ✅ |
| `--text-muted` on `--cream-3` | 4.65:1（亮）/ 5.60:1（暗）✅ |
| 强调小字 `--accent` on `--cream` | 4.52:1（亮）/ 9.73:1（暗）✅ |
| `--jade-ink` / `--coral-ink` on `--cream` | 5.56 / 5.52 ✅（暗色 7.63 / 6.40） |
| 主按钮（墨底米字） | 16.81:1（亮）/ 15.98:1（暗）；悬停转黄铜 `--brass-2` 时 4.52:1 ✅ |
| 焦点可见 | `:focus-visible` → `outline: 2px solid var(--focus-ring); outline-offset: 2px`，覆盖 8 类控件 + 4 个原本 `outline:none` 的输入框 |
| 触控目标 | `@media (pointer: coarse)` 下 `.btn/.op/.ed-btn/.ed-rail button/.ed-chip/.ed-shots button/.ctl-*/.lib-item/.en-card/.env-card/.mine-card/.search/.d-close/.modal-head button/.lib-ops button` 全部 `min-height: 44px`（`min-width` 不动，避免撑破 46px 侧栏） |
| 降低动效 | `@media (prefers-reduced-motion: reduce)` → `animation-duration/transition-duration: .001ms !important` + `transition-delay: 0ms` + `scroll-behavior: auto` |
| 动效时长 | 全部在 **0.2–0.32s**：原 `0.12/0.13/0.15/0.16/0.18s` 的 9 处（`.btn`、`.op`、`.lib-item`、`.lib-del`、`.shot`、`.ctl-*`、`.card`、`.en-card`、`.ed-btn` 等）都覆盖为本层 token；`#emptyHint 0.3s`、`#modal 0.2s` 已在区间内保留 |

`--ink-4 (#847967)` 是 cinemap 原值 4.00:1，**本层只用于描边与装饰**，所有 10–12px 说明文字改用 `--text-muted`。

---

## 6. `index.html` 的改动（全部 3 行，零删除）

```diff
-<html lang="zh-CN">
+<html lang="zh-CN" data-theme="light">
 <link rel="stylesheet" href="css/workbench.css">
+<!-- cinemap 视觉层：先字体，再覆盖层（必须在 workbench.css 之后） -->
+<link rel="stylesheet" href="css/fonts.css">
+<link rel="stylesheet" href="css/cinemap.css">
```

**没有改任何 id、class、DOM 结构、脚本引用**——"左侧编号栏"之类的观感全部由 CSS 计数器
（`counter-reset`/`counter-increment`/`::before`/`::after`）和伪元素完成，不需要往 HTML 里加标记，
因此 `app.js` 里大量 `$('#id')` 与 `classList.add('active')` 全部不受影响。

### 验收证据

**(a) id 清单前后对比（改动后必须只增不减）**

```powershell
# 改动前快照（本次会话开工时，先于任何编辑）
Select-String -Path index.html -Pattern 'id="[^"]*"' -AllMatches -> tmp_ids_before.txt   # 56 项
# 改动后
Select-String -Path index.html -Pattern 'id="[^"]*"' -AllMatches | % { $_.Matches.Value } | Sort-Object -Unique
Compare-Object -ReferenceObject $before -DifferenceObject $after
```
输出：
```
before=56 after=56
=== diff (before vs after) ===
（空）
```

**(b) CSS 括号配平 + 结构校验**（脚本剥离注释后逐字符扫描，见 `%TEMP%\csscheck.py`）：

```powershell
python csscheck.py css\fonts.css css\cinemap.css
```
输出：
```
fonts.css     bytes=8094    lines=179   braces=balanced
cinemap.css   bytes=44357   lines=1328  braces=balanced
RESULT: PASS
```
（另外：`var(--x)` 全部有定义 —— 110 个已定义变量、71 个被引用，缺失 0；
`{`/`}` 266/266，注释剥离后 `(`/`)` 全部配平。）

**(c) 未触碰的文件**：`product/css/workbench.css`、`product/js/**` 本次会话未写入（工作台原样式与逻辑保持原样；
队友正在改的 `js/app.js`、`js/editor.js`、`js/timeline.js`、`js/storyboard.js`、`js/export.js` 与 `product/css/timeline.css` 均未由本层改动）。

---

## 7. 已知未覆盖处（需要别人接力，或明确接受）

1. **3D 视口的 WebGL 清屏色 CSS 改不了**（最重要）。
   `js/editor.js` 在构造时写 `this.scene.background = new THREE.Color(0xeceae4)`（第 45 行），
   载入环境时又写 `new THREE.Color(built.sky)`（第 99 行）。这两处直接决定视口里那块**浅米色背景**，
   CSS 的 `.ed-viewport { background: var(--pane-bg) }` 只在 canvas 之下、被 canvas 盖住。
   **需要 editor.js 的负责人改一行**：
   `this.scene.background = null;`（让 CSS `--pane-bg` 透出，最干净）或 `new THREE.Color(0x0a0907)`。
   本层已把 `.ed-viewport`、canvas 容器、pane label、`.ed-vp-tip` 的深色取景框全部做好，正等这一行。
2. **`js/storyboard.js` 的全屏分镜面板用内联 `style` 硬编码颜色**（`#fffdf8`、`#c8891a`、`#d9d5c9`、`#6b7280` 等），
   内联样式优先级高于本层且没有 class 锚点，CSS 无法覆盖；要它跟随 token，得把那些 `UI.*` 样式常量改成 class 或读 `var(--ed-*)`。
3. **`css/timeline.css`（队友产出，运行时注入）自带一套 `--tl-*` 默认值**。
   它优先读 `var(--ed-panel)` 等编辑器变量，所以本层桥接后它**自动**跟随明暗主题；
   但它内部仍有 3–4 处硬编码渐变（如 `.tl-bar` 的 `#fbfaf7`），暗色下会有轻微亮边——归属该文件的作者。
4. **Three.js 场景内部颜色**（`GridHelper` 网格、选中框、环境天空色）由 JS 决定，本层不覆盖。
   `.ed-rail` 的"网格"按钮切换出的网格线颜色即属此类。
5. **品牌 SVG / 像素小人是内联 presentation attribute**（`stroke="#ffd250"` 等，写在 `index.html` 里）。
   本层用属性选择器 `.brand-logo [stroke="#ffd250"]` 改成 `var(--brass)`，视觉已对；
   但 HTML 源里这些硬编码色值仍然存在——那是原工程标记，本层按"最小改动"原则没有改 DOM。
6. **入口页星尘 canvas**（`js/app.js` 的 `initStarfield`，画的点固定是 `#cdd6ea`）：
   亮色下用 `mix-blend-mode: multiply` 压成极淡纸屑、暗色下 `screen` 露出当星光；
   如果以后希望纸屑带黄铜色调，需要 JS 端换色（当前 CSS 方案已足够淡，肉眼几乎只是纸纹）。
7. **滚动条**：本层同时给了现代属性 `scrollbar-width: thin` + `scrollbar-color` 与 `::-webkit-scrollbar` 伪元素；
   在 Chromium 121+ 上现代属性优先（细条、`--line` 色），旧内核走伪元素。两者都只在亮/暗 token 内取色。
8. **没有做真实浏览器截图验收**（纪律：共享 Chromium 归 Lead 统一截图）。
   本层只做了静态验证：括号配平、`var()` 定义完整性、id 零增删、`prefers-reduced-motion` 与 `pointer: coarse` 分支存在性。
   建议 Lead 截图核对三处：① 入口页（米色纸面 + 编号区块 + 衬线标题）② 场景库三栏 ③ 编辑器（深色视口 + 编号侧栏 + 右侧检视卡片），
   并切一次 `document.documentElement.dataset.theme='dark'` 看 After Dark。
