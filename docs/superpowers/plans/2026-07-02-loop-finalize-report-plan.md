# Loop Finalize Report Plan

> 状态：实施前计划。目标是先做只读 finalize report，让 parallel worktree 的结尾状态可审计；不执行 merge，不执行 cleanup。

## 目标

新增只读命令：

```bash
npm run loop:finalize -- --loop <id>
```

成功标准：

- 读取 `data/loops/<id>.jsonl`。
- 汇总每个目标的 latest attempt、logged state/outcome、worktree path、git status、diff stat。
- 只对 logged `state=complete` 且 `outcome=verified` 且 worktree clean 的 goal 生成 merge proposal。
- blocked、parked、rejected、couldNotVerify、missing verdict、missing worktree、dirty/conflict 都进入 stop/park 分类。
- 全流程只读，不 merge、不 cleanup、不 push、不 rebase、不删除 worktree。

## 本 slice 范围

1. 新增纯函数分类：
   - 输入 loop records + 每个 goal 的 worktree status。
   - 输出 report items 与 proposal 列表。
2. 新增 CLI 参数：
   - `--loop <id>` 必填。
   - `--worktree-root <path>` 可选；缺省沿用 loop-cli 的默认 root。
   - 拒绝 `--merge`、`--cleanup`，避免用户误以为已支持执行模式。
3. 新增 CLI：
   - `src/surfaces/cli/loop-finalize-cli.ts`
   - 只读加载 loop log 和 worktree status。
   - 打印人可读报告。
4. 新增 package script：
   - `loop:finalize`

## 暂不做

- merge apply。
- cleanup apply。
- dry-run merge 冲突模拟。
- 删除 worktree。
- 修改 goal verdict。
- 自动 reverify。
- 从 cwd 内读取 trusted config。

## 文件

- `src/capabilities/goal/loop-finalize.ts`
- `src/capabilities/goal/index.ts`
- `src/surfaces/cli/loop-finalize-args.ts`
- `src/surfaces/cli/loop-finalize-cli.ts`
- `package.json`
- `test/capabilities/goal/loop-finalize.test.ts`
- `test/cli/loop-finalize-args.test.ts`
- `test/cli/loop-finalize-cli-smoke.test.ts`
- `README.md`
- `docs/handoff-loop-remaining.md`

## 信任边界

- `data/loops/*.jsonl` 在 cwd 内，只能作为审计输入。read-only report 可以展示 logged verdict，但不能把它当 merge 授权。
- worktree root 只用于定位 report 对象，realpath 后仍拒 cwd 内，沿用 worktree helper 边界。
- report 不执行任何破坏性命令。
- 后续 merge/cleanup 必须重新设计交互确认和 reverify 规则。

## 失败模式测试

- parser 拒绝缺 `--loop`、未知 flag、`--merge`、`--cleanup`。
- verified + clean 出现在 proposal。
- blocked / rejected / couldNotVerify / missing verdict 不进 proposal。
- missing worktree 不进 proposal。
- dirty / conflict 不进 proposal。
- CLI smoke 对 `--merge` 返回非零且不创建/删除文件。
- CLI smoke 对缺失 worktree 输出 parked。

## 验收

代码切片完成后运行：

```bash
npm run test
npm run typecheck
npm run build
npm run lint
```

Windows 子进程测试如果出现 timeout / EBUSY，先原命令重跑确认。
