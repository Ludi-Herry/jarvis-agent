# gui-plain-v1 对照稿源码

2026-10-15 · 方案与签收要点见 `docs/PLAN-gui-plain-v1.md`。这是**静态演示稿**：数据全部来自 `src/scenario.ts` 的剧本，不连 Jarvis Runtime，不是正式 GUI 代码。

- 技术：Vite + React 19，`vite-plugin-singlefile` 打成一个自包含 HTML（`npm install && npm run build` → `dist/index.html`）。
- 结构：`src/App.tsx` 三栏骨架与走查台；`src/ui/` 侧栏、对话、输入框、右栏（更改 / 预览 / 终端）、走查台；`src/store.ts` 状态机与自动演示；`src/theme.css` 色彩与字体 token；`src/arc/` 只保留用到的 Arc 控件。
- 第二轮（同日）：按 PastaUI / Arc 补齐所有可点入口——左栏品牌菜单、搜索（`Ctrl K`）、项目分组折叠与「…」菜单、任务行重命名 / 归档（可撤销）、添加项目、头像菜单（外观）、设置（通用 / 外观 / 项目预览地址 / 模型与用量 / 关于）、快捷键表、顶栏重命名与「…」菜单、历史任务回放、真实的图片 / 文件附件（选择、粘贴、拖入）、预览栏刷新 / 手机宽度 / 在浏览器中打开。新文件：`src/prefs.ts`、`src/ui/{Dialogs,History,feedback}.tsx`。
- 第三轮（2026-10-16，分支 `gui-plain-v1-canvas`）：加「画布」，把整条对话链路、要做的事和进度放在一个视图里。
  - 入口：顶栏「对话 / 画布」切换（`Ctrl G`），运行中显示 `完成/总数`；左栏运行中的任务也显示进度。历史任务同样能看画布。
  - 画布顶部是一行统计：要做的事（进度环）、用时、花费 · 预算、改动文件（点开右栏更改）、检查（点开终端）。
  - 三种看法：**链路**（四条泳道 你 / Jarvis / 项目文件 / 检查 × 六个阶段 理解 → 方案 → 确认 → 修改 → 检查 → 交付，编号色带、带标签的折线箭头、悬停高亮相邻步骤、按泳道筛选、拖动平移、`Ctrl` + 滚轮缩放、适应窗口、跟随最新、图例计数；修好再跑会标出「第 2 轮」）；**状态**（任务生命周期图，实线是这次走过的路，虚线是可能的路，下方列出「这次走过的路」）；**时间**（每一步的示意时长瀑布图、花费按阶段的环形图、预算条、检查结果）。
  - 右侧：选中步骤的详情卡（Jarvis 说了什么、改了哪些文件、输出、可做的操作：允许 / 不允许 / 让 Jarvis 修好 / 接着做 / 看预览 / 看改动，上一步 / 下一步）和「要做的事」清单（每项的状态、你补充的、建议；点一项跳到对应步骤）。窄于 900px 时这两张卡排到画布下方。
  - 「讲解图」：分层拆解（设置页的爆炸等轴图，蓝色是改动层）、改动前后（同一张卡片对照 + 编号改动表）、做法（流程图，实线是这次真的走的路）；可「下载 HTML」发给别人。对话里最后一次结果下面也有讲解图卡片。
  - URL 参数：`view=canvas`、`map=flow|state|time`、`explain=layers|delta|flow`，可与原有 `state=`、`past=`、`panel=`、`theme=dark`、`dock=0` 组合。
  - 新文件：`src/canvas/{model.ts,canvas-view.tsx,canvas.css}`、`src/artifact/{explainer.tsx,explainer.css}`、`src/arc/{donut-chart,usage-meter}/`。
  - 时长与花费是按剧本估算的**示意值**，界面上标了「示意时长」，不是实测。
- 来源：PastaUI 布局与输入框形态；Arc（uiarc.dev 免费组件，MIT；这轮新引入 `donut-chart`、`usage-meter`，改成中文文案、加金额前缀、配色改用 `--series-*`，文件头已注明）；`thinking-orbs`、`border-beam`（均 MIT）。画布的结构参考 archify（MIT：泳道、编号阶段带、图例计数、底部工具栏、步骤详情卡、生命周期图、「示意时长」瀑布图），讲解图按 diagram-design（MIT：爆炸等轴图的 2:1 投影、单一强调色、右侧标注列、编辑式排版）的规范手画；AI Elements（Apache-2.0）只参考了 Queue / Test Results / Context 的信息组织，没有拷代码；React Flow 评估过，没有引入（自己画的 SVG 够用，单文件更小）。

## 未随提交的二进制文件

推送工具只支持文本，下列文件没有入库，构建前需放回原路径（或直接用对话附件里的单文件 HTML，已内嵌）：

- `src/assets/fonts/manrope-latin.woff2`：Manrope 可变字体拉丁子集（SIL OFL），取自 PastaUI showcase 资源；可用 `@fontsource-variable/manrope` 的 latin woff2 替代。
- `src/assets/old/{empty,running,approval,complete,failed,recoverable}.webp`：现行 GUI 对应试件的截图（`?fixture=` 各状态，1440×900），用于「旧版 / 新稿」滑动对照。
