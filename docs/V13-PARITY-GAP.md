# V13 讨论区 1:1 还原 · 能力缺口清单

> **范围更新（2026-09-26）**：Owner 已明确要求 Jarvis 对 V13 **讨论区**做真实功能、接口与后端的 1:1 接入；设计区排除。本页原先的“B 留不可用、C 跳过”仅是旧阶段的缺口分类，**不再是最终验收口径**。原 C 桶每项的新归属、19 项 B 桶的实施包、顺序与工作量见 [真 1:1 接入规划](./PLAN-V13-discussion-true-parity-2026-09-26.md)。

> 用途：保留 2026-09-26 的能力缺口盘点，供新会话核对来源与现状。口径只含**讨论区**（不含设计画布）；最终范围与验收由上方链接的真 1:1 规划决定。
> 事实核对日期：2026-09-26。V13 源：`H:\Ludi-design-studio\docs\prototypes\studio-annotation-branches-v13\`（`index.html` + `v13-workspace.js` + 各 `v*.css/js` + `v23-neutral-theme.css`）。
> Jarvis 现状入口：`src/surfaces/gui/app/src/workbench/`（对话优先工作台）、`src/surfaces/gui/live-types.ts`（投影）、`src/surfaces/gui/live-session.ts`（宿主）。

## 桶定义

- **A · 已有前端或事实基础**：可直接接线或继续校准视觉；标为 A 不代表已通过最终 1:1 验收。
- **B · 缺真实事实或命令**：原阶段可显示诚实空态；最终验收须按新规划接入后端，不以禁用入口充数。
- **C · 原阶段冻结项**：现按“讨论区真实入口 / 设计区专属 / 讨论区不存在的扩展”重新归属，见新规划 §3。

## A · 现在就能 1:1

- 三栏骨架、灰侧栏（#f3f3f5）+ 白工作面 + zinc 黑灰白控件三态、阴影/圆角/焦点环尺度、reduced motion。
- 左栏：新建任务入口（空态）、搜索过滤、工作区分组（单工作区）、任务切换与运行中锁定、收起态与窄屏图标条、拖拽/方向键调宽（纯前端）、底部个人区。
- 页头：文件夹图标 + 工作区名 + 单行任务标题、页头折叠紧凑排列、右栏抽屉开关。
- 对话：连续消息流、用户气泡（14px 14px 4px 14px 圆角、#f4f4f5 底）、Agent 回复、回复操作行（复制 + 悬停/聚焦显示时间）、执行记录折叠组与一步跳证据、对话内审批/验收决策卡、顶部提问摘要（整条滚出才出现）、定位刻度（≥1200px + 留白 + 可滚动 + 已滚动）、hover 预览卡与点击回跳、回到最新与渐隐遮罩、空态结构（标题 + 引导 + 合同卡）。
- Composer：输入框三态、发送/提交理由/启动标签、草稿与滚动位置恢复、Ctrl Enter。
- 证据抽屉：Diff/产物、验证、上下文三页签，联动工具面板，审批历史，加宽/收起。
- 运行控制：暂停/继续/恢复/急停（仅显示当前可用）、急停确认对话框、断线禁用与重连重建、toast。

## B · 需要后续开发才能接入（最终验收须真实可用）

| # | V13 元素 | 缺什么 | 归属层 | runtime 雏形 |
|---|---|---|---|---|
| 1 | 新建任务直达空态、starter 卡、工作区「＋」弹窗 | 任务合同作者权：`POST /api/live/task`（创建/校验/落盘/审计），含 writePaths、checkCommands、预算、pricing | host + live-api | `validateGuiTask` 只做结构校验 |
| 2 | 多任务并行/排队 | 并发上限与排队语义、同 cwd 写冲突策略、每会话独立 baseline index；`overview.activeId` 扩为多 active | host | `start` 现在对第二个运行中任务 409 |
| 3 | 工作区注册/枚举/切换/编辑（名称、图标、颜色、置顶、归档） | workspace registry 持久化 + 本机目录枚举的授权边界 + 目录选择命令 | host + 新存储 | overview 只有单一 cwd |
| 4 | 任务菜单：重命名/置顶/标记未读/归档/迁移工作区/导出 | 会话元数据索引（id→objective/created/status/archived）与对应命令；导出可先做纯前端 | host + 存储 | 列表目前靠 journal 重建 |
| 5 | 回复操作「分支」（分叉会话） | Session JSONL fork 命令（新 session id 共享前缀） | host | 无 |
| 6 | 环境信息四行：未提交 / 分支 / 提交或推送 / Worktree 模式 | 只读 git 事实投影（worktree status、branch、ahead/behind）；Worktree 创建/切换属危险操作需审批链 | projection + host | `snapshotWorktreeStatus`/`WorktreeStatusSummary` 已存在（`src/capabilities/goal/observability.ts:252`） |
| 7 | 模型选择菜单 + 思考强度滑杆 | 合同级 model 字段、provider thinking 开关暴露（live-session 现硬编码 `withThinking('off')`）、可选模型清单只读 API | host + live-api | pricing 已进合同，model 未暴露 |
| 8 | Composer 上下文用量条/菜单 | ContextManager 用量事实投影（已用/上限 token） | projection | `DefaultContextManager` 存在（`src/core/context/context-manager.ts:66`），用量未投影 |
| 9 | 回复操作「钩子」popover | `hook_output` 事件投影 + 只读 hooks 清单 API | projection + live-api | 事件类型已存在（`src/runtime/event-bus.ts:149`），live-projection 当前忽略 |
| 10 | 任务监控「子智能体」段与详情 | 子代理事件类型与 GUI 投影 | projection + runtime events | `src/capabilities/subagents/`（delegate/roster/panel/derive）已存在 |
| 11 | 任务监控「Skill 与 MCP」行 | Skill 只读清单 API；MCP 本体不存在（见 C） | live-api | `src/capabilities/skills/skill-registry.ts` 已存在 |
| 12 | 终端按钮/终端面板、后台 Bash dock、当前进度、活动面板 | PTY/后台进程管理器（安全边界大：命令白名单、生命周期、输出截断） | 新 capability | 只有合同内批量 checkCommands |
| 13 | 快捷面板「工作区文件」浏览与预览 | FS 只读列表/读取 API + 授权边界（路径白名单、大小上限、脱敏） | host + live-api | 无 |
| 14 | Composer 附件/引用插入子菜单 | 上传存储 + 附件到工具参数的通道 + adapter 支持 | host + adapter | 无 |
| 15 | 任务悬停预览卡 | overview.sessions 增加 lastMessage/updatedAt 摘要字段 | projection | 小改 |
| 16 | 设置齿轮七类设置页 | 配置读写服务（当前 config 只读、含密钥边界；写入需审计与重启语义） | host + 新存储 | 无 |
| 17 | 侧边聊天/侧边任务 | 侧会话能力（产品未规划，可降级为 C） | 新 capability | 无 |
| 18 | 启动前 dry-run（自由创建任务的预校验） | 不消耗模型地校验路径/命令/基线可捕获 | host | 无 |
| 19 | 取消与清理 | 失败/取消后 journal 与 baseline index 的显式清理命令 | host | 只读不删 |

## C · 原阶段冻结项（逐项归属见新规划 §3）

原清单包含：团队成员与协作开关、roster 卡与成员配色、方案分支与「＋新建方案」、设计画布与工具药丸、元素注释、需求卡/PRD 文档槽、内置浏览器、MCP 连接、云同步与多人协作、插件/Skill 市场、模型议会、V13 设计区全部。其中团队、任务文档、内置浏览器和 MCP 属讨论区真实接入范围；设计区专属项与讨论区不存在的扩展分别排除并记录原因。旧冻结依据只说明历史阶段，不得用来跳过新规划中的讨论区功能。

## 主题 token（1:1 直接取用，权威块为 v23 末尾 :root）

`--ink #18181b`、`--ink-soft #3f3f46`、`--muted #71717a`、`--faint #a1a1aa`、`--line #e4e4e7`、`--line-strong #d4d4d8`、`--paper #ffffff`、`--shell #f3f3f5`、`--well #fafafa`、`--accent #27272a`、`--accent-soft #f4f4f5`、`--accent-line #d4d4d8`；语义色保留 `--success #387a5a / --success-soft #edf6ef`、`--warning #a66b2d / --warning-soft #fbf5eb`、危险文字 `#be5f5f`；阴影 `--shadow-small 0 1px 2px rgba(24,24,27,.05),0 4px 14px rgba(24,24,27,.04)`、`--shadow-float 0 18px 50px rgba(24,24,27,.14)`、composer `0 2px 6px rgba(39,39,42,.035),0 8px 25px rgba(39,39,42,.04)`；焦点环 `outline:2px solid #27272a; offset:3px`（侧栏行 `#d4d4d8; offset:-2px`）；圆角阶梯 5/6/7/8/9/10/12/13/15（气泡 14px 14px 4px 14px）。注意：V13 把 Diff 增删行中性化是 `build-neutral-theme.mjs` 语义豁免遗漏的副作用，Jarvis 保留增删语义色，1:1 时以 Jarvis 为准。

## 给新会话的验收口径

- 分批开发时未完成的 B/C 讨论区能力必须有诚实禁用或空态表达；**最终 1:1 验收须真实接入**，禁止用前端状态伪装运行中能力。
- 1280×800 展开证据抽屉时中栏 ≥610px、无整页横向溢出；审批与急停在任何视口持续可达。
- 门：根 typecheck/lint/test/build + 子包 typecheck/build；视觉以截图交 Ludi 验收。
- 不新增 verifier/route/scheduler 抽象、第二事件总线、云服务或插件市场；不改完成授权与权限边界。
