# AGENTS.md — openVideoForge（OVF）协作规则

> 本文件对**所有在本项目上干活的人 / Agent / 脚本**生效。
> 权威源在 `00-Rules/`（工作区级），本文件只写**本项目特有**的硬规矩。

## 0. 一句话

**openVideoForge（OVF）是插件**，不是 VideoForge、不是掌柜AI。
目标是「世界更大、性能更强、更丰富 + 真实世界 + 本地可掌握」。

---

## 1. ★★ 不要随便关用户的浏览器

**用户明确要求（2026-11-10）：**
> 「后面执行 openVideoForge 任务的时候不要再关闭浏览器后再重开浏览器了（不要随便关掉浏览器）。。。这点太反人性了」

### 为什么

用户在**用**这个应用 —— 关掉他的窗口 = 把人正在干的事打断。
而且反复重开 Chrome 会丢掉页面上的一切状态（当前场景、面板布局、未保存的改动）。

### 正确做法

| 需求 | 做法 |
|---|---|
| 让新 js/css 生效 | **CDP `Page.reload`**（页面刷新，浏览器进程和窗口都留着） |
| 让服务端（桥）的新代码生效 | **只重启 node 桥进程**（`cli.mjs serve`），**绝不动 Chrome** |
| 需要干净环境 | 用**新的 user-data-dir + 另一个 CDP 端口**开第二个浏览器实例，**不要动用户那个** |
| 需要重新连 CDP | `tools/cdp.mjs` 的 `CDP.attach('index.html')` 复用现有标签页 |

### 禁止

```powershell
# ✗ 绝对不要
Get-Process chrome | Stop-Process -Force
Get-Process chrome | Where-Object { $_.MainWindowTitle } | Stop-Process
taskkill /F /IM chrome.exe
```

### 例外

只有用户**明确要求**「重启浏览器 / 刷新一下 / 关掉重开」时才可以动。

---

## 2. 产物不落在系统安装目录

数据、缓存、产物、日志一律落在**可配置的目录**（环境变量优先，否则用标准用户目录）：

| 用途 | 位置 |
|---|---|
| 产物 / 输出 | `<输出目录>`（`WBWB_OUT_DIR`） |
| VideoForge 数据 | `<数据目录>`（`VIDEOFORGE_DATA_DIR`） |
| 交付说明 | VideoForge 仓库的 `dist\` |
| 截图 / 测试产物 | `<输出目录>\shots\` |

---

## 3. 改完必须验，且要如实说

- 改 js/css ⇒ **`?v=` 要 bump 到一个新数字**（bump 到同一个数字不生效，浏览器缓存不变）
- 改完跑 `node --check`
- 声称「做完了」必须有**本次会话的命令输出 + 文件路径**为证
- 报告分三段：**结论 / 证据 / 未做项**。做不到的**明说**，别含糊

---

## 4. 真实世界的还原度

用户原话：
> 「场景还原度再高点吧（**真实里面楼栋数是多少给多少，有哪些就给哪些**），按真实的来」

⇒ **不要**用「取样/抽稀」换速度。上限已提到 30000 栋 / 30000 条路，
真实世界是「有多少给多少」。省时间靠**缓存**（本地 raw 重算 0.5 秒），不靠少给。

**数据源署名**：OSM 数据必须带 `© OpenStreetMap contributors`。
Poly Haven / ambientCG 是 CC0。

---

## 5. 已知的老问题（别重复踩）

| 现象 | 真因 | 状态 |
|---|---|---|
| 打开应用是「空房间」 | 已做「打开就是上次的地方」（记住 + 自动恢复） | 已修 |
| 「拍成片」报 Blender 不可用 | 后端要手动起 | 已修（桥启动时自动拉起） |
| 1 秒视频要 337 秒 | 页面在后台时 **rAF 被饿死**（hidden 页第一个 rAF 等 214 秒） | 已修（加 setTimeout 兜底） |
| 40 层楼看不到全貌 | 只画当前层 ±1 | 已修（总览 = 爆炸图） |
| 验收器里 `cmd asset.transform` 失败 | 验收器时序问题（单独复测正常） | 未根治，如实记着 |

---

## 6. 常用命令

```powershell
$node = "<用户目录>"
Set-Location "<仓库目录>"

& $node tools\bump-version.mjs 101          # js/css 缓存版本号（必须是新数字）
& $node tools\ovf-full-accept.mjs          # 综合验收（97 项）
& $node tools\ovf-accept-tour.mjs 京都      # 端到端（17 项）
& $node tools\ovf-huangpu-full.mjs          # 上海黄浦区全量（13 项）
& $node tools\ovf-interior-overview.mjs     # 室内总览（21 项）
& $node tools\ovf-lastworld.mjs             # 打开就是上次的地方（15 项）
& $node tools\ovf-entry-card.mjs            # 入口页卡片 + 自动恢复（5 项）
& npm test                                 # 单测 20 套 / 666 断言
```

**重启桥（不动浏览器）**：

```powershell
Get-Process node | ForEach-Object {
  $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
  if ($cl -like "*cli.mjs*") { Stop-Process -Id $_.Id -Force }
}
Start-Process -FilePath $node -ArgumentList @("bin/cli.mjs","serve","--out","<输出目录>") `
  -WorkingDirectory "<仓库目录>" -WindowStyle Hidden
```

---

## 7. 交付

改完功能 ⇒ 同步交付说明 + 分享包：

```powershell
& $py -X utf8 tools\patch-delivery*.py      # 追加新一轮说明
& $node tools\sync-sharepkg.mjs             # 同步分享包 + md5
```
