# hmCodex 最新目标验收：2026-10-07

> 后续真实 Jev 开／关结果、证据边界修复及新源码验收见 [最新再验收](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_JEV_ABLATION_AUDIT_2026-10-07.md)。下面的成对结果保留其原源码归属。

> 本文保留对应源码 e3f05eae 的真实模型对照。随后补齐真实进程终止恢复并重新编译，当前源码 a51d1943 的验收见 [进程中断恢复与最新验收](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_PROCESS_INTERRUPTION_AUDIT_2026-10-07.md)。本文的真实模型结果没有重新标成新源码的结果。

**两项流程通过工程验收，固定任务与收益验证部分完成，整体目标保持 active。** 三类自动化入口已经实现，当前源码的真实同模型对照已完成；实际省钱、省人工和 Jev 加速的证据尚未闭环。按明确验收项判断，不用测试数量推算产品完成百分比。

## 三项目标

| 目标 | 最新结果 | 证据范围 |
|---|---|---|
| 中断任务从 checkpoint 继续 | 工程验收通过 | 新编译原生桌面自动点击继续；已完成步骤保留，planner 不重复，executor 推进 |
| 必失败任务经重试／升级／Jev 恢复 | 工程验收通过，真实 Jev 小样本成功 | 桌面强模型升级使用本地 fixture；真实 Mimo 加真实 Jev 恢复 2/2，决策请求 20/20 |
| 固定任务、持续指标与同模型收益对照 | 测试与指标已实现，收益验收部分完成 | 六任务、各两轮、双方共 24 次；保留失败；实际收费与人工收益未知 |

## 最新回归和滚动验收

- 运行时：629 通过，0 失败，1 项可选压力测试跳过。[日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_FINAL_FULL_RUNTIME_2026-10-07.log)。
- 脚本：46/46；桌面单元：60/60；浏览器历史和滚动：13/13。[脚本日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_FINAL_ALL_SCRIPTS_WITH_BILLING_2026-10-07.log)；[桌面日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_VALUE_DESKTOP_UNIT_2026-10-07.log)；[浏览器结果](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_VALUE_SIDEBAR_HISTORY_FINAL_2026-10-07.json)。
- 当前 Windows x64 debug 编译和一键本地验收的四个步骤全部通过；原生桌面 27/27，无跳过。覆盖 checkpoint、失败重试升级、取消、目录、文件预览、主导航和六个任务操作。[总报告](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_JEV_MERGED_VALIDATION_2026-10-07.json)。
- 原生侧栏预置 80 条持久化任务，实际滚轮到达末项且品牌与外层侧栏不移动；浏览器另外覆盖矮窗口及任务切换后的滚动。[原生截图](C:/Users/User/hmCodex-local/docs/artifacts/goal-validation-20261007T091052934Z/native-sidebar.png)。

这是上述明确场景的通过记录，不表示产品所有功能组合都已穷尽。

## 当前源码的完整真实对照

批次 20261007T092219874Z-08e88e14，任务集 3.1，实际模型 mimo-v2.6-pro，Jev 关闭。双方交替顺序，从相同独立文件开始。普通 Codex 是 codex-cli 0.155.1；成功行均核对上游响应身份。自定义 Mimo 路由不同于原生 GPT Codex，结论只适用于本实验。

| 条件 | 成功 | 恢复／机会 | 工具轮数 | 模型请求 | 累计耗时 | 总 token | 总订阅额度估算 USD |
|---|---:|---:|---:|---:|---:|---|---|
| 普通 Codex | 8/12 | 4/8 | 57 | 74 | 1539.5 秒 | UNKNOWN | UNKNOWN |
| hmCodex | 11/12 | 7/8 | 29 | 45 | 732.2 秒 | UNKNOWN | UNKNOWN |

原始 [JSON](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_CURRENT_SOURCE_PAIRED_2026-10-07.json)、[可读报告](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_CURRENT_SOURCE_PAIRED_2026-10-07.md)。实际收费双方均 UNKNOWN；无人运行的人工分钟 0 只说明没有人工接入，不证明节省人工。缺 usage 的请求不补零，下面的小计不能当总用量或据此计算完整省钱比例。

| 条件 | 有 usage 请求／全部 | 已知 token 小计 | 已知订阅额度小计 USD |
|---|---:|---:|---:|
| 普通 Codex | 67/74 | 678209 | 0.041685180 |
| hmCodex | 42/45 | 102165 | 0.021810233 |

三类工程任务是预先定义的子集，以下包括失败和耗时，不替代完整六任务结果：

| 条件 | 成功 | 恢复／机会 | 工具轮数 | 累计耗时 | 总 token | 总订阅额度估算 USD |
|---|---:|---:|---:|---:|---|---|
| 普通 Codex | 2/6 | 2/6 | 49 | 1378.8 秒 | UNKNOWN | UNKNOWN |
| hmCodex | 6/6 | 6/6 | 19 | 294.4 秒 | 75488 | 0.014905362 |

失败清单：

- 20261007T092219874Z-08e88e14/1-code-syntax-001-ordinary-codex: FAILED；未通过 actualSuccessfulTest。
- 20261007T092219874Z-08e88e14/1-code-feature-001-ordinary-codex: FAILED；未通过 correctAnswer、actualSuccessfulTest、workspaceScopeRespected。
- 20261007T092219874Z-08e88e14/2-recoverable-read-001-hmcodex-runtime: TIMED_OUT；未通过 processCompleted、agentCompleted、correctAnswer。
- 20261007T092219874Z-08e88e14/2-code-syntax-001-ordinary-codex: TIMED_OUT；未通过 processCompleted、agentCompleted、correctAnswer、actualSuccessfulTest、workspaceScopeRespected。
- 20261007T092219874Z-08e88e14/2-code-feature-001-ordinary-codex: TIMED_OUT；未通过 processCompleted、agentCompleted。

独立验收要求实际测试成功、行为断言正确和文件范围保持。内容审计 21/24 通过；其中两条已取得正确工具证据，但进程超时，仍计为失败。全部成功行均有内容证据，不能把取证成功直接当任务成功。耗时包含重试与等待，网络延迟及小样本限制归因。

额度价格依据 [OpenCode Go 官方说明](https://opencode.ai/docs/go/#usage-limits)，额度消耗不是现金账单。先前只读样本双方 6/6 时，hmCodex 虽 token 少却消耗更多额度且更慢，所以不能从 token 少直接推论省钱。[历史结果](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_PRICED_USAGE_2026-10-07.json)。

## 真实 Jev 恢复及修复

批次 20261007T090526039Z-99955e26 是真实 Mimo 加真实 Jev 的单方诊断：2/2 成功和恢复、实际内容审计 2/2；20/20 决策请求成功。它运行在隔离副本，100 个运行时源码／依赖锁文件摘要与当前主工作区一致。逐次请求、原样答案和 usage 已保存。[原始报告](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_STAGED_LIVE_JEV_VERIFIER_EVIDENCE_2026-10-07.json)。

本轮修复了决策缺少先前工具完成／失败事实，以及恢复验收缺少主机工具输出的问题。门控接收有界历史动作；只读路径经过工作区相对路径校验；验收得到有界真实工具预览，并把模型回答及工具内容作为不可信数据。新增回归检查这些证据真正进入后续门控和恢复验收。候选隔离测试修正了把 /jev 验收请求误计为执行器请求的分类，保留隔离断言。

语言模型 17,652 token、订阅额度估算 USD 0.005026077；决策输入 53599／输出 1834 token、发布 API 价格估算 USD 0.002251158。两者分开记录，实际收费均 UNKNOWN。决策价格依据 [TypeSafe 官方说明](https://typesafe.ai/blog/introducing-system-one-models-and-jev)。这证明集成可用，没有同批开关对照，尚不能证明 Jev 导致加速或省钱。

前期失败诊断仍保留在追加历史中。用户持久化配置未改，仍只有一个 Mimo Pro，Jev 未显式启用。测试使用 5000 ms 决策上限，默认 1200 ms 的生产超时及降级仍需按场景验证。

## 剩余验收

1. 改善并复测网络超时；加入真正杀进程／重启恢复、多文件改动、真实仓库构建和长任务。
2. 同一固定任务集比较真实低价／强模型角色和 Jev 开／关，验证各自贡献，计入所有分项成本及延迟。
3. 导入实际供应商收费和真实人工 START／END 活动，按成功任务核算完整成本和人工时间。接入与补录派生报告已实现，缺原始数据仍保持未知；当前浏览器账单读取因连接失败不可用。

一键入口见 [验收说明](C:/Users/User/hmCodex-local/docs/AGENT_GOAL_TESTING.md)。无需逐个点按钮。当前冻结源码 e3f05eae3507f516cbffadb31814763f04ee4a69f5d3813f0fb3033f76dbb2ea，debug exe 936b5ebcdb03c15ded97f43e1d4abd3ab2480fbbe780bbb6f60238b0e25d9580。[源码核对](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_CURRENT_SOURCE_VERIFICATION_2026-10-07.json)；[机器可读验收](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_CURRENT_AUDIT_2026-10-07.json)。
