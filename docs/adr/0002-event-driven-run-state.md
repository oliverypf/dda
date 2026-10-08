# ADR-0002: TaskRun 使用追加事件和可重建投影

- Status: Accepted
- Date: 2026-08-29
- Deciders: dda architecture
- Supersedes: none

## Context

Agent 运行包含流式输出、审批、断线、重试、Verifier、Profile 和安全治理。只保存当前状态无法解释决策、处理竞态或从崩溃恢复，也无法可靠评价 Router。

## Decision

所有影响 run、权限和评价的事实写入版本化 `HarnessEventEnvelope`。`trajectory_events` 是权威来源，`runs`、timeline 和 UI read model 是可重建投影。每个 run 使用串行 Coordinator mailbox 和乐观 aggregate version。

## Consequences

- 支持审计、回放、恢复、离线评价和 read model 重建。
- 需要事件 schema 兼容、compaction、容量和迁移治理。
- 高频 delta 必须聚合，不能把每个 token 永久保存。
- 外部副作用无法由本地事务回滚，必须使用 outcome reconciliation。

## Alternatives considered

- 仅保存最终状态：拒绝，无法恢复或 Credit/Blame。
- 保存供应商原始日志作为事实：拒绝，协议不稳定且缺少领域语义。

## Verification

状态机属性测试、重复/乱序/迟到事件测试、每个 schema 迁移和事件全量回放 checksum 必须通过。

