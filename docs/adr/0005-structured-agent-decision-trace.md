# ADR-0005: 使用结构化 Agent Decision Trace

- Status: Accepted
- Date: 2026-08-29
- Deciders: hmCodex architecture
- Supersedes: none

## Context

只记录最终答案、工具调用和 Verifier 结果，无法可靠回答某个 Agent 当时看到了什么、比较了哪些可行方案、为何选择当前步骤，也无法区分路由、规划、执行选择和验证判断各自造成的 Credit/Blame。后续 Capability Profile、Router 评价、Dreaming 和策略学习因此容易受到结果泄漏、自评偏差和不完整轨迹影响。

另一方面，保存或要求模型隐藏 chain-of-thought 不稳定、不可验证，也会扩大隐私、注入和数据保留风险。hmCodex 需要的是可审计领域事实，而不是复原模型内部逐 token 推理。

## Decision

所有影响路线、计划、下一步、工具/ActionIntent、重试/停止、Verifier verdict、诊断 Probe、Council 选择或 Memory Proposal 的 Agent 决策，都使用 provider-neutral 的结构化 `AgentDecisionRecord`：

- 保存决策时目标、约束、可见 evidence refs、假设、不确定性、候选、选择标准、选中项、简短摘要和可检验预期；
- 在下游效果前原子提交 `AgentDecisionCommitted`，未提交、被拒绝或 abstain 的记录不能驱动动作或状态迁移；
- 修改决策创建新记录并用 `supersedes` 关联，不覆盖历史；
- 执行、Verifier、用户反馈和 Credit/Blame 通过 `DecisionOutcomeLinked` 事后追加，不回写 decision-time feature snapshot；
- Provider reasoning summary 仅可作为可选、未验证、受隐私策略控制的附件，不是权限、事实、Verifier 结论或学习标签；普通记录不保存 prompt、reasoning token、系统提示或隐藏思维链。

SafetyDecision、Approval 和 PolicyLease 仍由各自权威聚合产生。Decision Trace 只能引用它们，不能替代或放宽它们。

## Consequences

- UI 可以解释 Agent 的可观察选择过程，并关联候选、证据和真实结果。
- Credit/Blame、Profile 和离线学习获得具有时间边界和版本 cohort 的样本，可检测重复坏决策与预测误差。
- Phase 1 即需要 Decision schema、验证器、存储、projection、恢复和隐私测试，增加少量模型结构化输出、延迟和存储开销。
- 不能稳定生成合规 Decision schema 的模型/Agent，不可绑定到要求可审计决策的角色。
- 该轨迹不能证明模型“真实内心原因”，产品文案必须称为结构化决策摘要。

## Alternatives considered

- 只记录最终动作和结果：拒绝，无法做角色级归因、候选比较和过程学习。
- 保存完整 chain-of-thought：拒绝，不可验证且扩大隐私、安全和供应商耦合风险。
- 任务结束后让模型回顾并补写过程：拒绝，容易事后合理化并产生 outcome leakage。
- 仅对失败任务记录：拒绝，会造成选择偏差，无法校准成功路径和 Router regret。

## Verification

以 [Agent Decision Trace 规范](../DECISION_TRACE_SPEC.md) 为准。Phase 1 必须达到 `decisionCoverage=100%`，通过 commit-before-effect、身份/scope、Decision DAG、崩溃恢复、outcome 不可回填、秘密/隐藏思维链扫描和 learning export outcome-leakage 测试；安全退化或完整性失败时样本不得进入 Profile/学习管线。
