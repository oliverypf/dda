# UI 规格第 10 节：Verifier 与证据逐项验收

范围：Windows 当前源码、dist、运行时报告结构；2026-09-17。整体未通过。

> **历史审计说明**：本文保留当时 UI 规格与构建的验收结果。当前不再使用独立语义 Verifier 或 LLM-as-a-Verifier；语义判断、工具门禁和候选选择统一显示为 Jev Decision Plane，确定性检查显示为 Rule Verifier。

| 规格要求 | 当前结论 | 当前证据与剩余工作 |
|---|---|---|
| 逐项 PASS/FAIL/UNKNOWN/SKIPPED | 浏览器定向通过 | 当前任务的 verification.checks 全部展示；20 条执行测试结果通过，包含四种状态和新任务隔离。已补测 run.failed 携带检查后收到失败响应仍保留；无事件失败与持久化历史恢复尚未覆盖。 |
| 证据来源 | 部分符合 | 区分运行时规则 Verifier 报告与语义 Verifier；逐项保留 evidence 引用。具体来源系统、文件、命令关联尚未解析。 |
| 检查时间 | 缺口 | 当前协议不含逐项时间；只显示明确标注的报告接收时间，并提示缺少检查时间，不能替代规格要求。 |
| 影响 | 缺口 | 协议仅有 id/status/message/evidence，未含逐项影响等级或阻断规则；不能从文字推测。 |
| 编译/测试、静态、diff、目标覆盖、安全、过程和语义检查 | 部分符合 | 按运行时报告逐项展示，不补造未执行检查；尚未用真实项目证明每类检查都产生并正确显示。 |
| UNKNOWN 不绿色或完成 | 浏览器定向通过 | UNKNOWN/SKIPPED 卡片 PENDING、橙色边框、明确非通过解释；未知总体结果显示任务未完成。真实原生负向组合仍待验。 |
| 高风险 unknown 阻止成功 | 浏览器定向通过 | 汇总 UNKNOWN、缺失验证、required 语义 ABSTAIN 均不成功。需要当前原生失败场景及运行时独立门控证据。 |
| 语义与确定性区分 | 部分符合 | 独立的确定性验收检查区域与“语义 Verifier 证据”时间线摘要；语义摘要仍在可折叠执行过程内。 |
| 点击证据到文件/diff/命令/事件 | 缺口 | 当前仅引用文本；没有可用的解析和导航，不能把 digest 文本当证据跳转。 |
| 不展示隐藏推理 | 当前实现未新增推理输出 | 只读检查 message/evidence 和已有语义 summary；未做全部 provider 输出的安全审计。 |
| 最终成功页验收项与非阻断风险 | 部分符合 | 当前显示报告检查项，但没有独立成功页、非阻断风险分类和逐项影响。 |

## 本轮证据

- 构建通过。
- .codex-tmp/verifier-checks-20260917/results.json：20 条结果通过，longTasks=[]（一次运行，不代表长期性能）。
- verification-checks-desktop.png 与 verification-checks-mobile.png 已人工查看；列表可见，窄屏无卡片横向溢出。
- 本轮没有更改运行时验收策略。规则报告中的检查可见性已修复，不代表检查本身覆盖全部开发目标。
- 当前原生 exe 未包含逐项检查列表及上轮最后的按钮外边距修正；旧原生 7/7 不能证明新面板。


### run.failed 逐项证据保留
- 当前 runtime 的 trajectoryErrorPayload 已发送 checks，但 UI run.failed 只追加摘要；新增共享 appendVerificationChecks，将失败事件的每项状态/说明/引用保留，与成功报告采用同一面板。未知状态降为 UNKNOWN，无效对象/引用忽略，不改写成通过。
- 构建通过；verifier-failed-report-20260917 功能断言全部通过，整体因54ms长任务失败。为使失败报告进入截图视野，测试补充 scrollIntoViewIfNeeded 后运行 verifier-failed-report-visible-20260917，21条结果通过、longTasks=[]。两次证据均保留，后一结果不抹除前一性能失败。
- 已查看失败报告可见截图：FAIL与UNKNOWN卡片、原始有效引用及“任务未完成”同时存在。报告在随后ok:false响应后保留。当前原生exe仍未包含此次面板。
- 新发现待修复：已开始运行的任务在最终失败时，lastSubmitReceipt.status 被无条件置为 rejected，导致“提交被拒绝”与任务实际已执行相矛盾；失败事件和失败返回还可能产生两条错误摘要。尚未将这些问题标为解决。
