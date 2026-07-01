# Parallel Resume Plan

> 状态：实施前计划。目标是补齐 parallel worktree first slice 的 crash/replay 缺口，只落一个最小可验证切片。

## 目标

允许并行 loop 在 crash 后恢复，同时保持当前隔离语义：

- 只有用户在当前命令中显式传 `--resume --parallel N --worktree-root <cwd外dir>` 时进入 parallel resume。
- 每个 in-flight goal 回到既有 `worktreeRoot/<loopId>/g<index>` 继续或复核。
- cwd 内 loop log 只提供 `loopId`、queue、`goalId`、in-flight index 这类审计线索。
- trusted verifier/hook map 仍必须由当前命令显式传 cwd 外文件。
- worktree 缺失、路径不可信、goal/session log 不匹配时 fail-closed，交人工检查。

## 本 slice 范围

1. Parser 规则：
   - 允许 `--resume --parallel 2..4 --worktree-root <path>`。
   - 拒绝 `--resume --parallel >1` 但缺 `--worktree-root`。
2. Worktree 身份：
   - 新增只读 helper 解析既有 goal worktree。
   - helper 复用 `assertWorktreeRootOutsideCwd` 的 realpath 边界。
   - helper 要求目标 worktree 已存在。
3. CLI resume 接线：
   - fresh parallel 继续按当前逻辑创建 detached worktree。
   - parallel resume 对 in-flight goal 解析既有 worktree，不自动创建替身。
   - `loadLoopGoalResume` 继续用 expected cwd 校验 session header。
4. Hook 边界：
   - parallel 与全局 hooks / per-goal hook-map 继续互斥。

## 暂不做

- 自动 merge。
- 自动 cleanup。
- 自动重建缺失 worktree。
- per-worktree hook cwd 语义。
- cron daemon。
- 修改 `runGoal`、`decideVerdict`、三腿验收或 `PermissionGate`。
- 新增 unattended bash auto-allow。

## 文件

- `src/surfaces/cli/loop-args.ts`
- `src/surfaces/cli/loop-cli.ts`
- `src/capabilities/goal/loop-worktree.ts`
- `test/cli/loop-args.test.ts`
- `test/capabilities/goal/loop-worktree.test.ts`
- `test/cli/loop-resume.test.ts`

如 CLI smoke 成本可控，再补一个验证 malformed parallel resume 在写新记录前失败的测试。

## 信任边界

- `data/loops/*.jsonl` 在 cwd 内，不能提供权限、trusted config、parallel 授权或 worktree root 授权。
- `--worktree-root` 必须来自当前命令，realpath 后拒 cwd 内。
- `--verifier-map` / `--hook-map` resume 规则沿用现有实现；无 per-goal hooks 也要用可信空 map。
- session header 的 cwd 必须等于目标 worktree cwd，防止篡改 loop log 后回落主 cwd。
- 缺失 worktree、缺失 goal/session header、cwd 不匹配均停止。

## 失败模式测试

- parser 允许显式 `--resume --parallel N --worktree-root <path>`。
- parser 拒绝缺 root 的 parallel resume。
- worktree root 在 cwd 内失败。
- symlink / junction / Windows `\\?\` 最终落 cwd 内失败。
- in-flight parallel worktree 不存在失败。
- session header cwd 与恢复 worktree 不匹配失败。
- `--parallel` 加任何 hooks 仍失败，且在写 `loop-created` 前失败。
- verifier/hook map mismatch 仍失败。

## 验收

代码切片完成后运行：

```bash
npm run test
npm run typecheck
npm run build
npm run lint
```

Windows 子进程测试如果出现 timeout / EBUSY，先原命令重跑确认。
