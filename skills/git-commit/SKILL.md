---
name: git-commit
description: 用户要写 commit message、提交代码、或问该怎么提交时
triggers: [commit, 提交, commit message, 提交代码, 提交信息, 写个 commit]
---

当用户要写 commit message 或提交代码时，按以下规范产出。

## 规范

1. **语言**：commit message 一律用英文。
2. **首行**：`<type>(<scope>): <intent>`，不超过 72 字符，用祈使句说清**意图**（要达成什么），不要描述过程。
   - `type`：feat / fix / docs / refactor / test / chore / perf 等。
   - `scope`：受影响的模块名（如 `A2`、`tools`、`cli`）。
3. **正文**（需要时）：首行后空一行再写，解释**为什么**这样改、对体验 / 维护 / 风险的影响；列要点用 `-`。
4. **结尾**：固定追加一行（与项目约定一致）：

   ```
   Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
   ```

## 看改动（A 阶段没有 git 工具）

A 阶段还没接入 Bash / git 工具，你**无法**自己跑 `git diff`。所以：

- 请让用户把 `git diff --staged`（或 `git diff`）的输出贴进来；
- 或用 `read` 工具读取用户指明的、本次改动涉及的文件；
- **绝不编造**没看到的改动。看不到 diff 就先要 diff，别凭猜写。

## 输出

只输出最终的 commit message，用代码块包裹，不附加解释（除非用户另问）。若信息不足以判断 type/scope/意图，先问一句，避免凭空补全。
