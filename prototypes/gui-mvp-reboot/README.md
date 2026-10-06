# GUI MVP 重启原型目录

> 阶段：`P1 CLOSED / DIRECTION SELECTED`。当前内容作为冻结方向证据，禁止被 `src/`、现有 GUI 服务或测试直接导入。

方向选择：2026-09-01，Ludi 选择“对话主导”作为共同结构方向。Codex 现稿保持冻结；Round 1/2 保存探索证据，Round 3 以拿到最好页面为目标：Kimi/ZCode 使用创意开放合同，Gemini 使用严格形态纠偏合同。

吸收迭代：2026-09-01，三方评分后保留 Codex 产品壳，吸收 Kimi 的暖纸/朱砂/字号与 ZCode 的阶段证据联动，形成 [`conversation-first-refined/`](./conversation-first-refined/)。

最终裁决：2026-09-02，ASCII 盲评首轮由 ZCode Phase Shift 小幅领先；加入唯一目标用户对完整壳层、会话连续性与空间稳定性的实际偏好后，网页版 gpt-5.6-sol Pro 返回 `UPDATED VERDICT: Candidate B`。Ludi 接受 Candidate B，即 Codex `conversation-first-refined`。完整决策见 [`docs/DECISION-gui-mvp-p1.md`](../../docs/DECISION-gui-mvp-p1.md)。

## 范围与完成条件

- 交付三份原生 HTML/CSS/JavaScript 静态原型：对话主导、任务主导、产物主导。
- 三稿共用一份模拟任务和同一组状态事实，方便直接比较信息架构。
- 每稿覆盖消息、Reasoning 摘要、工具执行、审批、完成或失败、Artifact/Diff，以及暂停、继续、终止、恢复。
- 目标视口为 1440×900 与 1280×800；急停与审批在两个视口持续可达。
- 所有写入、审批、完成和恢复只改变页面内存中的演示状态，并持续显示“静态原型”标识。

## 目录结构

```text
prototypes/gui-mvp-reboot/
  README.md                         # 本目录合同、设计读法与归档规则
  REFERENCE-REFRESH.md              # P0 一手参考快照
  shared/
    motion.css                      # 统一 motion token 与 reduced-motion 路径
    scenario.js                     # 唯一模拟任务事实
    prototype-runtime.js            # 纯前端演示状态与通用键盘/按钮行为
  conversation-first/
    index.html
    prototype.css
  conversation-first-refined/
    index.html                       # 选定方向的吸收迭代
    refined.css
    refined.js
    DESIGN-NOTE.md
    screenshots/
  ascii-benchmark/
    CODEX-ASCII-BASELINE.md          # refined 当前设计的完整 ASCII 规格
    ASCII-COMMON-BRIEF.md            # 去除 Codex 布局答案的公共输入
    ASCII-BENCHMARK-PROMPT.md        # Kimi/ZCode 共用比稿合同
    PROMPT-KIMI.md
    PROMPT-ZCODE.md
  task-first/
    index.html
    prototype.css
  artifact-first/
    index.html
    prototype.css
  screenshots/
    conversation-first-1440x900.png
    conversation-first-1280x800.png
    task-first-1440x900.png
    task-first-1280x800.png
    artifact-first-1440x900.png
    artifact-first-1280x800.png
  ACCEPTANCE.md                     # URL、视口、交互与截图验收记录
```

## 命名规则

- 方向目录固定使用 `conversation-first`、`task-first`、`artifact-first`，避免后续用“方案 A/B/C”造成沟通错位。
- 每个方向只有一个入口 `index.html`；本阶段不产生 `v2`、`final-final` 等临时命名。
- 公共文件只承载相同事实与无权威的演示行为。布局、视觉优先级和方向特有交互留在各方向目录。
- 截图名固定为 `<direction>-<width>x<height>.png`，截图内容以文件名对应的真实 viewport 为准。

## Design Read

```yaml
artifact: desktop coding-agent workspace prototypes
audience: Ludi，唯一用户与最终裁决者
mode: greenfield exploration on top of frozen Jarvis product semantics
visual-language: calm local-first workbench with explicit evidence and control
visual-variance: 8
motion-intensity: 3
information-density: 7
asset-dependence: 1
brand-fidelity: 7
```

这些刻度会直接改变产物：三稿在主视区、阅读顺序和操作落点上分叉；动效只服务状态变化与焦点反馈；界面依靠排版、状态与代码证据完成表达；Jarvis 的权限、完成授权、持久化事实和显示投影边界保持可见。

## 三稿定位

| 方向 | 主叙事 | 1 米笔记本阅读顺序 | 温度与密度 | 容量策略 |
|---|---|---|---|---|
| 对话主导 | 人与 Agent 持续协作 | 对话 → 待处理审批 → 产物摘要 | 温和、低压，中高密度 | 长过程折叠，当前消息与介入点持续可见 |
| 任务主导 | 计划、进度与当前动作 | 当前阶段 → 阻塞点 → 输入区与证据 | 冷静、操作型，高密度 | 稳定任务骨架，细节进入步骤和运行轨迹 |
| 产物主导 | Diff 与验证证据 | 变更 → 批注/审批 → 对话与运行轨迹 | 中性、审阅型，中高密度 | 中央编辑器占主要面积，过程退到侧栏 |

## Motion 规则

- 采用 `transitions-dev` 的语义时长、缓动、位移、缩放与模糊 token。
- 150ms 用于文字或按钮状态切换，250ms 用于面板与焦点移动，400ms 只用于较大区域揭示。
- Reasoning 与运行状态允许轻量 shimmer/位移；审批、急停和失败不使用庆祝性动效。
- `prefers-reduced-motion: reduce` 下关闭位移、模糊、循环 shimmer 和平滑滚动，内容顺序与可操作性保持完整。

## 归档规则

1. Ludi 选择前，三稿与六张截图视为一组冻结比较证据；不覆盖截图，不合并方向，不删除落选稿。
2. 选择结果单独追加到本文件，不回写历史判断，也不把原型状态改写成 beta 验收。
3. 进入 P2 前，经 Ludi 明确授权后，将整组证据原样移动到 `docs/archive/gui-mvp-reboot-2026-09-01/`；未授权时保持当前位置。
4. React Spike 在新的正式前端目录开始，禁止从本目录直接加载脚本或样式。可人工抄取已选方向的结构与 token，并重新接受工程验证。
5. 任何归档、移动或清理都保留 `REFERENCE-REFRESH.md`、`ACCEPTANCE.md` 与原始截图。

## 明确非目标

- 不安装依赖，不连接真实模型，不启动新 Runtime。
- 不修改 Session、权限、Goal、完成授权、EventBus 或现有 API。
- 不引入 React、assistant-ui、模型路由、插件、多 Agent、云协作、自我改进或桌面打包。
- 不删除或替换 `src/surfaces/gui/assets/`；旧 GUI 继续作为行为证据。
