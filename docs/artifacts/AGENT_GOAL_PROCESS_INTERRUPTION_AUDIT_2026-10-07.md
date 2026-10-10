# hmCodex 真实进程中断恢复验收：2026-10-07

> 本文保留对应源码的历史验收。后续已完成真实 Jev 开／关对照，并修复决策证据的 500 字符截断；新源码检查与未达成项见 [再验收报告](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_JEV_ABLATION_AUDIT_2026-10-07.md)。

**本轮补齐了真实终止进程后的恢复测试，并修复两个恢复缺陷。当前工程验收通过，产品收益验证仍部分完成，整体目标保持 active。**

## 修复及实际行为

旧实现把所有 RUNNING 步骤都当成写入结果未知；即使任务始终只读，终止进程后也无法继续。现在读取旧运行的持久化 TaskRunCreated 主机事件，只有旧运行和新运行都明确受 READ_ONLY 限制，才把中断观察重新置为可执行。模型计划中的 READ 标签不提供许可；缺少或存在歧义的旧运行证据继续封锁。

恢复出可执行步骤后，协调器会先从 RECOVERING 回到 EXECUTING，再执行及验证，修复原先 RECOVERING 直接进入 VERIFYING 的非法转换。没有放宽状态机的转换规则。

四个场景真正启动子运行时，第一步成功后强制终止自己创建的进程；没有预先伪造第二步失败状态。新进程通过 resume 读取原 checkpoint：

| 场景 | 结果 |
|---|---|
| JSON 日志下中断只读任务 | 继续第二步成功，第一步不重复，planner 不重跑 |
| 实际 file.write 后终止，改为只读恢复 | 保留已写文件，未知写入步骤封锁，没有模型／工具重放 |
| 原来只读，恢复时改为受控模式 | 封锁，没有模型／工具重放 |
| SQLite 存储下中断只读任务 | 继续第二步成功，完成步骤的摘要与尝试次数保持 |

已完成步骤的输出摘要和尝试次数由持久化 PlanStepStateChanged 事件核对；实际工具输出进入后续模型请求。[四场景日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_PROCESS_INTERRUPTION_VERIFIED_2026-10-07.log)。

## 当前源码的检查

| 检查 | 结果 |
|---|---|
| 完整运行时回归 | 633 通过，0 失败，1 项可选压力测试跳过 |
| 脚本回归 | 46/46 |
| Windows x64 debug 编译 | 通过 |
| 一键恢复／Jev 回归 | 16/16 |
| 新编译程序的桌面自动操作 | 27/27，含 80 条历史任务滚动、继续、重试升级及取消 |
| 六任务各两轮的本地服务成对对照 | 双方 12/12，恢复各 8/8，内容审计 24/24 |

[完整回归](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_PROCESS_INTERRUPTION_FULL_RUNTIME_2026-10-07.log)；[脚本回归](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_PROCESS_INTERRUPTION_SCRIPTS_2026-10-07.log)；编译 [日志](C:/Users/User/hmCodex-local/docs/artifacts/goal-validation-20261007T102756538Z/build.log)；恢复 [日志](C:/Users/User/hmCodex-local/docs/artifacts/goal-validation-20261007T102756538Z/recovery-jev-runtime.log)；桌面 [日志](C:/Users/User/hmCodex-local/docs/artifacts/goal-validation-20261007T102756538Z/native-resume-retry.log)；[一键总报告](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_PROCESS_INTERRUPTION_VALIDATION_2026-10-07.json)；[固定任务结果](C:/Users/User/hmCodex-local/docs/artifacts/goal-validation-20261007T102756538Z/comparison.json)。

这批模型输出和 token 是本地 fixture，用于验收工程行为与统计流程，不能证明实际模型质量或省钱。原生桌面的模型升级也是本地服务验证。

## 与上一轮真实模型结果的关系

当前运行时摘要为 a51d19434c4cdd6676ea4aa8a25019035307deaf486a63b831977410a7b62683；与上一轮真实对照的 e3f05eae3507f516cbffadb31814763f04ee4a69f5d3813f0fb3033f76dbb2ea 相比，运行时改动仅在 index.mjs 的中断恢复衔接。本轮没有重新进行付费模型比较。

上一轮相同 Mimo 路由的实际对照仍为 hmCodex 11/12、恢复 7/8、工具轮数 29；普通 Codex CLI 8/12、恢复 4/8、工具轮数 57。真实 Mimo 加真实 Jev 的单方恢复为 2/2。它们保留在原始源码快照下，不能标成当前源码的新对照。[上一轮验收](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_CURRENT_AUDIT_2026-10-07.md)。

## 仍需完成的目标

1. 在相同冻结源码上验证真实低价／强模型路由与 Jev 开／关，计入决策延迟和所有费用分项。
2. 扩充多文件改动、真实仓库构建及长任务；继续改善网络超时可靠性。
3. 导入实际收费和真人活动记录，核算每个成功任务的完整费用与人工时间。当前缺少原始数据，仍保留未知。

三类自动化测试和指标入口已经可运行。实际收益验证不能用 fixture 的费用、无人测试的零分钟或缺 usage 请求的已知小计替代。用户配置仍未更改。

执行入口见 [验收说明](C:/Users/User/hmCodex-local/docs/AGENT_GOAL_TESTING.md)；[机器可读验收](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_PROCESS_INTERRUPTION_AUDIT_2026-10-07.json)。新 debug exe SHA-256 为 24021de73a25cf7c31b2468cf78ac28c48fe3c92c21f80c437bcd963ecc64722。
