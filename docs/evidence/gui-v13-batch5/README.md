# 批 5（单任务启动与错误恢复）回执

2026-10-07 · Mirasim Kimi K3 Max（effort=max）。上游：`docs/PLAN-gui-v13-batch5-start-recovery.md`、HANDOFF §「第二批」。上一批 `1535b7c`。

## 做了什么

1. **箭头校准**：空态向上箭头由「只展开合同」改为「校验合同并展开范围与检查」——点击即走 `validate` dry-run 并展开任务合同，可见含义与实际动作一致（试件截图 `contract-probe-1440x900.png` 中校验后字段错误如实出现）。
2. **工作区预设（用户确认）**：`workspaces.json` schema v1 additive 新增 `presets`（writePaths/checkCommands/maxRounds/maxTurns/minutes/savedAt）。只由「保存为该工作区预设」按钮（先校验后落盘）写入；读取时无效的 presets 单独省略、不拖垮整表。创建面板按所选工作区切换时预填；折叠态摘要行「范围 N 条 · 检查 M 条 · 预算 R×T≤P 分 · 预设（保存于X）/在预设基础上已修改/界面默认值」+「修改」入口（`empty-preset-summary-1440x900.png`）。
3. **只读发现候选命令**：`GET /api/live/workspaces/:id/probe` 只读 package.json scripts（test/lint/typecheck/check/verify）、vite/vitest 配置、tsconfig；结果标注来源，「采用」仅追加进检查命令草稿，不写盘、不自动授予任何权限（截图同 `contract-probe-1440x900.png`）。
4. **运行状态条 wb-vitals**：运行态（starting/running/approval/pausing/paused/checking/stopping）页头下常驻四格：在做什么（phase）、在等什么（审批/边界/暂停/验收/补充送达）、下一步（nextAction）、预算（已用/上限时间 + 输入/输出 token + 成本，存在才显示）。真实字段，无伪造百分比；终态仍由 StatusCard 承担（`vitals-running-1440x900.png`）。
5. **终端超时 ≠ 取消**：`GuiTerminalEntry.cause` 折叠自 cancel reason（user/timeout/interrupted），页签分别显示「已取消 / 超时自动结束 / 宿主退出，命令中断」（`terminal-timeout-1440x900.png`）。

## 门禁

- 根 `typecheck`、`lint`、`vitest --maxWorkers=4`：**1841 passed / 2 skipped**（新增 12 条：投影 cause 折叠与回放、presets 存取回环/字段校验/未知工作区 404、probe 候选与空态、run-vitals 派生）。
- 根 `npm run build`、GUI `npm --prefix src/surfaces/gui/app run build` 均通过（既有 bundle 体积提示保留）。
- 试件截图 4 张（上列）；全程 console 无 error/warning；未触真实模型，4317 服务本轮未在运行。

## 收尾与边界

- V13 空态布局未动（居中标题、785px 单输入框与既有锚点保留）；CSS 只追加新 class。
- 预设只预填表单，不授予写权限、不扩大路径、不改检查合同；probe 只读，不写盘。
- 第三批（已有能力可控化：待补充内容查看/撤回、其他任务待处理提示、成本预算摘要）与条件项（worktree/多 pane/模型配置等）仍按方案/实际需求推进。
