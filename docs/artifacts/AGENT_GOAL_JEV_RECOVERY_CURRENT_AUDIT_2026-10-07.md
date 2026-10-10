# hmCodex 真实 Jev 恢复修复验收：2026-10-07

后续完整客户端批次已结束，结果及剩余目标见 [当前再测试报告](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_CURRENT_RETEST_AUDIT_2026-10-07.md)。下文保留当时单任务诊断及启动状态，不能作为后续完整任务集通过的结论。

**当前源码的语法修复任务经真实 Mimo 加真实 Jev 两轮均成功（2/2）。工程回归通过；完整客户端对照、低价路由和收益证据仍待完成，整体目标保持 active。**

## 本轮修复

1. 工具准入原来只收到进程命令／参数摘要，无法识别语法检查或测试，也缺少主机能力配置。现在提供有界的未可信调用预览，以及登记工具、执行模式、配置能力和必须经过的主机检查。配置的能力不等于已签发的租约。
2. Jev 请求补证据的提案被记录为永久执行失败；之后代码及实际测试成功，任务仍 FAIL。现在只有主机明确标记 `invocationAttempted=false`、`gateDecision=REQUEST_EVIDENCE` 且错误码匹配的提案，才区别于实际执行失败。历史保留，只有提案不能算完成；明确 BLOCK、权限错误、实际已调用及未解决测试失败仍执行原有约束。回归在修复前确实出现两项失败。
3. 文件准入原来只有路径，无法审阅拟修改内容及此前读取结果。现在提供有界的未可信修改预览，以及此前实际返回的成功或失败工具结果；失败进程在 stdout 为空时保留 stderr。单条 JSON claim 仍不超过 500 字符，模型数据不提供权限，也没有提高其置信度。

## 真实结果与版本归属

| 阶段 | 运行时摘要前缀 | 两轮语法任务 | 原始事实 |
|---|---|---:|---|
| 增加工具意图与主机策略 | b289bab3 | 0/2 | 代码及实际测试均正确，补证据提案仍导致永久 FAIL |
| 区分执行前补证据请求 | f6f9b17a | 1/2 | 一轮完成恢复；另一轮明确 BLOCK，继续保留失败 |
| 补充修改预览与实际工具数据 | a1489aa6 | 2/2 | 两轮均实际触发预置语法失败，修复后实际测试及独立验收通过 |

三个阶段的失败与原始日志均保留。它们是不同源码上的单方诊断，不能拼成同源码的开／关对照，也不能直接将耗时变化归因于修复。

当前批次 20261007T124402967Z-d697bf7f，完整源码摘要 a1489aa65ff8bfbdf24deba355bba7d2479a113f492737a0db38d065a75a4c2a。另行核对实际原生结果：两轮第一次失败均为 `node --check tags.mjs` 返回 exit code 1 和 SyntaxError；没有把补证据拒绝或其他随机工具错误当作预置失败。两轮内容审计均通过，38 条相关请求 claim 都是有效且不超过 500 字符的 JSON。

语言模型 9 次请求均有 usage，共 25,937 token；工具轮数 7、实际工具调用 8、累计任务耗时 118.9 秒。Jev 共 10 次请求、9 次成功，一次请求失败使其完整 token 与费用保持未知。实际现金收费仍未知；无人测试的 0 分钟不能证明节省人工。

[当前真实结果](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_JEV_EDIT_CONTEXT_LIVE_2026-10-07.json)；[当前机器审计](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_JEV_RECOVERY_CURRENT_AUDIT_2026-10-07.json)；[修复前错误分类证据](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_DEFERRAL_FAILURE_AUDIT_2026-10-07.json)；[中间版本真实结果](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_DEFERRAL_LIVE_REVIEW_2026-10-07.json)。

## 当前工程检查

| 检查 | 结果 |
|---|---|
| 针对性证据、补证据恢复、规则及工具检查 | 39/39 |
| 完整运行时回归 | 643 通过、0 失败、1 项可选压力测试跳过 |
| 目标测试脚本回归 | 27/27 |
| Windows x64 debug 编译 | 通过 |
| 新编译程序原生桌面自动操作 | 27/27，包含继续、失败重试升级、取消和 80 条历史任务滚动 |

原生桌面的模型升级仍用本地模型服务，不能当作真实低价／强模型经济收益。当前一键入口增加了证据边界与补证据恢复的子进程检查。

[针对性日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_EDIT_CONTEXT_CHECKS_FINAL_2026-10-07.log)；[完整回归](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_EDIT_CONTEXT_FULL_RUNTIME_2026-10-07.log)；[脚本回归](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_RECOVERY_CURRENT_SCRIPTS_2026-10-07.log)；[编译](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_EDIT_CONTEXT_BUILD_2026-10-07.log)；[原生桌面](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_EDIT_CONTEXT_NATIVE_2026-10-07.log)；[滚动截图](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_EDIT_CONTEXT_SIDEBAR_2026-10-07.png)。

debug exe SHA-256：ad908cd1951bcec433d16416236c9ed81d690d9cf72d6c8d15db841041a3de83。

## 剩余目标

1. 冻结当前源码，完成六任务各两轮的真实普通 Codex 同模型对照和独立的 Jev 开／关对照。当前 2/2 仅是一个任务的重复诊断，不能证明完整任务集稳定或提速。
   当前源码的 24 次真实客户端对照已启动：双方使用相同 Mimo 路由，hmCodex 另启用真实 Jev。此批次还在运行，不能提前算通过；它也不能替代独立的 Jev 开／关实验。[运行日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_CURRENT_JEV_SOURCE_PAIRED_2026-10-07.log)。
2. 验证真实低价／强模型角色及升级，扩充多文件、真实仓库构建和长任务。当前用户持久化配置没有改变。
3. 接入完整供应商使用量、实际语言模型及决策收费、真实人工活动，计算每个成功任务的完整成本与人工分钟。缺失数据保持未知。

较早源码的 Jev 开／关结果仍为关闭 12/12、开启 7/12，开启组累计耗时约多 59%，不能因为本轮单方成功就删除或改写。[历史开／关审计](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_JEV_ABLATION_AUDIT_2026-10-07.md)。入口与证据规则见 [验收说明](C:/Users/User/hmCodex-local/docs/AGENT_GOAL_TESTING.md)。
