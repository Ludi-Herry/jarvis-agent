# Known Issues

这份清单只记录当前源码仍存在的保证边界。已完成能力和历史修复进入 [Changelog](CHANGELOG.md)；v0.1 的人工验收进度进入 [收口执行手册](docs/TODO-v01-evidence.md)。

## 发布前仍需人工证据

- **v0.1 三任务 dogfood 已以 NO-GO 收口。** 代码+测试、文档修改、只读审计三个交付物均由主线程完成，Jarvis 0/3 自然完成。零 false-verified 与零孤儿副作用成立；无进展/长等待门槛失败。完整证据见 [docs/TODO-v01-evidence.md](docs/TODO-v01-evidence.md)。
- **DeepSeek 模型 Spike 通过，thinking 模式采用仍 hold。** `deepseek-v4-pro-ga-260813` 在冻结 canary 中约 45 秒自然返回 14/0/0；协议诊断确认 ARK GA 的 `thinking=disabled + tools` 把思路与 `</think>` 放进 content，`thinking=enabled` 能正确分离 reasoning。默认模型与写任务复验继续暂停，详见 [协议诊断](docs/ANALYSIS-deepseek-v4-pro-ga-thinking.md)。
- **GUI 审批中继 G5 仍在决策门后。** 只有真实 attended 任务反复暴露终端审批打断，才重新评估桥接方案。决策阈值同样记录在 [docs/TODO-v01-evidence.md](docs/TODO-v01-evidence.md)。
- **zsh completion 缺少本机实测。** 生成器有自动测试，当前 Windows 环境无法完成真实 zsh 安装与 Tab 验收。PowerShell 是已验证的本机路径。

## 运行与操作边界

- **Cron daemon 使用单工作区锁。** 进程被强制终止后，下一次启动可能先执行 stale-lock 恢复。锁与恢复逻辑由 `src/capabilities/goal/loop-cron.ts` 的 `FileLoopCronLock` 负责。
- **Human review 只写本地 JSONL。** 当前没有多用户身份、远程通知、connector 或团队工作流；人工裁决入口是 `jarvis review` 与本地 GUI。
- **Attended Bash 的 scheduler-command 仍有 TOCTOU 窗口。** 命令级 session allow 无法把检查后的命令文本与外部 scheduler 的最终执行绑定；安全严重度和接受边界见 [docs/security-review-baseline.md](docs/security-review-baseline.md)。
- **Token 统计覆盖不完整。** Off-bus verifier 与 pinned-requirement derivation 调用未计量；`status` 会显示 `partial` 和 `unknown`，并分开呈现 loop rollup 与 goal 明细。格式化逻辑在 `src/capabilities/goal/observability.ts` 的 `formatObservationReport`。

## 文件与会话完整性边界

- **Managed write 无法提供通用跨进程 CAS。** `expectedVersion`、`createOnly` 和同进程串行化能阻止常见 stale write；外部编辑器、另一个 Jarvis 进程、已批准 Bash，或最终检查到 rename 之间的路径与元数据变化仍可能竞争。工具发现 post-state 无法确认时会返回 `unknown`。合同实现位于 `src/core/tools/builtins.ts`。
- **Session append 缺少跨进程 writer lock 与逐记录 durable fsync。** Session v2 能拒绝混版、序号断裂、重复逻辑执行、composition 矛盾和未决副作用；并发写入与突然断电仍超出保证。实现位于 `src/runtime/session/session-store.ts`。
- **Composition provenance 仍有后续范围。** 当前 header 覆盖 base prompt、有效工具 schema 和 Skill manifest identity；完整 model-visible request 重建、显式 redaction receipt、provider/protocol/config/policy identity、嵌套 subagent prompt provenance 与日志密码学真实性尚未进入合同。
- **`sessions show` 只能做恢复前预检。** 它会报告 `ready-for-resume-check`；只有实际 `resume` 能对比本次调用的 composition 与 addendum 并给出精确兼容结论。
- **路径检查无法抵御敌对同用户进程的校验后替换。** 静态 symlink、junction、reparse 和 canonical-containment escape 会被拒绝；同用户进程在检查后、读取前主动交换路径仍超出当前威胁模型。
- **非 Session JSONL 只做有限语义校验。** Goal、loop 与 cron store 会拒绝中段损坏、无效记录形状和缺失 header；形状正确但跨记录关系错误的深层语义仍需要审计层或专门 loader 发现。
