# Round 2 通用 Prompt

> 使用前将 `<AGENT>` 替换为 `kimi`、`zcode` 或 `gemini`。整段粘贴给对应 Agent；三家只替换这个名字。

```text
在 H:\jarvis-agent 参加 Jarvis-Agent「对话主导 GUI」Round 2 统一参考增强比稿。

你的身份是 <AGENT>。你的唯一可写目录是：
H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\round-2\<AGENT>\

Outcome:
基于同一公共 Brief 和精选参考包，独立制作一份可本地运行的对话主导静态页面。页面需要体现你对参考的选择、拒绝和重新组织，禁止拼贴四家产品或复刻任何完整布局。

必须按顺序完整读取：
1. H:\jarvis-agent\AGENTS.md
2. H:\jarvis-agent\PRODUCT.md
3. H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\BRIEF.md
4. H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\round-2\reference-pack\REFERENCE-PACKET.md
5. H:\jarvis-agent\prototypes\gui-mvp-reboot\benchmarks\round-2\reference-pack\READ-RECEIPT-TEMPLATE.md

独立性边界：
- 禁止读取 conversation-first、task-first、artifact-first、shared 和任何既有 screenshots。
- 禁止读取 benchmarks 下的 Round 1 页面。
- 禁止读取 Round 2 其他参赛目录。
- 不参考 Codex 页面，也不读取其他 Agent 的页面或设计说明。
- 只出一份完成稿，不扩展成三个视觉方向。

Stage 1 · 参考回执：
- 编码前先在你的目录创建 REFERENCE-READ.md。
- 按模板逐卡填写实际打开来源、吸收点、拒绝点和 Jarvis 转译动作。
- 有 Browser 时打开固定截图或源码；无法打开时诚实写 packet-only。
- 回执完成前禁止创建 index.html、style.css 或 app.js。

Stage 2 · v0：
- 原生 HTML/CSS/JavaScript，无依赖、无 CDN、无远端页面资源。
- 页面根元素添加 data-author="<AGENT>" 和 data-round="2"。
- 只更新页面内存中的模拟状态；禁止 fetch、EventSource、WebSocket 和 Jarvis API。
- 对话保持主要阅读路径，首屏回答目标、阶段、停下原因、用户动作和完成授权。
- 严格使用 Brief 的文件路径：
  src/surfaces/gui/assets/presentation.js
  test/surfaces/gui/gui-presentation.test.js
- 覆盖消息、Reasoning、工具、审批、Artifact/Diff、测试、未验证项、完成与失败。
- 提供允许一次、拒绝、要求调整，以及暂停、继续、终止、恢复。
- 使用统一 motion token，支持 prefers-reduced-motion 和可见键盘焦点。

Stage 3 · 真实视觉回路：
- 优先复用 http://127.0.0.1:4327/；禁止扫描端口或重复启动第二个服务。
- 在 1440×900 与 1280×800 生成 v0 截图，保存到你的目录 screenshots/v0-<viewport>.png。
- 若当前 Browser 不可用，写明“未执行视觉验收”，禁止声称通过。
- 基于截图从以下五项自评：产品契合、视觉层级、工艺质量、交互可达、原创性。
- 至少指出 3 个具体问题；完成一轮因果修正，不允许只改配色或文案。
- 把“截图问题 → 修改 → 复验结果”写进 DESIGN-NOTE.md。
- 生成 final-1440x900.png 与 final-1280x800.png；最终截图中审批和终止持续可达，页面无横向溢出。

设计底线：
- 避免通用深色控制台、紫蓝霓虹、10px 信息墙和所有内容同形卡片；若选择暗色，必须在 DESIGN-NOTE.md 说明它如何服务 Jarvis。
- 状态不能只靠颜色表达。
- 禁止人格头像、陪伴装饰、插件、多 Agent、模型路由、云协作和自我改进。
- 完成态明确显示 decideVerdict · verified（模拟）；其他状态持续显示完成授权未授予。
- 禁止编造真实测试通过、Runtime API、Session 事实或成本数据；所有演示内容标明模拟。

文件边界：
- 只写你的 Round 2 目录。
- 允许 REFERENCE-READ.md、index.html、style.css、app.js、DESIGN-NOTE.md 和 screenshots/。
- 不安装依赖，不修改仓库现有源码，不删除或移动任何文件，不执行 git commit/push。

Checks:
- 检查 HTML/JS 语法。
- 检查无远端资源和网络调用。
- 检查 reduced-motion、焦点、两档 viewport、关键交互和 console error。
- 不跑仓库全量测试或 CI。

Stop when:
同类失败达到 3 次、需要产品裁决、Browser 不可用且无法诚实继续，或遇到删除、安装、Git 历史等越界操作时停止并写明卡点。

Return:
完成后只汇报文件清单、逐卡吸收/拒绝摘要、v0 到 final 的三项主要变化、实际检查与未验证项。不要扩大范围，不要运行额外审查或 CI。
```
