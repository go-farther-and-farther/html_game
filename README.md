# HTML 游戏合集

经典小游戏的纯 HTML/CSS/JavaScript 实现，打开即玩，无需安装。已打包为 Android APK（v1.3.0），3D 页面已全部本地化，离线可玩。

## 🎮 游戏列表

每个游戏独立一个文件夹，打开文件夹内的 `.html` 文件即可游玩。

### 合集内小游戏

| 游戏 | 文件 | 说明 |
|------|------|------|
| 2048 合集 | `2048/index.html` | 手动 / AI / 自动 × 4×4 / 5×5；6 个本机排行榜；退出续玩；旧版 5 个页面保留 |
| 贪吃蛇 | `贪吃蛇/贪吃蛇.html` | 基础版贪吃蛇 |
| 人机版贪吃蛇 | `贪吃蛇/人机版贪吃蛇.html` | AI 对战版贪吃蛇 |
| 人机版贪吃蛇2 | `贪吃蛇/人机版贪吃蛇2.html` | AI 对战版贪吃蛇（进阶版） |
| **人机版贪吃蛇3** | `贪吃蛇/人机版贪吃蛇3.html` | **完整版** · 队友/猎杀模式 · 截图 · 小地图 |
| 人机版贪吃蛇3.5 | `贪吃蛇/人机版贪吃蛇3.5.html` | 增强版 |
| 人机版贪吃蛇4 | `贪吃蛇/人机版贪吃蛇4.html` | 高级AI版 |
| 人机版贪吃蛇5 | `贪吃蛇/人机版贪吃蛇5.html` | 终极AI版 |
| 贪吃蛇大冒险V6 | `贪吃蛇/贪吃蛇大冒险V6.html` | 冒险模式 |
| 俄罗斯方块 | `俄罗斯方块/俄罗斯方块.html` | 经典俄罗斯方块 |
| 塔防 · 元素前哨 | `塔防游戏/elemental_outpostV7.html` | 元素塔防 V7 |
| 我的世界 | `我的世界/minicraft3.html` | minicraft 类沙盒 |
| 修仙天赋模拟器 | `修仙天赋模拟器/修仙天赋模拟器-v2.html` | 随机天赋模拟 |
| 鹈鹕自由骑行 | `鹈鹕骑车3D/pelican-free-ride.html` | 3D 骑行游戏 · 需要键盘 |

首页共 18 张卡片：14 个游戏卡片（2048 合集内含 6 种模式）+ 3 个 3D 场景 + 1 个工具。按「经典小游戏 / 人机贪吃蛇 / 策略·沙盒·模拟 / 3D 场景 / 实用工具」分组，支持搜索和类型筛选，手机端固定两列。

### 其他游戏项目

| 项目 | 目录 | 说明 |
|------|------|------|
| 泰坦尼克号 | `泰坦尼克号/` | 3D 泰坦尼克号体验（three.js） |
| 雨夜便利店 | `雨夜便利店/` | 3D 雨夜便利店场景（three.js） |
| 雨夜加油站 | `雨夜加油站/` | 3D 雨夜加油站场景 |
| 鹈鹕骑车3D | `鹈鹕骑车3D/` | 鹈鹕骑车 4 个版本（three.js 3D / SVG 动画），版本导航：`鹈鹕骑车3D/versions.html` |
| 塔防游戏 | `塔防游戏/` | 元素前哨塔防（elemental_outpost V1~V7），附设计文档与测试脚本 |
| 我的世界 | `我的世界/` | minicraft 类沙盒游戏（3 个版本） |
| 修仙天赋模拟器 | `修仙天赋模拟器/` | 修仙天赋随机模拟器（2 个版本），附设计文档 |
| 人生清单 V3 | `人生清单/人生清单_v3.html` | 400 条（核心 100 + 非核心 300）、11 个分类分块、已完成/未完成筛选、导出 PNG 海报；自动迁移 V2 进度 |
| 人生已完成清单 | `人生清单/人生清单_v2.html` | V2 旧版，185 条，进度可被 V3 自动读取 |

### 动画合集（仅网页，不进 APK）

`animations.html` 收录鹈鹕骑车的 3 个 SVG / 3D 演示版本。它们没有游戏玩法，所以只在网页提供，不打包进 APK；首页保留一个「动画合集」入口。

`鹈鹕骑车3D/versions.html` 是更早的版本导航页，保留作为完整版本历史。

### 2048 合集（统一入口）

`2048/index.html` 把原来的 5 个 2048 页面合并成一个：

- 手动 / AI / 自动 × 4×4 / 5×5，共 6 种组合
- 本机排行榜：手动 / AI / 自动 × 4×4 / 5×5，6 个榜各存前 10 名；第 11 名起提示「未进前 10」
- 每个组合独立自动保存；关闭页面/App 后重新打开会恢复上局（AI/自动恢复为暂停）
- AI 使用 expectimax 搜索（4×4 深度 4，5×5 深度 3），默认 650ms 时间上限；速度滑杆只在 60 以上压缩思考预算（最低 120ms），默认强度不变
- 达成 2048 立即写入排行榜和历史；点「继续挑战」后，最终结束再记一条
- 暂停、切后台、停在胜利层时不计时
- 写入失败（隐私模式、空间不足）会明确提示，不会假装「已记录」
- 多个标签页同时打开时，排行榜写入不会互相覆盖

5×5 使用独立最高分键 `2048_5x5_best`；旧版困难模式（每步 2 块）保留自己的键和历史 id `2048-5x5-hard`，两套记录不再混在一起。

旧版 `2048.html`、`2048-5x5.html`、`2048-ai.html`、`2048-ai-5x5.html`、`2048-auto.html` 保留（带 `noindex`），统一页底部有入口。

### 离线与依赖

- 4 个 three.js 页面（我的世界、泰坦尼克号、雨夜加油站、鹈鹕自由骑行）已全部改为本地加载：`js/three/0.160.0/`（ESM + addons）和 `js/three/r128/three.min.js`（minicraft 用的全局版）
- 不再依赖 unpkg / jsdelivr / cdnjs，断网也能打开
- 泰坦尼克号的音色包（tonejs-instruments MP3）和 Google Fonts 仍是外链，离线时自动用内置合成音频和系统字体
- `scripts/`（打包、语法检查）、`文档/`（设计文档与截图）、`js/`（共享库与本地 three）为辅助目录；测试脚本在各游戏 `tests/` 子目录，不进 APK

## 📊 历史记录功能

已接入统一历史记录：

- 2048 六种模式（手动 / AI / 自动 × 4×4 / 5×5）
- 俄罗斯方块、贪吃蛇系列
- 塔防 · 元素前哨（记录到达波次与得分）
- 鹈鹕自由骑行（退出时记录本次里程）

纯 3D 场景（泰坦尼克号、雨夜便利店、雨夜加油站）和「人生清单」不写历史记录。每个游戏最多保留 50 条。

记录内容：得分 / 最高分、游戏时长、胜利/失败/退出、游戏时间。在主页点「📊 历史记录」查看，支持按游戏筛选。

## 📱 Android APK

已打包为 Android 安装包 `HTML游戏合集.apk`（versionName `1.3.0`，约 4.4 MB，release 签名）。

安装方式：

1. 从 [Releases](https://github.com/go-farther-and-farther/html_game/releases/latest) 下载 `html-game-collection.apk`（或使用仓库根目录的 `HTML游戏合集.apk`）
2. 在手机上打开安装（需允许安装未知来源应用）
3. 打开即可玩所有游戏

> **首次升级注意**：1.3.0 起改用固定 release keystore 签名，和之前 debug 签名的包不兼容。已经装过 1.2.0 及更早版本的话，需要先卸载旧版再安装（卸载会清空本地排行榜和历史记录）。

### 应用内下载 / 更新

首页右上角「⬇️ 下载」和页脚都能进入 `download.html`：

- 从 GitHub Releases API 读取最新版本号、APK 大小和更新说明
- 点「下载」会跳转系统浏览器，从最新 Release 下载 APK
- 覆盖安装即可保留本地历史记录（同一签名）
- 网络不可用 / 被限流时自动回退到 `releases/latest` 固定链接

### APK 里有什么

- 首页、历史页、下载页、共享样式/脚本、本地 three.js
- 18 张卡片：14 个游戏（2048 内含 6 种模式）+ 3 个 3D 场景 + 1 个工具
- **不包含**：`animations.html`、鹈鹕骑车的 3 个演示版本、`404.html`、`robots.txt`、`sitemap.xml`、`img/`、`LICENSE`（这些只在网页提供）

### 重新构建 APK

游戏源文件直接放在仓库根目录的各游戏文件夹中（单一源，不再手工维护 www）；`www/` 是自动生成的打包目录（已 gitignore）。

```bash
npm install
npm run check        # 全站 HTML 内联脚本语法检查
npm run cap:sync     # 生成 www → 校验版本号/首页链接 → 同步到安卓工程
cd android && ./gradlew.bat assembleRelease
```

APK 输出路径：`android/app/build/outputs/apk/release/app-release.apk`

> `scripts/build-web.mjs` 会按 `items` 打包、排除 `tests/` / `docs/` / `backup/`，并校验首页 18 个链接和 `package.json` / `js/version.js` / `build.gradle` 三处版本号一致；任何一项不对会直接失败。

### 发布新版本（GitHub Releases）

```bash
# 1. 同步三处版本号：package.json、js/version.js、android/app/build.gradle（versionCode 记得 +1）
# 2. 构建 release 包（需要 android/keystore.properties + htmlgame-release.jks）
cd android && ./gradlew.bat assembleRelease
Copy-Item android/app/build/outputs/apk/release/app-release.apk ../HTML游戏合集.apk
Copy-Item ../HTML游戏合集.apk ../html-game-collection.apk

# 3. 推送代码后发布 Release（download.html 自动读取 latest）
git push origin master
gh release create v1.3.0 "html-game-collection.apk" --title "v1.3.0" --notes "更新说明"
```

签名文件（`android/htmlgame-release.jks` 和 `android/keystore.properties`）已被 gitignore，**务必备份**：丢了就无法再给已安装用户做覆盖升级。根目录的 `HTML游戏合集.apk` 只是本地构建产物（也被 gitignore），clone 仓库不会带安装包，安装请走 Releases。

## 🐍 人机版贪吃蛇3（完整版）

功能最丰富的贪吃蛇版本，支持多种游戏模式：

### 核心玩法
- 🎯 **AI 对战**：最多 18 条 AI 蛇同场竞技（每种最多 3 条）
- 🎮 **PC/手机双端**：WASD/方向键 + 空格加速，或触摸屏幕控制
- ❤️ **复活系统**：每局 3 次复活机会
- 🏆 **胜利截图**：击败所有敌人后自动截图，可保存为 PNG

### 游戏模式
- ⚔️ **猎杀模式**：可穿过自己身体，撞到对方使其变小，越长越强，低于 8 节永久死亡
- 👥 **队友模式**：分蓝/红两队对抗，队友不会互吃，AI 会协作作战
- 两种模式可叠加使用

### 难度设置
- **AI 数量**：2~18 条可调
- **AI 难度**：简单 / 普通 / 困难（影响 AI 反应速度、视野、攻击性）

### 界面增强
- 🗺️ **增强小地图**：显示玩家位置/方向、队友标记、危险方向箭头、红色发光边界
- ⚠️ **边界警告**：靠近地图边缘时屏幕出现红色渐变警告 + 距离提示
- 🔵🔴 **队伍标识**：队友模式下蛇身/名字/排行榜显示队伍颜色

### 性能优化
- 碰撞检测：距离预判 + 空间网格加速食物查找
- 渲染优化：食物批量绘制、长蛇跳帧、粒子数量限制、视口裁剪
- AI 优化：决策频率调整、平方距离替代开方运算

## 🧪 模型 × Agent 记录规则

**以后任何 agent 在这个仓库里新做一个 HTML，都必须写下用了什么模型、什么 agent。** 目的是把模型能力的变化留在仓库里 —— 隔一段时间回看，能看出进步到底在哪、哪些毛病一直没解决。

### 1. 文件名：`<模型>_<agent>_<内容>.html`

```
qwen3.8-27b-nvfp4_dsh_pelican-riding-3d.html
deepseek-v4_zcode_rainy-gas-station.html
glm-5.3-flash_web_tower-defense-v8.html
```

- **模型**：具体型号，小写，带上关键限定（量化方式、版本），如 `qwen3.8-27b-nvfp4`、`glm-5.3-flash`
- **agent**：驱动它的 agent / harness，如 `dsh`（DeepSeek Harness）、`zcode`、`codex`、`web`（网页版对话）
- **内容**：这个 HTML 是什么，如 `pelican-riding-3d`、`tower-defense-v8`

沿用现有约定：**文件名带模型标识 = 一次性生成测试**。正式迭代的主文件（如 `pelican-free-ride.html`）可以不带模型标识，但下面第 2 条的记录块仍然必写。

### 2. HTML 内部记录块：放在 `<head>` 里，必写

```html
<!-- ==================== 生成记录 ====================
模型   : Qwen3.8-27B (nvfp4 本地量化)
Agent  : DSH (DeepSeek Harness)
日期   : 2026-10-10
提示词 : 一句话写清给了它什么要求
轮次   : 一次生成 / 多轮迭代的第 N 轮
结果   : 能不能直接玩、有没有外部依赖（CDN / three.min.js）
评价   : 效果好的点 1~2 条 + 明显的毛病 1~2 条
===================================================== -->
<meta name="x-model" content="Qwen3.8-27B-nvfp4">
<meta name="x-agent" content="DSH">
<meta name="x-date" content="2026-10-10">
<meta name="x-round" content="1">
```

注释给人看，`meta` 给脚本看 —— 以后可以扫全部 HTML 的 `x-model` / `x-date` 自动生成模型能力时间线。

### 3. 新文件在下表追加一行

模型或 agent 不确定就写「未记录」，**不要猜**。

| 日期 | 文件 | 模型 | Agent | 一句话结论 |
|---|---|---|---|---|
| 2026-08-17 | `鹈鹕骑车3D/pelican-cycling-svg-v1.html` | 未记录 | 未记录 | 最早一版，单个内联 SVG 静态插画 |
| 2026-09-25 | `鹈鹕骑车3D/index.html` | 未记录 | 未记录 | 本地 three.min.js 3D 场景 + 「嘎！！」气泡互动 |
| 2026-09-26 | `鹈鹕骑车3D/pelican-free-ride.html` | 未记录 | 未记录 | 1557 行完整游戏，这批里效果最好 |
| 2026-10-10 | `鹈鹕骑车3D/pelican-bicycle-svg.html` | 未记录 | 未记录 | 709 行 HTML+SVG 循环动画，细节最足 |

> 2026-10-20 清理：删除了 6 个早期一次性产物（`qwen3.8_27b_nvfp4` / `deepseek_html_` / `pelican-bike27B` / `鹈鹕5.3flash` / `pelican_bicycleqwen38fn` / `pelican-3d-cdn`）。模型对比的结论留在提交历史和这份文档里，产物本身不再占仓库体积；以后要做对比，在本地或临时分支生成，确认值得长期保留再按本节规则入库并登记。

### 4. 旧文件不追溯

2026-10-10 之前已有的文件不补模型标识、不改名，只按内容补了名字（`pelican-cycling-svg-v1.html`）。表里凡标「按文件名」的模型归属都是从文件名推断的，不是实测。

## 🚀 使用方法

1. 克隆仓库或下载 ZIP
2. 用浏览器直接打开任意 `.html` 文件即可开始游戏

```bash
git clone https://github.com/go-farther-and-farther/html_game.git
```

## 📜 License

[MIT](LICENSE) · 网页版带 `robots.txt` / `sitemap.xml` / `404.html`，分享时使用 `img/og-cover.png` 作为社交预览图。
