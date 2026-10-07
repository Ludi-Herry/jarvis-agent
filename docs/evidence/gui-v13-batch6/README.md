# 批 6（已有能力可控化）回执

2026-10-07 · Mirasim Kimi K3 Max（effort=max）。上游：`docs/PLAN-gui-v13-batch6-controllability.md`、HANDOFF §「第三批」。上一批 `5d2e221`。

## 做了什么

1. **待补充内容可见/撤回/修改**：pendingInputs 从「只计数」改为列表展示全文，逐条 撤回 / 修改。
   - 服务端新增 `POST /api/live/:id/input-withdraw {index}`：journal 记录 `gui_input_withdrawn`，投影按 index splice（越界折叠为空操作，重放确定性；已送达内容返回 409「该条补充不存在或已在处理边界送达」）。运行循环在边界处读取**折叠后**的队列，被撤回的补充不会进入模型消息（整合测试证明）。
   - 「修改」= 撤回 + 文本回填 composer 草稿（复用 draftRecoveryToken 机制），实测回填生效。
   - 文案保持诚实：「这些内容会在下一次处理边界送达；撤回只影响尚未送达的内容。」不声称即时打断。
2. **其他任务待处理提示**：overview.sessions 中（排除当前选中）存在 approval 状态任务时，对话区顶部显示「还有 N 个任务等你处理」+ 最多 3 个切换按钮（chooseSession，不打断当前任务）。
3. **真实成本/预算摘要**：上下文页签顶部新增「本次任务消耗与预算」卡：累计输入/输出 token、估算成本（含原口径备注）、已用/上限时间、结构上限；并明确注释「累计 Token 是消耗总量，不等于上下文窗口占用；窗口余量未测量，不显示占比。」
4. **布局修正（验证中发现）**：
   - 批 5 引入的状态条放进 `wb-conversation` 两行 grid 后，`minmax(0,1fr)` 行被压成 0，状态条与消息区重叠。用 `:has(> .wb-vitals)` 补第三行模板修复（54px/30px/816px 实测归位），空态两行模板不受影响。
   - 成本卡 `small` 备注在 `display:contents` 行内错位（串列），加 `grid-column: 2` 单列归位。

## 门禁

- 根 `typecheck`、`lint`、`vitest --maxWorkers=4`：**1845 passed / 2 skipped**（新增 4 条：withdraw 投影折叠/409/已送达诚实拒绝、边界整合验证撤回不进模型）。
- 根 `npm run build`、GUI build 通过。
- 试件截图：`pending-withdraw-1440x900.png`（待补充列表+撤回/修改按钮）、`attention-banner-1440x900.png`（待处理提示条）、`cost-summary-1440x900.png`（成本/预算摘要）。交互实测：撤回后卡片消失；修改后文本回填输入框。console 零 error/warning。

## 边界

- model/thinking 仍为任务创建时固定（队列级或中途变更属条件项，需明确真实合同，本批未做）。
- 未伪造窗口占比、未伪造送达时刻；V13 结构未动，CSS 只追加。
- 未触真实模型额度；4317 服务本轮未在运行。
