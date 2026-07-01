# Loop Finalize Apply / Cleanup Design

> 状态：Slice A `--merge` 交互 apply 与 Slice B `--cleanup` 交互清理均已落地。当前默认 `npm run loop:finalize -- --loop <id>` 保持只读报告。

## 目标

把只读 finalize report 升级为可人工确认的收尾流程：

- `--merge`：只对 report 中的 verified + tracked diff proposal 做交互式 merge。
- `--cleanup`：只对已确认合并且仍 clean 的 worktree 做交互式清理。
- 任一 goal 出现 blocked、parked、rejected、missing verdict、missing worktree、dirty、conflict，默认停下并保留 worktree。
- 不 push、不 rebase、不强删、不改 verdict、不修改三腿验收。

## 建议接口

只读报告保持默认：

```bash
npm run loop:finalize -- --loop <id>
```

已落地执行 slice：只做 merge apply：

```bash
npm run loop:finalize -- --loop <id> --merge
```

已落地执行 slice：只做 cleanup apply：

```bash
npm run loop:finalize -- --loop <id> --cleanup
```

可选组合后续再考虑：

```bash
npm run loop:finalize -- --loop <id> --merge --cleanup
```

组合模式也必须分两次确认：先确认 merge，再重新计算 cleanup report，再确认 cleanup。

## 交互确认

### Merge 确认

执行前打印：

- loop id。
- cwd。
- worktree root。
- proposal 数量。
- 每个 proposal 的 index、goalId、worktree path、diff stat。
- 被 park 的条目及原因。

要求用户输入完整短语：

```text
merge <loopId>
```

EOF、空输入、大小写不匹配、只输入 `y/yes/allow` 全部取消。

### Cleanup 确认

cleanup 必须在独立阶段重新扫描，不复用 merge 前 report。执行前打印：

- loop id。
- 将要清理的 worktree path 列表。
- 每个 worktree 的 clean 状态。
- 不会清理的条目及原因。

要求用户输入完整短语：

```text
cleanup <loopId>
```

EOF、空输入、非完整短语全部取消。

## Merge 规则

### 可进入 merge proposal 的条件

沿用只读 report 的 proposal 条件，并在执行前重新检查：

- logged state 是 `complete`。
- logged outcome 是 `verified`。
- worktree 存在，realpath 后仍在 trusted worktree root 内，且不落 cwd 内。
- `git status --porcelain=v1 --untracked-files=all` 可读。
- 有 tracked changes。
- 没有 untracked 文件。
- 没有 conflict。
- `git diff --stat HEAD` 可读。

### 执行步骤

每个 proposal 串行执行：

1. 记录主 cwd 当前 `HEAD`。
2. 在主 cwd 重新确认 `git status --porcelain=v1 --untracked-files=all` clean；不 clean 立即停止。
3. 在 worktree 重新确认 proposal 条件；不满足立即停止。
4. 生成 worktree 相对 `HEAD` 的 patch：
   - `git -C <worktree> diff --binary HEAD`
   - 可选补 untracked 文件策略见下方未决问题；第一版建议 untracked 存在即 park，不纳入 merge。
5. 在主 cwd 试应用：
   - `git apply --check --index <patch>`
6. `--check` 通过后再执行：
   - `git apply --index <patch>`
7. 每个成功 merge 记录一条 finalize JSONL 审计记录。

### 停止条件

以下任一情况停止后续 merge，保留所有 worktree：

- 主 cwd dirty。
- worktree untracked / conflict / status 不可读 / diff 不可读。
- patch 为空。
- patch check 失败。
- conflict。
- proposal 对应 logged verdict 缺失或不再是 verified。
- loop log 解析失败。
- worktree realpath 边界失败。
- 任一 git 命令异常或 timeout。

失败后不回滚已成功应用的前序 patch。原因：自动回滚会碰用户工作树和可能混入的手工修复。报告里打印已应用列表和停止原因，由人决定下一步。

## Cleanup 规则

cleanup 不跟 merge 自动绑定。只有以下 worktree 可进入 cleanup proposal：

- 对应 goal 已在 finalize 审计记录中标记为 merge-applied，或用户显式传未来设计里的 `--cleanup-merged <manifest>`。
- worktree 当前 clean。
- worktree realpath 在 trusted worktree root 内。
- worktree 不落 cwd 内。
- worktree realpath 不指向 cwd。
- 没有 untracked 文件。

执行方式建议第一版使用 `git worktree remove <path>`，不加 `--force`。如果 Git 拒绝删除，停止并提示人工处理。不要使用 `Remove-Item` 递归删除。

cleanup 成功后只记录审计，不删除 loop log、goal log、session log、shadow log。

当前实现：

- `--cleanup` 会先打印 cleanup candidate / park report，再要求输入完整 `cleanup <loopId>`。
- 候选必须同时满足：`data/loops/<id>.finalize.jsonl` 有对应 `merge-applied` 审计、当前 worktree realpath 通过边界检查、当前 worktree clean。
- dirty / untracked / conflict / missing audit / missing worktree 全部 park，不删除。
- 执行使用 `git worktree remove <path>`，不带 `--force`。

## 审计记录

新增 `data/loops/<id>.finalize.jsonl`，与原 loop log 分开，避免把执行态混入调度 replay。

建议记录：

- `finalize-started`：mode、loopId、cwd、worktreeRoot、at。
- `merge-confirmed`：proposal count、confirmedAt。
- `merge-applied`：index、goalId、worktreePath、headBefore、headAfter、at。
- `merge-parked`：index、goalId、reason、at。
- `cleanup-confirmed`：candidate count、confirmedAt。
- `cleanup-removed`：index、goalId、worktreePath、at。
- `finalize-stopped`：reason、at。

这些记录只用于审计和 cleanup 候选判断，不参与 goal 完成判定。

## 信任边界

- `data/loops/*.jsonl` 是 cwd 内审计输入，不能单独授权 merge/cleanup。
- `data/loops/*.finalize.jsonl` 也是 cwd 内审计输入，不能覆盖当前重新扫描结果。
- 当前命令参数和交互确认才是执行授权。
- 执行前必须重新扫描 worktree 和主 cwd 状态。
- 不从 cwd 自动发现 trusted verifier/hook/cron 配置。
- 不读取 repo 内 allow-list 来放行危险命令。

## 未决问题

1. untracked 文件是否允许 merge：
   - 推荐第一版 park。理由：`git diff HEAD` 默认不包含 untracked，自动打包 untracked 会扩大实现面。
2. 多 proposal 顺序：
   - 推荐按 objective index 顺序串行。冲突时停止，保留后续 worktree。
3. 空 patch：
   - 推荐 park。可能表示目标无改动或改动已被人工合并，需要人看。
4. cleanup 是否支持 manifest：
   - 推荐后续再加，第一版只信本次 `finalize.jsonl` 中的 `merge-applied` 加当前扫描。

## 实施切片

### Slice A：merge interactive apply（已落地）

文件：

- `src/capabilities/goal/loop-finalize.ts`
- `src/surfaces/cli/loop-finalize-args.ts`
- `src/surfaces/cli/loop-finalize-cli.ts`
- `test/capabilities/goal/loop-finalize.test.ts`
- `test/cli/loop-finalize-cli-smoke.test.ts`

测试：

- `--merge` 需要完整确认短语。
- EOF / 空输入 / `yes` 取消。
- 主 cwd dirty 时不 apply。
- worktree untracked 时不 apply。
- conflict 时不 apply。
- verified + tracked diff + patch check 通过时应用 patch。
- applied 后写 finalize audit。
- 不调用 push / rebase / force remove。

实现说明：

- `--merge` 会先打印只读 report，再要求输入完整 `merge <loopId>`。
- 确认后重新扫描 worktree 状态，主 cwd clean 后才串行 apply。
- 成功写 `merge-confirmed` / `merge-applied` / `finalize-stopped` 到 `data/loops/<id>.finalize.jsonl`。
- patch 为空、patch check 失败、apply 失败写 `merge-parked` 并停止后续 proposal。

### Slice B：cleanup dry-run + confirm（已落地）

文件：

- `src/surfaces/cli/loop-finalize-args.ts`
- `src/surfaces/cli/loop-finalize-cli.ts`
- `test/cli/loop-finalize-args.test.ts`
- `test/cli/loop-finalize-cli-smoke.test.ts`

测试：

- `--cleanup` 需要完整确认短语。
- 只清理有 merge-applied 审计且当前 clean 的 worktree。
- dirty / untracked / missing audit / rejected / parked 不清理。
- 使用 `git worktree remove` 且不带 `--force`。
- 删除失败时停止并保留后续 worktree。
- 不删除 loop log、goal log、session log、shadow log。

## 验收

每个执行 slice 完成后运行：

```bash
npm run test
npm run typecheck
npm run build
npm run lint
```

安全审查重点：

- 哪个 cwd 日志字段被误当成授权？
- 哪个路径没 realpath 就执行？
- 哪个失败模式会继续 merge/cleanup？
- 哪个 cleanup 分支可能删除未检查产物？
- 有没有新增 push、rebase、force remove、hard reset？
