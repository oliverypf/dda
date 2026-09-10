# hmCodex Agent Decision Trace 规范

版本：Decision Trace 1.0  
状态：Phase 1 实现基线

## 1. 目的

Decision Trace 记录每个 Agent 在关键决策点的可审计过程，使系统能够解释“依据什么作出什么选择”，并在获得执行和 Verifier 结果后做可靠的 Credit/Blame、离线回放和策略学习。

这里的“过程”是结构化决策轨迹，不是模型隐藏 chain-of-thought。系统记录输入事实、约束、候选、选择标准、简短理由、假设、不确定性、输出和结果；不要求、不推断、也不长期保存不可验证的逐 token 内心推理。

官方 OpenAI 模型指导建议长运行 Agent 在状态压缩中保留已完成动作、活跃假设、ID、工具结果、未决阻塞和下一目标，并通过 tracing 管理工具编排与状态。本规范把这些内容固化为 provider-neutral 的领域记录。[OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)

## 2. 记录范围

以下决策必须记录：

| 决策者 | 必记决策 |
| --- | --- |
| Classifier Agent | task class、风险标签、能力需求、低置信分类 |
| Router/Coordinator Agent | topology、角色/模型/Agent/Skill/Executor、fallback、升级/降级、预算分配 |
| PlanningRole | 计划步骤、假设、依赖、信息缺口、是否请求用户、下一目标 |
| ExecutionRole | 选择哪个只读操作或 `ActionIntent`、参数/scope、重试/停止、最小 Probe |
| VerificationRole | 证据采信/排除、verdict、置信与缺口、继续/诊断/失败/通过 |
| Diagnostician | 多假设生成、区分性证据、Probe 建议和排序输入 |
| Critic/Judge/Council | Proposal、定向质疑、反例、排序、选中/淘汰和 `ABSTAIN` |
| MemoryConsolidator | MemoryProposal、来源、冲突处理、合并/撤回建议 |

SafetyDecision、用户 Approval、PolicyLease 和确定性 RuleRouter 也要记录，但它们属于系统/策略决策，继续使用各自权威事件；Decision Trace 通过 ID 引用，不将它们伪装为 Agent 推理。

可以不记录：纯文本润色、token 级生成选择、无分支的序列化步骤、UI 渲染细节和不会影响状态/预算/权限/结果的内部实现选择。

## 3. 核心原则

1. **语义检查点，不记 token 思维。** 在产生可观察分支或动作时记录一次 Decision，不抓取隐含推理流。
2. **先记录再行动。** 可能影响状态、成本、权限或外部世界的选择，必须在下游操作前持久化 `DecisionProposed/Committed`。
3. **事实与自述分离。** Evidence、策略和实际结果是事实；模型提供的 summary/confidence 是不可信声明。
4. **候选与选择同时保存。** 至少保留被认真考虑的候选及结构化淘汰原因，不能只保存胜者。
5. **不可变修订。** 决策不覆盖；改变主意时创建新的 `COMMITTED` Decision，使用 `supersedesDecisionId` 并发布 `AgentDecisionRevised`，旧记录及其真实 Outcome 保持不变。
6. **结果后绑定。** Decision 创建时不能预写成功；Execution/Verifier 完成后追加 `DecisionOutcomeLinked`。
7. **权限不来自记录。** “理由充分”不能授予权限，仍必须经过 Safety/Approval/PolicyLease。
8. **可学习但不自我证明。** 学习使用独立 Verifier/用户/确定性结果，不使用 Agent 自评作为唯一标签。

## 4. 数据契约

### 4.1 AgentDecisionRecord

```ts
interface AgentDecisionRecord {
  decisionId: string;
  schemaVersion: string;
  runId: string;
  stepId: string;
  operationId?: string;
  parentDecisionIds: Array<string>;
  supersedesDecisionId?: string;

  agentInstanceId: string;
  role: string;
  roleContextId: string;
  bindingSnapshotId: string;
  modelInvocationId?: string;
  promptTemplateVersion?: string;

  decisionType: string;
  status: string; // PROPOSED | COMMITTED | REJECTED | ABSTAINED | INVALIDATED
  objectiveRef: string;
  constraintSnapshotId: string;
  featureSnapshotId: string;

  evidenceRefs: Array<DecisionEvidenceRef>;
  assumptions: Array<DecisionAssumption>;
  options: Array<DecisionOption>;
  selectedOptionId?: string;

  decisionSummary: string;
  selectionCriteria: Array<string>;
  reasonCodes: Array<string>;
  uncertaintyCodes: Array<string>;
  claimedConfidence?: number;

  expectedOutcome: DecisionExpectation;
  outputRefs: Array<string>;
  sensitivity: string;
  createdAtMs: number;
  committedAtMs?: number;
  recordDigest: string;
}
```

### 4.2 Evidence、Assumption 与 Option

```ts
interface DecisionEvidenceRef {
  evidenceId: string;
  eventId?: string;
  artifactDigest?: string;
  evidenceType: string;
  stance: string; // SUPPORTS | CONTRADICTS | CONTEXT | UNKNOWN
  freshnessAtMs: number;
}

interface DecisionAssumption {
  assumptionId: string;
  statement: string;
  source: string; // USER | POLICY | WORKSPACE | MODEL_INFERENCE
  testable: boolean;
  verificationRef?: string;
}

interface DecisionOption {
  optionId: string;
  actionKind: string;
  summary: string;
  requiredCapabilityIds: Array<string>;
  evidenceRefs: Array<string>;
  expectedInformationGain?: number;
  expectedQuality?: number;
  expectedCost?: number;
  expectedLatencyMs?: number;
  riskCodes: Array<string>;
  rejectionReasonCodes: Array<string>;
  outputDraftDigest?: string;
}

interface DecisionExpectation {
  successCriteriaRefs: Array<string>;
  predictedOutcomeCode: string;
  predictedProgress?: number;
  predictedCost?: number;
  predictedRiskCodes: Array<string>;
}
```

`claimedConfidence` 只表示模型自述；后续校准结果保存在 Profile/Evaluation，不回写原 Decision。

`recordDigest` 覆盖决策身份、决策时输入快照、证据、假设、候选、选择、理由和预期等不可变内容，不覆盖 `status`、`committedAtMs` 或 Outcome。生命周期由追加式 Decision 事件表达；存储中的当前 `status` 只是可从事件重建的投影。

### 4.3 DecisionOutcome

```ts
interface DecisionOutcome {
  outcomeId: string;
  decisionId: string;
  runId: string;
  status: string; // SUCCEEDED | PARTIAL | FAILED | CANCELLED | NOT_EXECUTED | UNKNOWN
  executionEventIds: Array<string>;
  verifierReportIds: Array<string>;
  userFeedbackEventIds: Array<string>;
  observedEffects: Array<string>;
  progressDelta?: number;
  qualityScore?: number;
  safetyOutcomeCodes: Array<string>;
  actualCost?: number;
  actualLatencyMs?: number;
  creditAssignments: Array<CreditAssignmentRef>;
  blameAssignments: Array<BlameAssignmentRef>;
  linkedAtMs: number;
  evaluatorVersion: string;
  outcomeDigest: string;
}
```

未执行候选没有真实 Outcome，只能用于 counterfactual/shadow 分析，不能标成失败或成功。

## 5. 决策类型

首版固定类型：

- `CLASSIFY_TASK`
- `SELECT_ROUTE`
- `RESOLVE_ROLE_BINDING`
- `CREATE_PLAN`
- `SELECT_NEXT_STEP`
- `SELECT_WORKSPACE_READ`
- `PROPOSE_ACTION_INTENT`
- `RETRY_OR_STOP`
- `FORM_HYPOTHESES`
- `SELECT_PROBE`
- `CRITIQUE_PROPOSAL`
- `RANK_PROPOSALS`
- `VERIFIER_VERDICT`
- `REQUEST_USER_INPUT`
- `ABSTAIN_OR_ESCALATE`
- `PROPOSE_MEMORY`
- `REVISE_MEMORY`

新增类型是 Protocol minor 变化。未知类型保留为只读记录；如果它关联副作用或状态迁移，run 进入 `PAUSED_UNSUPPORTED`。

## 6. 捕获流程

```text
Input/Policy/Capability/Evidence Snapshot
       │
       ▼
Model Invocation / Deterministic Agent
       │ structured DecisionProposal
       ▼
Decision Schema + Evidence Validator
       ├── invalid → DecisionRejected → reformat/fallback/stop
       ▼
DecisionProposed
       │ candidate/safety/coordinator check
       ▼
DecisionCommitted / DecisionRejected / DecisionAbstained
       │
       ├── Plan/Read/ActionIntent/Verifier/MemoryProposal
       ▼
Execution + Evidence + Verifier + User Feedback
       ▼
DecisionOutcomeLinked
       ▼
Credit/Blame → Profile/Eval/Offline Learning
```

强制步骤：

1. 调用 Agent 前保存 binding、prompt template、policy、capability、workspace、budget 和 feature snapshot ID。
2. Agent 通过结构化输出生成 `DecisionProposal`；Adapter 可附带 provider reasoning summary，但它只作为可选 `UNVERIFIED_PROVIDER_SUMMARY` artifact，不是权威记录。
3. Validator 验证 schema、option 唯一性、evidence 是否存在、输出 scope 和长度。
4. Coordinator 持久化 Decision 后才接受其计划、Verifier verdict 或 ActionIntent。
5. Safety/Router/Verifier 可以拒绝 Decision，但不能修改原记录；拒绝原因形成事件。
6. 修改选择必须新建 Decision 并引用被替代记录。
7. Outcome 由执行事实与独立 Verifier 关联，Agent 不得自行写入。

如果某模型无法稳定输出 Decision schema，该绑定降级为不可用于需要可审计决策的角色；不得从自由文本中猜测并生成虚假过程。

## 7. Decision Graph

一个 run 的 Decision Trace 是有向无环图。方向统一为“先存在的依据/对象 → 后产生的决策/结果”：parent → child、旧决策 → 修订决策、被质疑对象 → critique decision、Judge decision → selected option、Decision → artifact/outcome/credit assignment。边类型：

- `DEPENDS_ON`：使用了前一决策输出；
- `REFINES`：细化计划或假设；
- `SUPERSEDES`：替代旧决策；
- `CRITIQUES`：质疑特定 Decision/Option/Claim；
- `SELECTS`：Judge/Router 选择某 option；
- `PRODUCES`：产生 ActionIntent、PlanStep、VerifierReport 或 MemoryProposal；
- `OUTCOME_OF`：结果归属；
- `CREDIT_FOR` / `BLAME_FOR`：归因。

禁止环；检测到 parent 指向未来、环或跨 run 非授权引用时拒绝记录并暂停相关 Agent。跨 run 学习只通过脱敏 feature/evidence snapshot 引用，不直接复制另一 run 的私密记录。

## 8. 学习数据构造

训练/策略样本采用：

```text
context_features_at_decision_time
+ safe_candidate_set
+ decision_option_features
+ selected_option
+ downstream_verified_outcome
+ cost/latency/safety
+ credit/blame
```

规则：

- 只使用决策当时可见特征，防止 outcome leakage。
- 执行候选与未执行候选分开；未执行候选只能做 off-policy/counterfactual 估计，并标明估计方法。
- 用户纠正、确定性测试和独立 Verifier 优先于 Agent 自评。
- 同一根因产生的多条 Decision 防重复加权，按 run/incident 聚类。
- Model/Plugin/Prompt/Policy 版本变化后使用新 cohort，不混合信用。
- Safety hard constraints 不从数据中学习放宽；学习只优化安全集合内选择。
- 每个候选学习样本先生成版本化 eligibility assessment；身份、证据时序、feature/outcome digest、删除状态、cohort 或隐私授权不完整时不得导出。
- 在线更新前必须离线 replay、shadow、canary，并遵守 [评价与发布治理计划](./EVALUATION_PLAN.md)。

## 9. 粒度与容量

MUST 记录：改变 route/角色/模型/Skill、下一步骤、工具/ActionIntent、retry/stop、Verifier verdict、诊断假设、Council 选择、MemoryProposal 的决策。

SHOULD 记录：重要假设变化、证据被采信/排除、预算升级和用户输入请求。

MAY 省略：重复无分支的低层动作，但必须由父 Decision 的 outputRefs 覆盖。

初始限制：

- 每个 Decision 最多 8 个 option，更多候选先由确定性过滤并记录过滤统计；
- `decisionSummary` 最多 1,000 字符，option summary 最多 500 字符；
- evidence 只保存引用和最小摘要，原文在受控 artifact；
- 每个 run 默认最多 1,000 条 Decision，超限触发停滞/预算策略，不通过丢记录解决；
- 完成 run 可以生成只读 `DecisionTraceSummary`，但不能删除保留期内的原始结构化记录。

## 10. 安全与隐私

- DecisionRecord 是不可信模型输出，不拥有执行或放权能力。
- evidence 引用必须经过 scope 与访问校验，不能通过 Decision 引用读取新秘密。
- summary/assumption/option 在落库前做秘密和个人数据扫描；命中时删除内容、保留 reason code 和安全引用。
- prompt 原文、隐藏 reasoning token、provider encrypted reasoning 和系统提示不写入普通 Decision 表。
- provider reasoning summary 只有在用户/企业保留策略允许时加密保存，并明确标记为模型生成摘要；默认不用于 Credit/Blame。
- 用户可以导出/删除普通 Decision Trace；Security Audit 关联按公开保留策略处理。
- 恶意 Agent 试图伪造 evidence、outcome 或其他 Agent 身份时触发安全事件和 Profile 收紧。

## 11. UI

UI 提供“决策轨迹”视图：

- 时间/因果图展示角色、决策类型、状态和父子关系；
- 卡片展示目标、约束、证据、候选、选中项、淘汰 reason codes、假设和不确定性；
- Outcome 到达后展示预测与实际差异、Verifier、成本、Credit/Blame；
- Provider summary 与结构化事实视觉分离，并标记“模型生成摘要”；
- 默认折叠低风险细节，高风险、副作用、fallback、revised、abstained 和失败决策优先展示；
- 不使用“完整思维”“脑内过程”等误导文案。

## 12. 评价指标

- `decisionCoverage`：必须记录的关键决策中有合规记录的比例，发布目标 100%。
- `evidenceLinkRate`：有有效 evidence 引用的 Decision 比例。
- `optionCoverage`：有真实分支时保存候选和淘汰原因的比例。
- `decisionOutcomeLinkRate`：已结算 Decision 链接 Outcome 的比例。
- `decisionReversalRate`：被 supersede/reject 的比例，按原因分层。
- `repeatedBadDecisionRate`：相同失败指纹重复出现的比例。
- `confidenceCalibration`：claimed confidence 与独立 outcome 的校准，仅用于评价。
- `predictionError`：预期质量/成本/风险与实际差异。
- `creditEvidenceCoverage`：Credit/Blame 有可回放 evidence 的比例。
- `traceOverhead`：决策记录带来的 token、延迟、存储开销。

## 13. 验收测试

Phase 1 前必须验证：

1. 每类角色和关键 DecisionType 都能生成/校验/持久化/回放；
2. Decision 未持久化时 ActionIntent、Verifier verdict 和 MemoryProposal 不被接受；
3. evidence 不存在、跨 scope、被删除或 digest 不匹配时拒绝/降级；
4. revision/supersede/critique/selection/outcome 图无环且因果正确；
5. 取消、崩溃、迟到输出和重试不会重复提交 Decision；
6. Outcome 只能由 Coordinator/Verifier 事实链接，Agent 无法伪造；
7. secret、系统提示和隐藏 reasoning 不进入普通表、日志、UI 和导出；
8. 从 Decision Trace 可重建 Agent 的可观察选择序列，并关联最终结果；
9. 学习导出只包含 decision-time features，不包含未来泄漏；
10. 关闭 provider summary 后核心 Decision Trace 仍完整工作。
