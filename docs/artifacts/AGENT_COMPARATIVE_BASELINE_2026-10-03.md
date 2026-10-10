# Agent comparative baseline — 2026-10-03

这份报告只汇总当前仓库已有证据，不把架构字段或单元测试当成 A/B 结果。

## 已测到的数值

- 84 个任务运行记录，181 个 run，4119 个事件。
- 1128 次提交尝试全部成功，提交成功率 100%。这是 durable commit 的代理指标，不是代码任务成功率。
- 137 个决策、133 个结果、4 个未关联结果；决策结果关联率约 97.08%。
- 历史真实执行报告没有成本记录；新增本地 fixture 批次的外部 provider 费用可确定为 **$0**，本机计算成本和生产 provider 费用仍未知。

## 三个闭环状态

| 闭环 | 当前状态 | 缺失的对照 |
| --- | --- | --- |
| 代码任务 vs 普通 Codex | 已完成能力冒烟 | 更大任务集、同模型分层 |
| 普通模型 vs hmCodex | 已完成本地 fixture 批次 | 生产模型、价格表、完整普通 Codex 对照 |
| Jev 开启 vs 关闭 | 已完成成功路径和错误路径批次 | 生产模型、更大样本、普通 Codex 对照 |

## 结论

仓库历史验收记录能提供 hmCodex 的代理事实：UI 功能任务 20/20 通过；另一个真实任务先遇到可恢复工具错误，下一轮成功，人工介入为 0。新增的同题代码任务能力冒烟中，普通 Codex CLI 与 hmCodex 受控 fixture 都成功并通过 2/2 测试，返工都是 0；样本各 1 个，不能推出生产质量差异。普通模型直连批次与 hmCodex 批次各 5 次，模型 token 都是每次输入 12、输出 4，工具轮数都是 0；本机 fixture 的 provider 费用为 $0，hmCodex 平均 wall time 4941.4 ms，直连为 16.4 ms。Jev 成功路径批次中，off/on 都是 5/5，开启后平均慢 1.16%；新增错误路径批次中，两组都是 0/3，每次 1 个 `WORKSPACE_NOT_FOUND` 错误、0 次人工介入，Jev 开启平均快 14.29%，但样本小且噪声大。生产 provider 费用和本机计算成本仍未知。

批次明细见 [AGENT_CODE_TASK_AB_2026-10-03.md](AGENT_CODE_TASK_AB_2026-10-03.md)、[AGENT_MODEL_BASELINE_AB_2026-10-03.md](AGENT_MODEL_BASELINE_AB_2026-10-03.md)、[AGENT_JEV_BATCH_AB_2026-10-03.md](AGENT_JEV_BATCH_AB_2026-10-03.md) 和 [AGENT_JEV_ERROR_BATCH_AB_2026-10-03.md](AGENT_JEV_ERROR_BATCH_AB_2026-10-03.md)。

下一次实验必须为每个固定 `taskId` 记录 `condition`、状态、测试通过数、返工数、token、费用、工具轮数、错误尝试和人工介入次数，并至少让 `hmcodex` 与对照条件各执行一次。
