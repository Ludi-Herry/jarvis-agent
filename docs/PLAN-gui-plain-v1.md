# GUI plain-v1 · 给设计师用的简化方向（P0 对照稿 + P2/P3 后台配合）

2026-10-15 · Notion AI 云端代做 · 分支 `gui-plain-v1`，草稿 PR，**不合并**。

性质：P0 是静态对照稿，等 Ludi 签收；P2/P3 是代码草稿。云端拿不到完整仓库，只跑了纯函数与真实 Git 的单测（`gui-plain-controls.test.ts` 8 条全过、strict tsc 通过）和 GUI 前端构建；**根目录 typecheck / lint / test / build 与 GuiSessionHost 集成测试需 Ludi 本机验证**（清单见 §6），通过前不算完成。UI 试件与演示稿不计为 Jarvis 真实任务成功。

## 0. 状态一览

| 阶段 | 内容 | 状态 |
|---|---|---|
| P0 对照稿 | 空态、运行中、需要确认、完成、没通过、没做完 6 屏 + 走查台 | 已交付，**等签收** |
| P1 正式界面简化 | 改说法、删四段状态条、停止进输入框、右栏收成「更改 / 预览 / 终端」、结果卡、合同进「高级设置」 | **未开始**，签收后另开改动 |
| P2 交互模型 | 权限三档、「这个任务都允许」、撤销 / 恢复 | 后台 + API + 测试在本分支；审批卡已加「这个任务都允许」；模式切换和撤销按钮的界面随 P1 |
| P3 自动预览 | 改了界面文件就自动打开预览 | 预设 `previewUrl` + 判定函数在本分支；自动打开的界面随 P1 |
| P3 截图 | 「截图发给 Jarvis」/ 结果卡附截图 | 只在对照稿里做了设计，**未实现**（§4.2） |

## 1. 原则

界面和操作向主流编码 Agent（Claude Code 桌面端、Codex）靠：事前一个模式开关，事中尽量不打扰，事后靠撤销兜底。Jarvis 的可靠性机制留在后台：权限闸门、合同写入范围、检查命令、JSONL 日志、完成授权可信链**一律不动**，只改默认展示和用户要理解的概念数（35+ → 约 10 个：项目、任务、输入框、模型、权限模式、停止、更改、预览、终端、撤销）。

## 2. P0 对照稿

- 交付物：单文件 `jarvis-gui-对照稿.html`（约 1 MB，自包含、离线可开），附在 2026-10-15 的对话里；文件超过推送工具单次上限，未入库。源码在 `prototypes/gui-plain-v1/`（见其 README）。
- 内容：6 个状态屏；右下「走查台」可切状态、切「旧版 / 新稿」滑动对照、显示改动编号；「从头自动演示」按剧本走一遍输入 → 确认 → 插话 → 预览 → 撤销。
- 数据全是演示剧本，不连 Runtime；云端 Linux 字体渲染与 Windows 略有差异。
- 组件来源：PastaUI 的三栏布局与输入框形态；Arc（uiarc.dev registry）的色彩 / 动效 token 与按钮、分段、开关、弹层、确认变形控件；`thinking-orbs`（MIT）表示正在思考；`border-beam`（MIT）表示等你确认。Arc 源码未见独立许可证声明，进正式 GUI 前需确认；正式 GUI 目前只多了 `lucide-react` 一个依赖，再加依赖需单独拍板。

签收时请明确：① 哪些屏和说法照做；② 默认权限档位（建议保持「改之前问我」，§3.1）；③ 视觉是否从现行 V13 中性灰改成对照稿配色（会改 `PRODUCT.md`「已选视觉主题」）。

## 3. P2：权限模式、这个任务都允许、撤销

### 3.1 权限三档（`GuiPermissionMode`）

| 档位 | 值 | 行为 |
|---|---|---|
| 只讨论 | `discuss` | 读类工具和 `update_goal` 照常；写文件、跑命令、联网在 GUI 闸门直接拒绝，理由 `DISCUSS_MODE_REASON` 回给模型，让它先用文字讲方案 |
| 改之前问我 | `ask` | 与现状一致：写入和命令都弹审批。默认值；旧 journal 没有该字段时按此处理 |
| 自动 | `auto` | 只有「合同 `writePaths` 内、本来要问的文件写入」直接放行；命令、联网照旧问 |

判定顺序（`live-session.ts` 的 GUI 闸门包装）：合同边界（writePaths / shellCommands，越界直接拒）→ 硬规则 `decide()`（密钥路径、危险命令、配置上限；结果是 deny 时模式层**不改写**）→ 模式层 `decideModeGate()`（`plain-controls.ts`，纯函数）→ 原 `DefaultPermissionGate`。模式层只会收窄（discuss），或在合同范围内放行文件写入（auto）；不扩大合同，不碰 bash。

- `auto` 不放行命令：命令的副作用不受 writePaths 约束，撤销也兜不住，保持逐次确认。
- 切换：`POST /api/live/:id/mode {mode}`，写 journal 事件 `gui_permission_mode`，刷新和重放都保持。从下一次工具调用起生效；已挂起的审批不受影响，仍由用户回答。

### 3.2 这个任务都允许（`allow-session`）

复用 `DefaultPermissionGate` 已有的 `allow-session`：文件写入类按工具放行到本次运行结束（仍限合同 writePaths）；bash 只放行**这条完全相同的命令**。审批事件新增 `sessionScope: 'tool' | 'command'`，审批卡据此写明范围。授权只在内存里，任务中断后恢复会重新问；审计记录照旧。

### 3.3 撤销 / 恢复

不复用 checkpoint/rewind：rewind 绑定 Session，拒绝带工具回执的会话（`isReceiptFreeRewindProjection`），文件回退还要 ShadowGit，GUI 任务都不满足。改用任务启动时已有的私有基线树（`captureBaseline` → `baseline.headSha`）：

- `GET /api/live/:id/undo` → `GuiUndoPlan {kind, available, reason?, files[{path, change}], token}`，只读。
- `POST /api/live/:id/undo` 或 `/redo {token}`：token 是算计划时这些文件的树 SHA；确认时文件又变了 → 409，要求重看。
- 撤销：把合同 writePaths 恢复到基线；基线里没有的文件（本任务新建）删除，只删 cwd 内的普通文件或链接，不删目录。恢复：回到撤销前的树；撤销后文件又被改过 → 拒绝。
- Git 操作全部用 `dataDir/gui-undo/` 下的一次性 index（`GIT_INDEX_FILE`），用完即删；**不读写用户的 index 和任务基线 index**，不动 HEAD、分支和合同外文件。
- 不让撤的情况（`undoBlocker`）：任务没开始、运行中、中断但还能恢复（Session 认为写入已发生）、正在提交验收、终端有命令、同项目有任务在跑或启动中。执行期间占用 `launching`，不能同时启动任务。
- 结果写 journal `gui_undo`（只含树 SHA、路径和增删改），快照 `undo` 字段保留最近一次；恢复后和目标树不完全一致时（常见于 Windows 换行符或文件权限）追加 `gui_warning`。

已知限制：

1. 只撤合同 writePaths 内的文件；命令造成的其他副作用（装包、生成文件）不在范围。
2. 撤销用的树对象没有被 ref 引用，`git gc` 清理过期对象后可能丢失；届时撤销失败并提示，不会乱写。
3. Windows `core.autocrlf=true` 时检出会转换换行，可能出现「不完全一致」警告，需本机验证（§6）。
4. 撤销不改 Session 和日志事实，也不撤销完成授权；界面要写清楚「文件已退回」，而不是「任务没做过」。

### 3.4 本分支的前端接线

- 审批卡加「这个任务都允许」（`active-stage.tsx`，可选 `onAllowSession`，范围说明来自 `sessionScope`）；试件里与「允许一次」同样处理。
- `live/api.ts` 新增 `postPermissionMode`、`getUndoPlan`、`postUndo`。**模式切换和撤销按钮的界面没做**，等 P1 签收后按对照稿放进输入框和结果卡。

## 4. P3

### 4.1 改了界面自动开预览

- 工作区预设新增 `previewUrl`：只接受本机回环地址（复用 `resolvePreviewSource`），其他地址在保存时报字段错误。
- `shouldAutoOpenPreview()`（`preview-policy.ts`，纯函数）：任务停下、保存过本机预览地址、确实改了界面类文件（tsx / jsx / vue / svelte / css / scss / less / html / svg）、本任务还没自动开过，四条同时满足才开。何时调用、开在哪个页签由 P1 前端决定。

### 4.2 截图发给 Jarvis（未实现）

已有外层视觉模型能力（`src/core/model/vision.ts` + `tools/vision-tool.ts`，经 ARK），但 GUI 的 `toolsFor()` 没注册它。要做需先定：视觉模型 id 与单次成本上限；截图来源（预览 iframe 跨源截不到，需要后台无头浏览器或用户粘贴）；新任务的 composition 变化对恢复校验的影响。定了再做，不在本分支。

## 5. 新增与变更接口

| 接口 | 说明 |
|---|---|
| `POST /api/live/:id/decision` | `decision` 新增 `allow-session` |
| `POST /api/live/:id/mode` | `{mode: 'discuss' \| 'ask' \| 'auto'}` → 快照 |
| `GET /api/live/:id/undo` | → `GuiUndoPlan` |
| `POST /api/live/:id/undo`、`/redo` | `{token}` → 快照；409 带中文原因 |
| 快照字段 | `permissionMode?`、`undo?`；审批 `sessionScope?`；预设 `previewUrl?` |
| journal 事件 | `gui_permission_mode`、`gui_undo`（投影见 `live-projection.ts`） |

## 6. 需 Ludi 本机验证

1. 根目录 `npm run typecheck`、`npm run lint`、`npm test`、`npm run build`，以及 `npm --prefix src/surfaces/gui/app run build`。
2. 新测试：`npx vitest run test/surfaces/gui/gui-plain-controls.test.ts test/surfaces/gui/gui-plain-v1-p2.test.ts`。后者是 6 条 GuiSessionHost 集成测试，云端没跑过。
3. 既有 GUI 测试若断言审批卡按钮数量或文案，可能因新增「这个任务都允许」失败，按新文案更新断言即可，不要删按钮绕过。
4. Windows 换行：在 `core.autocrlf=true` 的仓库里跑一次撤销 → 恢复，确认文件内容回到原样，并记录是否出现「不完全一致」警告。
5. 试件 `?fixture=approval`：审批卡出现「这个任务都允许」，点了与「允许一次」一样推进。

## 7. 与真实任务窗口的关系

真实模型任务窗口（`docs/PLAN-gui-real-task-window.md`）建议仍在 `main` 上跑，不依赖本分支；若在本分支跑，见该文档 §8 的补充约定。
