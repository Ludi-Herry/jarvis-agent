# 批 4（第一批接续）：基础阅读与授权判断 — 实施笔记

2026-10-07 · Mirasim Kimi K3 Max（effort=max）接替 Codex。上游：`HANDOFF-gui-kimi-k3-max-2026-10-07.md` §「第一批」、`ANALYSIS-gui-openhanako-mirasim-gap-2026-10-07.md` §3/§6。保护基线 `94a66cb`（含 Codex 修复与证据，原样入库）。

> **状态：已完成（2026-10-07）。** 证据与门禁：`docs/evidence/gui-v13-batch4/README.md`。全量 1829 passed / 2 skipped，typecheck/lint/双 build 通过。

## 本批目标（已批准范围内的最小实现）

1. **Markdown 渲染**：live 消息文本从 `<p>{part.text}</p>` 升级为最小 Markdown（标题/列表/代码围栏/行内代码/链接/表格降级）。无新依赖：手写安全受限 renderer（先按 HTML 转义 → 再结构化，绝不 dangerouslySetInnerHTML）。
2. **代码块复制**：围栏块带复制按钮与语言标注。
3. **成果可打开**：Diff/产物页签的 artifact 行提供「打开」入口 → 新端点只读读取文件内容（文本截断 / 图片 data-URI / 其他二进制诚实拒绝），UI 内联预览；「在外部编辑器打开」用系统默认程序打开该文件（保留真实路径）。
4. **待授权变更视图**：审批卡新增结构化「即将批准的变更」——从 `approval.arguments`（write: path+content；edit: path+oldText→newText）解析出文件与 unified diff 预览；bash 类命令原样列出；解析失败回退到现有参数详情。与已执行 Diff 页签明确区分（标注「待授权预览 ≠ 已执行改动」）。
5. **GitRows 修复**：`evidence.tsx` 中 getGit reject 后永久「读取中」→ 用 reject sentinel 显式显示「读取失败」。

## 文件范围

| 文件 | 改动 |
| --- | --- |
| `src/surfaces/gui/live-types.ts` | `GuiFileView` 类型 |
| `src/surfaces/gui/live-session.ts` | `readFileView(id, path)`（safeResolve + 敏感路径/符号链接边界 + 10s 超时 + ≤200KB 截断）、`openFileExternal(id, path)`（同边界校验后 spawn 系统打开器） |
| `src/surfaces/gui/live-api.ts` | 路由：`GET /api/live/:id/file?path=`、`POST /api/live/:id/open-external` |
| `src/surfaces/gui/app/src/live/api.ts` | `getFileView` / `openFileExternal` 客户端 |
| `src/surfaces/gui/app/src/workbench/markdown.tsx` | 新：受限 Markdown renderer（纯函数可测） |
| `src/surfaces/gui/app/src/workbench/message-item.tsx` | 文本 part → Markdown |
| `src/surfaces/gui/app/src/workbench/approval-diff.ts` | 新：从 approval arguments 构造预览 diff（纯函数） |
| `src/surfaces/gui/app/src/workbench/active-stage.tsx` | ApprovalCard 结构化变更视图 |
| `src/surfaces/gui/app/src/workbench/evidence.tsx` | artifact 打开按钮 + 文件预览内联 + GitRows 修复 |
| `src/surfaces/gui/app/src/workbench/types.ts` + `fixture-store.ts` + `use-live-session.ts` | 新命令接线 |
| `src/surfaces/gui/app/src/styles/workbench.css` | 新增样式（沿用既有 token/黑白灰） |
| `test/surfaces/gui/` | markdown 纯函数、approval-diff 纯函数、readFileView 边界/截断/敏感路径、GitRows 状态（组件级若可行，否则走 fixture 截图验证） |

## 验收

- 全门：`typecheck`、`lint`、`vitest run --maxWorkers=4` 绿；根 build + GUI build 通过。
- 新增测试覆盖：markdown 渲染（代码围栏/表格降级/XSS 转义）、approval diff 构造（write 新文件/write 旧版被拒/edit 正常）、readFileView（越界、敏感路径、大文件截断、图片）。
- 试件截图：markdown 消息、审批卡变更视图、产物打开预览，1440×900 入 `docs/evidence/gui-v13-batch4/`。
- 4317 只读服务若恢复则做一次真实页面 smoke；否则明确记录限制，不虚构真实任务成功。

## 不做（本批）

- 不引入 markdown 库新依赖（手写受限子集）；不做办公文档编辑器；不改审批/权限合同；不动 V13 布局结构（列宽/抽屉不变）；不扩大 writePaths 语义；不触碰 worktree/多 pane/模型配置等条件项。
