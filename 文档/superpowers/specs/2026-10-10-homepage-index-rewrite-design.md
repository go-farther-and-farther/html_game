# 首页 index.html 重写 + 鹈鹕骑车版本导航 · 设计

日期：2026-10-10
范围：内容同步 + 修链接（不做视觉改版）
发布：GitHub Pages 直接服务仓库根目录，推 `master` 即发布（无 gh-pages 分支、无 Actions workflow）

## 背景与问题

线上 <https://go-farther-and-farther.github.io/html_game/> 与本地 `index.html` 逐字一致。维护检查发现 5 处问题：

1. `鹈鹕骑车3D/` 里已有 **10 个 HTML 版本**（多轮迭代 + 单轮模型能力测试混在一起），首页只链 1 个，没有导航层。
2. `人生清单_v2.html` 首页有卡片，但不在 `scripts/build-web.mjs` 的 `items` 列表里 → APK 内点它是 404。
3. `index.html` 的 `showLastPlayTimes()` 硬编码 14 个 gameId，加一张卡要改 HTML + JS 两处。
4. `js/history.js` 的 `GAME_NAMES` / `GAME_ICONS` 缺 4 个 2048 变体 → 历史页筛选栏显示 `2048-5x5` 这类原始 id。
5. `工具脚本/check-syntax.cjs` 读的路径 `html game/pelican-free-ride.html` 早已移到 `鹈鹕骑车3D/`，脚本必然失败。

## 方案

采用**静态手工维护**：直接重写 `index.html`（清单驱动渲染）+ 新建 `鹈鹕骑车3D/versions.html` 静态导航页 + 修上述漏项。

不采用：脚本扫描目录自动生成首页/导航页（「正式迭代 vs 模型测试」是人工判断，无法从目录结构推出）。

## 设计

### 1. 新 `index.html`

- 视觉与现有一致：同一渐变背景、同一卡片网格、同一配色，不做改版。
- 页面底部一个 `GAMES` 清单数组，卡片、分组标题、最近游玩全部由它生成 → **新增游戏只改一处**。
- 清单条目字段：`section`（分组标题，按首次出现顺序生成分组）、`icon`、`name`、`href`、`desc`、可选 `tag`、可选 `id`。
- 有 `id` 的条目才渲染「最近游玩 / 最高分」行；`id` 沿用现有值，**历史记录不丢**。
- 卡片数量 22，与现有持平；唯一内容变化是鹈鹕骑车那张卡改指导航页。

### 2. 多版本呈现规则

每个游戏只留最新版一张卡。2048 的 5 张卡保留 —— 它们是不同玩法（5×5 / AI / 自动化），不是版本迭代。

鹈鹕骑车卡片：`href` 改为 `鹈鹕骑车3D/versions.html`，名称「鹈鹕骑车 · 版本导航」，tag「导航」。

### 3. 新 `鹈鹕骑车3D/versions.html`

纯静态，样式沿用首页那套。顶部「← 返回」回根首页。两组，按修改时间倒序：

**正式迭代（5）**

| 文件 | 日期 | 大小 | 说明 |
|---|---|---|---|
| `pelican-free-ride.html` | 2026-09-26 | 55.5 KB | 3D 开放世界自由骑行 · WASD/跳跃/收集小鱼/里程/音乐 · **推荐** |
| `pelican-bicycle-svg.html` | 2026-10-10 | 33.3 KB | 纯 HTML + SVG 循环动画 · 视差远景、辐条与太阳光芒 |
| `index.html` | 2026-09-25 | 20.1 KB | 3D 展示场景 · 拖拽转视角、滚轮缩放、点鹈鹕逗它 |
| `pelican-bicycle.html` | 2026-09-22 | 18.3 KB | 早期 2D 版 |
| `pelican-cycling.html` | 2026-08-17 | 19.2 KB | 最早的一版 |

**模型能力测试（5）** —— 单轮生成的能力验证产物，未做后续打磨，无历史记录：

| 文件 | 日期 | 大小 |
|---|---|---|
| `鹈鹕5.3flash.html` | 2026-10-09 | 25.8 KB |
| `pelican_bicycleqwen38fn.html` | 2026-10-09 | 18.7 KB |
| `pelican-bike27B.html` | 2026-10-09 | 17.1 KB |
| `qwen3.8_27b_nvfp4_pelican-riding-v2.html` | 2026-09-24 | 20.1 KB |
| `deepseek_html_醍醐骑自行车.html` | 2026-09-22 | 17.8 KB |

分组划分依据是命名（带模型标识的归测试组），属于人工判断，后续新增版本按此约定归组。

### 4. 漏项修正

- `scripts/build-web.mjs`：`items` 补 `'人生清单_v2.html'`，注释写明根目录单文件也要加一行。
- `js/history.js`：补 `2048-5x5` / `2048-ai` / `2048-ai-5x5` / `2048-auto` 的名称与图标。
- `工具脚本/check-syntax.cjs`：路径改为 `鹈鹕骑车3D/pelican-free-ride.html`。残留副本 `工具脚本/syntax-check.mjs` 保留不动（未获删除许可）。
- `README.md`：补 `人生清单_v2.html` 条目，鹈鹕骑车条目说明 versions.html 是版本导航。

## 验证

1. 一次性链接检查：遍历 `index.html` / `history.html` / `versions.html` 全部 `href`，确认目标文件存在。
2. `node --check` 过改动的 `.mjs` / `.cjs`。
3. commit + push（仓库已配 Clash 代理 `127.0.0.1:7897`）→ 等 Pages 生效 → 抓线上首页确认新卡片、抓 `versions.html` 确认 200。

## 不做

视觉改版、搜索框、全站清单驱动、其他文件夹的导航页、重新构建 APK。
