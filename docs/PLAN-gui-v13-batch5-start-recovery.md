# 批 5（第二批）：单任务启动与错误恢复 — 实施笔记

2026-10-07 · Mirasim Kimi K3 Max。上游：`HANDOFF-gui-kimi-k3-max-2026-10-07.md` §「第二批」、`ANALYSIS-gui-openhanako-mirasim-gap-2026-10-07.md` §3 开始任务/运行状态。上一批：`1535b7c`（批 4 阅读与授权判断）。

> **状态：已完成（2026-10-07）。** 证据与门禁：`docs/evidence/gui-v13-batch5/README.md`。全量 1841 passed / 2 skipped，typecheck/lint/双 build 通过。

## 目标

1. **箭头校准**：空态向上箭头现在只 `setContractOpen(true)`，可见含义像「发送」。改为「校验合同并展开范围与检查」：点击即 dry-run 校验并展开合同区，可见含义与实际动作一致。
2. **工作区预设（用户确认）**：`workspaces.json` schema v1 additive 增加 `presets`（writePaths/checkCommands/maxRounds/maxTurns/minutes/savedAt）。来源只有用户点「保存为该工作区预设」；不自动授予写权限、不扩大路径、不改检查合同。创建面板按所选工作区预填，并显示摘要「范围 N 条 · 检查 M 条 · 预算 R×T≤P 分 · 预设（保存于X）/ 界面默认值」+「修改」入口。
3. **只读发现候选命令**：`GET /api/live/workspaces/:id/probe` 只读项目根：package.json scripts（test/lint/typecheck/check/verify → `npm run X`）、vite/vitest 配置存在 → `npx vitest run`、tsconfig.json → `npx tsc --noEmit`。结果诚实标注来源；采用与否由用户点击决定。
4. **省心率状态表达**：对话区页头下新增运行态状态条（wb-vitals）：在做什么（phase）、在等什么（审批/边界/暂停/验收）、下一步（nextAction）、预算（已用/上限时间 + token + 成本）。真实字段，不伪造百分比。仅在运行态（starting/running/approval/pausing/paused/checking/stopping）显示，终态仍由既有 StatusCard 承担。
5. **终端超时 ≠ 取消**：cancel journal 已有 reason（user/timeout/interrupted），投影折叠进 `GuiTerminalEntry.cause`，终端页签分别显示「超时自动结束 / 宿主退出中断 / 已取消」。

## 文件范围

`live-types.ts`（GuiWorkspacePresets、GuiWorkspaceInfo.presets?、GuiWorkspaceProbe、GuiTerminalEntry.cause?）、`live-session.ts`（saveWorkspacePresets/probeWorkspaceCommands/loadWorkspaces 容忍动）、`live-projection.ts`（cancel cause 折叠）、`live-api.ts`（`POST /api/live/workspaces/:id/presets`、`GET /api/live/workspaces/:id/probe`）、app 侧 `live/api.ts`、`workbench/types.ts`、`use-live-session.ts`、新 `workbench/run-vitals.ts`（纯函数）、`conversation-pane.tsx`、`create-task-panel.tsx`、`terminal-pane.tsx`、`fixtures.ts`、`fixture-store.ts`、`workbench.css`（仅追加）、`test/surfaces/gui/gui-batch5-start-recovery.test.ts`。

## 验收

- 全门绿（typecheck/lint/vitest --maxWorkers=4/双 build）；新增测试：投影 cause 折叠、presets 存取回环+字段校验+未知工作区 404、probe 候选/空态、run-vitals 派生文案。
- 试件截图：预设摘要+修改入口、probe 候选列表、运行状态条、终端超时标签 → `docs/evidence/gui-v13-batch5/`。
- 门禁与纪律同批 4；不自动扩权限、不伪造预算数字。

## 不做

不改任务合同/启动语义；不同工作区并发上限不变；写路径与检查命令的来源不进模型；probe 不写盘；V13 结构不动。
