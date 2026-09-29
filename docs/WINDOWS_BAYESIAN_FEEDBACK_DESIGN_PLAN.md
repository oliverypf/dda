# Windows 反馈系统与 Bayesian 评分设计计划

版本：v1.0  
状态：纳入 Windows 全功能路线  
关联主计划：[Windows 全功能优先实施计划](WINDOWS_ALL_FEATURES_IMPLEMENTATION_PLAN.md)  
适用阶段：Windows Phase 1、Phase 1.5、Windows 全功能版本

## 1. 目标

在 Windows 版本中实现一个可审计的模型反馈和评分系统：

- 用户可以对任务结果进行反馈和评分；
- 系统同时保留用户反馈、Verifier 结果、确定性检查、成本、延迟和安全事件；
- 每个任务场景下分别统计每个模型、角色、Plugin 和版本的表现；
- 使用 Bayesian posterior 估计候选的成功率和不确定性；
- 后续只在已经通过安全过滤的候选集合内参与模型排序；
- 评分、后验和用户反馈不能扩大权限、绕过 Approval、PolicyLease、Verifier 或 RuntimeSafetyMonitor；
- Windows 全功能完成并实际使用稳定后，再把该能力迁移到其他平台。

## 2. 安全边界

反馈系统是观测和排序系统，不是授权系统。

固定调用顺序：

```text
TaskSafetyPrecheck
  -> CandidateSafetyFilter
  -> Feedback/Profile 查询
  -> BayesianAssessment
  -> DecisionCommitted
  -> Planner / Executor
  -> RuntimeSafetyMonitor
  -> Approval
  -> PolicyLease
  -> Executor
  -> Verifier
  -> DecisionOutcomeLinked
  -> FeedbackSubmitted
  -> Profile/Bayesian projection 更新
```

以下规则不可被反馈或 Bayesian 结果覆盖：

- 不得把 posterior 当成 `ALLOW` 条件；
- 不得将被 Safety Gate 拒绝的候选重新加入候选集合；
- 不得通过高历史评分扩大 capability、workspace scope 或 PermissionCeiling；
- 不得跳过 Approval、PolicyLease、Restricted Executor 或 Verifier；
- 不得将 Verifier `FAIL`、安全事件、秘密泄露、路径越界或未授权副作用平均化；
- 不得将 `UNKNOWN`、`CANCELLED`、`NOT_EXECUTED` 当作成功；
- 这些状态不进入 Beta-Bernoulli posterior，但评估结果必须通过 `excludedOutcomeCounts` 显式报告，禁止静默丢弃。
- 不得使用模型自报 confidence 或 reasoning summary 作为独立事实；
- 反馈系统不可直接创建 ActionIntent、Approval、PolicyLease 或 Executor operation。

## 3. 反馈事实模型

新增 provider-neutral 的 `FeedbackRegistry`。Feedback 是追加式事实，不能直接覆盖旧记录。

推荐事件：

- `FeedbackSubmitted`
- `FeedbackRevised`
- `FeedbackRetracted`
- `ModelScenarioScoreProjected`
- `BayesianAssessmentCreated`

其中前三类是权威事实；`ModelScenarioScoreProjected` 和 `BayesianAssessmentCreated` 是可从事实事件重建的派生投影或解释事件。

每条反馈至少保存：

```text
feedbackId
runId
taskId
threadId
decisionId
outcomeId
modelIdentity
role
scenarioKey
sourceType
rating
dimensions
reasonCodes
evidenceRefs
independenceGroup
submittedAtMs
recordDigest
```

`modelIdentity` 至少包含：

```text
provider
protocol
model
modelVersion
modelRegistryDigest
role
pluginVersion
```

不能只用 `model` 字符串作为模型身份。Provider、协议、模型版本、Plugin 或 Role 发生变化时，默认创建新的 candidate profile。

## 4. 场景和候选键

`scenarioKey` 不保存原始 prompt，建议由以下脱敏字段组成：

```text
taskClass
riskClass
operationClass
requiredCapabilities
workspaceCapabilityClass
platform
policyClass
```

`candidateKey` 单独标识实际候选：

```text
provider/protocol/model/version/role/pluginVersion
```

模型统计按以下粒度隔离：

```text
scenarioKey + candidateKey + policyVersion + modelRegistryDigest
```

必要时可以受控回退到：

```text
精确场景和版本
  -> taskClass + riskClass + platform
  -> 当前模型全局统计
  -> Windows baseline
  -> prior-only
```

不得直接把不同风险等级、不同 Provider、不同模型版本或不同执行边界的结果混合统计。

## 5. 反馈来源和评分维度

保留多维度数据，不立即压缩成一个不可解释的总分。

| 维度 | 主要来源 | 说明 |
| --- | --- | --- |
| `objectiveSuccess` | RuleVerifier、测试、确定性检查 | 是否完成目标 |
| `verifierPass` | 独立 Verifier | 是否通过验证 |
| `userSatisfaction` | 用户反馈 | 主观可用性 |
| `quality` | Verifier 结构化结果 | 完整性和质量 |
| `cost` | runtime 统计 | 成本排序 |
| `latency` | runtime 统计 | 速度排序 |
| `safetyIncident` | Safety Audit、Executor、PolicyLease | 硬安全信号 |

第一版用户反馈界面：

- 1-5 分；
- “结果是否可用”；
- 原因标签：错误、不完整、太慢、成本高、结果优秀、需要人工修正；
- 可选短文本，默认脱敏；
- 用户没有反馈时不记为负反馈。

1-5 分可以映射成用户满意度观测值：

```text
1 -> 0.00
2 -> 0.25
3 -> 0.50
4 -> 0.75
5 -> 1.00
```

用户满意度、客观成功率和安全状态必须分别统计，不得用一次高分抵消安全事件。

## 6. 多模型任务的归因

不能把一次任务的最终评分完整复制给所有参与模型。

- 单模型任务：最终反馈可以直接关联该模型；
- 多模型任务：保存一个 task-level feedback；
- Planner、Executor、Verifier 等角色通过 Decision Trace 和 Credit/Blame 进行局部归因；
- 每个模型只接收与自身 Role、Decision 和 evidence 有关的反馈；
- 无法可靠归因时只保留 task-level feedback，不生成模型级正向样本；
- 一个 run、一个 outcome 或一个 incident group 对同一模型最多贡献一次同类反馈。

现有 `Decision Trace`、`DecisionOutcomeLinked` 和 `Credit/Blame` 是模型级归因的基础。用户最终评分必须关联到 `runId`、`outcomeId` 和实际参与模型，而不能只关联 UI 当前选中的模型。

## 7. Bayesian 统计模型

第一版只使用 Beta-Bernoulli，不实现在线 Bayesian Bandit、Thompson Sampling 或复杂 Bayesian Network。

对于二元目标：

```text
prior:       Beta(alpha0, beta0)
posterior:   Beta(alpha0 + success, beta0 + failure)
mean:        alpha / (alpha + beta)
```

第一版分别维护：

```text
P(objectiveSuccess | model, scenario)
P(verifierPass | model, scenario)
P(userSatisfaction | model, scenario)
```

每个 posterior 保存：

```text
alpha
beta
mean
lowerCredibleBound
upperCredibleBound
effectiveSampleCount
evidenceRefs
scenarioKey
candidateKey
posteriorVersion
priorOnly
uncertaintyCodes
```

默认新候选使用 `Beta(1, 1)`，但必须标记为 `PRIOR_ONLY`。`Beta(1, 1)` 不是默认安全，也不能作为高风险自动放行依据。

第一版排序使用可信区间和不确定性惩罚，而不是只使用平均值：

```text
rankScore =
  objectiveLowerBound
  + satisfactionWeight * satisfactionMean
  - uncertaintyPenalty
  - costPenalty
  - latencyPenalty
```

该分数只能用于已经通过 `CandidateSafetyFilter` 的候选。

## 8. Evidence 和数据泄漏规则

客观成功、Verifier 通过和安全状态只能由独立事实更新。可接受的证据来源包括：

1. RuntimeSafetyMonitor、Approval、PolicyLease、Executor 和 Security Audit；
2. RuleVerifier 的确定性检查、scope、diff、artifact 和测试结果；
3. Jev Decision Plane 的结构化判断与 Rule Verifier 的确定性结果；
4. 明确的用户接受、拒绝或修正反馈。

以下内容不能作为独立成功证据：

- Agent 自报 confidence；
- Provider reasoning summary；
- 模型自己声称“任务完成”；
- 没有独立检查支撑的 caller-provided quality；
- 将同一 Outcome 的多个摘要重复计权。

`DecisionCommitted` 时冻结：

- task/risk class；
- candidate set；
- model、role、Plugin 和 binding snapshot；
- policy/capability snapshot；
- baseline digest；
- 当时已经可见的 evidence；
- posterior alpha/beta、样本量和可信区间；
- feature snapshot digest。

最终 Verifier、用户反馈、最终成本、后续安全事件和后续 route 只能作为 label，不能回写 decision-time feature。

## 9. Windows 计划中的实施阶段

### F0：反馈契约和事件

纳入主计划 W4 的 Decision Trace 工作：

- 定义 Feedback schema、source type、scenario key 和 candidate key；
- 将 FeedbackSubmitted 关联到 run、decision、outcome 和 model identity；
- 实现 append-only、幂等、撤回和修订事件；
- 禁止保存 prompt 原文、完整模型输出、reasoning 和凭据。

### F1：Windows 反馈采集

纳入主计划 W6/W7：

- 在任务结果和 Verifier 完成后提供用户评分入口；
- 采集 1-5 分、可用性和原因标签；
- 客观 Verifier 结果和用户反馈分开保存；
- 反馈提交失败不能影响当前 TaskRun 结果；
- 一个用户对同一 run 的重复提交使用幂等或追加修订，不重复计权。

### F2：模型-场景评分投影

新增 `ModelScenarioProfile` 派生投影：

- 按场景、模型、Role、版本和 Plugin 聚合；
- 保存 objective、verifier、satisfaction、cost、latency 和 safety 维度；
- 保存样本数、时间窗口、独立事件数、版本和证据引用；
- 支持从 Event Store 全量重建；
- 不让桌面 UI 成为统计事实源。

### F3：Bayesian shadow

纳入主计划 W4/W5/W7：

- 新增 `runtime/src/bayesian-assessment.mjs`；
- 实现 Beta posterior、可信区间、prior-only、样本去重和 cohort 隔离；
- 对当前 RuleRouter 生成 shadow 排序；
- 实际运行仍使用静态 Router；
- 对比 B1/B2 baseline 的 Brier score、ECE、shadow regret、成本和延迟；
- 记录 `posteriorVersion`、dataset digest 和 evidence window。

### F4：安全候选内部排序

纳入主计划 W8/W9：

- Phase 1.5 安全门通过后，Bayesian 才能影响安全候选内部排序；
- 不改变候选过滤、权限上限、Approval、PolicyLease 或 Verifier；
- 模型切换、版本变化、Plugin 变化或 snapshot 过期时必须重新过滤并创建新的 Decision；
- Bayesian 模块不可用、数据损坏或证据不足时回退到静态 Router。

### F5：Evolution 和 Windows 全功能验收

纳入主计划 W9/W10：

- Bayesian router/config 作为 Evolution candidate version；
- 通过 replay、shadow、canary 和 monitor 验证；
- 固定 baseline、dataset digest、posterior algorithm version 和 holdout；
- safety regression、leakage、校准漂移、成本失控或恢复失败时立即 rollback；
- Windows 实际使用观察期结束后，才把 schema、fixture 和行为规则迁移到其他平台。

## 10. 测试要求

必须增加以下测试：

- Beta posterior、可信区间、边界值、空样本、NaN、Infinity 和大样本；
- 小样本 prior-only 行为和冷启动回退；
- 同一 run、outcome、decision、incident group 的重复证据去重；
- unknown、cancelled、not-executed 不被计为成功；
- 新模型、Provider、Plugin 和版本不继承旧 profile 信用；
- 用户评分和客观 Verifier 结果分开更新；
- 多模型任务不会把最终分数完整复制给所有模型；
- Decision-time feature 不包含未来 Verifier、Outcome、用户反馈或后续 evidence；
- evidence、snapshot、policy、binding、run 和 workspace 不匹配时拒绝更新；
- Bayesian 模块异常时回退到静态 Router；
- 被 Safety Gate 拒绝的候选不会因 posterior 重新进入候选集；
- Bayesian 不能创建 Approval、PolicyLease 或 Executor operation；
- Phase 1 下写入、shell、测试和网络 intent 仍然全部拒绝；
- Replay 前后 Feedback、Profile 和 posterior projection checksum 一致；
- Evolution replay/shadow/canary/rollback 保留 baseline、dataset 和 posterior 版本。

## 11. 发布门

### Phase 1：`WINDOWS_PHASE1_READ_ONLY`

- Bayesian 默认只运行 shadow/advisory；
- 不改变实际 route、权限或执行；
- `decisionCoverage=100%`；
- 所有 feedback sample 通过 evidence scope、snapshot 和 leakage 检查；
- `unauthorizedSideEffectCount=0`；
- 用户评分、Verifier 结果和 posterior 可以全量回放；
- 不允许 shadow 结果自动修改 Policy、Profile eligibility 或 Evolution lifecycle。

### Phase 1.5：`WINDOWS_PHASE1_5_CONTROLLED`

- Controlled Executor 的 Approval、PolicyLease、SafetyMonitor、Executor 权威复核和 recovery 全部通过；
- 所有副作用具备 intent、approval、lease、outcome 和 evidence 链；
- Bayesian 只能影响已通过安全过滤的候选排序；
- 任意安全回归或未授权副作用立即回退静态 Router。

### Windows 全功能：`WINDOWS_FULL_LOCAL`

- 反馈 UI、FeedbackRegistry、ModelScenarioProfile、BayesianAssessment、Evolution 和 dashboard 集成完成；
- 完成安装升级、迁移、长运行、实际 Windows 工作区试用和 rollback；
- 通过实际使用观察期；
- `WINDOWS_FULL_LOCAL` 之前不实现其他平台的反馈或 Bayesian 功能。

## 12. 关联模块

首批实现范围：

- `runtime/src/profile-registry.mjs`
- `runtime/src/model-registry.mjs`
- `runtime/src/evolution-evaluator.mjs`
- `runtime/src/decision-trace.mjs`
- `runtime/src/credit-blame-ledger.mjs`
- `runtime/src/rule-verifier.mjs`
- `runtime/src/index.mjs`
- `desktop/src/domain/models.ts`
- `desktop/src/domain/store.ts`
- `desktop/src/main.ts`

实现顺序必须先完成 Event Store 和真实 Decision capture，再加入 BayesianAssessment。不能在当前空 evidence、单候选和虚拟 snapshot 的状态下直接让反馈分数影响模型选择。
