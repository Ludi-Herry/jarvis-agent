# 批 6（第三批）：已有能力可控化 — 实施笔记

2026-10-07 · Mirasim Kimi K3 Max。上游：`HANDOFF-gui-kimi-k3-max-2026-10-07.md` §「第三批」、差距报告 §3 执行中纠偏。上一批：`5d2e221`（批 5 启动与错误恢复）。

> **状态：已完成（2026-10-07）。** 证据与门禁：`docs/evidence/gui-v13-batch6/README.md`。全量 1845 passed / 2 skipped，typecheck/lint/双 build 通过；验证中修正两处布局（vitals 第三行 grid 模板、成本卡 small 错位）。

## 目标

1. **待补充内容可见 / 撤回 / 修改**：pendingInputs 目前只显示数量。改为列表展示全文；每条支持撤回（journal `gui_input_withdrawn{index}`，投影 splice，重放确定性；只在下一边界前有效，已送达则 409 如实拒绝）与「修改」（撤回 + 草稿回填 composer）。文案明确：送达时刻是下一次处理边界，不是即时打断。
2. **其他任务待处理提示**：从 overview.sessions 派生（排除当前选中项）：存在 `approval` 状态任务时在对话区顶部显示提示条「还有 N 个任务等你处理」+ 切换按钮（commands.chooseSession），切任务不漏审批。
3. **真实成本/预算摘要**：上下文页签顶部新增「本次任务消耗与预算」卡：累计输入/输出 token、估算成本（有则含原口径）、已用/上限时间、执行上限；加诚实注释：累计 Token 是消耗总量，不等于上下文窗口占用，不显示占比。
4. **明确不做**：model/thinking 仍为任务创建时固定（队列级/中途变更需要明确真实合同，属条件项）；不重开窗口占比；不声称即时打断。

## 文件范围

`live-api.ts`（`POST /api/live/:id/input-withdraw`）、`live-session.ts`（`withdrawInput`）、`live-projection.ts`（gui_input_withdrawn 折叠，越界守护）、app 侧 `live/api.ts`、`use-live-session.ts`、`types.ts`、`conversation-pane.tsx`（补充列表 + 提示条 + 新 props）、`workbench.tsx`（withdraw/回填接线 + draftRecoveryToken 复用）、`evidence.tsx`（成本/预算摘要卡）、`fixtures.ts`（running 加 pendingInputs；multi 的 demo 任务改 approval）、`fixture-store.ts`（withdrawInput）、`workbench.css`（仅追加）、`test/surfaces/gui/gui-batch6-controllability.test.ts`。

## 验收

- 全门绿；新增测试：withdraw 折叠（含越界）、409 路径、确定性 provider 下「队列 → 撤回 → 边界」整合验证撤回内容不进入模型消息。
- 试件截图：补充列表+撤回/修改、其他任务提示条、成本/预算摘要 → `docs/evidence/gui-v13-batch6/`。
- 纪律同批 4/5：不伪造送达时刻、不伪造窗口占比、V13 结构不动、CSS 只追加。
