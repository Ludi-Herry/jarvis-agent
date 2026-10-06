# Jarvis GUI · ASCII 原型与独立比稿

## 当前结论

项目已经出现过 ASCII 结构草图：

- Kimi Round 3：`benchmarks/round-3/kimi/DIRECTION-NOTE.md`，3 个高层构想。
- ZCode Round 3：`benchmarks/round-3/zcode/DIRECTION-NOTE.md`，3 个高层构想。

这些草图用于 Agent 自己选择方向，只覆盖区域拓扑。此前没有一份完整记录 Codex refined 功能、布局、状态、交互和 UI 文案的 canonical ASCII 规格。

## 本目录

```text
ascii-benchmark/
  README.md
  CODEX-ASCII-BASELINE.md      # 当前 Codex refined 的完整 ASCII 交付规格
  ASCII-COMMON-BRIEF.md        # 移除 Codex 布局答案的公共输入
  ASCII-BENCHMARK-PROMPT.md    # Kimi/ZCode 共用比稿合同
  PROMPT-KIMI.md               # 可直接粘贴
  PROMPT-ZCODE.md              # 可直接粘贴
  PRO-REVIEW-PACKET-BLIND.md   # 网页版 5.6 Sol Pro 盲评主材料
  PRO-REVIEW-PROMPT.md         # 盲评裁决 Prompt
  PRO-REVIEW-IDENTITY-KEY.md   # 身份映射，裁决前禁止粘贴
  PRO-OWNER-SIGNAL-FOLLOWUP.md # 盲评后的 Owner 信号复核
  kimi/                        # Kimi 唯一可写目录
  zcode/                       # ZCode 唯一可写目录
```

## 独立性

- `CODEX-ASCII-BASELINE.md` 用于项目留档、后续实现和最终人工比较。
- Kimi/ZCode 禁止读取 Codex ASCII 基线、现有 HTML、历史方向草图和另一家输出。
- 两家只读取 `ASCII-COMMON-BRIEF.md`、产品定义和公共外部参考包。
- 比稿只产出 Markdown ASCII，不进入 HTML、React 或 Runtime。

## 比较目标

ASCII 比稿专门回答：

1. 桌面对话产品应该怎样分配空间；
2. 对话、任务、审批和 Artifact 如何形成主次；
3. 1440 与 1280 下哪些区域常驻、折叠或切换；
4. 哪种结构最像可持续使用的 AI 对话界面。

## 网页版 Pro 裁决顺序

1. 粘贴 `PRO-REVIEW-PROMPT.md`。
2. 紧接着粘贴 `PRO-REVIEW-PACKET-BLIND.md`。
3. 等待唯一赢家裁决。
4. 再打开 `PRO-REVIEW-IDENTITY-KEY.md` 查看作者。
5. 需要加入 Ludi 已有偏好时，再粘贴 `PRO-OWNER-SIGNAL-FOLLOWUP.md`。
