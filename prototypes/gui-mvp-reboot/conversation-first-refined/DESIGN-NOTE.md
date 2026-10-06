# Conversation First Refined · Design Note

## Design Read

```yaml
artifact: desktop coding-agent conversation workspace prototype
audience: Ludi，唯一用户与最终裁决者
mode: selected-direction refinement
visual-language: warm humanist conversation shell with precise evidence handling
visual-variance: 4
motion-intensity: 3
information-density: 7
asset-dependence: 1
brand-fidelity: 9
```

## 保留

- Codex 原稿的三栏产品壳：Session/任务历史、中央对话、右侧任务与证据。
- Jarvis 对消息、Reasoning、工具、审批、Artifact 和完成授权的完整表达。
- 原始 `conversation-first/` 保持冻结，refined 版本独立交付。

## 吸收

1. Kimi：暖纸、墨色、朱砂授权印章和不低于 11–12px 的主要辅助文字。
2. Kimi：右侧审阅区可按需扩到约 38vw；审批通过后自动进入验证证据。
3. ZCode：工具条目与上下文/Diff/验证证据联动定位。
4. ZCode：状态变化不重建消息列表，保持用户回读位置；原始 runtime 已满足，继续保留。

## Motion

- 审阅栏宽度切换使用 `transitions-dev` card-resize：300ms、`cubic-bezier(0.22, 1, 0.36, 1)`。
- 证据定位只使用短暂背景与描边反馈。
- `prefers-reduced-motion: reduce` 关闭宽度、位移和状态过渡。

## 非目标

- 不修改共享 scenario/runtime，不影响冻结基准和其他参赛稿。
- 不接 React、assistant-ui、真实 Runtime、Session、权限或完成授权。
- 不复制 Kimi/ZCode 的整体布局，只吸收已验证的局部手法。

## 浏览器验收

- 环境：Codex 内置 Browser，`http://127.0.0.1:4327/conversation-first-refined/`。
- 1440×900 compact：三栏 `208 / 888 / 344`，审批完整可见，页面级零溢出。
- 1440×900 expanded：三栏 `208 / 685 / 547`，完整 Diff 可读，页面级零溢出。
- 1280×800 compact：三栏 `184 / 784 / 312`，审批与 Composer 持续可达，页面级零溢出。
- 1280×800 expanded：三栏 `184 / 610 / 486`，页面级零溢出。
- 最小可见文字 11px；任务标题在 1440 为 1 行、1280 为 2 行，均无截断。
- 核心状态：暂停→继续、终止确认→恢复、审批三决定、完成/失败演示均通过。
- 证据联动：`apply_patch → Diff`、`vitest → 验证`、`read_file/rg → 上下文` 均通过；Enter/Space 可触发工具定位。
- 审批通过后自动扩宽审阅栏并切至验证；完成授权保持未授予，直到显式 `completed` 状态才显示“已授权”。
- console error：0。

## 验收中修正

- 初稿加入授权印章后，1440 任务标题尾部出现截断。改为最多两行的弹性标题并收紧 topbar gap；复验 1440 compact/expanded 与 1280 compact 均无截断。
- 字号首轮仍有 8–10px 辅助文字。最终统一抬至最小 11px，同时保留代码区可读密度。

## 截图

- `screenshots/final-1440x900.png`
- `screenshots/final-1440x900-expanded.png`
- `screenshots/final-1280x800.png`
