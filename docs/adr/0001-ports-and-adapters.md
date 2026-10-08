# ADR-0001: Core 只依赖领域 Port

- Status: Accepted
- Date: 2026-08-29
- Deciders: dda architecture
- Supersedes: none

## Context

当前 UI 直接依赖 `CodexSession`，而 `CodexTransport` 同时包含连接、Thread/Turn、工作区和审批。若继续扩展，该协议会进入 Router、Safety、Agent 和 UI，使更换模型、Executor 或 wire 版本需要重写核心。

## Decision

Core 只依赖 `ModelInvocationPort`、`ExecutorPort`、`WorkspacePort` 和 `ApprovalPort`。`HarnessFacade` 是 UI 唯一命令入口，UI 只读取 `HarnessReadModel`。Codex JSON-RPC、WebSocket、Thread/Turn 和 schema 留在 `CodexAppServerAdapter`；旧 `CodexSession` 只作为迁移兼容层。

## Consequences

- 可以复用现有 UI/Transport 并渐进迁移。
- Adapter 需要完成完整语义转换和契约测试。
- 某个供应商的便利字段不能直接穿透 Core。
- 新 provider/Executor 只需实现相同领域 Port。

## Alternatives considered

- 扩张 `CodexTransport` 为通用接口：拒绝，职责混合且绑定供应商生命周期。
- UI 直接订阅全部 wire 事件：拒绝，会复制状态机并产生安全竞态。

## Verification

CI 执行依赖规则：Core/Router/Safety/Agent/Verifier/UI 不得 import `adapters/codex`、JSON-RPC 或 WebSocket 类型；每个 Adapter 通过 `PROTOCOL_SPEC.md` 契约测试。

