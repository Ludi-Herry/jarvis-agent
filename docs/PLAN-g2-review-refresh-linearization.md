# G2.3 裁决队列刷新线性化提案

> 状态：已批准并解决。Ludi 于 2026-08-23 批准选项 A；统一 mutation barrier 随代码提交 `8dab2df` 落地，最终独立复核 `GO（P0=0 / P1=0）`。

## 触发条件

G2.3 的三轮独立复核连续发现同族问题：人工裁决写入与 1.5 秒自动轮询共享同一组 DOM 和刷新状态，却缺少“写入成功后，所有更旧读响应永久失效”的线性化边界。

1. 第一轮 `NO-GO（P0=0 / P1=3）`：编辑时冻结整队列；多个表单可遗留重复提交；每轮整块替换会丢键盘焦点，提交刷新与轮询还存在响应乱序。
2. 第二轮 `NO-GO（P0=0 / P1=1）`：POST 已成功、紧接着刷新失败时，旧表单重新启用，可重复提交同一裁决。
3. 第三轮 `NO-GO（P0=0 / P1=1）`：旧轮询 `N` 在 POST 前启动；POST 成功后刷新 `N+1` 失败；旧轮询 `N` 随后返回。当前 `appliedRefreshSequence` 没有被失败的 `N+1` 推进，旧响应仍被接受，并用旧队列重建可操作行。

当前证据保留：聚焦 4 files / 33 passed；canonical 148 files / 1684 passed / 2 skipped；typecheck、lint、build `--noEmit`、diff check 全绿；Browser 验证 6 张卡、默认展开 1 张、隐藏表单 0、相同快照跨 1.8 秒保持焦点、单表单互斥、console warning/error 0。这些绿灯没有覆盖第三轮交错时序。

## 共同 Owner 与同构绑定

共同 Owner 是 `src/surfaces/gui/assets/app.js` 的刷新时序状态：`refreshSequence`、`appliedRefreshSequence`、`refresh()` 与 mutation 后的显式 `refresh()`。

同构绑定共两处：

1. human-review：`POST /api/human-reviews/:goalId/decide` 成功后刷新 status + reviews。
2. emergency stop：`POST /api/emergency-stop` 成功后刷新 status + reviews。

两处都允许 mutation 前启动的旧 GET 在 mutation 后返回。当前序号只比较“已成功应用的读响应”，mutation 成功本身没有建立失效水位。

## 一次性解耦方案

新增一个前端纯状态函数 `advanceMutationBarrier(state)`，mutation POST 只有在服务端返回成功后调用：

1. 单调增加 `refreshSequence`，取得 mutation barrier 序号。
2. 把 `appliedRefreshSequence` 至少推进到该 barrier。
3. 清空受影响的显示快照，当前已提交行保持不可操作。
4. 启动 barrier 之后的新 refresh；其失败只影响新鲜度提示，不回滚 mutation 成功事实。
5. 任何序号低于 barrier 的在途响应都被丢弃；下一次自动轮询可继续恢复界面。

这条边界同时用于 human-review 与 emergency stop，避免为两个按钮分别追加补丁。服务端 API、JSONL、`decideVerdict`、权限闸门、Host/CSRF 防线与 `ObservationReport` 均不改。

## 迁移边界

- 只改 `src/surfaces/gui/assets/presentation.js`、`app.js` 与对应前端测试；必要的静态断言留在 `gui-assets.test.ts`。
- G2.3 已有折叠队列、单表单、草稿恢复、焦点恢复与提交状态保留，不回退。
- 不新增依赖、构建链、API、路由、map 或完成授权。
- 不提前实现 G3 的裁决历史，也不提前实现 G4 的 goal/loop 过滤。

## 必须新增的负例

1. 旧轮询 `N` 启动 → POST 成功 → barrier `N+1` → 新刷新 `N+2` 失败 → 旧轮询 `N` 返回：断言旧响应被拒，已提交行保持不可操作。
2. POST 失败：断言 barrier 不推进，表单保留可修正状态。
3. POST 成功 + 新刷新成功：断言队列以新响应替换。
4. emergency-stop 使用同一 barrier：断言 mutation 前的旧 status 无法把已急停显示回待命。
5. barrier 后下一次自动轮询成功：断言界面恢复，无永久冻结。

## 剩余选择

### A. 批准统一 mutation barrier（推荐）

按上述共同 Owner 一次修复两处绑定，完成负例、全量门禁与新一轮独立复核；GO 后提交 G2.3，再进入 G2.4。

### B. 暂停 G2.3–G2.4

保留当前未提交工作区和本提案，不继续写代码；后续单独恢复。

### C. 回退 G2.3 交互改版

需要 Ludi 另行明确授权回退精确文件；G2.2 已提交内容保持。此选项会放弃折叠队列与焦点稳定改进。

## 待裁决问题

是否批准选项 A，以统一 mutation barrier 收口 human-review 与 emergency-stop 的旧响应失效语义？

## 最终解决记录（2026-08-23）

- `advanceMutationBarrier()` 把 requested/applied 水位一起推进到 `max + 1`，human-review 与 emergency-stop 在 POST 成功后调用同一 barrier。
- `settleSequencedRefresh()` 让旧刷新无论成功、HTTP 失败、网络失败或 JSON 失败都静默失效；当前刷新错误继续可见，后续新轮询可恢复。
- 两类 mutation 共用 `commitMutationThenRefresh()`；POST 非 2xx 不建立 barrier，刷新失败不回滚“已记录”事实。
- G2.3 同时完成按 goal 折叠、单表单互斥、草稿/焦点保持、成功行防重复提交与完整目标展示。
- 聚焦 4 files / 37 passed；canonical 148 files / 1688 passed / 2 skipped；typecheck、lint、build `--noEmit`、diff check 全绿。
- Browser 1440×900 验证 6 张卡、默认展开 1 张、可见表单 0、console warning/error 0；最终复核 GO。
