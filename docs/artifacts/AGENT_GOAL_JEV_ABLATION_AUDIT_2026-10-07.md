# hmCodex 再验收与剩余目标：2026-10-07

> 后续已修复真实 Jev 工程恢复的证据缺口与错误分类，新源码语法任务 2/2、完整回归和剩余项见 [最新恢复验收](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_JEV_RECOVERY_CURRENT_AUDIT_2026-10-07.md)。本文的开／关失败保留原源码归属。

**三类自动化验收已可运行，工程主体通过；Jev 提速、真实低价路由和完整收益证据仍未达成。** 不能把通过的测试数量换算成整个产品完成百分比。

| 目标 | 当前达成情况 | 还缺什么 |
|---|---|---|
| 中断后从 checkpoint 继续 | 工程验收通过；实际终止自己启动的进程，恢复只读任务且不重跑完成步骤；未知写入仍封锁 | 更长任务、多工作区和长期故障样本 |
| 必失败任务重试／升级／Jev 后成功 | 原生桌面重试与升级、运行时恢复链通过；真实 Jev 最新选择性复测 1/2 | 工程任务的 Jev 工具准入与超时恢复；真实低价／强模型升级对照 |
| 固定任务与持续指标、普通 Codex 同模型对照 | 六任务、独立验收、源码快照、追加历史及对照入口已实现；真实对照和 Jev 开／关均已运行 | 更广的真实仓库任务、完整 usage、供应商账单及真人活动 |

## 这轮真实 Jev 开／关对照

同一 hmCodex 源码、同一 Mimo Pro 路由、每对相同初始文件，六任务各两轮并交替执行顺序。批次 20261007T110629419Z-b67a743d，运行时摘要 a51d19434c4cdd6676ea4aa8a25019035307deaf486a63b831977410a7b62683；不是普通 Codex 客户端对照。

| 条件 | 成功 | 失败恢复 | 工具轮数 | 模型请求数 | 累计耗时 |
|---|---:|---:|---:|---:|---:|
| Jev 关闭 | 12/12 | 8/8 | 28 | 47 | 577.5 秒 |
| Jev 开启 | 7/12 | 4/8 | 36 | 69 | 918.1 秒 |

开启组累计耗时约多 59%，本轮没有显示提速或成功率收益。开启组 12 个任务中 11 个实际调用 Jev，70 次请求有 50 次成功；代理测得决策请求累计 145.7 秒。全部失败保留在分配的条件内，没有删掉未激活 Jev 的失败任务。小样本、语言模型 HTTP 502 和决策请求超时限制因果归因，不能据此断言 Jev 在所有任务上无效。

两组的语言模型 usage 均不完整，完整 token 与费用仍未知；Jev 的完整 usage／费用也未知。已知 token 小计与订阅额度不能代替完整账单。无人运行的人工分钟 0 只表示没有接入真人。[原始对照](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_JEV_ABLATION_2026-10-07.json)；[成对摘要](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_JEV_ABLATION_2026-10-07.md)；[失败与请求边界审计](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_ABLATION_REVIEW_FACTS_2026-10-07.json)。

## 发现的缺陷、修复和单独复测

原始请求中两个 model-answer claim 在 DecisionState 边界被直接裁到 500 字符，成为不完整 JSON，且丢失实际回答中已报告的文件标记。这证明验收材料传递有缺陷，但不能解释全部失败；原请求同时存在超时和低置信度决策。

现在在边界之前生成有效的有界 JSON：保留原始长度、截断标记和文本首尾；实际工具结果保留 ok／exitCode，模型回答保留有限的反引号字面值。模型字面值仍是未可信数据，没有提高置信度、扩大 500 字符上限或绕过硬验收。

修复后运行时摘要为 3661b0be9c7a0574562d3524f9f926b08adedd8278271b73ac15f6962ee59c2d。批次 20261007T114245110Z-87c8c135 使用真实 Mimo 加真实 Jev：缺失文件恢复成功，语法修复失败，合计 1/2。读取任务的 5 条模型／工具结果 claim 都是有效 JSON 且不超过 500 字符；语法任务未完成实际成功测试，工具准入反复请求证据、低置信度与超时仍需处理。没有把独立断言正确当成完整任务成功，也没有把这批单方结果与旧源码关闭组拼成新对照。

[修复后真实复测](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_JEV_CLAIM_DIAGNOSTIC_2026-10-07.json)；[请求边界核对](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_CLAIM_DIAGNOSTIC_REVIEW_2026-10-07.json)。

## 修复后工程检查

| 检查 | 结果 |
|---|---|
| 证据边界、实际 Jev 请求、候选隔离及工具失败针对性检查 | 18/18 |
| 完整运行时回归 | 636 通过、0 失败、1 项可选压力测试跳过 |
| 本轮测试脚本回归 | 50/50 |
| Windows x64 debug 编译 | 通过 |
| 一键恢复／Jev 运行时检查 | 16/16 |
| 新编译程序原生桌面自动操作 | 27/27，包括 checkpoint 继续、失败重试升级、取消和 80 条历史任务滚动 |
| 一键本地固定任务 | 双方各 6/6、失败恢复各 4/4，内容审计 12/12；四个一键步骤全部通过 |

桌面升级与一键固定任务使用本地模型服务，证明工程行为与统计流程，不证明真实升级或收益。测试没有要求用户逐个点按钮。滚动截图也已目视核对：到达列表底部，品牌和设置栏保持位置。

[针对性日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_CLAIM_BOUNDARY_CHECKS_2026-10-07.log)；[完整运行时日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_CLAIM_FULL_RUNTIME_2026-10-07.log)；[脚本日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_ABLATION_ALL_SCRIPTS_2026-10-07.log)；[一键总报告](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_JEV_CLAIM_VALIDATION_2026-10-07.json)；[原生日志](C:/Users/User/hmCodex-local/docs/artifacts/goal-validation-20261007T114501545Z/native-resume-retry.log)；[滚动截图](C:/Users/User/hmCodex-local/docs/artifacts/goal-validation-20261007T114501545Z/native-sidebar.png)。

debug exe SHA-256：9fa428090828d1f7292d888626151396e4eb8228ba78cde7839c938ad1f44c33。收尾重新核对 101 个运行时源码／包文件，当前摘要与修复后真实诊断、一键固定任务的摘要一致。

## 达成收益目标需要的工作

1. 先解决真实 Jev 工程任务的证据请求、合法测试执行与超时恢复，再在冻结后的同一源码上重跑完整开／关和普通 Codex 对照。每个任务必须同时满足实际工具／测试及独立验收，保留失败。
2. 使用真实低价与强模型角色验证路由及升级，并加入多文件修改、真实仓库构建和长任务，衡量每个成功任务的时间与完整成本。当前用户配置只有单一模型，测试没有修改持久化配置。
3. 接入完整供应商 usage／账单和实际真人 START／END 活动，才能计算现金费用与节省的人工分钟。本轮浏览器读取计费入口未成功，没有获得账单；真人记录也尚未提供，保持未知。

上一源码的普通 Codex 同模型对照曾为 hmCodex 11/12、Codex 8/12，属于限定路由下的小样本历史证据，不能标成修复后源码的对照。[历史当前源码审计](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_CURRENT_AUDIT_2026-10-07.md)；[实际进程中断验收](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_PROCESS_INTERRUPTION_AUDIT_2026-10-07.md)。

整体目标仍为 active。[机器可读审计](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_JEV_ABLATION_AUDIT_2026-10-07.json)；运行入口、证据口径与账单导入方法见 [验收说明](C:/Users/User/hmCodex-local/docs/AGENT_GOAL_TESTING.md)。
