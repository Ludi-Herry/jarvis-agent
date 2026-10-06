# 对话主导三方比稿

> 状态：Round 1 盲测稿与 Round 2 参考增强稿并行保留。Codex 基准稿位于 `../conversation-first/`，不得被参赛 Agent 读取或改写。

## 参赛与目录所有权

| 参赛者 | 唯一可写目录 | 页面入口 | 设计说明 |
|---|---|---|---|
| Codex | 已冻结 `../conversation-first/` | `../conversation-first/index.html` | `../README.md` |
| Kimi | `./kimi/` | `./kimi/index.html` | `./kimi/DESIGN-NOTE.md` |
| ZCode | `./zcode/` | `./zcode/index.html` | `./zcode/DESIGN-NOTE.md` |
| Gemini | `./gemini/` | `./gemini/index.html` | `./gemini/DESIGN-NOTE.md` |

## 独立性规则

1. 两家只读取根 `AGENTS.md`、`PRODUCT.md` 和本目录 `BRIEF.md`。
2. 禁止读取 Codex 三稿、公共 scenario、既有截图和另一家参赛目录；每家从同一中性 brief 独立推导。
3. 每家最多交付 `index.html`、`style.css`、`app.js` 与 `DESIGN-NOTE.md`；不使用共享 CSS/JS。
4. 主线程只修复阻断验收的机械问题。视觉判断、信息架构和交互选择保持原作者版本，不替参赛者润色。
5. 所有截图由主线程在同一浏览器、同一服务和同一 viewport 生成，参赛者自评不计入最终验收。

## 截图命名

```text
screenshots/
  kimi-1440x900.png
  kimi-1280x800.png
  zcode-1440x900.png
  zcode-1280x800.png
```

## 收口规则

- 比稿交付只提供事实对比与各稿取舍，不自动选冠军，也不融合三稿。
- Ludi 二次选择后，才讨论所选稿的深化范围；React、assistant-ui 与 Runtime 继续冻结。

## Round 2

精选参考包、阅读回执和统一二轮 Prompt 位于 [`round-2/`](./round-2/)。Round 2 写入独立目录，禁止覆盖 Round 1；最终比较同时保留“原始理解”和“参考学习后重组”两组证据。

## Round 3 · 最好页面探索

[`round-3/`](./round-3/) 从三家空目录重新开始。Kimi/ZCode 放开结构与审美探索，Gemini 保留严格形态纠偏；Round 1/2 和 Gemini 的纠偏中间稿只保留为过程证据，不进入三家输入。Round 3 用于选页面，不用于公平评测模型。
