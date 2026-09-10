# ADR-0003: 所有副作用使用一次性 PolicyLease

- Status: Accepted
- Date: 2026-08-29
- Deciders: hmCodex architecture
- Supersedes: none

## Context

任务开始时的一次风险判断无法覆盖模型在运行中生成的具体命令、路径、网络目标和环境。用户审批也可能过期、被替换或被错误复用。

## Decision

每个副作用形成不可变 `ActionIntent`，经 Runtime Safety Monitor 和必要 Approval 后签发一次性、短时、scope-bound `PolicyLease`。Executor 在权威环境中再次校验并原子消费。Approval 本身不等于授权。

## Consequences

- 安全监控贯穿运行，而非只在任务开始。
- 每个动作都有 intent/decision/approval/lease/outcome/evidence 链。
- 复合动作需要拆分或定义不可分割事务类型。
- 断线和 outcome unknown 不允许直接重试，需要恢复验证和新 lease。

## Alternatives considered

- 每个任务一个长期 token：拒绝，scope 过大且无法防止后续动作漂移。
- 仅依赖服务端审批：拒绝，无法表达本地 Router/Profile/项目策略。
- 仅客户端校验路径/命令：拒绝，客户端不是远端资源权威方。

## Verification

P0/P1 安全集覆盖 lease 伪造、过期、撤销、double spend、scope/identity/channel mismatch 和崩溃重放；未授权副作用必须为零。

