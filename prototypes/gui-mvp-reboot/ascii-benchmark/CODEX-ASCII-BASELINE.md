# Codex Conversation First Refined · Canonical ASCII Baseline

> 源页面：`../conversation-first-refined/index.html`  
> 设计说明：`../conversation-first-refined/DESIGN-NOTE.md`  
> 状态：已完成 1440×900、1280×800 浏览器验收。本文忠实记录当前稿，不参与 Kimi/ZCode 输入。

## 1. 产品目的

Ludi 在同一个桌面工作区中发起和监督编码任务，持续理解 Agent 正在做什么，并在审批、纠偏和产物验收时接管判断。

首屏需要回答：

- 当前会话与任务；
- 当前目标和阶段；
- Agent 已经做了什么；
- 为什么停下；
- 用户现在能做什么；
- 产物与验证证据在哪里；
- 完成授权是否已授予。

## 2. 1440×900 · Compact ASCII

权威尺寸：左 `208px`，中 `888px`，右 `344px`。

```text
┌────────────── SESSION / HISTORY ──────────────┬──────────────────── CONVERSATION WORKSPACE ────────────────────┬──────── TASK / EVIDENCE ────────┐
│ [J] Jarvis                                    │ GUI-RECOVER-17                                                   │ REVIEW               [展开审阅] │
│     Conversation workspace                    │ 修复会话恢复后消息状态与最新 Diff 不同步                          │ 任务与证据                       │
│                                               │ [● 需要审批] [AUTH 未授予] [暂停][继续][恢复][终止]                ├─────────────────────────────────┤
│ ● Refined 静态原型                            ├───────────────────────────────────────────────────────────────────┤ TASK                     2 / 5  │
│   无 Runtime · 无真实写入                      │ 当前目标  只改显示投影与聚焦测试；保留 Runtime / Session / API       │ 任务现场                         │
│───────────────────────────────────────────────│                                                                   │ 恢复会话后…做最小修复并补聚焦测试 │
│ 当前任务                                      │        ┌─ Ludi · 14:26 ───────────────────────────────────┐       │ 01 复现旧投影              完成 │
│ ● 修复会话恢复后…                             │        │ 恢复会话后，活动记录显示已完成，但 Artifact 仍停在旧 Diff │       │ 02 核对持久事实            完成 │
│   等待一次性审批 · 14:32                       │        └───────────────────────────────────────────────────┘       │ 03 修正刷新屏障            待批 │
│                                               │                                                                   │ 04 运行聚焦测试            待办 │
│ 最近会话                                      │   Jarvis · 14:27                                                  │ 05 交给完成授权链          待办 │
│ ● 统一 CLI doctor 输出                        │   已复现显示层竞态。Session 序列完整，旧刷新覆盖较新投影。             ├─────────────────────────────────┤
│   已完成 · 昨天                               │                                                                   │ ◆ 需要你处理                   │
│ ● 异常流故障注入                              │   Jarvis · 14:31                                                  │ 批准一次性写入？  [等待你的决定] │
│   失败，保留证据 · 8 月 30 日                  │   补丁已整理为 2 个文件，当前停在一次性审批。                         │ 写入 presentation.js 与 test…  │
│                                               │───────────────────────────────────────────────────────────────────│ 能力  workspace.write          │
│                                               │ ▾ Reasoning 摘要 · 4 条                         核对恢复序列        │ 影响  +29/−2 · 可 Git 还原      │
│                                               │   01 比较 Session JSONL sequence                                  │ [拒绝][要求调整][允许一次]       │
│                                               │   02 确认持久化事实没有倒退                                       ├─────────────────────────────────┤
│                                               │   03 沿用 mutation barrier                                       │ EVIDENCE               2 files │
│                                               │   04 审批后写入并运行聚焦测试                                     │ 补丁与验证                       │
│                                               │───────────────────────────────────────────────────────────────────│ [ Diff ][ 验证 ][ 上下文 ]       │
│                                               │ ▾ 工具执行 · 点击工具定位右侧证据                                 │ presentation.js       +11 −2   │
│                                               │   完成  read_file   presentation.js      247 lines               │ gui-presentation.test +18 −0   │
│                                               │   完成  rg          refreshSequence       8 matches               │ ┌─ mini Diff ─────────────────┐ │
│                                               │   待批  apply_patch 2 files                workspace write          │ │ 118 export function…        │ │
│                                               │   待办  vitest      gui-presentation       queued                   │ │ 122 + reconcileRecovered…   │ │
│                                               ├───────────────────────────────────────────────────────────────────┤ └─────────────────────────────┘ │
│ 状态演示                                      │ 补充指令                                                          │                                 │
│ [运行][待批][完成][失败]  [重置]               │ ┌──────────────────────────────────────────────┐ [作为调整意见] │                                 │
│                                               │ │ 告诉 Jarvis 要调整什么；静态原型不会发送       │                │                                 │
│ H:\jarvis-agent                         main │ └──────────────────────────────────────────────┘                │                                 │
│                                               │ Session session_gui_recover_017        完成授权：未授予             │                                 │
└───────────────────────────────────────────────┴───────────────────────────────────────────────────────────────────┴─────────────────────────────────┘
```

## 3. 1440×900 · Expanded Review ASCII

权威尺寸：左 `208px`，中 `685px`，右 `547px`。

```text
┌──── SESSION 208 ────┬──────────────── CONVERSATION 685 ────────────────┬──────────────────────── REVIEW 547 ────────────────────────┐
│ 会话与历史          │ 目标 / 当前状态 / AUTH / 运行控制                │ REVIEW                                      [收起审阅]            │
│                    │                                                   │ 任务现场 · 计划 1—5                                      2 / 5 │
│ 当前任务            │ Ludi 消息                                        │───────────────────────────────────────────────────────────────│
│ 最近会话            │ Jarvis 回复                                      │ ◆ 批准一次性写入？                 [等待你的决定]             │
│ 状态演示            │ Reasoning                                        │ 文件 / 能力 / 影响                                           │
│                    │ 工具台账 → 点击联动右栏                            │ [拒绝] [要求调整] [允许一次]                                 │
│                    │                                                   │───────────────────────────────────────────────────────────────│
│                    │                                                   │ EVIDENCE · [Diff] [验证] [上下文]                             │
│                    │                                                   │ 完整可读 Diff / 验证检查 / Session 与 scope                   │
│                    │                                                   │                                                               │
│ workspace / branch │ Composer                                          │ 证据 pane 内部滚动                                            │
└────────────────────┴───────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────┘
```

点击 `展开审阅` 后，右栏使用 `300ms` card-resize；页面本身无滚动，三栏继续占满 `100vh`。

## 4. 1280×800 · Compact ASCII

权威尺寸：左 `184px`，中 `784px`，右 `312px`。任务标题在顶部允许 2 行，内容不截断。

```text
┌──── HISTORY 184 ────┬──────────────────── CONVERSATION 784 ────────────────────┬──────── REVIEW 312 ────────┐
│ Jarvis              │ GUI-RECOVER-17                                            │ REVIEW          [展开审阅] │
│ 当前 / 最近会话      │ 修复会话恢复后消息状态与最新 Diff 不同步                    │ 任务现场              2/5  │
│                    │ [需要审批][AUTH 未授予][暂停][继续][恢复][终止]               │ 计划 1—5                   │
│                    ├─────────────────────────────────────────────────────────────┤                              │
│                    │ Ludi + 2 条 Jarvis 消息                                     │ ◆ 批准一次性写入？          │
│                    │ Reasoning 4 条                                               │ 能力 / 影响                 │
│                    │ 工具 4 条                                                    │ [拒绝][调整]                │
│                    │                                                              │ [      允许一次      ]      │
│                    │                                                              │                              │
│ 状态演示            │ Composer                                                     │ EVIDENCE                     │
│ workspace / branch │ Session + 完成授权                                           │ [Diff][验证][上下文]         │
└────────────────────┴──────────────────────────────────────────────────────────────┴──────────────────────────────┘
```

1280 expanded 尺寸为 `184 / 610 / 486`，仍无页面级溢出。

## 5. 区域与滚动归属

| 区域 | 常驻 | 滚动 | 作用 |
|---|---|---|---|
| Session/History | 是 | 目录内容可内部滚动 | 建立 AI 对话产品的会话连续性与项目感 |
| Topbar | 是 | 否 | 当前目标、阶段、运行控制和完成授权 |
| Conversation | 是 | 消息区内部滚动 | 用户消息、Agent 回复、Reasoning、工具与人工 gate 说明 |
| Composer | 是 | 否 | 补充指令与调整意见入口 |
| Task/Review | 是 | 右栏内部滚动 | 计划、审批、Diff、验证和上下文 |
| Dialog | 条件出现 | 模态内部 | 终止二次确认 |

页面 `document` 固定为 viewport 尺寸；compact/expanded 都不产生页面级横向或纵向滚动。

## 6. 组件清单

| 组件 | 主要内容 | 状态/变体 |
|---|---|---|
| Brand block | `Jarvis`、`Conversation workspace` | 默认 |
| Prototype note | `Refined 静态原型`、`无 Runtime · 无真实写入` | 默认 |
| Session row | 任务标题、状态、时间 | current / done / failed |
| State lab | 运行、待批、完成、失败、重置 | selected / default |
| Run status | 当前运行标签与原因 | running / approval / paused / interrupted / completed / failed |
| Authority seal | `AUTH`、`未授予/已授权` | outline / filled / danger |
| Message | 作者、时间、正文 | user / assistant |
| Reasoning disclosure | 4 条摘要 | open / collapsed |
| Tool row | 状态、工具、目标、结果 | complete / approval / pending / evidence-linked |
| Approval card | 能力、影响、3 个决定 | pending / allowed / denied / revised |
| Evidence tabs | Diff、验证、上下文 | active / inactive |
| Review resize | 展开审阅 / 收起审阅 | compact / expanded |
| Composer | 输入框、作为调整意见 | enabled / disabled |
| Terminate dialog | 原因、取消、确认终止 | closed / open |
| Toast | 状态反馈 | hidden / open |

## 7. 状态机与反馈

| 状态 | 顶部状态 | 印章 | 可用控制 | 证据反馈 |
|---|---|---|---|---|
| `running` | 运行中 | 未授予 | 暂停、终止 | 当前执行阶段 |
| `approval` | 需要审批 | 未授予 | 暂停、终止、审批三决定 | Diff 默认显示 |
| `paused` | 已暂停 | 未授予 | 继续、终止 | 现场保留 |
| `interrupted` | 已终止 | 未授予 | 恢复 | 消息/工具/审批保留 |
| `restored` | 已恢复现场 | 未授予 | 暂停、终止 | 从 sequence 继续 |
| `completed` | 已完成 | 已授权实心印章 | 终止禁用 | `decideVerdict · verified（模拟）` |
| `failed` | 运行失败 | 未授予 | 恢复 | 原始失败证据可见 |

交互规则：

- `允许一次`：状态进入 running，自动扩宽审阅栏并切到“验证”；完成授权继续未授予。
- `拒绝`：状态进入 failed，保留证据。
- `要求调整`：状态进入 paused，Composer 继续可用。
- `暂停 → 继续`：消息列表不重建，用户回读位置保持。
- `终止 → 确认终止 → 恢复`：恢复后回到 running。
- 工具证据联动：`apply_patch → Diff`，`vitest → 验证`，`read_file/rg → 上下文`。
- `完成` 演示：只有该状态把印章改成“已授权”。

## 8. UI 文案清单

### 全局与导航

- `Jarvis`
- `Conversation workspace`
- `Refined 静态原型`
- `无 Runtime · 无真实写入`
- `当前任务`
- `最近会话`
- `统一 CLI doctor 输出`
- `异常流故障注入`
- `状态演示`
- `运行` / `待批` / `完成` / `失败` / `重置`

### 任务与控制

- `GUI-RECOVER-17`
- `修复会话恢复后消息状态与最新 Diff 不同步`
- `需要审批`
- `一次性写入 2 个现有文件`
- `AUTH` / `未授予` / `已授权`
- `暂停` / `继续` / `恢复` / `终止`

### 对话与过程

- `当前目标`
- `Reasoning 摘要`
- `4 条 · 隐藏私有思维链`
- `工具执行`
- `点击工具可定位右侧证据`
- `执行已停在人工 gate`
- `审批结果会作为新的持久事实进入既有权限路径；本页按钮只演示界面反馈。`

### Composer

- Label：`补充指令`
- Placeholder：`告诉 Jarvis 要调整什么；静态原型不会发送`
- Action：`作为调整意见`
- Meta：`Session session_gui_recover_017`
- Meta：`完成授权：未授予`

### 右栏

- `REVIEW` / `任务与证据`
- `展开审阅` / `收起审阅`
- `TASK` / `任务现场`
- `需要你处理`
- `批准一次性写入？`
- `等待你的决定`
- `能力` / `影响`
- `拒绝` / `要求调整` / `允许一次`
- `EVIDENCE` / `补丁与验证`
- `Diff` / `验证` / `上下文`
- `聚焦命令`
- `模拟 Diff · 审批前可检查，写入后仍需测试。`

### 终止确认

- `终止这次模拟运行？`
- `界面会切到“已终止”，消息、工具与审批现场继续保留，并提供恢复入口。`
- `取消`
- `确认终止`

## 9. 模拟任务内容

### 消息

1. Ludi · 14:26：`恢复会话后，活动记录显示已完成，但 Artifact 仍停在旧 Diff。保持 API 与完成授权不变，做最小修复并补一条聚焦测试。`
2. Jarvis · 14:27：`已复现显示层竞态。持久化 Session 序列完整，旧刷新响应覆盖了较新的显示投影。准备把修复限制在 presentation 投影与现有测试。`
3. Jarvis · 14:31：`补丁已整理为 2 个文件。写入会改变工作区，当前停在一次性审批；完成状态仍需聚焦测试与 decideVerdict 通过。`

### Reasoning

1. `先比较 Session JSONL 的最新 sequence 与页面 applied sequence。`
2. `确认持久化事实没有倒退，问题只出现在异步刷新回写顺序。`
3. `沿用现有 mutation barrier，不增加新的状态层或 API。`
4. `审批通过后只写 2 个现有文件，再运行聚焦测试。`

### 工具

- `read_file` · `presentation.js` · 完成 · `247 lines`
- `rg` · `refreshSequence` · 完成 · `8 matches`
- `apply_patch` · `2 files` · 待审批 · `workspace write`
- `vitest` · `gui-presentation` · 排队 · `queued after approval`

### 审批与产物

- 权限：`workspace.write`
- 影响：`+29 / −2 · 2 个现有文件 · 可通过 Git 还原`
- 文件 1：`src/surfaces/gui/assets/presentation.js` · `+11 −2`
- 文件 2：`test/surfaces/gui/gui-presentation.test.js` · `+18 −0`
- 聚焦命令：`npm test -- gui-presentation`

## 10. 视觉与动效 token

| Token | 值 | 用途 |
|---|---|---|
| Paper | `#F4EFE6` | 页面基底 |
| Surface | `#FBF8F1` / `#FFFDF8` | 面板与输入面 |
| Ink | `#24231F` | 主文字 |
| Sage | `#49685C` | 对话与普通状态 |
| Seal | `#B43A24` | 审批主动作与授权印章 |
| Warning | `#8A5B20` | 等待、风险 |
| Danger | `#9B3C32` | 失败、终止 |
| Body | `Microsoft YaHei UI / Segoe UI Variable Text` | 正文，主要 11–14px |
| Code | `Consolas` | ID、路径、Diff |
| Resize | `300ms cubic-bezier(0.22,1,0.36,1)` | 审阅栏 compact/expanded |

`prefers-reduced-motion: reduce` 下关闭宽度、位移、模糊和状态过渡。

## 11. 响应式、边界与可访问性

- 目标 viewport：1440×900、1280×800。
- 标题：1440 一行；1280 最多两行；禁止截断任务语义。
- 最小可见文字：11px。
- Session 长标题：单行省略号，完整内容由任务主区承担。
- Diff 长行：证据 pane 内横向滚动，页面不滚动。
- Focus：所有按钮、Tab、Composer、工具行有可见焦点。
- 工具行：Enter/Space 触发证据定位。
- 状态：图形、文字和颜色共同表达。
- Screen reader：运行状态、toast 使用 `role=status` / `aria-live`；Dialog 使用原生 `dialog`。
