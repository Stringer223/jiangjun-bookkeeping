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
- **读盘失败时拒绝启动，绝不回写**（2026-09-20 修正）。`load()` 按错误类型分流：只有 `ENOENT`（文件真的不存在）才当成首次启动、生成默认分类并落盘；JSON 内容损坏时先把坏文件改名成 `data.json.corrupt-<时间戳>` 留证，再回落默认分类；其余错误（`EACCES` 被杀毒/备份软件占用、磁盘满、`EIO`）**原样抛出**，由 `src/main/index.ts` 弹错误框后退出。
  - **这条纪律不能松**：早期实现把所有异常都当「首次启动」，于是上述任何一种失败都会用一份空账本覆盖用户唯一的数据文件，且没有备份、不可恢复（`store.ts` 里原本还有一句注释预感到了这个风险，却没兜住）。
  - 代价是启动失败时用户看到一个错误框（提示数据文件未被改动、不要反复重启），而不是一个能用的空界面。这是刻意的取舍：**丢启动可以，丢数据不行。**
- **落盘是原子写**：`persist()` 先写 `data.json.tmp` 再 `rename`。同分区 rename 是原子的，所以 `data.json` 永远只可能是「旧的完整内容」或「新的完整内容」，不会留下写了一半的 JSON（半截 JSON 会走进上面的损坏分支，两级串起来就是丢账目）。
- **落盘失败要回滚内存**：`setCategories` / `addExpense` / `updateExpense` / `deleteExpense` 四个写操作在 `persist()` 抛错时会把内存改回去再抛，避免「界面说已保存、重启后记录不存在」。
- **脏记录在入口过滤**：`load()` 用 `isExpense()` 逐条校验，不合格的记录不进内存（一条 `{ id: 'e1' }` 就足以让整张账单显示 `¥ NaN` 并把排序打乱），同时把被丢弃的记录另存为 `data.json.rejected.json` 留证。
  - 校验口径与 IPC 层的 `assertExpenseInput` **保持一致**：`id` 与 `categoryId` 非空、金额必须是**正整数**（排掉 `NaN`/`Infinity`/负数/`0`/浮点）、`date` 必须是 `YYYY-MM-DD`。两条入口都要守 —— IPC 那层挡渲染进程，`isExpense` 挡**手工改过的文件**，松紧不能不一致，否则会出现「App 造不出来但文件里能存在」的脏数据。
- 因此数据目录下可能出现 `data.json.tmp`（正常情况瞬间消失）、`data.json.corrupt-<时间戳>`、`data.json.rejected.json`。**都是刻意留的证据文件，不是垃圾，不要随手删。**
  - 注意 `rejected` 那个**刻意不带时间戳**：`load()` 不写回 `data.json`（读盘路径不该顺手改用户的数据），所以脏记录会一直留在原文件里、每次启动被重新过滤一遍。若用带时间戳的名字，就会每次开机复制一份内容完全相同的证据，无限累积。
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
- 单元测试：`npm test`（= `vitest run`，跑完即退，不进 watch）
- 打包 Windows 安装包：`npm run package:win`

> 项目结构：`src/main`（主进程 + 数据存储 + IPC）、`src/preload`（contextBridge 桥接）、`src/renderer`（Vue 3 + Naive UI 界面）、`src/shared`（共享类型）。

> **打包注意事项（本机环境）**：本机访问 GitHub 被墙，打包需设镜像 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`；本机未开 Windows「开发者模式」、无符号链接权限，故 `electron-builder.yml` 已设 `signAndEditExecutable: false`（跳过 exe 图标/版本写入，当前使用默认 Electron 图标）。若需自定义图标：先开启开发者模式（或管理员运行打包），再移除该开关并配置 `win.icon`。

## 8. 提交门禁（commit gate）

**本仓库的提交被一道闸门拦着。** `git commit` 只有在「单元测试 + 类型检查 + 质量检查」三项全过、
并由 `tools/commit-gate/gate.py` 签发通行证之后才放行。目的是**防遗忘、防走捷径、防自动流程漏跑**——
不是防蓄意攻击（通行证是普通文本文件，谁都能伪造；HMAC 签名刻意不做，那会把纯 shell 钩子变成必须调 Python）。

### 怎么提交

**走 `gitcommit-agent`。** 它会：审视提交清单 → `git add -A` → `gate.py begin` →
在一条消息里并行派 `tester` 与 `quality-engineer` → `gate.py check` → 写提交信息 → `git commit` →
走 `git-save` 推送 → 独立确认推送结果 → `gate.py revoke`。

手动敲 `git commit` 会被拦下，**这是预期行为**，不是出故障。

### 克隆之后必须做一次

`core.hooksPath` 存在 `.git/config` 里，**不受版本控制**，所以每次 clone 之后都要重跑：

```bash
git config core.hooksPath .githooks      # 仓库级，绝不要 --global
```

忘了跑的话 `git commit` 会畅通无阻——**门禁静默失效**。查当前状态：`git config --get core.hooksPath`。

### 出问题时怎么合法绕过

**不要用 `--no-verify`**（Claude 层专门拦它，而且它会连合并/变基的豁免一起跳过，把仓库搞乱）。正确做法：

```bash
git config --unset core.hooksPath                    # 关掉 git 层
```

Claude 层还要从 `~/.claude/settings.json` 的 `hooks` 里去掉那一项（改完立即生效，不用重启）。
**绕过之后记得恢复**，恢复后重跑一轮 `gitcommit-agent` 把漏掉的检查补上。

### 有意留出的缺口（别以为它全覆盖了）

- **合并 / 变基 / 拣选的收尾提交不受门禁覆盖。** 钩子必须放行这些操作，否则连冲突都收不了尾（已实测）。
- **`--no-verify` 能跳过整个 git 层**，只有 Claude 层拦得住，而 Claude 层只在 Claude Code 里生效——
  在外部终端敲 `git commit --no-verify`，谁也拦不住。
- **`tester` 的「植入 bug 验证」这类瞬时改动，门禁在原理上看不见**（前后指纹比对只取两个端点，
  「改了又还回去」两端都是干净的）。这是本设计里**唯一依赖 agent 自律**的地方。
- **`git commit -- <路径>` 会走临时索引**，通常导致指纹不匹配而被拒。这是 fail closed，属于可接受的代价。
- **提交后想 `git commit --amend` 改提交信息会被拒**（提交一发生 HEAD 就前移，通行证是一次性的）。
  需要重跑一轮。

### 改门禁时必须一起改的文件

`~/.claude/agents/tester.md` 与 `~/.claude/agents/quality-engineer.md` 里各有一节**「门禁模式」**，
写明它们要产出哪些标记文件、字段叫什么、以及为什么不能用 `Out-File` 写 JSON（PowerShell 5.1 会写 BOM）。
这三份文档（加上 `.claude/agents/gitcommit-agent.md`）与 `gate.py` 里的字段名是**硬耦合**的，
改一处不改另一处会静默对不上——门禁会拒，但拒绝理由看着像 agent 没干活。

### 一个可用性限制：门禁只支持全量提交

`gate.py begin` 要求「工作区 == 暂存区」且**没有未跟踪文件**，所以它天然只支持**把当前所有改动一起提交**。
想只提交一部分、把其余留在工作区（比如「先提交门禁基建，app 侧继续改」），得先把不想提交的路径
写进 `.git/info/exclude`（**本地忽略，不进版本库**）：

```bash
echo "/tools/" >> .git/info/exclude     # 临时藏起来，用完记得删掉这几行
```

这条限制是有代价的，但它换来的是「**测过的内容 == 提交的内容**」不再依赖人的自觉：
只看指纹的比对，在工作区存在未暂存改动时是**看不见问题**的（索引的 tree 没变，而测试跑的是工作区里的新代码）。
如果哪天觉得这道限制太碍事，正确的做法是重新设计这一环（比如让 `gate.py` 自己 stash 未暂存改动），
**而不是放宽 `begin` 的那条断言**——那条断言正是这套东西赖以成立的地方。

