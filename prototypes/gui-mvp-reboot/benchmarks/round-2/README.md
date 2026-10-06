# Round 2 · 统一参考增强比稿

> 状态：历史探索轮，输入包与产物保持冻结。最好页面探索已转入 [`../round-3/`](../round-3/)。

## 目录

```text
round-2/
  README.md
  ROUND-2-PROMPT.md
  PROMPT-KIMI.md
  PROMPT-ZCODE.md
  PROMPT-GEMINI.md
  reference-pack/
    REFERENCE-PACKET.md
    READ-RECEIPT-TEMPLATE.md
  kimi/            # Kimi Round 2 唯一可写目录
  zcode/           # ZCode Round 2 唯一可写目录
  gemini/          # Gemini Round 2 唯一可写目录
  screenshots/     # 主线程最终统一截图
```

## 比较问题

Round 1 观察 Agent 在无视觉参考时如何理解 Jarvis。Round 2 观察同一 Agent 能否读取证据、提炼手法、拒绝范围错位，并通过真实截图完成一次可见修正。

## 公平性

- 三家使用同一 `REFERENCE-PACKET.md`、同一模拟任务和同一验收门。
- 参赛者禁止读取 Codex 页面、Round 1 页面和其他参赛目录。
- 参考包约束产品语义与质量底线；配色、排版、构图和交互主张保持自由。
- 主线程不替参赛者润色，只修复阻断页面加载的机械错误，并保留原始证据。

## 完成证据

每家至少交付：

1. `REFERENCE-READ.md`；
2. 可运行页面；
3. v0 双视口截图；
4. 一次基于截图的自评与修正记录；
5. final 双视口截图；
6. `DESIGN-NOTE.md`。

浏览器不可用时必须明确写“未执行视觉验收”，主线程随后补做；禁止用代码检查替代截图结论。

## 粘贴入口

- Kimi：[`PROMPT-KIMI.md`](./PROMPT-KIMI.md)
- ZCode：[`PROMPT-ZCODE.md`](./PROMPT-ZCODE.md)
- Gemini：[`PROMPT-GEMINI.md`](./PROMPT-GEMINI.md)

三份入口只固定身份，完整约束统一来自 `ROUND-2-PROMPT.md`。
