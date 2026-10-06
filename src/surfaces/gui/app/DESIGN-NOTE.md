# Jarvis GUI P2 React Spike · Design Note

## Design Read

```yaml
artifact: desktop coding-agent conversation workspace spike
audience: Ludi，唯一用户与最终裁决者
mode: redesign-preserve
visual-language: shadcn-neutral white workspace with Codex-like restraint
visual-variance: 3
motion-intensity: 2
information-density: 7
asset-dependence: 1
brand-fidelity: 10
```

## Preserve

- `conversation-first-refined` 的三栏信息架构、全部模拟任务文案和状态层级。
- 左侧会话连续性、中央对话主轴、右侧任务与证据的空间关系。
- 现有权限、Session、Runtime、Goal、API 与完成授权边界。

## Improve

- 采用 shadcn neutral 语义 token：纯白 background/card、近黑 foreground/primary、浅灰 muted/accent 与 1px border。
- 移除纸张、印章、贴纸和东方材质语言；AUTH 改成普通权威状态 badge。
- 右栏只展开一个活动阶段；审批、验证、失败和完成原位切换。
- `要求调整` 直接聚焦 Composer。
- 暂停、终止、恢复保留消息、右栏、焦点和 Composer 草稿。
- assistant-ui 只承担公开 conversation primitives 与 External Store 显示适配。

## Remove

- 暖米色、径向纸面光斑、朱砂大面积强调、旋转印章和装饰性材质。
- assistant-ui 默认主题、Cloud、CLI scaffold、shadcn、Tailwind 与 library tool execution。
- 对已关闭方向的变体、Tweaks 面板和额外产品功能。

## Protected contracts

- UI 无权授予权限或完成；只有带 verified verdict 的 demo fixture 展示完成授权。
- P2 不调用现有 API，不读取 JSONL，不连接模型，不修改旧 GUI。
- 1280×800 expanded 的中央对话宽度不低于 610px。

## Motion

- `transitions-dev` card resize：审阅栏 compact/expanded。
- `transitions-dev` accordion：Reasoning disclosure。
- `transitions-dev` modal：终止确认。
- `prefers-reduced-motion: reduce` 关闭上述位移、缩放、模糊和宽度过渡。

## Fallback

P2 若因依赖所有权、实验 API、非 localhost 网络或 1280 宽度失败，保留 Spike 证据并回到 app-owned React primitives；不会用 Cloud、第二 Runtime 或范围扩张补救。
