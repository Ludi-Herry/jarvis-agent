# Jarvis-Agent

Jarvis-Agent 是一个以 GUI 为主表面的本地 TypeScript/Node 编码 agent harness。它把模型调用、工具执行、权限审批、会话恢复和完成验收放进同一个有状态宿主，并让 CLI、TUI 与本地 GUI 复用同一套事件和状态事实。

项目面向 Ludi 的个人项目维护场景。核心目标是让长任务持续推进，同时让失败、阻塞、权限和可信证据始终可见。

> **项目状态：V13 重启批 0–2 进行中（2026-10-05）**。当前总计划见 [GUI 重启总计划](docs/PLAN-gui-v13-restart-2026-10-05.md)：以黑白灰精准还原 V13 讨论区样稿为最终目标，首批功能子集为自由任务/工作区/讨论分支/Git 状态/模型选择。
> 历史状态：GUI MVP P3 未验收（2026-09-06，真实任务因传输故障安全终止，0 写入 0 介入，完成授权未授予）；v0.1 自然完成 0/3、PRODUCT NO-GO 与历史失败继续保留。见 [P3 真实 Web 闭环](docs/PLAN-gui-mvp-p3-runtime.md)。

现有依赖已安装时，P3 Web 入口：

```powershell
npm --prefix src/surfaces/gui/app run build
npm run gui -- --task-file docs/gui-mvp-p3-first-task.json
```

打开终端实际报告的 `/app/` 地址。该任务合同只允许首次使用引导组件的一次真实任务，启动后从 GUI 审批和纠偏；存在既有记录时恢复查看，不自动重跑。旧 GUI 保留在同一服务 `/`，P2 模拟证据保留在 `/app/?demo=1`。不带 `--task-file` 可只读打开工作区，不启动模型。

## 快速开始

前置条件：Node.js 20 或更高版本。

```powershell
Set-Location -LiteralPath 'H:\jarvis-agent'
npm install
npm run jarvis -- doctor
npm run jarvis -- --help
```

`doctor` 只做本地只读检查，不会调用模型，也不会显示凭据值。需要真实模型的 `run`、`goal`、`loop` 和 `a0 run` 还需配置 `.env`：

```powershell
Copy-Item -LiteralPath '.env.example' -Destination '.env'
```

在 `.env` 中填写 `ARK_API_KEY`。模型、端点和权限的最终生效值用命令查询，避免依赖文档快照：

```powershell
npm run jarvis -- config show
npm run jarvis -- config validate
```

## 第一次运行

```powershell
npm run jarvis -- run '检查这个仓库，并告诉我最值得先处理的一项问题'
```

`run` 会先执行这条请求，再保留交互会话。需要固定使用行模式时加全局参数 `--no-tui`：

```powershell
npm run jarvis -- --no-tui run
```

## 常用入口

完整参数始终以 `npm run jarvis -- --help` 和各子命令的 `--help` 为准。

| 目的 | 入口 |
|---|---|
| 交互维护 | `jarvis run [prompt]`、`jarvis resume [session-id]` |
| 单目标达标 | `jarvis goal <objective>` |
| 多目标队列 | `jarvis loop <objectives-file>` |
| 会话与检查点 | `jarvis sessions ...`、`jarvis checkpoints ...`、`jarvis rewind ...` |
| 就绪与状态 | `jarvis doctor`、`jarvis status`、`jarvis config ...` |
| 人工介入 | `jarvis review ...`、`jarvis stop` |
| 冻结评测 | `jarvis a0 run|report` |
| 本地 GUI | `npm run gui` |

不确定该用 `run`、`goal`、`loop` 还是 `cron` 时，查看 [Loop primitive 选择指南](docs/loop-primitives-guide.md)。需要逐条复制命令做使用验收时，查看 [使用与验收指南](docs/usage-guide.md)。

## 可信边界

- PermissionGate 在运行时处理文件写入、命令执行、网络和敏感路径；只读、需确认和拒绝是明确状态。
- `decideVerdict`、确定性检查、可信 requirements 与人工 review 共同决定 goal 结果。状态页、Recall、TUI 和 GUI 只负责观察与交互，不授予完成状态。
- Session 使用 append-only JSONL 保存消息、composition、请求收据和工具执行状态。恢复遇到损坏、来源漂移或未决副作用时会停下并给出处理方向。
- GUI 监听本机回环地址，当前控制面限定为观察、急停与人工裁决。
- 已知保证边界与剩余风险集中记录在 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)。

## 开发与验证

```powershell
npm run typecheck
npm run lint
npm test
npm run build
```

项目采用 TypeScript strict 与 ES modules。关键决策写成纯函数并配触发路径测试；副作用通过注入接口进入运行时。详细工程规范、架构蓝图入口和禁止扩张的边界见 [AGENTS.md](AGENTS.md)。

## 文档入口

- [文档地图](docs/README.md)：按阅读任务查找全部项目文档，并区分当前入口与历史材料。
- [产品定义](PRODUCT.md)：用户、目标、体验原则和范围。
- [使用与验收指南](docs/usage-guide.md)：从零成本检查到真实模型任务的操作路径。
- [CLI-first 路线与验收合同](docs/cli-first-plan.md)：版本线、信任边界和发布门槛。
- [v0.1 MVP dogfood 手册](docs/TODO-v01-evidence.md)：三个真实任务、当前证据、停止线与扩样条件。
- [GUI MVP 重启交接](docs/handoff-gui-mvp-reboot.md)：当前产品方向、复用边界、参考对象、技术选择和新会话 P0-P1 开工合同。
- [Changelog](CHANGELOG.md)：实现变更与发布历史。
- [Known Issues](KNOWN_ISSUES.md)：仍成立的产品限制和风险。

当前命令能力以 CLI help 为准；当前运行状态以 `jarvis doctor`、`jarvis config show` 和 `jarvis status` 为准；实现变更以 Changelog 与 Git 历史为准。
