# 将军记账 — 项目文档

> 本文档是「将军记账」App 的权威产品文档与开发约定，由 Claude Code 维护并随项目更新。

---

## ⚠️ 核心协作规则（整个项目期间必须遵守）

在「将军记账」项目的整个开发过程中，**所有关键方案决策都必须由用户拍板**：

- 遇到技术选型、方案取舍、功能取舍、界面/交互设计等「有多个可行方案」的决策时，**Claude 必须先列出多个方案，逐一说明优劣势，并给出建议，然后由用户选择决定**。
- 禁止 Claude 在未经用户确认的情况下，自行选定唯一方案并直接实施。
- 用户拥有最终决定权；Claude 可以推荐，但不能替用户做决定。
- 本规则适用于：技术栈、数据存储、前端框架、分类设计、功能范围、界面布局、开发步骤等一切非显而易见的决策。

---

## 1. 项目概述

- 产品名称：**将军记账**
- 产品定位：一款运行在 **Windows** 平台的本地记账 App，帮助用户记录日常每一笔**人民币**花销，并通过**两级分类**进行管理。
- 目标平台：Windows（首要保证 Windows 11 正常运行）
- 使用人群：需要记录个人日常开销的用户
- 语言与货币：简体中文，人民币（CNY / ¥）

## 2. 产品需求（MVP 建议范围，最终由用户决定）

1. **记一笔**：录入一笔花销，字段含【金额（人民币）、分类、日期时间、备注】。
2. **分类管理**：花销分为「一级大类 → 二级小类」两级；内置一套默认分类，用户可增删改。
3. **账单列表**：按时间倒序展示所有花销记录，支持搜索、筛选（按分类 / 日期）。
4. **统计**：按分类、按月汇总花销，可用图表展示。
5. **数据持久化**：数据本地保存，重启不丢失。
6. **数据导出**：支持导出 CSV / Excel（便于备份）。

> 以上为 MVP 建议范围，是否裁剪或扩展由用户决定。

## 3. 记账分类体系（一级大类 → 二级小类）

> 以下为内置默认分类，用户可在 App 内自定义增删改。

- **餐饮食品**：早餐 / 午餐 / 晚餐 / 外卖 / 零食饮料 / 聚餐宴请 / 食材生鲜
- **交通出行**：公交地铁 / 打车网约车 / 加油充电 / 停车费 / 汽车保养维修 / 火车高铁 / 飞机票 / 共享单车
- **购物消费**：服饰鞋包 / 日用品 / 数码家电 / 美妆护肤 / 家居家具 / 母婴用品
- **居住生活**：房租 / 水电燃气 / 物业费 / 宽带网络 / 家居维修
- **娱乐休闲**：电影演出 / 游戏充值 / 旅游度假 / 运动健身 / 宠物 / 酒吧KTV
- **医疗健康**：门诊看病 / 药品 / 体检 / 牙科眼科 / 保健养生
- **人情往来**：红包礼金 / 请客送礼 / 捐款
- **教育培训**：学费 / 书籍 / 网课 / 考试报名 / 文具
- **其他**：其他杂项

## 4. 技术栈（✅ 已选定）

> **最终选定：方案 B —— Electron + Vue 3 + TypeScript + 本地 JSON 存储**
> Node.js + Chromium + 前端 Vue 3 + UI 组件库 Naive UI + 本地 JSON 文件存储。
> 选定理由（用户决策）：本机缺 Rust + VS C++ 构建工具，而 Node 已就绪；改用 Electron 零额外系统安装、最快跑起来。

### 方案 A：Tauri 2 + Vue 3 + TypeScript（未选）
- 后端 Rust + 前端 Vue 3 + SQLite
- 优势：安装包极小（约 5~15MB）、内存占用低、启动快；复用系统 WebView2（Win11 已内置）；性能与安全好；跨平台
- 劣势：需要 Rust 工具链 + VS C++ 构建工具（本机未安装），首次构建环境配置复杂，故未选

### 方案 B：Electron + Vue 3 + TypeScript ✅ 已选定
- Node.js + Chromium + 前端 Vue 3 + 本地 JSON 文件存储
- 优势：生态最成熟、资料丰富、问题好解决；纯 JS/TS 技术栈，开发调试方便；Node 已就绪、零额外系统安装；跨平台
- 劣势：安装包大（约 80~150MB）、内存占用高、启动慢

### 方案 C：Flutter（Windows 桌面版）
- 语言 Dart + SQLite（drift）
- 优势：单一代码库、UI 精美流畅；未来可扩展 Android/iOS；性能接近原生
- 劣势：Windows 桌面支持不如移动端成熟；需学 Dart；桌面安装包偏大

### 方案 D：.NET WPF / WinUI 3（C#）
- 语言 C# + SQLite（Microsoft.Data.Sqlite）
- 优势：Windows 原生、性能最好、启动最快；系统集成好、安装分发简单；工具链成熟
- 劣势：仅 Windows（但用户只需 Windows）；需 C#/.NET 知识；UI 现代化程度略低

## 5. 数据存储（当前实现：本地 JSON 文件）

- 当前实现：**本地 JSON 文件**，固定存放于 `%APPDATA%\将军记账\data.json`。
- **目录名是钉死的，不要改成跟随 `app.getName()`**：`src/main/store.ts` 的 `pinDataLocation()` 在 app ready 之前调用 `app.setPath('userData', ...)`。若不钉死，打包后读 productName「将军记账」、开发模式读 package.json 的 name「jiangjun-bookkeeping」，两种运行方式会各写一份 `data.json`，换个方式打开 App 就会看到空账本，像是账目丢了（这个坑真实发生过）。
- 旧目录 `%APPDATA%\jiangjun-bookkeeping` 是历史遗留。`migrateLegacyData()` 会在新目录没有数据时把旧数据复制过去（只复制不删除，旧文件留作兜底），在 `load()` 之前调用。
- 选型理由：本机缺 VS C++ 构建工具，SQLite 原生绑定（better-sqlite3）需编译；纯 JS 版（sql.js）打包时 wasm 路径处理繁琐。个人记账数据量（即使十年也就几万条）JSON 完全够用，零依赖、最稳。
- 预留升级：数据层已集中在 `src/main/store.ts`，日后若需 SQLite（大数据量 / 复杂查询），仅替换该文件即可。

## 6. 待办 / 下一步
- [x] 用户选定技术栈（Electron）
- [x] 确认前端框架（Vue 3）
- [x] 确认 UI 组件库（Naive UI）
- [x] 确定 MVP 功能范围（6 项）
- [x] 搭建项目骨架（electron-vite + Vue 3 + TS）
- [x] 实现记账与分类（记一笔 / 账单列表 / 分类管理）
- [x] 实现统计与导出（统计页 / CSV 导出）
- [x] 打包 Windows 安装程序（已产出 `dist/将军记账-0.1.0-setup.exe`；自定义图标待补充）
- [ ] 界面视觉打磨（配色 / 图标 / 暗色模式等，待用户反馈）

## 7. 开发与运行

- 安装依赖：`npm install`
- 开发模式（带热更新）：`npm run dev`
- 编译产物：`npm run build`（输出到 `out/`）
- 预览编译产物：`npm run preview`
- 类型检查：`npm run typecheck`
- 打包 Windows 安装包：`npm run package:win`

> 项目结构：`src/main`（主进程 + 数据存储 + IPC）、`src/preload`（contextBridge 桥接）、`src/renderer`（Vue 3 + Naive UI 界面）、`src/shared`（共享类型）。

> **打包注意事项（本机环境）**：本机访问 GitHub 被墙，打包需设镜像 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`；本机未开 Windows「开发者模式」、无符号链接权限，故 `electron-builder.yml` 已设 `signAndEditExecutable: false`（跳过 exe 图标/版本写入，当前使用默认 Electron 图标）。若需自定义图标：先开启开发者模式（或管理员运行打包），再移除该开关并配置 `win.icon`。
