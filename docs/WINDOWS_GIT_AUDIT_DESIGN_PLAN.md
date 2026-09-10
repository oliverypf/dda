# Windows Git 执行审计设计计划

版本：v1.0  
状态：纳入 Windows 全功能路线  
适用阶段：Windows Phase 1、Phase 1.5、Windows 全功能版本

## 1. 目标

为每次 Windows Agent 执行建立可查询、可验证的 Git 审计索引，用于回答：

- 模型请求了哪些操作；
- 哪个 Role、模型、Plugin 和 Executor 执行了操作；
- 当时允许的 workspace、路径、命令、网络和能力范围是什么；
- 实际观察到哪些文件、进程、网络和 Git 状态变化；
- 是否超出允许范围；
- 哪些 Approval、PolicyLease、Decision、Verifier 和 Outcome 与动作相关；
- 违规发生前后仓库和执行状态是什么。

Git 不替代 Harness Event Store。全部运行时事实的权威来源仍然是 durable Harness Event Store；Git 保存可审计的脱敏索引和不可变检查点，用于查询、交叉验证和人工审计。

## 2. 为什么不能把所有原始轨迹直接写进用户 Git

不把 prompt、模型完整输出、reasoning、凭据、完整命令环境和所有高频 delta 直接提交到用户代码仓库，原因包括：

- Git 对本地拥有者不是不可篡改存储，branch、tag、ref 和历史都可以被重写；
- Git 对象通常会长期保留，即使删除 commit 也可能通过 reflog、pack 或备份恢复；
- prompt、源码、路径、命令输出和模型输出可能包含个人数据、秘密或企业代码；
- 每个 token、heartbeat 和流式 delta 写进 Git 会造成严重的性能和存储问题；
- 自动提交会污染用户项目历史、触发 hooks、产生冲突并改变工作区语义；
- Git diff 只能说明文件状态变化，不能独立证明进程、网络、被拒绝动作和 lease 生命周期。

因此采用三层模型：

```text
Harness Event Store
  = 全部结构化运行时事实和安全事件的权威来源

Artifact/Blob Store
  = 加密或脱敏的大型证据、diff、日志和快照

Git Audit Index
  = 可查询的审计清单、digest、范围快照、证据引用和违规检查点
```

如果用户需要强不可抵赖审计，Git audit commit 必须使用 Windows 安全存储中的签名密钥，并可选地复制到独立 audit repository 或企业 WORM 存储。单一本地 Git 仓库不能被声明为绝对不可篡改审计库。

## 3. 审计边界和允许范围

每次执行开始前生成并 durable commit 一个 `ExecutionScopeSnapshot`，内容包括：

```text
runId
taskId
threadId
workspaceId
canonicalRootDigest
repositoryRootDigest
beforeHead
allowedPathRoots
allowedPathGlobs
forbiddenPathGlobs
allowedCapabilities
allowedCommands
allowedNetworkTargets
executionMode
policyVersion
bindingSnapshotDigest
approvalScopeDigest
leaseScopeDigest
decisionIds
createdAtMs
snapshotDigest
```

原始 workspace 路径、用户名、网络目标和命令正文按隐私策略脱敏；需要审计的敏感值使用 digest、HMAC ref 或加密 artifact ref。

允许范围判断必须区分：

- `requested`：模型或 Role 请求的动作；
- `approved`：用户 Approval 授权的 scope；
- `leased`：一次性 PolicyLease 实际授予的 scope；
- `executed`：Executor 实际接受并运行的动作；
- `observed`：系统从文件、进程、网络和 Git 观察到的结果。

任何一层不一致都要记录，不能只检查最后的 Git diff。

## 4. 审计事件

新增或统一以下 Harness Event：

- `ExecutionScopeSnapshotCreated`
- `ActionIntentCreated`
- `ApprovalGranted` / `ApprovalDenied` / `ApprovalExpired`
- `PolicyLeaseIssued` / `PolicyLeaseClaimed` / `PolicyLeaseConsumed` / `PolicyLeaseRevoked`
- `ExecutorActionStarted`
- `ExecutorActionCompleted`
- `ExecutorActionBlocked`
- `WorkspaceSnapshotCreated`
- `GitStateObserved`
- `GitDiffObserved`
- `ProcessObservationRecorded`
- `NetworkObservationRecorded`
- `ScopeViolationDetected`
- `UnauthorizedEffectBlocked`
- `UnauthorizedEffectObserved`
- `AuditCheckpointCreated`
- `AuditCheckpointVerified`

每个动作事件至少关联：

```text
eventId
runId
decisionId
operationId
intentId
approvalId
leaseId
actorType
actorId
modelIdentity
role
scopeSnapshotDigest
requestedDigest
executedDigest
resultDigest
observedEffectDigest
sensitivity
policyVersion
producerVersion
```

动作正文、文件内容、完整输出和凭据不进入普通事件。大证据放入加密/脱敏 artifact，并在事件中保存 `artifactId`、`artifactDigest`、范围和保留状态。

## 5. Git 审计检查点

每次 TaskRun 至少创建以下检查点：

1. `RUN_STARTED`：记录执行前 Git HEAD、工作区状态和允许范围 digest；
2. `ACTION_BOUNDARY`：每个可能改变文件或仓库状态的动作前后记录 Git 状态；
3. `RUN_TERMINAL`：记录最终 HEAD、工作区状态、diff digest、违规数量和完整性结果；
4. `RECOVERY`：崩溃、取消、超时、未知执行结果或恢复后再次记录状态；
5. `VIOLATION`：发现越界行为时立即创建安全审计检查点，并停止或隔离后续动作。

Git 检查点 manifest 建议包含：

```text
checkpointId
runId
checkpointKind
eventSequenceStart
eventSequenceEnd
beforeHead
afterHead
indexDigest
workingTreeDigest
untrackedDigest
diffDigest
allowedScopeDigest
observedActionCount
blockedActionCount
violationCount
trajectoryRootDigest
projectionChecksum
retentionUntilMs
signature
createdAtMs
```

Git 中只保存 manifest、脱敏索引和引用：

```text
refs/hmcodex/audit/<workspaceId>/<runId>/<checkpointId>
```

默认不自动提交用户工作区的业务文件。可选实现可以使用独立 audit repository；如果用户明确选择同仓库审计，则使用独立 audit ref 或 Git notes，并且不能修改用户当前分支、触发用户 hooks 或把审计对象混入业务 commit。

## 6. Git 和 Event Store 的一致性

Git checkpoint 不是新的事实源。验证流程必须反向检查：

1. checkpoint manifest 的 `eventSequenceStart/End` 在 Event Store 中存在；
2. `trajectoryRootDigest` 和 `projectionChecksum` 与 Event Store/rebuild 结果一致；
3. `beforeHead`、`afterHead` 和 diff digest 能通过 Git 状态重新计算；
4. 每个执行动作都有对应 intent、decision、approval、lease 和 outcome 关系；
5. manifest 的签名、policyVersion、scopeSnapshotDigest 和 producerVersion 有效；
6. checkpoint 不包含禁止的 prompt、reasoning、凭据、原始命令环境或未脱敏源码；
7. Git ref 不是唯一的保留手段，Event Store 删除或 tombstone 策略必须同步处理 audit artifact 和 checkpoint。

如果 Git 仓库损坏或 audit ref 丢失：

- Event Store 仍然保留事实和 digest；
- 可以通过 `audit rebuild` 重建新的 Git audit index；
- 重建结果必须标记为 `REBUILT`，不能伪装成原始 checkpoint；
- 缺少原始签名时，审计状态为 `INTEGRITY_UNKNOWN`，不能标记为已验证。

## 7. 越界行为检测

审计检查至少覆盖以下范围：

### 文件和 Git

- 规范化路径是否在允许 root 和 glob 内；
- 是否访问敏感路径、凭据目录、`.git` 内部文件或 workspace 外路径；
- 是否创建、修改、删除了未授权文件；
- 是否发生未授权的 Git add、commit、reset、checkout、branch、tag、push、hook 或 config 修改；
- 是否出现允许范围外的 diff、untracked file 或 index 改变。

### 命令和进程

- 实际 executable、参数 digest、cwd、父进程、环境 digest 是否与 lease 一致；
- 是否出现 shell escape、命令拼接、未声明 child process 或未授权长期进程；
- 是否超出 timeout、CPU、内存、输出和调用次数预算；
- 被拒绝的动作是否仍产生了文件、进程或网络效果。

### 网络

- 目标 host、port、protocol 是否在允许范围；
- DNS 解析和最终连接目标是否与 policy 一致；
- 是否发生未声明 endpoint、重定向、代理或外联；
- 本地模型 API、loopback sidecar 和外部网络必须按不同 trust class 记录。

### 状态和权限

- `requested`、`approved`、`leased`、`executed`、`observed` scope 是否完全匹配；
- 是否在 lease 过期、撤销或已消费后继续执行；
- 是否发生 Decision、Approval、PolicyLease 和 Executor actor identity 不匹配；
- 是否发生恢复重试导致重复副作用。

发现违规时：

```text
ScopeViolationDetected
  -> AuditCheckpointCreated
  -> revoke lease
  -> stop or quarantine run
  -> persist evidence digest
  -> mark run QUARANTINED/FAILED
  -> exclude learning/profile sample
```

## 8. 查询接口

Windows runtime 提供只读审计命令：

```text
runtime audit list --run-id <id>
runtime audit show --run-id <id>
runtime audit verify --run-id <id>
runtime audit diff --run-id <id>
runtime audit violations --run-id <id>
runtime audit rebuild --workspace-id <id>
runtime audit export --run-id <id>
```

输出只返回脱敏的：

- 执行时间线；
- 模型、Role、Plugin 和 Executor identity；
- requested/approved/leased/executed/observed scope；
- Git HEAD、状态和 diff digest；
- 事件 ID、Decision ID、Approval ID、Lease ID 和 evidence ref；
- 违规 reason code、状态和验证结果。

默认不返回完整 prompt、模型输出、源码或命令正文。通过 Support Bundle 或受保护导出时，用户必须明确选择额外证据范围。

## 9. 与反馈、Bayesian 和学习系统的关系

Git 审计结果是安全和执行事实，不是用户满意度。

- `ScopeViolationDetected`、`UnauthorizedEffectObserved`、秘密泄露和 audit integrity failure 立即使本次样本不可训练；
- 安全事件不能被用户高分或模型历史成功率抵消；
- 通过审计且被 Verifier 确认的结果，才可作为 objective outcome；
- Git checkpoint digest 可以作为 Decision Outcome 的 evidence ref；
- Git audit index 丢失或无法验证时，保守地暂停相关 Bayesian/Profile 更新；
- 用户反馈仍保存在 `FeedbackRegistry`，不能用 Git diff 代替用户满意度；
- Decision-time feature 只能引用决策时已经可见的 Git state digest，最终 diff 和用户反馈只能作为后续 label。

## 10. Windows 实施阶段

### G0：审计契约和范围快照

纳入 Windows 计划 W1-W2：

- 定义 `ExecutionScopeSnapshot`、audit event 和 checkpoint manifest；
- 统一 requested/approved/leased/executed/observed 语义；
- 定义敏感字段、artifact、digest、retention 和签名策略；
- 明确 Git 是审计索引，不是全部运行时事实源。

### G1：只读观察

纳入 Windows Phase 1 W3-W7：

- 在不修改工作区的条件下记录 Git HEAD、index、working tree、untracked 和 repository digest；
- 对只读工具、模型调用、workspace snapshot、Verifier 和 recovery 建立 event-to-Git 关联；
- 实现 `audit list/show/verify`；
- Git 审计故障不能影响只读任务，但必须降低审计状态并阻止不完整样本进入学习导出。

### G2：Controlled Executor 集成

纳入 Windows Phase 1.5 W8：

- Executor 动作前后采集 Git 和 workspace observation；
- 对写入、命令和网络操作进行 scope 对照；
- 越界时撤销 lease、停止或 quarantine run，并提交 violation checkpoint；
- 受控执行不自动提交用户业务文件。

### G3：Git 查询和签名检查点

纳入 Windows W9：

- 独立 audit ref 或可选独立 audit repository；
- manifest digest、签名、Event Store sequence 和 projection checksum 互相验证；
- `audit diff`、`audit violations`、`audit export` 和 Support Bundle 集成；
- 支持从 Event Store 重建 Git audit index，并标记 `REBUILT`。

### G4：Windows 全功能验收

纳入 Windows W10：

- 正常任务、取消、超时、崩溃、恢复、存储损坏、Git 损坏和 audit ref 丢失；
- 路径越界、命令越界、Git 内部修改、未声明进程、网络越界和 lease 过期；
- 用户工作区已有未提交修改、子模块、忽略文件、大小写路径和符号链接；
- Git hook、并发 Agent、外部用户修改和仓库锁冲突；
- 审计查询、签名验证、Support Bundle、删除和 retention；
- 审计违规样本不能进入 Feedback/Profile/Bayesian/Evolution 学习管线。

## 11. 必须测试

- Event Store 和 Git checkpoint 的 sequence、digest、projection checksum 一致性；
- checkpoint 幂等、重复创建、乱序、迟到、损坏和重建；
- Git commit/ref/notes 写失败时不影响权威事件提交，且状态标记为 `AUDIT_DEGRADED`；
- Git audit index 重建不伪造原始签名；
- 用户仓库已有修改不会被自动覆盖、提交或丢失；
- Agent 无法通过修改 Git metadata、hooks、index 或 `.git` 内部文件规避审计；
- workspace 外路径、敏感路径、符号链接、junction 和大小写绕过；
- shell、child process、网络 endpoint 和 redirect 越界；
- approval/lease 过期、撤销、已消费和 scope mismatch；
- 取消、超时、崩溃和恢复不会重复副作用；
- prompt、reasoning、凭据、源码正文和完整命令环境不会进入 Git manifest、普通 Trajectory、Support Bundle 或导出；
- `ScopeViolationDetected` 会撤销 lease、隔离 run 并阻止学习样本；
- Event Store 有事实但 Git index 丢失时可以重建并明确标记完整性状态。

## 12. Windows 发布门

### Phase 1：`WINDOWS_PHASE1_READ_ONLY`

- 记录只读执行轨迹和 Git 状态检查点；
- 不产生工作区写入或业务 Git commit；
- 能验证事件、Git HEAD、workspace snapshot 和 projection checksum 的关系；
- Git 审计索引只是辅助查询，不能替代 Event Store；
- 审计不完整的样本不能进入学习导出。

### Phase 1.5：`WINDOWS_PHASE1_5_CONTROLLED`

- 所有受控动作拥有完整 intent、approval、lease、executor、Git/workspace observation 和 outcome 链；
- 越界动作的未授权副作用率为零；
- 违规会在动作后续阶段被检测，且会立即停止或 quarantine；
- 审计检查点签名和 Event Store sequence 可以相互验证。

### Windows 全功能：`WINDOWS_FULL_LOCAL`

- Git audit query、verify、diff、violation、rebuild 和 export 全部可用；
- Windows 的模型反馈、Bayesian、Profile、Evolution 和审计链路完成集成；
- 完成真实仓库和长运行观察期；
- 在 Windows 全功能完成前不实现其他平台 Git 审计能力。

## 13. 关联模块

首批实现范围：

- `runtime/src/harness-event-store.mjs`
- `runtime/src/trajectory-store.mjs`
- `runtime/src/execution-state-store.mjs`
- `runtime/src/runtime-safety-monitor.mjs`
- `runtime/src/restricted-windows-executor.mjs`
- `runtime/src/controlled-tools.mjs`
- `runtime/src/decision-trace.mjs`
- `runtime/src/feedback-registry.mjs`
- `runtime/src/bayesian-assessment.mjs`
- `runtime/src/index.mjs`
- `desktop/src/services/desktopBridge.ts`
- `desktop/src/domain/models.ts`
- `desktop/src/main.ts`

实现顺序必须先完成 Event Store、ExecutionScopeSnapshot 和 commit-before-effect，再接入 Git observation 和审计查询。不能让 Git commit 成为执行成功的前提，也不能让 Git 历史替代安全 Executor 的实时边界检查。
