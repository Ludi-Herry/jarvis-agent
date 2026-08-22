# Completion bash 探针路径兼容修复提案

> 状态：已解决。Luis 先后批准路径解耦与 bash stdin 方案；最终采用 stdin 驱动并通过完整门禁，completion 产品代码保持不变。

## 触发条件与证据

- `npm test -- --maxWorkers=4`：`test/cli/completion-cli.test.ts:102` 失败，`bashProbe` 的子命令行为空；全量结果为 145 files passed、1 failed，1661 passed、2 skipped。
- 同文件 `--maxWorkers=1` 定向重跑再次失败，信号连续出现 2 次。
- 当前 `bash` 解析到 WindowsApps/WSL。测试把 Node `tmpdir()` 生成的 `C:\...\jarvis-completion-test-*.bash` 直接交给 `/bin/bash` 的 `source`；路径无法解析，随后 `_jarvis_completions` 未定义。命令末尾的 `echo` 仍返回 exit 0，因此测试只看到空输出。
- 同一生成脚本交给 `C:\Program Files\Git\bin\bash.exe` 时能输出 `list show search fork rename archive unarchive`，产品生成脚本本身有可用证据。

## 共同 Owner 与同构绑定

- Owner：`test/cli/completion-cli.test.ts` 的 bash 真实调用探针。
- 同构绑定：Windows Node 路径方言被传入 bash 内建命令。PowerShell 探针已单独转义路径，不共享该失败模式。
- 当前未发现其他测试把 Windows 临时路径直接交给 bash `source`；实施前再用 `rg` 做一次定向确认。

## 一次性解耦方式

把已生成的 bash completion 脚本与探针命令作为同一段 stdin/command 文本交给 bash 执行，取消临时脚本路径跨 Windows/WSL/Git Bash 的翻译依赖。继续真实调用 `_jarvis_completions`，不降低断言，不指定某个固定 bash 发行版，也不改产品生成器。

## 迁移边界

- 只改 `test/cli/completion-cli.test.ts`。
- 不改 `src/surfaces/cli/completion.ts`、命令表、断言、PATH 或系统配置。
- 不新增依赖，不触碰 G1 产品文件，不清理历史临时文件。

## 负例与验证

1. bash 子命令补全仍包含 `archive` 与 `list`。
2. bash 顶层部分词 `rev` 仍只得到 `review`。
3. PowerShell `TabExpansion2` 两条现有断言保持。
4. 定向测试在当前默认 WSL bash 下通过；可选再用 Git Bash 复验同一测试。
5. 回到 canonical `npm test -- --maxWorkers=4`，再跑 typecheck、lint、build `--noEmit` 与 `git diff --check`。

## 停止条件与待裁决问题

- 修复后同一信号再次失败，停止并保留原始输出，不继续追加补丁。
- 需要 Luis 决定：是否批准这个纯测试、单文件的路径解耦，使 G1 能重新进入完整提交门。

## 2026-08-22 授权实施后的停止记录

Luis 已批准第一版纯测试修复：取消临时 bash 文件，把生成脚本与探针直接拼成 `bash -c` 的同一段命令。产品生成器和断言未改。

定向测试再次失败，触发上方停止条件：

```text
Error: bash probe failed: /bin/bash: line 1: jarvis: command not found
/bin/bash: -c: line 7: conditional binary operator expected
/bin/bash: -c: line 7: syntax error near `1'
/bin/bash: -c: line 7: `  if [[  -eq 1 ]]; then'
```

新证据表明 WindowsApps/WSL 的 `bash.exe -c` 转交多行命令时仍存在一层命令字符串解释：生成脚本注释中的反引号被执行，函数体里的 `$COMP_CWORD` 在定义前被展开为空。当前信号累计 3 次：全量门一次、原实现定向复现一次、授权修复后定向复现一次。

已消耗验证：G1 聚焦测试 71/71 与 requestedAt 定向 11/11 通过；typecheck、lint、build `--noEmit`、diff check 通过；独立 Reviewer 最终 GO，P0/P1/P2 均为 0。完整测试门仍停在这一个 completion 探针。

剩余选项：

1. **推荐**：测试里用 `spawn('bash', ['-s', '--'])`，通过 stdin 写入生成脚本与探针。这样同时绕开 Windows 路径方言和 `-c` 命令行二次解释，仍由当前默认 bash 真实执行脚本。
2. 固定调用 Git Bash 绝对路径。当前机器可用，但会把测试绑定到本机安装位置，不推荐。
3. 跳过该测试或降低断言。违反门禁，不采用。

历史待裁决点：是否批准选项 1。后续已获批准，结果见下方最终解决记录。

## 最终解决记录

- Luis 批准选项 1 后，`test/cli/completion-cli.test.ts` 改用 `execFile('bash', ['-s', '--'])`，通过 stdin 发送生成脚本与探针。
- 独立复核确认生成脚本仍被真实执行，P0/P1 为 0；Reviewer 提醒 stdin `EPIPE` 需要显式处理，已补 error 监听。
- completion 定向测试：5/5 通过。
- G1 + completion 聚焦测试：5 files、77/77 通过。
- canonical 全量测试：146/146 files、1667 passed、2 skipped、0 failed。
- `npm run typecheck`、`npm run lint`、`npm run build -- --noEmit`、`git diff --check` 全绿。
