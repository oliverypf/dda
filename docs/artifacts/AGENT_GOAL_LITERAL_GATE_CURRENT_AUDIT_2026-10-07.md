# hmCodex 前版真实工程恢复验收：2026-10-07

**本报告记录源码 9accbfdd 的阶段验收。归一化与新增功能两任务、各两轮，真实模型加真实 Jev 均成功（4/4）；随后完整 24 次客户端对照已完成：hmCodex 9/12，普通 Codex 10/12。运行时回归 648 通过、0 失败、1 项可选检查跳过，原生桌面检查 27/27 均属于当时的编译版本。后续源码已增加实际读取结果的状态表达，正在重新验收，不能沿用本报告的“当前版本”结论。整体目标保持 active。**

## 修复与证据

1. **测试准入缺当前文件。** 增加通过已有授权工作区服务收集的有界源码／测试上下文。启动快照只提供候选路径，内容重新读取；仍执行敏感路径、排除项和真实路径约束。上下文不是测试已执行的证明，也不提供租约。
2. **正常验收读取被误判重复。** 同一读取的实际输出摘要变化，或实际文件写入后的保留文件复查，现可作为新观察；同一写入周期内相同输出的重复读取、没有实际写入证据和重复副作用仍保留停滞检查。新增回归在修复前确实失败。
3. **长轨迹挤掉关键事实。** 保留早期实际失败测试、后续实际成功测试和最新写入；准入策略、调用预览和文件上下文放在证据压缩可保留的位置。恢复决策也获得实际结果，执行前拒绝提案不列为已执行测试。单条 claim 仍是有效 JSON、最多 500 字符。
4. **准入提问混合了未来结果与当前授权。** 明确区分诊断测试的预期失败、主机授权／租约与未知范围，并移除问题内重复的整份执行证据。Jev 的实际答案仍原样使用；低置信度 BLOCK 不会自动变成 ALLOW，主机硬约束和实际租约检查保留。

提问调整先经过真实归档请求诊断：正常诊断从 BLOCK 变为 REQUIRE_APPROVAL；补充范围边界后，构造的范围不明提案返回 REQUEST_EVIDENCE。归档诊断本身不算任务成功，也不算安全性认证。TypeSafe 官方建议对文字条件、间接推理和无关上下文作针对性验证，见 [Jev 1.13 已知局限](https://docs.typesafe.ai/model-jaggedness/jev-1.13)。

## 两阶段真实结果

| 诊断阶段 | 源码摘要前缀 | normalizeName | uniqueNames | 实际事实 |
|---|---|---:|---:|---|
| 文件上下文、读取观察与证据保留 | 131cda99 | 1/2 | 0/2 | 四次独立代码断言都通过；三次预置测试未实际执行，继续保留失败 |
| 澄清当前提案与授权判定 | 9accbfdd | 2/2 | 2/2 | 四次均实际执行失败测试、修复文件、执行同一测试成功并完成独立验收 |

这是不同源码的两组单方诊断，不能将结果拼成同源码对照，也不单独证明提速或省钱。前一阶段及较早完整对照的失败没有删除。

当前批次 `20261007T142807863Z-02cee6a9`，运行时摘要 `9accbfdd5d7a4843984d84072a26fcdbdbe16b8f20e2cf843ee0fdaa67057f2f`。四轮实际第一项工具均为 `node --test --test-isolation=none` 返回 exit code 1；原始进程输出分别保留 TypeError／SyntaxError 和预置文件引用。之后只修改目标文件，同一测试返回 0，独立行为、语法、测试和文件范围检查全通过。每轮实际工具链都是失败测试 → 文件 patch → 成功测试，共 12 次工具调用；84 条相关请求 claim 都是有效且有界的 JSON。

Jev 实际请求 16 次、全部成功，输入 73,394、输出 892 token，代理测量累计决策请求耗时约 16.9 秒；发布 API 价格估算为 USD 0.003082548，**不是现金账单**。语言模型 17 次请求有 16 次返回 usage，已知小计 46,626 token；完整 token 和额度总额保持 UNKNOWN。无人测试的人工时间 0 不能证明节省人工。

当前 debug exe 摘要 `d1a6760b8a040084b16c0de62d0ac02634d86126481e06bf7c3aa7a08849d516`。桌面检查包含 checkpoint 继续、必失败任务的重试升级、取消、价值摘要六项入口和 80 条历史任务滚动；其中升级仍使用本地模型服务，不能当作真实强模型升级的证据。

## 尚未完成的目标

- 本源码六任务 × 两轮 × 两客户端的 24 次对照已完成，退出码 1。hmCodex 成功 9/12、恢复 5/8；普通 Codex 成功 10/12、恢复 6/8。双方使用相同真实 Mimo 模型，hmCodex 另启用 Jev。[完整结果](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_LITERAL_GATE_PAIRED_2026-10-07.json)。
- hmCodex 两轮读取恢复均失败：缺失文件错误已经实际观察，后续 README 提案仍被要求补证据；另有一次语法修复虽然独立代码断言通过，却没有实际执行完整测试。三个失败均保留；两类工程任务较早的 4/4 不能代表全部恢复场景通过。[第一轮读取失败原始事实](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_LITERAL_GATE_PAIRED_READ_FAILURE_2026-10-07.json)。
- 还需当前源码的独立 Jev 开／关对照、真实低价／强模型升级实验，以及多文件、真实仓库构建和长任务验证。
- 完整语言模型及 Jev 收费、真实人工活动仍缺。语言模型请求可记录供应商响应标识，Jev 当前没有返回可记录的标识；这些字段不生成实际收费金额。

## 原始证据

- [当前真实四轮结果](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_LITERAL_GATE_LIVE_2026-10-07.json)与[当前机器审计](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_LITERAL_GATE_CURRENT_AUDIT_2026-10-07.json)。
- [前阶段失败与实际事实](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_ACTUAL_CONTEXT_STAGE_AUDIT_2026-10-07.json)、[提问形状诊断](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_AUTHORIZATION_SHAPE_PROBE_2026-10-07.json)、[授权边界诊断](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_JEV_AUTHORIZATION_BOUNDARY_PROBE_2026-10-07.json)。
- [完整回归](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_LITERAL_GATE_FULL_RUNTIME_2026-10-07.log)、[编译](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_LITERAL_GATE_BUILD_2026-10-07.log)、[原生桌面](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_LITERAL_GATE_NATIVE_2026-10-07.log)。
- [已完成的完整客户端对照日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_LITERAL_GATE_PAIRED_2026-10-07.log)与[验收入口说明](C:/Users/User/hmCodex-local/docs/AGENT_GOAL_TESTING.md)。
