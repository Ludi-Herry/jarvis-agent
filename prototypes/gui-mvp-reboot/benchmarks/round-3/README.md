# Round 3 · 桌面对话工作区最好页面探索

> 状态：合同已按 Agent 能力拆分，等待 Ludi 分别粘贴三家入口 Prompt。本目录不运行任何 Agent，也不承担公平模型测试。

## 目标

三家从相同产品事实和空输出目录开始，各自设计一份桌面对话工作区。Kimi/ZCode 获得更大的结构与审美自由；Gemini 延续严格形态合同，避免再次收敛成单列时间线。

## 目录所有权

| Agent | 唯一可写目录 | 粘贴入口 |
|---|---|---|
| Kimi | `./kimi/` | [`PROMPT-KIMI.md`](./PROMPT-KIMI.md) · 创意开放 |
| ZCode | `./zcode/` | [`PROMPT-ZCODE.md`](./PROMPT-ZCODE.md) · 创意开放 |
| Gemini | `./gemini/` | [`PROMPT-GEMINI.md`](./PROMPT-GEMINI.md) · 严格纠偏 |

Kimi/ZCode 共用 [`ROUND-3-CREATIVE-PROMPT.md`](./ROUND-3-CREATIVE-PROMPT.md)。Gemini 使用 [`ROUND-3-PROMPT.md`](./ROUND-3-PROMPT.md) 严格合同。

## 输入策略

- 三家共享 Jarvis 产品事实、模拟任务、安全边界和双视口底线。
- 三家禁止读取 Codex、Round 1、Round 2、Gemini 纠偏中间稿和其他参赛目录。
- Kimi/ZCode 打开四家参考后自行选择一个结构主锚点和一个交互辅锚点，其余参考可明确拒绝。
- Gemini 必须执行更严格的两区、首屏与 Composer 形态门。
- 主线程最终统一检查页面滚动、关键控制、console error 和截图；结果用于选择页面，不能解释为模型能力公平排名。

## 三家共同硬门

1. `body` / `document` 无页面级滚动；产品壳固定为 `100vh`。
2. 页面必须支持持续对话，包含可输入 Composer 和至少两条消息。
3. 当前目标、阶段、终止和完成授权持续可见。
4. 审批立即可达，Artifact/Diff 最多一步打开。
5. 两档 viewport 无横向溢出，关键控制不丢失。

Kimi/ZCode 可以使用分屏、浮层、可变 pane、上下文抽屉、空间画布、聚焦模式或其他结构。Gemini 继续接受严格的两区和七项首屏合同。

## 旧稿边界

以下内容全部禁止参赛者读取：

- `../conversation-first/`、`../task-first/`、`../artifact-first/`；
- `../kimi/`、`../zcode/`、`../gemini/`；
- `../round-2/kimi/`、`../round-2/zcode/`、`../round-2/gemini/`；
- `../round-2/gemini-dialog-workspace/`；
- 所有既有参赛截图。

旧稿继续保留，禁止删除、覆盖或移动。
