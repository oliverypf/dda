# hmCodex 状态机规范

版本：v1.1  
状态：Phase 1 实现基线

## 1. 总则

`HarnessCoordinator` 是 `TaskRun` 状态机的唯一写入者。模型、Adapter、Plugin、UI 和 Verifier 只能提交命令或事实事件，不能直接赋值 run 状态。每次迁移必须以一个持久化事件为依据，并通过 `expectedRunVersion` 做乐观并发控制。

终态不可逆；需要继续工作时创建新的 run，并用 `causedByRunId` 关联原 run。

## 2. TaskRun 状态

```ts
enum TaskRunState {
  CREATED = 'CREATED',
  CLASSIFYING = 'CLASSIFYING',
  PRECHECKING = 'PRECHECKING',
  ROUTING = 'ROUTING',
  ALLOCATING_CONTEXTS = 'ALLOCATING_CONTEXTS',
  PLANNING = 'PLANNING',
  SAFETY_EVALUATING = 'SAFETY_EVALUATING',
  WAITING_APPROVAL = 'WAITING_APPROVAL',
  EXECUTING = 'EXECUTING',
  VERIFYING = 'VERIFYING',
  DIAGNOSING = 'DIAGNOSING',
  PAUSING = 'PAUSING',
  PAUSED = 'PAUSED',
  PAUSED_UNSUPPORTED = 'PAUSED_UNSUPPORTED',
  RECOVERING = 'RECOVERING',
  CANCELLING = 'CANCELLING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  QUARANTINED = 'QUARANTINED'
}
```

### 2.1 主路径

```text
CREATED
  → CLASSIFYING
  → PRECHECKING
  → ROUTING
  → ALLOCATING_CONTEXTS
  → PLANNING
  → SAFETY_EVALUATING
      ├─ 无副作用/只读 → EXECUTING 或 VERIFYING
      ├─ 需要确认       → WAITING_APPROVAL → SAFETY_EVALUATING
      ├─ 需要诊断       → DIAGNOSING → PLANNING
      └─ 拒绝/隔离      → FAILED 或 QUARANTINED
  → EXECUTING
  → VERIFYING
      ├─ 通过           → SUCCEEDED
      ├─ 有进展         → PLANNING
      ├─ 停滞/不确定    → DIAGNOSING → PLANNING
      ├─ 可解释失败     → FAILED
      └─ 安全事件       → QUARANTINED
```

只读 Phase 1 仍可使用 `EXECUTING` 表示 WorkspacePort 搜索/读取等无副作用操作，但 `ActionIntent.actionClass` 必须为 `READ_ONLY`，且不会签发副作用 lease。

### 2.2 迁移表

| 当前状态 | 触发事实 | 下一状态 | 必要副作用前置条件 |
| --- | --- | --- | --- |
| `CREATED` | `RunAccepted` | `CLASSIFYING` | TaskEnvelope 已持久化 |
| `CLASSIFYING` | `TaskClassified` | `PRECHECKING` | 分类 schema 有效 |
| `CLASSIFYING` | `ClassificationFailed` | `FAILED` | 重试/fallback 已耗尽 |
| `PRECHECKING` | `TaskPrecheckPassed` | `ROUTING` | 无硬拒绝 |
| `PRECHECKING` | `TaskPrecheckDenied` | `FAILED/QUARANTINED` | 记录 reason codes |
| `ROUTING` | `RouteSelected` | `ALLOCATING_CONTEXTS` | 候选均经过过滤，路由 decision 已提交 |
| `ROUTING` | `NoSafeCandidate` | `FAILED/QUARANTINED` | 区分能力缺失与安全隔离 |
| `ALLOCATING_CONTEXTS` | `RequiredContextsReady` | `PLANNING` | 绑定 snapshot 已保存 |
| `ALLOCATING_CONTEXTS` | `ContextAllocationFailed` | `ROUTING/FAILED` | 仅允许安全 fallback，预算未超限 |
| `PLANNING` | `ActionIntentProposed` | `SAFETY_EVALUATING` | intent digest 已固定，动作 decision 已提交 |
| `PLANNING` | `AnswerReadyWithoutAction` | `VERIFYING` | 有目标覆盖证据，停止/回答 decision 已提交 |
| `PLANNING` | `PlanningFailed` | `ROUTING/FAILED` | fallback 必须重新候选过滤 |
| `SAFETY_EVALUATING` | `SafetyAllowedRead` | `EXECUTING` | scope snapshot 有效 |
| `SAFETY_EVALUATING` | `ApprovalRequired` | `WAITING_APPROVAL` | approval 已持久化并展示 |
| `SAFETY_EVALUATING` | `PolicyLeaseIssued` | `EXECUTING` | 审批仍有效、租约已持久化 |
| `SAFETY_EVALUATING` | `SafetyDenied` | `FAILED/QUARANTINED` | 根据 reason/severity 决定 |
| `WAITING_APPROVAL` | `ApprovalApproved` | `SAFETY_EVALUATING` | 必须重新检查策略和 intent |
| `WAITING_APPROVAL` | `ApprovalDeclined/Expired` | `VERIFYING/FAILED` | 不得执行原 intent |
| `EXECUTING` | `ExecutionCompleted` | `VERIFYING` | execution evidence 已追加 |
| `EXECUTING` | `ExecutionFailed` | `VERIFYING` | Verifier 判断是否诊断/fail/fallback |
| `EXECUTING` | `ExecutionOutcomeUnknown` | `RECOVERING` | 立即撤销未消费 lease |
| `VERIFYING` | `VerificationPassed` | `SUCCEEDED` | 验收证据完整，Verifier decision 已提交 |
| `VERIFYING` | `VerificationContinue` | `PLANNING` | 预算未超限、有新证据，Verifier decision 已提交 |
| `VERIFYING` | `StallDetected` | `DIAGNOSING` | 记录动作指纹/缺口，Verifier decision 已提交 |
| `DIAGNOSING` | `ProbePlanRanked` | `PLANNING` | 诊断/排序 decision 已提交；Probe 仍需重新过安全链 |
| `DIAGNOSING` | `DiagnosisFailedOrBudgetExhausted` | `FAILED` | 保存未决假设和证据 |
| 任意非终态 | `PauseRequested` | `PAUSING` | 停止接收新动作 |
| `PAUSING` | `ActiveOperationsStopped` | `PAUSED` | lease 已撤销，状态已 checkpoint |
| `PAUSED` | `ResumeAccepted` | `RECOVERING` | 重新检查能力、策略、binding、snapshot |
| `PAUSED_UNSUPPORTED` | `CompatibilityRestored` | `RECOVERING` | 新 Reader/Adapter 已识别关键事件 |
| `RECOVERING` | `OutcomeReconciled` | `VERIFYING/PLANNING/PAUSED` | 永不直接恢复副作用执行 |
| `RECOVERING` | `RecoveryFailed` | `FAILED/QUARANTINED` | 保留 outcome unknown 与安全证据 |
| 任意非终态 | `CancelRequested` | `CANCELLING` | 先撤销审批/lease |
| `CANCELLING` | `CancellationSettled` | `CANCELLED` | 迟到结果只能作为证据 |
| 任意非终态 | `SecurityIncidentConfirmed` | `QUARANTINED` | 隔离主体并保存证据 |

不在表中的迁移一律非法，产生 `InvariantViolationDetected`，run 进入 `PAUSED_UNSUPPORTED` 或 `QUARANTINED`，不得猜测下一状态。

组件错误不会自动决定终态。Coordinator 先依据 `HarnessError.category`、预算、fallback 和安全等级生成上述事实事件；只有表中的事实才能迁移。特别是 `EXECUTING` 失败先进入 Verifier/Recovery，不能把“RPC 失败”解释成“副作用没有发生”。

## 3. 不变量

1. 同一 run 同时最多一个 active state。
2. 同一 workspace 同时最多一个持有可写 lease 的 ExecutionRole；只读 snapshot 可并发。
3. `EXECUTING` 中的副作用 operation 必须引用 active、未消费、未过期且 intent digest 相同的 lease。
4. `WAITING_APPROVAL` 不允许启动新的副作用；可以处理取消、断线和只读展示。
5. Verifier 不能签发 lease，Planner 不能直接调用 ExecutorPort，Adapter 不能改变 SafetyDecision。
6. `SUCCEEDED` 必须有 `VerificationPassed`；模型说“完成”不构成通过。
7. `FAILED`、`CANCELLED`、`QUARANTINED` 和 `SUCCEEDED` 不接受恢复命令。
8. 预算超限后只能进入 `VERIFYING`、`FAILED`、`PAUSED` 或 `CANCELLED`，不能继续规划或重试。
9. 所有循环必须产生新 evidence digest；重复动作达到阈值后进入 `DIAGNOSING`。
10. run 状态投影与事件不一致时，事件是权威来源，停止执行并重建投影。
11. 由 Agent 发起的状态迁移必须引用同一 run 中已提交且未被取代的 `decisionId`；`PROPOSED`、`REJECTED` 或 `ABSTAINED` 决策不能驱动迁移。
12. Agent Decision 只能解释或建议下一步，不能签发 SafetyDecision、Approval 或 PolicyLease，也不能证明自身输出正确。

### 3.1 决策提交与恢复

- Classifier、Router、PlanningRole、ExecutionRole、VerificationRole、Diagnostician、Critic/Judge/Council 和 MemoryConsolidator 的语义决策都使用 [Agent Decision Trace 规范](./DECISION_TRACE_SPEC.md)。
- `AgentDecisionCommitted` 与其结构化记录在同一事务提交；提交完成后，Coordinator 才能发布对应的 route、intent、verdict、probe 或 memory proposal。
- 决策修订不会自动回滚 run，也不会撤销已经发生的外部效果；必须创建补偿决策并重新进入合法迁移路径。
- 恢复时，没有 commit 的 `PROPOSED` 决策标记为 `INVALIDATED`，reason code 为 `INVALIDATED_BY_RECOVERY`；已 commit 但尚无 outcome 的决策保持待对账，禁止仅凭模型重放生成同一副作用。
- `DecisionOutcomeLinked` 不触发状态迁移；它只把后续执行、Verifier、用户反馈和 Credit/Blame 连接到当时的决策快照。

## 4. Step 与 Operation

一个 run 包含有序 Step。Step 状态：

```text
PROPOSED → ACCEPTED → RUNNING → COMPLETED
                    ├→ FAILED
                    ├→ CANCELLED
                    └→ OUTCOME_UNKNOWN
```

- Step 是领域计划单位；Operation 是某 Port 的一次实际调用。
- 一个 Step 可以有多个只读 operation 或受控重试，但最多一个未结算的副作用 operation。
- 重试创建新的 operationId，保留相同 stepId，并记录 retryOfOperationId。
- `OUTCOME_UNKNOWN` 不能直接重试副作用；必须先由 RecoveryVerifier 判断外部状态。

## 5. Approval 状态机

```text
REQUESTED → PRESENTED → APPROVED
                    ├→ DECLINED
                    ├→ EXPIRED
                    ├→ CANCELLED
                    └→ SUPERSEDED
```

- Approval 只能从 `PRESENTED` 解析；UI 必须回传 `displayedDigest`。
- intent、scope、工作区 snapshot、策略版本或展示内容变化时，原 Approval 变为 `SUPERSEDED`，重新申请。
- `APPROVED` 只表示用户允许 Safety Monitor 继续评估，不直接授权 Executor。
- Approval 默认一次性；任何“本会话允许”属于供应商 Adapter 的能力，也不能高于本地 PermissionCeiling。
- 终态响应重复到达时返回原结果；不同 decision 返回冲突。

## 6. PolicyLease 状态机

```text
PROPOSED → ACTIVE → CONSUMING → CONSUMED
                 ├→ REVOKED
                 └→ EXPIRED
```

- lease 在 `ACTIVE` 前必须持久化，Executor 以 compare-and-set 将其变为 `CONSUMING`。
- Executor 权威校验成功后执行动作；动作明确未启动则可回到 `ACTIVE`，否则只能进入 `CONSUMED` 或由恢复流程判定。
- `maxUses` 首版固定为 1。一个复合操作必须展开为多个 intent/lease，或声明不可分割的事务 action type。
- Pause、Cancel、策略收紧、scope 变化、上下文关闭、连接身份变化会立即 `REVOKED`。
- 过期、撤销、消费后的 lease 永不复活；重试需要新 lease。

## 7. RoleContext 状态机

```text
ALLOCATING → READY → BUSY → READY
          └→ FAILED   └→ INTERRUPTING → READY/CLOSING
READY/FAILED → CLOSING → CLOSED
```

- 同一 context 同时只有一个模型 turn；需要并行时分配独立 context 或 fork。
- `EXPLICIT_SHARED` context 必须记录成员、共享原因和 permission intersection。
- 角色切换时重新解析 binding；不能继承上一角色的模型、工具或权限默认值。
- Verifier context 默认独立，不能读取 Executor 未完成的隐藏状态，只读取已持久化证据。
- context 恢复必须验证 Adapter identity、外部 thread id 和 binding snapshot；任一变化则新建 context。

## 8. Pause、取消和超时

### Pause

Pause 是可恢复控制：停止创建新 operation，取消/中断活动模型调用，撤销未消费 lease，保存 `resumeState` 和 checkpoint。恢复时重新做 capability、策略、binding 和 workspace snapshot 检查，不直接回到 `EXECUTING`。

### Cancel

取消顺序固定：

1. 写入 `CancelRequested`；
2. 关闭新命令入口；
3. 撤销 pending Approval 和 active lease；
4. 向 Adapter 发送 cancel/interrupt；
5. 等待有界 grace period；
6. 保存迟到事件和 outcome 状态；
7. 完成 `CANCELLED`。

取消超时不代表动作未执行；涉及副作用时必须标记 `externalOutcomeUnknown=true` 并安排恢复验证。

### Timeout

- 每个 operation、step、run 和 approval 都有绝对 deadline。
- deadline 到达由系统事件触发，不依赖 UI 计时器。
- 超时先取消，再按错误类别进入 VERIFYING、RECOVERING 或 FAILED。
- 自动重试不能把 run deadline 向后延长。

## 9. 崩溃与断线恢复

应用启动恢复流程：

1. 校验数据库 schema 和最后一个完整事务；
2. 从事件重建非终态 run；
3. 将 `PLANNING/EXECUTING/WAITING_APPROVAL` 等活动状态转入 `RECOVERING`；
4. 所有未消费 lease 先撤销，所有未决 Approval 标记待重新确认；
5. 查询 Adapter operation/thread 状态；无法证明结果时标记 unknown；
6. RecoveryVerifier 比较 workspace snapshot、diff、测试和远端 item；
7. 仅恢复只读操作或重新进入 `PLANNING/SAFETY_EVALUATING`，永不直接恢复副作用执行。

断线时 UI 可以继续查看本地时间线和取消 run。重新连接后使用 capability snapshot 和事件游标补齐；没有可靠游标时读取 thread/turn 最终状态并生成 reconciliation 事件。

## 10. Coordinator 并发模型

- 每个 run 使用串行 mailbox/actor；跨 run 可以并发。
- 写命令必须带 expected version；Store 以 `(runId, aggregateVersion)` 唯一约束提交。
- 同一 workspace 的可写 lease 由独立 WorkspaceLeaseCoordinator 串行化。
- UI read model 是最终一致，不可作为执行授权来源。
- Router/Model/Verifier 的结果在进入 mailbox 时重新验证 run state；迟到结果只作为 evidence。

## 11. 测试矩阵

必须覆盖：

- 每条合法迁移和每条非法迁移；
- Approval approve/decline/expire/supersede/cancel；
- Lease consume/revoke/expire/double-consume；
- 完成与取消、断线与完成、超时与审批的竞态；
- 任意状态崩溃后的重建与恢复；
- 乱序、重复和迟到事件；
- 多 run 读取同一 workspace、两个 run 竞争写 lease；
- Verifier continue/stall/diagnose/budget exhausted；
- Agent Decision proposed/committed/rejected/abstained/revised、commit-before-transition 和恢复时 invalidation/outcome reconciliation；
- 未知关键事件进入 `PAUSED_UNSUPPORTED` 且零副作用。

属性测试应验证：终态不可离开、无 lease 无副作用、每个成功 run 有 Verifier 通过、每个副作用最多消费一个 lease、Agent 驱动迁移都可追溯到已提交 Decision、Outcome 不改变历史决策快照。
