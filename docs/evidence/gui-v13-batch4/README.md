# 批 4（基础阅读与授权判断）回执

2026-10-07 · Mirasim Kimi K3 Max（effort=max）执行。上游：`docs/PLAN-gui-v13-batch4-reading-approval.md`、`docs/HANDOFF-gui-kimi-k3-max-2026-10-07.md`、`docs/ANALYSIS-gui-openhanako-mirasim-gap-2026-10-07.md` §6 第一行。保护基线 `94a66cb`。

## 做了什么

1. **Markdown 渲染**：live 消息文本由 `<p>` 换为受限 Markdown（`markdown-blocks.ts` 纯解析 + `markdown.tsx` 渲染）。支持标题 1–4、围栏代码块（语言标签 + 复制按钮）、行内代码、粗体/斜体（词边界保护，snake_case 不误判）、`[text](url)` 链接（仅 https/http/mailto，其他一律降级为字面文本）、管道表格、引用、分割线。无新依赖；不解析 HTML（React 转义兜底），无 `dangerouslySetInnerHTML`。
2. **成果打开**：`GET /api/live/:id/file?path=` 只读预览（safeResolve 越界/符号链接/敏感路径/git 元数据拦截；文本 ≤200KB 截断、图片 ≤2MiB 返回 base64、二进制诚实拒绝 415）。`POST /api/live/:id/open-external` 用系统默认程序打开（无 shell、detached）。Diff 页签 artifact 行新增「打开」按钮，内联预览卡带复制/在外部打开/关闭。
3. **待授权变更视图**：审批卡新增「即将批准的变更（预览，尚未执行）」区——`approval-diff.ts` 纯函数从审批参数构造：write createOnly → unified diff 全新增；write expectedVersion → 替换内容 + 明确注释「旧文本以工作区为准，预览未执行」；edit → oldText/newText 行级 LCS diff；bash/sandboxed_exec → 命令块；解析失败诚实回退到原参数详情。区注明与右侧已执行 Diff 不是同一份。
4. **GitRows 修复**：`evidence.tsx` 中 git 查询 reject 后不再永久「读取中」，显示「git 状态查询失败；请稍后重试」。
5. **试件扩充**：新增 `markdown` 与 `edit` 两个试件（仅构造数据，不构成验收结论）；approval 试件的 expectedVersion 修正为真实 fv1 token 字符串形状。

## 门禁

- 根 `typecheck`、`lint`、`vitest run --maxWorkers=4`：1829 passed / 2 skipped（新增 24 条：markdown 解析 10、approval 预览 6、readFileView 边界/截断/图片/敏感路径 8）。
- 根 `npm run build`、GUI `npm --prefix src/surfaces/gui/app run build` 均通过（GUI 仍有既有大 bundle 提示，未处理）。

## 浏览器证据（`npm run preview -- --port 4319`，fixture 页，Playwright MCP）

- `markdown-1440x900.png`：标题/列表/表格/代码块/引用/链接按样式渲染。
- `approval-write-1440x900.png`：write-replace 审批预览（替换内容 + 诚实注释 + 代码块）。
- `approval-edit-1440x900.png`：edit 审批行级 LCS diff（老红新绿，黑底）。
- `artifact-preview-1440x900.png`：Diff 页签 artifact「打开」→ 内联预览（复制/在外部打开/关闭）。
- `running-1440x900.png`：运行中基线回归对照。
- 全程 console 无 error/warning。4317 只读服务本轮未在运行，UI 验证以试件渲染为准；真实模型任务未触碰。

## 收尾

- V13 布局结构未动；CSS 只追加新 class（复用既有 zinc/token），未改任何既有选择器。
- 第二批（单任务启动与错误恢复）与后续条件项待推进；worktree/多 pane/模型配置等条件项仍按需求触发。
- 本批未消耗任何真实模型额度；未提交前经 `git diff --cached --stat` 核对仅含本批文件。
