# dda 跨平台 Harness Protocol 规范

版本：Harness Protocol 1.1  
状态：Phase 0.5–1 实现基线

## 1. 范围

本规范定义 HarmonyOS、Windows、Linux 客户端、Harness Core、Gateway、领域 Port 和 Adapter 之间的稳定协议。它不复制任何供应商 wire schema。Codex JSON-RPC、WebSocket framing、provider 模型字段只能出现在 `adapters/codex` 内，并在边界转换为本规范的命令、事件和结果。

协议设计目标：

- 所有操作可取消、可超时、可审计、可去重；
- 流式更新和最终结果使用同一 operation 关联；
- 错误分类独立于供应商错误码；
- 未知消息不能导致隐式状态迁移或副作用；
- 领域对象不包含 API key、bearer token、完整秘密或模型隐含思维过程。

## 2. 编码与基础类型

- 内部持久化和 Adapter 边界默认 UTF-8 JSON。
- 时间使用 Unix epoch 毫秒 `number`，同时允许在诊断导出中附加 ISO-8601 字符串。
- ID 使用不可预测的 UUIDv7/ULID 等有序唯一值，不从用户输入、路径或远端 request id 直接派生。
- Digest 使用 `sha256:<lowercase-hex>`；涉及凭据时只保存带应用密钥的 HMAC digest。
- 所有 enum 在 ArkTS 中使用显式字符串枚举，禁止业务逻辑依赖 ordinal。
- `schemaVersion` 格式为 `<major>.<minor>`；Reader 必须忽略未知的可选字段，但不得忽略未知的权限、状态或副作用事件。

## 3. 命令 envelope

UI 只能向 `HarnessFacade` 提交领域命令：

```ts
interface HarnessCommandEnvelope<T> {
  commandId: string;
  schemaVersion: string;
  kind: string;
  actorId: string;
  issuedAtMs: number;
  expectedRunVersion?: number;
  correlationId: string;
  payload: T;
  payloadDigest: string;
}
```

首版命令采用判别联合：

```ts
interface SubmitTaskPayload {
  input: string;
  workspaceId: string;
  threadId?: string;
  roleConfigId?: string;
  requestedMode: string; // READ_ONLY | CONTROLLED_WRITE
}

interface CancelRunPayload { runId: string; reason?: string; }

interface PauseRunPayload { runId: string; reason?: string; }

interface ResumeRunPayload { runId: string; expectedState: string; }

interface ResolveApprovalPayload {
  runId: string;
  approvalId: string;
  decision: string; // APPROVE_ONCE | DECLINE | CANCEL
  displayedDigest: string;
}

interface UpdateRoleConfigPayload {
  configId: string;
  expectedVersion: number;
  patch: RoleConfigPatch;
}

interface RoleConfigPatch {
  changesCanonicalJson: string;
  changesDigest: string;
}
```

规则：

- `commandId` 全局唯一，并作为幂等键；相同 ID、相同 digest 返回原结果，相同 ID、不同 digest 返回 `IDEMPOTENCY_CONFLICT`。
- 改变已有 run 的命令必须带 `expectedRunVersion`，版本不符返回 `STALE_VERSION`。
- `ResolveApproval` 必须携带 UI 实际展示内容的 digest，防止批准对象在展示后被替换。
- Facade 接收不代表操作完成；接收后先返回 `CommandReceipt`，后续状态通过事件/read model 展示。

## 4. 事件 envelope

Trajectory 的权威事件格式：

```ts
interface HarnessEventEnvelope<T> {
  eventId: string;
  schemaVersion: string;
  kind: string;
  runId: string;
  aggregateType: string;
  aggregateId: string;
  sequence: number;
  aggregateVersion: number;
  operationId?: string;
  correlationId: string;
  causationId?: string;
  actorType: string; // USER | CORE | MODEL | ADAPTER | PLUGIN | SYSTEM
  actorId: string;
  emittedAtMs: number;
  observedAtMs: number;
  payload: T;
  payloadDigest: string;
  sensitivity: string; // PUBLIC | INTERNAL | SOURCE | SENSITIVE | SECRET_REF
  protocolVersion: string;
  appVersion: string;
  storageSchemaVersion: number;
  policyVersion: string;
  producerVersion: string;
}
```

强制语义：

- `sequence` 在一个 run 内严格递增；`aggregateVersion` 在一个 aggregate 内严格递增。
- 传输允许 at-least-once，Store 以 `eventId` 去重；同一 operation 的事件按 `operationSequence`（在 payload 中）排序。
- 原始 Adapter 消息可以加密存档用于诊断，但不能直接成为 Core 的状态事件。
- 影响状态或权限的事件在成功持久化前不得驱动 UI 宣告完成。
- Agent 产生的路线、计划、动作、验证、诊断、质疑、停止或记忆决策，必须先持久化对应的 `AgentDecisionCommitted`，才能触发下游事实；模型输出本身不是已提交决策。
- 事件追加后不可修改；纠错通过 `*Corrected`、`*Revoked` 或补偿事件表达。
- 未知安全/状态事件将 run 置为 `PAUSED_UNSUPPORTED`。纯显示事件可显示为 `UnknownTimelineItem`。

首版事件族：

| 族 | 关键事件 |
| --- | --- |
| Run | `RunCreated`、`RunStateChanged`、`RunPaused`、`RunRecovered`、`RunCompleted` |
| Classification | `TaskClassified`、`RiskFlagRaised` |
| Routing | `CandidatesBuilt`、`CandidateRejected`、`RouteSelected`、`RoleBindingResolved` |
| Context | `RoleContextAllocated`、`RoleContextClosed`、`ContextIsolationViolation` |
| Model | `ModelInvocationStarted`、`ModelOutputDeltaObserved`、`ModelInvocationCompleted`、`ModelInvocationFailed` |
| Decision | `AgentDecisionProposed`、`AgentDecisionCommitted`、`AgentDecisionRejected`、`AgentDecisionRevised`、`AgentDecisionAbstained`、`DecisionOutcomeLinked` |
| Planning | `PlanCreated`、`PlanRevised`、`UserInputRequested` |
| Action | `ActionIntentProposed`、`ActionIntentRejected`、`ExecutionStarted`、`ExecutionOutputObserved`、`ExecutionCompleted` |
| Safety | `SafetyDecisionIssued`、`ApprovalRequested`、`ApprovalResolved`、`PolicyLeaseIssued`、`PolicyLeaseConsumed`、`PolicyLeaseRevoked` |
| Verification | `EvidenceRecorded`、`VerificationCompleted`、`StallDetected`、`DiagnosisRequested`、`ProbePlanRanked` |
| Memory | `MemoryProposalCreated`、`MemoryProposalVerified`、`MemoryActivated`、`MemoryRevoked` |
| Governance | `ProfileEvidenceAssigned`、`ProfileUpdated`、`PolicyTransitioned`、`EntityQuarantined` |
| System | `AdapterConnected`、`AdapterDisconnected`、`OperationRetryScheduled`、`UnsupportedInputObserved` |

### 4.1 Agent Decision 事件契约

Agent 决策的 payload 和语义以 [Agent Decision Trace 规范](./DECISION_TRACE_SPEC.md) 为权威来源，并遵循：

- `aggregateType` 固定为 `AgentDecision`，`aggregateId` 为 `decisionId`；修订创建新版本或新 decision，并使用 `supersedesDecisionId` 关联，禁止覆盖旧记录。
- `AgentDecisionProposed` 只表示候选决策已通过 schema 校验，不授权任何动作；只有 `AgentDecisionCommitted` 可成为后续 `PlanCreated`、`ActionIntentProposed`、`VerificationCompleted`、`ProbePlanRanked` 或 `MemoryProposalCreated` 的 `causationId`。
- `AgentDecisionRejected` 记录 schema、策略或协调器拒绝；`AgentDecisionAbstained` 记录信息不足、冲突或超出能力边界。
- `DecisionOutcomeLinked` 只能追加实际结果和 Credit/Blame，不得反向改写决策时可见的输入、候选、置信度或理由。
- Provider 可选 reasoning summary 只能作为 `UNVERIFIED_PROVIDER_SUMMARY` 附件保存，不能充当权限、事实、Verifier 结论或学习标签；隐藏思维链、reasoning token 和系统提示不得进入常规事件 payload。

Delta 默认只进入短期 timeline projection；需要长期保留时按固定大小或时间窗口聚合，避免每个 token 产生永久数据库行。最终文本及其 digest 必须落库。

## 5. 统一结果与错误

```ts
interface PortResult<T> {
  ok: boolean;
  value?: T;
  error?: HarnessError;
  operationId: string;
  startedAtMs: number;
  completedAtMs: number;
  evidenceEventIds: Array<string>;
}

interface HarnessError {
  code: string;
  category: string;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  providerCode?: string;
  detailsDigest?: string;
}
```

标准 category：

- `VALIDATION`：输入或 schema 无效；不重试。
- `CONFLICT`：版本、幂等或并发冲突；读取新状态后再决定。
- `UNSUPPORTED`：能力、版本或设备不支持；不能静默回退。
- `POLICY`：被策略、权限上限、审批或租约拒绝；不自动重试。
- `AUTH`：身份或凭据失效；暂停并请求重新连接。
- `TRANSIENT`：临时网络/服务错误；受预算限制重试。
- `OVERLOADED`：服务过载；指数退避加 jitter。
- `TIMEOUT`：达到 deadline；取消底层操作并进入验证/恢复。
- `CANCELLED`：用户或系统取消；不作为模型失败计入 Capability Profile。
- `PROTOCOL`：wire 消息不合规或未知关键字段；fail-closed。
- `INTERNAL`：本地不变量被破坏；隔离 run 并生成诊断包。

Adapter 必须保留 provider code 供诊断，但 Router、Safety 和 UI 只依赖标准 category/code。

## 6. 流式操作模型

不使用 `Promise<string>` 表达长操作。所有模型与执行操作使用“接收句柄 + 事件流 + 最终结果”：

```ts
interface OperationOptions {
  deadlineAtMs: number;
  cancellationTokenId: string;
  maxOutputBytes: number;
  traceId: string;
}

interface OperationHandle {
  operationId: string;
  acceptedEventId: string;
  acceptedAtMs: number;
}

interface OperationEventSink {
  onEvent(event: HarnessEventEnvelope<object>): Promise<void>;
}

interface OperationControlPort {
  cancel(operationId: string, reason: string): Promise<PortResult<void>>;
}
```

Adapter 在返回 `OperationHandle` 后才能产生对应流事件。完成事件只产生一次。底层重复完成通知由 Adapter 去重并记录诊断事件。取消是竞态操作：若完成先提交则返回完成；若取消先提交则后续迟到结果只能作为恢复证据，不能重新激活 run。

## 7. 领域 Port

### 7.1 ModelInvocationPort

```ts
interface ModelInvocationRequest {
  runId: string;
  stepId: string;
  context: RoleContextHandle;
  binding: ResolvedRoleBinding;
  input: Array<ModelInputItem>;
  inputDigest: string;
  responseContract?: JsonSchemaRef;
  options: OperationOptions;
}

interface ModelInputItem {
  type: string; // TEXT | IMAGE_REF | EVIDENCE_REF | WORKSPACE_REF
  text?: string;
  referenceId?: string;
  contentDigest: string;
  sensitivity: string;
}

interface JsonSchemaRef {
  schemaId: string;
  schemaVersion: string;
  schemaDigest: string;
}

interface ModelInvocationPort extends OperationControlPort {
  getCapabilities(): Promise<PortResult<ModelProviderCapabilities>>;
  startInvocation(
    request: ModelInvocationRequest,
    sink: OperationEventSink
  ): Promise<PortResult<OperationHandle>>;
}
```

模型输出必须标记为不可信建议。结构化输出先过 schema validator，再进入 Planner/Verifier；解析失败不能回退为可执行 shell 文本。

### 7.2 ExecutorPort

```ts
interface ExecutionRequest {
  intent: ActionIntent;
  context: RoleContextHandle;
  policyLease: PolicyLease;
  workspaceSnapshotId: string;
  options: OperationOptions;
}

interface ExecutorPort extends OperationControlPort {
  getCapabilities(): Promise<PortResult<ExecutorCapabilities>>;
  validateIntent(request: ExecutionRequest): Promise<PortResult<IntentValidation>>;
  startExecution(
    request: ExecutionRequest,
    sink: OperationEventSink
  ): Promise<PortResult<OperationHandle>>;
}
```

`validateIntent` 不产生副作用，并在 Executor 权威环境内完成路径、命令、网络和快照校验。`startExecution` 必须原子地再次校验并消费 lease；仅在客户端验证不满足安全要求。

### 7.3 WorkspacePort

```ts
interface WorkspacePort {
  getCapabilities(): Promise<PortResult<WorkspaceCapabilities>>;
  openSnapshot(workspaceId: string, scope: WorkspaceScope): Promise<PortResult<WorkspaceSnapshot>>;
  readDirectory(snapshotId: string, path: string, cursor?: string): Promise<PortResult<DirectoryPage>>;
  readFile(snapshotId: string, path: string, range?: ByteRange): Promise<PortResult<FileReadResult>>;
  search(snapshotId: string, query: WorkspaceQuery): Promise<PortResult<SearchPage>>;
  getMetadata(snapshotId: string, path: string): Promise<PortResult<WorkspaceMetadata>>;
  closeSnapshot(snapshotId: string): Promise<PortResult<void>>;
}
```

```ts
interface WorkspaceScope {
  roots: Array<string>;
  includePatterns: Array<string>;
  excludePatterns: Array<string>;
  maxFileBytes: number;
  allowSensitiveReads: boolean;
}

interface WorkspaceSnapshot {
  snapshotId: string;
  workspaceId: string;
  version: string;
  canonicalRootDigest: string;
  openedAtMs: number;
  stale: boolean;
}

interface ByteRange { offset: number; length: number; }

interface FileReadResult {
  canonicalPath: string;
  content: string;
  contentDigest: string;
  encoding: string;
  totalBytes: number;
  truncated: boolean;
  snapshotId: string;
}
```

Phase 1 只启用此只读 Port。读取返回 canonical path、内容 digest、大小、编码和 snapshot/version。大文件必须分页或范围读取。

### 7.4 ApprovalPort

```ts
interface ApprovalRequest {
  approvalId: string;
  runId: string;
  intentDigest: string;
  display: ApprovalDisplayModel;
  requiredDecision: string;
  expiresAtMs: number;
  policyVersion: string;
}

interface ApprovalPort {
  requestApproval(request: ApprovalRequest): Promise<PortResult<ApprovalReceipt>>;
  resolveApproval(
    approvalId: string,
    decision: string,
    displayedDigest: string
  ): Promise<PortResult<ApprovalResolution>>;
  cancelApproval(approvalId: string, reason: string): Promise<PortResult<void>>;
}
```

Approval 结果不等于 PolicyLease；Safety Monitor 在确认 intent、scope、版本和策略仍未变化后签发 lease。

### 7.5 RoleSessionManager 契约

```ts
interface RoleSessionManager {
  allocate(request: RoleContextRequest): Promise<PortResult<RoleContextHandle>>;
  fork(parent: RoleContextHandle, mode: string): Promise<PortResult<RoleContextHandle>>;
  interrupt(contextId: string, reason: string): Promise<PortResult<void>>;
  close(contextId: string): Promise<PortResult<void>>;
  recover(contextId: string): Promise<PortResult<RoleContextHandle>>;
}
```

默认 `DEDICATED`。`EXPLICIT_SHARED` 必须由 Router 策略声明，记录共享成员和只读/可写属性；Verifier、Council 和高风险诊断不能共享可写上下文。

## 8. 能力协商

每个 Adapter 启动时返回不可变 capability snapshot：

- Adapter ID、版本、wire schema hash、稳定/实验标记；
- 支持的模型、reasoning effort、输入模态和上下文能力；
- 支持的 thread resume/fork、stream、cancel、workspace snapshot；
- Executor 的 action type、sandbox、approval、network 和 rollback 能力；
- 最大并发、输出大小和 deadline 范围。

Router 只从 capability snapshot 构造候选。运行中能力变化先产生 `CapabilitiesChanged`，已有 run 保持原 snapshot 或安全暂停，不能悄悄切换。

## 9. Codex App Server Adapter 规范

以官方 Codex App Server 文档和目标 CLI 生成 schema 为准：

- wire 上是双向 JSON-RPC 语义，但省略 `"jsonrpc":"2.0"` 字段；
- stdio 是 JSONL，WebSocket 是“一帧一个消息”，不能在 Core 中按换行猜 framing；
- 每条连接先完成 `initialize` 请求和 `initialized` 通知；
- 默认只启用稳定 API，实验字段必须在 initialize capability 中显式协商；
- 使用目标 Codex 二进制执行 `generate-ts` 或 `generate-json-schema`，将版本、生成时间和 schema hash 固化为 fixture；
- 通过 `model/list` 发现模型，不把产品模型名称写死到核心；
- WebSocket `-32001` 过载映射为 `OVERLOADED`，按服务端建议指数退避加 jitter；
- server-initiated approval/tool request 必须关联 thread/turn/operation，并在超时或断线时 fail-closed；
- 未知 notification 原样记录为诊断事件；若可能影响状态、权限或 item 生命周期，则暂停 run。

目标版本固定格式：

```text
codexCliVersion: <exact version>
schemaSha256: <generated bundle digest>
wireProfile: codex-app-server/<version>/<transport>
experimentalCapabilities: []
```

升级 Codex 时必须重新生成 schema、运行双版本 fixture、检查枚举差异并新增 ADR 或兼容说明。不能仅修改字符串常量。

官方基线：[Codex App Server](https://developers.openai.com/codex/app-server)。

## 10. 重试、限流与背压

- 仅 `TRANSIENT`、`OVERLOADED` 且明确标记 retryable 的操作自动重试。
- 副作用操作只有在 Executor 证明“未开始执行”时才能沿用原 intent 重试；否则先进入恢复验证，并签发新 lease。
- 默认重试最多 3 次，full jitter，受 run deadline 和成本预算约束。
- EventSink 持久化队列接近上限时暂停读取或请求 Adapter 降速；不得丢弃安全、审批、完成和错误事件。
- 可丢弃/聚合的只有高频显示 delta，且必须保留最终内容和 `DeltasCompacted` 事件。
- 每个 provider、workspace、run 和 plugin 都有独立并发上限，防止一个 run 饿死全局。

## 11. 契约测试

每个 Adapter 必须通过：

1. 正常握手、能力发现、启动、流式和完成；
2. 重复、乱序、迟到、缺失完成和未知事件；
3. 取消与完成竞态；
4. 断线、恢复、过载、认证失败和 deadline；
5. 相同 command/event 去重与 digest 冲突；
6. approval 展示 digest 不一致；
7. 无 lease、过期 lease、重复 lease 和 scope 不匹配；
8. 旧 minor 事件读取和新可选字段忽略；
9. 敏感字段不进入事件、日志和支持包；
10. Adapter wire 类型无法被 Core 模块 import 的依赖检查；
11. 没有已提交 Decision 的 Agent route/intent/verdict/probe/memory 事件被拒绝，Decision outcome 不能修改 decision-time snapshot；
12. 事件、导出和支持包中不存在 prompt、reasoning token、隐藏思维链或未脱敏 provider summary。

Phase 0.5 发布要求所有固定协议 fixture 100% 通过，未知关键消息测试必须证明没有副作用。

本规范中为保持篇幅省略的分页/能力 DTO（如 `DirectoryPage`、`SearchPage`、各类 `*Capabilities`）必须在编码前以 JSON Schema 或 ArkTS 判别联合固化：包含 schema version、稳定 ID、cursor、limit、结果 digest 和明确的可选字段；不得退化为无约束 `object`/`any`。Safety 领域类型以 `SECURITY_MODEL.md` 为权威来源。
