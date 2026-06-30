# Handoff — Hooks 能力第一切片（PreToolUse + PostToolUse）

> 状态：已落地，616 测试 / 四关卡全绿（582 → 616，新增 34 条 hooks 测试）。经 codex CLI 双 lens（安全不变量 + 正确性/边界）对抗审查后加固。本页只讲第一切片：挂点、硬不变量、配置、defer。

## 是什么

让用户在**每次工具调用的生命周期**里插入自己的 shell 命令，两个事件：

- **PreToolUse**（执行前，可 fail-closed **阻断**）：gate 放行后跑；任一匹配 hook 退出非零（或超时）→ 该工具调用被拒，原因喂回模型。
- **PostToolUse**（执行后，**咨询型**）：工具跑完后跑；退出码忽略、抛错吞掉、**不改**结果、**不**阻断（纯副作用 / 可观测性，与 `goal-loop` 的 `snapshotShadow` 同纪律）。

默认 **off**：不设 `JARVIS_HOOKS` 就没有任何 hook，行为与切片前逐字节一致（沿用 vision=`ARK_VISION_MODEL`、leg3=`ARK_VERIFIER_MODEL`、shadow=`JARVIS_SHADOW_GIT` 的 env-gate opt-in 范式）。

## 挂点（harness seam）

唯一挂点是 `gatedRun`（`src/core/loop/run-agent.ts`）——所有 surface（repl / goal / loop）共用的工具调用 seam。顺序即安全契约：

```
gate.check  →  (deny ⇒ 立即返回，hooks 不被咨询)
            →  PreToolUse hooks  (仅在 allow 后跑；blocked ⇒ 拒绝，fail-closed)
            →  tools.run         (真正的副作用)
            →  PostToolUse hooks (咨询，吞异常，不改结果)
```

`AgentContext.hooks` 用**结构型**声明（镜像 `goal-loop` 给 `shadowGit` 的写法），所以 core 层不依赖 capabilities 层。`runGoal` 把 `deps.hooks` 原样透传进每轮的 runAgent ctx（不碰 `decideVerdict` 与验收三腿）。

## 硬不变量（违反即作废）

| # | 不变量 | 保证机制 |
|---|---|---|
| 1 | hook 只能加 deny / 跑副作用，**永不解锁** gate 的 deny | gate 先判、deny 立即 return（hooks 根本不被咨询）；PreToolUse 只在 allow 后跑且 API 只有 `block`、无 allow 路径 ⇒ **结构性** deny-only，非靠运行时检查 |
| 2 | 仓内（不可信仓库）hook 配置**排除** | `JARVIS_HOOKS` 在**加载 `.env` 之前**从启动 env 捕获（`JARVIS_HOOKS_LAUNCH`），所以仓内 `.env` 无法设它、无法启用 hook；**没有任何**扫 cwd 的代码路径；路径经 **realpath 规范化**后再判是否落 cwd 内（堵 Windows `\\?\` 扩展路径 + symlink 绕过），落内 → **拒绝 + warning**。理由同已撤回的 bash allow-list Path A（memory `restore-bash-session-allow`）：hook 执行任意 shell，从仓内加载 = 任意代码执行 |
| 3 | 默认 off，无配置 = 无 hook，行为不变 | `JARVIS_HOOKS` 未设 → `hooks=undefined` → `gatedRun` 走原路径 |
| 4 | hook 命令复用 `runCommand` 的脱敏 env 与超时 | `runCommand(..., { scrubSecretEnv:true, extraEnv })` + `HOOK_TIMEOUT_MS`（30s）+ tree-kill；**不**自起裸 shell。hook 收不到 `ARK_API_KEY` 等密钥 |

与 rules 的信任边界**相反**：rules 只能加 deny，从仓内（cwd）加载是安全的（`surfaces/cli/index.ts` 故意只扫 cwd）；hooks 能跑命令，只能从可信来源加载。

## 配置

`JARVIS_HOOKS` = 一个 **cwd 之外**的 JSON 文件路径。格式：

```json
{
  "PreToolUse":  [ { "matcher": "bash",  "command": "<guard 脚本>" } ],
  "PostToolUse": [ { "matcher": "write", "command": "<格式化/通知>" } ]
}
```

- `matcher`：可选，工具名 glob（线性 wildcard 匹配，`*` 唯一通配符；**缺省** = 匹配所有工具；**空串视为配置错、拒绝**）。
- `command`：必填非空。匹配到的 hook 按声明顺序执行（PreToolUse 首个非零即短路阻断）。
- **严格校验**：未知顶层 key（如 `PreToolUes` 拼错）会**报错禁用**而非静默丢弃——避免你以为生效的安全 hook 其实没装。
- hook 进程通过 env 收到工具上下文：`JARVIS_HOOK_EVENT`、`JARVIS_HOOK_TOOL`、`JARVIS_HOOK_TOOL_INPUT`（模型发出的参数；**超 ~4KB 时替换为合法 JSON 哨兵 `{"_jarvis_truncated":true,...}`**，绝不输出截断坏掉的 JSON 误导 hook）。hook 是可信计算边界，会看到工具参数明文，配置时自负其责。
- 解析失败 / 文件不可读 / 路径落 cwd 内 → warn + 禁用（不崩会话）。

端到端 smoke：`/tmp/hooks.json`（cwd 外）写 `{"PreToolUse":[{"matcher":"bash","command":"exit 1"}]}`，`JARVIS_HOOKS=/tmp/hooks.json npm run dev`，让模型跑一条 bash → 被 hook 阻断、原因喂回。

## 关键文件

- `src/capabilities/hooks/hook-config.ts` — 类型 + 纯函数 `parseHookConfig` + `loadHookConfig`（注入式 readText + cwd-排除守卫）。
- `src/capabilities/hooks/hook-runner.ts` — `createHookRunner`（preToolUse/postToolUse，注入式 `run` 默认 = `runCommand`）+ `resolveHooks`（env opt-in 包装）。
- `src/core/loop/run-agent.ts` — `AgentContext.hooks` + `gatedRun` 接入。
- `src/core/tools/run-command.ts` — `RunCommandOptions.extraEnv`（脱敏后叠加，传 hook 上下文）。
- 装配根：`surfaces/cli/{index,repl,goal-cli,loop-cli}.ts` + `capabilities/goal/goal-loop.ts`（2 行透传）。
- 测试：`test/capabilities/hooks/{hook-config,hook-runner}.test.ts` + `test/loop/run-agent.test.ts`（hooks slice 1 describe）。

## Defer（明确不做）

- round 级 / session 级 hook 事件（本切片只 per-tool-call）。
- PostToolUse 把 hook 输出**反馈进对话**（本切片纯副作用）。
- 每条 hook 自定义 `timeoutMs` 覆盖（本切片固定 `HOOK_TIMEOUT_MS`）。
- 多来源配置（如 `~/.jarvis/hooks.json` 默认位 + 合并）；本切片单一可信来源 `JARVIS_HOOKS`。
- 无人值守 bash 自治仍 gated on OS 沙箱（与本切片正交）。
