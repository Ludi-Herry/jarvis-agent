# Jarvis Desktop Conversation GUI · Blind Pro Review Packet

## Decision question

Which candidate provides the strongest long-term information architecture for Jarvis-Agent's primary Desktop GUI?

The target user is Ludi, a UI/UX designer and the only product user. He needs to start and supervise real coding tasks, understand what the Agent is doing, intervene at approval/correction points, inspect artifacts and evidence, and retain emergency control.

This review decides the architecture to take into the next implementation spike. It does not select a model or judge coding ability.

## Product contract

### Must support

- sustained user ↔ Jarvis conversation;
- current task goal, phase, and run state;
- Reasoning summary and tool execution;
- `workspace.write` approval with allow once / reject / request changes;
- Artifact/Diff, focused test, and unverified items;
- pause, continue, terminate, and recover;
- completion authority shown as ungranted until `decideVerdict · verified（模拟）`;
- 1440×900 and 1280×800;
- one user, one local primary task line.

### Frozen scope

- no multi-agent marketplace;
- no plugin marketplace;
- no model council or automatic routing expansion;
- no cloud collaboration;
- no self-improvement or automatic skill creation;
- no second completion or permission authority in the GUI.

### Shared task content

- ID: `GUI-RECOVER-17`
- Goal: `修复会话恢复后消息状态与最新 Diff 不同步`
- Phase: `修正显示投影`
- Progress: `2 / 5`
- Permission: `workspace.write`
- Impact: `+29 / −2 · 2 个现有文件 · 可通过 Git 还原`
- Files:
  - `src/surfaces/gui/assets/presentation.js`
  - `test/surfaces/gui/gui-presentation.test.js`
- Tools: `read_file` complete, `rg` complete, `apply_patch` awaiting approval, `vitest` queued.

## Unresolved risks

1. Whether permanent multi-pane context improves comprehension enough to justify reduced conversation width.
2. Whether contextual panels that open only when attention is required preserve spatial stability in long sessions.
3. Whether a three-column structure remains usable at 1280×800 without shrinking text or hiding unverified evidence.
4. Whether a dynamic approval/review surface becomes costly to implement and test across pause, failure, termination, and recovery.
5. Whether session history deserves permanent space in the primary task surface.

## Evidence

The following three candidates are author-blinded and normalized to their selected final direction. Self-scores and rejected alternatives are omitted.

---

# Candidate A · Phase-shift conversation with decision wing

## Core idea

The default state is a full-width conversation. When the Agent needs human action, a 38% decision wing pushes in from the right. Approval, Diff, tests, and unverified items live in this temporary-but-persistent work surface. When resolved, the wing closes and conversation returns to full width without losing scroll position.

## 1440×900

```text
+======================================================================================================================+
| [F] 任务条 · 顶部固定 · 全宽 · 高约 8% · 会话 ▾（导航收在此，无常驻侧栏）                                            |
| GUI-RECOVER-17 · 修复会话恢复后消息状态与最新 Diff 不同步                                                            |
| 阶段 修正显示投影 · 2/5 │ ○ 完成授权未授予 │ [暂停] [继续] [终止… modal] [恢复] │ ● 需要审批 ⌁ 决定翼 [1 click]      |
+======================================================+===============================================================+
| [↕] 对话 · 基态全宽 · 此刻 62% [state]              | [F] 决定翼 · 38% · 推入 [state] · 一次只办当前这件事           |
| ▲ 较早消息                                          |                                                               |
|                                                     | ⚠ 需要你处理                                                 |
| Ludi · 14:02                                        | workspace.write · 批准一次性写入？                            |
| 恢复会话后，活动记录显示已完成，但 Artifact         | 等待你的决定                                                 |
| 仍停在旧 Diff。保持 API 与完成授权不变，做最小      |                                                               |
| 修复并补一条聚焦测试。                              | 影响 +29 / −2 · 2 个现有文件 · 可通过 Git 还原                |
|                                                     |  · src/surfaces/gui/assets/presentation.js                    |
| Jarvis · 14:03                                      |  · test/surfaces/gui/gui-presentation.test.js                 |
| 已复现显示层竞态。持久化 Session 序列完整，旧       |                                                               |
| 刷新响应覆盖了较新的显示投影。准备把修复限制在      | [允许一次]   [拒绝]   [要求调整 → 载入 Composer]              |
| presentation 投影与现有测试。                       |                                                               |
|                                                     | ─── 补丁与验证 · 证据常驻翼内 ────────────────────────         |
|  ▸ Reasoning 摘要 · 4 条                             | Diff +29 / −2 · [1 click] 展开 · 展开后翼内 [↕] 长行 [↔]     |
|    1 比较 Session JSONL 与页面 applied sequence     | 聚焦命令 vitest --focus gui-presentation                      |
|    2 确认持久化事实没有倒退                          | 测试 vitest 排队 · 未验证项 2                                  |
|    3 沿用 mutation barrier，不加新状态层或 API      | decideVerdict · verified（模拟）未通过                        |
|    4 审批后写入 2 个文件并运行聚焦测试              |   → 完成授权仍 ○ 未授予（验证链没有走完）                     |
|  ▸ 工具执行                                          |                                                               |
|    read_file 完成 · rg 完成                          | [state] 基态：翼收起、对话全宽；                              |
|    apply_patch 待审批 · vitest 排队                  |   出现「需要你处理」→ 翼从右推入                              |
|                                                     |   对话压缩到 62%，滚动位置与阅读锚保留                        |
| Jarvis · 14:05                                      |   翼收起后对话流内保留一行审批锚 ⌁ 可回看历史决定             |
| 补丁已整理为 2 个文件。写入会改变工作区，当前停在   |   终止走 [modal] 二次确认；恢复后回到原状态原位置             |
| 一次性审批；完成状态仍需聚焦测试与                  |                                                               |
| decideVerdict 通过。                                |                                                               |
|  ⌁ 审批锚 · 决定在右侧翼 [1 click] 跳转             |                                                               |
+======================================================+===============================================================+
| [F] Composer · 底部固定 · 宽度跟随对话（基态全宽 / 翼开 62%）· 发送与调整入口永不消失                                 |
| 补充指令 │ 告诉 Jarvis 要调整什么；静态原型不会发送                                [发送] [作为调整意见]           |
+======================================================================================================================+
```

## 1280×800

At 1280, the decision wing becomes a 44% half-overlay so the underlying conversation does not shrink.

```text
+=======================================================================================================+
| [F] GUI-RECOVER-17 ▾ · 修复会话恢复后…不同步 · 修正显示投影 2/5 · ○ 授权未授予 · [暂停/继续][终止…][恢复]|
+==================================================+====================================================+
| [↕] 对话 · 保持全宽（翼为半覆盖） [state]        | [F] 决定翼 · 44% · 半覆盖 [state]                   |
| ▲ 较早消息                                       | ⚠ 需要你处理 · workspace.write                     |
|                                                  | 批准一次性写入？ · 等待你的决定                     |
| Ludi · 14:02                                     |                                                    |
| 恢复会话后，活动记录显示已完成，但               | +29 / −2 · 2 个现有文件 · 可通过 Git 还原           |
| Artifact 仍停在旧 Diff。保持 API 与              |  · presentation.js                                 |
| 完成授权不变，做最小修复并补一条                 |  · gui-presentation.test.js                        |
| 聚焦测试。                                       |                                                    |
|                                                  | [允许一次]  [拒绝]                                 |
| Jarvis · 14:03                                   | [要求调整 → 载入 Composer]                         |
| 已复现显示层竞态。持久化 Session                 |                                                    |
| 序列完整，旧刷新响应覆盖了较新的                 | ─── 补丁与验证 ─────────────────────────────────    |
| 显示投影。准备把修复限制在                       | Diff +29 / −2 · [1 click] 展开                     |
| presentation 投影与现有测试。                    |   展开时翼临时加宽 [state] · 长行 [↔] 全文 [↕]     |
|                                                  | 聚焦命令 vitest --focus                            |
|  ▸ Reasoning 摘要 · 4 条                          | 测试 vitest 排队 · 未验证项 2                       |
|  ▸ 工具执行 read_file ✓ · rg ✓                   | decideVerdict · verified（模拟）未通过             |
|    apply_patch ⛔ 待审批 · vitest ○ 排队          |   → 完成授权仍 ○ 未授予                            |
|                                                  |                                                    |
| Jarvis · 14:05                                   | [state] 关翼 → 对话全宽、滚动位置不动              |
| 补丁已整理为 2 个文件。写入会改变工作区，        |   暂停/继续按状态互斥显示，终止常驻 [modal]        |
| 当前停在一次性审批；完成状态仍需聚焦             |                                                    |
| 测试与 decideVerdict 通过。                      |                                                    |
|  ⌁ 审批锚 · 决定翼 [1 click] 跳转                |                                                    |
+==================================================+====================================================+
| [F] Composer · 全宽常驻 · 补充指令 · 告诉 Jarvis 要调整什么；静态原型不会发送  [发送] [作为调整意见]     |
+=======================================================================================================+
```

## Interaction contract

- Base state: conversation is full width; task bar and Composer remain fixed.
- Pending approval: the wing opens; conversation keeps scroll position.
- Allow once: wing changes to verification, authority remains ungranted until verification completes.
- Request changes: wing closes and focuses Composer in adjustment mode.
- Verification success: wing closes; task bar shows verified; conversation appends a terminal message.
- Reject/failure: wing becomes read-only evidence; conversation receives a blocked/failure message.
- Terminate: modal confirmation; Composer becomes recovery entry; restore returns to the previous state and reading position.

---

# Candidate B · Persistent session, conversation, and evidence shell

## Core idea

Three persistent regions establish a complete AI conversation product: session/history on the left, conversation and Composer in the center, task/approval/evidence on the right. The review panel can expand from compact to 38vw while all regions remain in the same stable shell.

## 1440×900 compact

Dimensions: `208 / 888 / 344`.

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
│ H:\jarvis-agent                         main │ │ 告诉 Jarvis 要调整什么；静态原型不会发送       │                │                                 │
│                                               │ └──────────────────────────────────────────────┘                │                                 │
│                                               │ Session session_gui_recover_017        完成授权：未授予             │                                 │
└───────────────────────────────────────────────┴───────────────────────────────────────────────────────────────────┴─────────────────────────────────┘
```

## 1440×900 expanded review

Dimensions: `208 / 685 / 547`.

```text
┌──── SESSION 208 ────┬──────────────── CONVERSATION 685 ────────────────┬──────────────────────── REVIEW 547 ────────────────────────┐
│ 会话与历史          │ 目标 / 当前状态 / AUTH / 运行控制                │ REVIEW                                      [收起审阅]            │
│ 当前任务 / 最近会话 │ Ludi + Jarvis messages                            │ 任务现场 · 计划 1—5                                      2 / 5 │
│ 状态演示            │ Reasoning / tool ledger                            │ ◆ 批准一次性写入？ [拒绝][要求调整][允许一次]                 │
│ workspace / branch │ Composer                                          │ EVIDENCE · [Diff] [验证] [上下文] · 证据 pane 内部滚动        │
└────────────────────┴───────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────┘
```

## 1280×800 compact

Dimensions: `184 / 784 / 312`. Title may wrap to two lines but cannot truncate its meaning.

```text
┌──── HISTORY 184 ────┬──────────────────── CONVERSATION 784 ────────────────────┬──────── REVIEW 312 ────────┐
│ Jarvis              │ GUI-RECOVER-17                                            │ REVIEW          [展开审阅] │
│ 当前 / 最近会话      │ 修复会话恢复后消息状态与最新 Diff 不同步                    │ 任务现场              2/5  │
│                    │ [需要审批][AUTH 未授予][暂停][继续][恢复][终止]               │ 计划 1—5                   │
│                    ├─────────────────────────────────────────────────────────────┤                              │
│                    │ Ludi + 2 条 Jarvis 消息                                     │ ◆ 批准一次性写入？          │
│                    │ Reasoning 4 条 · 工具 4 条                                  │ [拒绝][调整]                │
│ 状态演示            │ Composer                                                     │ [      允许一次      ]      │
│ workspace / branch │ Session + 完成授权                                           │ [Diff][验证][上下文]         │
└────────────────────┴──────────────────────────────────────────────────────────────┴──────────────────────────────┘
```

## Interaction contract

- Session/history remains visible and establishes conversation continuity.
- Allow once: status returns to running, review panel expands, and evidence switches to Verification; authority remains ungranted.
- Tools link directly to evidence tabs: `apply_patch → Diff`, `vitest → Verification`, `read_file/rg → Context`.
- Pause/continue preserves conversation and evidence position.
- Terminate uses confirmation; recovery restores the same shell and state.
- Only explicit completed state fills the AUTH seal and shows verified.

---

# Candidate C · Fixed task, conversation, and evidence columns

## Core idea

Three permanent functional columns: task/tool context on the left, conversation with inline approval in the center, evidence and verification on the right. Conversation always keeps at least half of desktop width; evidence is zero-step visible.

## 1440×900

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────────┐
│[F] GUI-RECOVER-17 · 修复会话恢复后消息状态与最新 Diff 不同步    阶段 修正显示投影 · 进度 2/5           │
│    ● 运行中    完成授权未授予 [state]                 [暂停] [继续] [终止] [恢复]        需要审批 ●   │
├────────────────────────┬─────────────────────────────────────────────────────────┬───────────────────┤
│ 任务现场         [F][↕] │ 对话                                                [↕] │ 补丁与验证  [F][↕]│
│ 目标 / 范围 / 影响      │ Ludi：恢复会话后…Artifact 仍停在旧 Diff。                 │ Diff [1 click]     │
│ 文件 2 个              │ Jarvis：已复现显示层竞态，修复限制在显示投影。             │ 两个文件 +29 / −2 │
│ 工具执行               │ ▾ Reasoning 摘要 · 4 条                                   │ 验证 · 聚焦测试排队│
│ ✓ read_file   完成     │ ┌─ 需要你处理 ──────────────────────────────────────┐ │ 未验证项          │
│ ✓ rg          完成     │ │ 批准一次性写入？ workspace.write                  │ │ 上下文 [↕]       │
│ ● apply_patch 待审批   │ │ [允许一次] [拒绝] [要求调整]                       │ │                   │
│ ○ vitest      排队     │ └──────────────────────────────────────────────────┘ │                   │
│ 检查点 1✓ 2● 3○       │ Jarvis：补丁已整理，完成仍需测试和 decideVerdict。         │                   │
├────────────────────────┴─────────────────────────────────────────────────────────┴───────────────────┤
│[F] 补充指令 ┌──────────────────────────────────────────────────────┐ [发送] [作为调整意见]          │
│            │ 告诉 Jarvis 要调整什么；静态原型不会发送                │                                │
│            └──────────────────────────────────────────────────────┘                                │
└──────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Dimensions: top bar `56px`; task `300px / 21%`; conversation `740px / 51%`; evidence `400px / 28%`; Composer `96px`.

## 1280×800

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│[F] GUI-RECOVER-17 · 修复会话恢复后消息状态与最新 Diff 不同步  阶段 修正显示投影 2/5               │
│    ● 运行中 · 完成授权未授予 [state]      [暂停] [继续] [终止] [恢复]               需要审批 ●    │
├────────────────────┬────────────────────────────────────────────────────────┬──────────────────┤
│ 任务现场     [F][↕]│ 对话                                               [↕] │ 补丁与验证 [F][↕]│
│ 目标 / 范围 / 影响 │ Ludi 与 2 条 Jarvis 消息                               │ Diff +29/−2       │
│ 工具执行           │ Reasoning 摘要 4 条                                    │ 验证 · 排队       │
│ ✓ read_file / rg   │ ┌─ 需要你处理 ─────────────────────────────────────┐ │ 未验证项          │
│ ● patch / ○ vitest│ │ workspace.write [允许一次][拒绝][要求调整]         │ │ 上下文            │
│ 检查点 1✓ 2● 3○   │ └──────────────────────────────────────────────────┘ │                  │
│                    │ Jarvis：补丁已整理，完成仍需测试与验证。               │                  │
├────────────────────┴────────────────────────────────────────────────────────┴──────────────────┤
│[F] Composer · 补充指令 ┌────────────────────────────────────┐ [发送] [作为调整意见]             │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Dimensions: task `230px / 18%`; conversation `660px / 52%`; evidence `390px / 30%`; Composer `88px`.

## Interaction contract

- Conversation is always the largest region and remains at least 50% wide.
- Approval appears inline in conversation; a fixed top-bar attention anchor can return focus to it.
- Diff, verification, and unverified items are permanently visible in the evidence column.
- Pause/continue freezes all three scroll positions.
- Allow once enters execution but does not grant completion; verification result controls verified state.
- Failure/termination preserves original evidence; recovery continues from the same context.

## Checks already passed

- All three candidates received the same product facts, task content, states, and target viewports.
- Each candidate produced three structural options and explicitly selected the final direction included here.
- Each candidate supplied a 1280×800 adaptation, fixed/scroll ownership, state changes, keyboard order, and implementation assertions.
- ASCII code fences and local file boundaries were checked.
- No candidate is being rewarded here for HTML implementation maturity.

## Do not repeat

- Do not request local files or screenshots; this packet is the review surface.
- Do not re-research OpenHanako, Tutti, Kun, CodePilot, or other products.
- Do not revisit Runtime, Session, PermissionGate, Goal, or `decideVerdict` ownership.
- Do not propose frozen features or a management dashboard.
- Do not judge color, typography, pixel craft, or animation quality from ASCII.
- Do not compare the authoring models.

## Required decision

Choose the architecture that best balances:

1. immediate AI-conversation feel;
2. low-effort human takeover;
3. honest and efficient artifact verification;
4. long-session and multi-session usability;
5. 1280 resilience;
6. implementation risk.

Return exactly one winner and no more than three transplantable ideas from the losers.
