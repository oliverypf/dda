# Jev Decision Plane 设计

版本：v1.2（渐进迁移）

dda 保留原有 Planner、Executor、Tool、Skill、Memory 和任务恢复执行层；所有需要在运行时“选什么、是否能做、是否继续、是否停止、是否换方向”的语义判断统一进入 Jev Decision Plane。

## 边界

```text
用户目标 / 当前状态
        ↓
证据收集与标准化
        ↓
Jev Decision Plane
  ├─ task / route judgment
  ├─ candidate selection
  ├─ action/tool gate
  ├─ behavior/result judgment
  ├─ evidence sufficiency
  ├─ failure routing
  └─ stop / replan / escalation
        ↓
硬规则与 Runtime Safety
        ↓
Existing Execution Plane
  Planner → Executor → Tool → Result → Evidence
```

Jev 只能在宿主提供的有限候选中选择，不能生成工具、命令、权限、路径或新的候选。`RuntimeSafetyMonitor`、workspace scope、Approval、PolicyLease 和确定性 Rule Verifier 仍是不可被 Jev 覆盖的硬边界。这里的“所有需要决策”指语义选择和方向判断；硬安全规则、权限校验和事实检查继续由确定性组件执行。

## 决策协议

统一入口为 `DecisionEngine`：

```js
decisionEngine.decide({ state, evidence, candidates })
decisionEngine.selectCandidates({ state, evidence, candidates })
decisionEngine.decideActionGate({ state, evidence, tool })
decisionEngine.judgeVerification({ state, evidence, ruleStatus })
```

每次调用必须带有当前状态、有限候选和证据引用。输出是有限枚举、置信度、原因码、来源和 fallback 状态，并进入 Decision Trace。Jev 不接收 tool surface，也不直接产生副作用。

## 决策覆盖范围

以下决策统一采用“证据包 → Jev → 有限结果”的协议：

| 决策点 | Jev 责任 | 不可覆盖的边界 |
| --- | --- | --- |
| 任务意图/风险补充 | 在受限分类候选中选择或请求澄清 | 规则式高风险拒绝、workspace scope |
| Route/角色/模型候选 | 在已通过安全过滤的候选中选择 | Candidate Safety Filter、批准模型集合 |
| 候选草稿选择 | 选择、拒绝或请求补充证据 | 候选无工具、无 lease、硬淘汰 |
| 工具调用 | 判断当前工具是否适合、是否需要证据/审批 | Runtime Safety、Approval、PolicyLease |
| 行为/结果验证 | 判断继续、停止、重试、重规划或升级 | Rule Verifier 的事实失败 |
| 诊断 Probe | 在有限 Probe 候选中选择下一步 | 工具权限、预算、路径和网络限制 |
| 终止/升级 | 选择完成、暂停、请求用户或收紧策略 | fail-closed、撤销 lease、审计要求 |

## JEV 适用性边界

JEV 适合处理“存在多个合理选项、需要结合当前上下文解释”的语义决策，具体包括：

- **任务领域识别**：在信息、调查、实现、配置、诊断和外部操作等有限分类中选择，从而确定完成标准和验证强度；
- **执行拓扑选择**：在 `DIRECT_EXECUTE`、`PLAN_THEN_EXECUTE`、`DIAGNOSE_PROBE_RECOVER` 等已通过安全过滤的拓扑中选择；
- **模型/角色/候选选择**：在安全候选集合中按证据、能力、质量、成本和延迟选择，或要求补充证据；
- **工具与动作语义判断**：判断动作是否符合当前目标、是否需要确认或额外证据；
- **验证后的下一步**：根据 Rule Verifier 提供的事实选择继续、重试、重规划、诊断、升级或停止；
- **Stop / Continue**：判断目标是否已满足、证据是否充分以及是否应请求用户；
- **Memory proposal 筛选**：辅助判断候选记忆是否有足够来源、是否存在冲突，但不能单独激活记忆；
- **策略演化建议**：辅助 shadow、canary、promotion 或 rollback 的候选判断，但不能绕过离线评估和安全回归。

JEV 不适合、也不得单独负责以下事项：

- 直接执行命令、写文件、访问网络或产生其他副作用；
- 授予权限、签发 `PolicyLease`、绕过用户审批或提高权限上限；
- 覆盖 workspace scope、路径/网络/凭据硬规则或 `Rule Verifier` 的事实失败；
- 自行生成未由宿主提供的工具、命令、路径或候选；
- 伪造验证事实、审计事实或把不确定结论写成成功；
- 在 JEV 超时、不可用或输出非法时继续执行高风险副作用。

因此，JEV 的职责是“在安全边界内选择下一步怎么走”，而不是“决定是否有权限走”或“实际去走”。

Jev 不作为 Planner、Executor、Verifier 或 Judge 角色注册；它是横切的 Decision Plane。任何新增决策点必须先定义候选集合、证据来源、硬约束、fallback 和 Decision Trace 事件，才能接入运行时。

## 当前迁移结果

当前实现属于渐进迁移阶段，Jev 已进入部分运行主链，但还不是完整的编排控制者。以下边界必须在产品状态和 Decision Trace 中明确标记：

- `ACTION_GATE`、候选选择、行为验证以及部分 stop/recovery 已接入 Jev；
- `CLASSIFY_TASK`、`SELECT_ROUTE`、`SELECT_TOPOLOGY` 现在共享同一个在分类之前解析的 Decision Engine，并各自由独立的显式 opt-in 开关控制（`decision` 块的 `classificationEnabled` / `routeSelectionEnabled` / `topologyEnabled`，或 `HMCODEX_JEV_CLASSIFY_ENABLED` / `HMCODEX_JEV_ROUTE_ENABLED` / `HMCODEX_JEV_TOPOLOGY_ENABLED`）。默认关闭；未 opt-in 时这三个决策仍由 `RuleRouter` 和固定规则完成，并在 Decision Trace 中标记 `RULE_FALLBACK`。
- 迁移仍不完整，不得宣称为 100%：
  - `SELECT_ROUTE` 现在确实把安全过滤后的路由交给 Jev，但 Jev 只能把已选路由收紧为 `BLOCKED`（fail-closed），不能放宽、改写角色或绕过批准模型集合；
  - 规则分类器目前仍只产出 `inspect | modify | test | unknown`，尚未扩展到设计中的 `inspect | investigate | implement | configure | diagnose | external-operation`，因此 `diagnose` 任务类从不出现，`SELECT_TOPOLOGY` 的 `DIAGNOSE_PROBE_RECOVER` 候选当前不可达；
  - `SELECT_TOPOLOGY` 仅在 Jev 选择时写入决策记录；规则路径的拓扑判断尚未作为独立的 `SELECT_TOPOLOGY` 决策写入 Decision Trace。
- Planner 计划已经接入受控拓扑和计划候选选择；诊断 Probe、recovery direction、Context Pack、澄清问题和已绑定模型 fallback 已形成统一的 Jev 有限候选协议，后续仍需补齐更丰富的受限 replan 候选执行器；
- 当 Jev 未启用、认证失败、超时或返回非法选择时，系统必须记录 fallback 原因并继续执行保守路径，不能把 fallback 伪装成 Jev 决策。

- 原 semantic LLM-as-a-Verifier turn 已从运行主链移除；行为/结果判断改为 `VERIFY_BEHAVIOR` 的 Jev 决策。
- 候选 draft 仍然只读、无工具、无 lease；候选选择改由 Jev 从候选集合中选择。
- 每个工具调用在 `ToolRegistry.invoke` 之前经过 `ACTION_GATE`。`BLOCK` 和 `REQUEST_EVIDENCE` 会在 TaskRunner 内形成受控拒绝，不会进入 registry。
- 原有 Rule Verifier 继续提供确定性事实；Jev 只能在规则证据之上判断语义是否充分，不能把硬失败升级为成功。
- OpenViking 不再是运行时 context provider、plugin 或启动依赖；上下文统一使用本地 `MemoryJournal`，证据统一由当前 run 的轨迹和执行结果产生。
- Jev 不可用时采用保守 fallback：只读工具可继续，副作用工具回到 `REQUIRE_APPROVAL`，候选按确定性成本/延迟顺序选择，行为判断为 `UNCERTAIN`。这保证系统 fail-closed，但不会让旧模型 verifier 重新获得控制权。
- Memory proposal 只有在保留来源事件、通过确定性来源/冲突检查并满足作用域约束后，才允许进入待审核状态；Jev 不能直接将其激活为 active memory。

## 当前不足与目标补齐项

### 1. 认证和运行可用性

Jev 的设计能力只有在真实请求可达时才会生效。运行配置必须支持显式的认证环境变量或受控 header 引用，并在启动诊断和 Decision Trace 中记录 `enabled`、endpoint、model、请求延迟、错误码和 fallback 原因。凭据本身不得写入日志、事件、Support Bundle 或普通配置快照。认证失败时继续使用保守 fallback，并将该 run 标记为 `JEV_UNAVAILABLE`。

### 2. 任务分类、路由和执行拓扑

必须把以下决策迁移为独立的有限选择协议，不能继续由 Jev 之外的语义 Router 并行覆盖：

```text
taskClass:
  inspect | investigate | implement | configure | diagnose | external-operation

topology:
  DIRECT_EXECUTE | PLAN_THEN_EXECUTE | DIAGNOSE_PROBE_RECOVER
```

宿主先完成安全过滤，再向 Jev 提供候选、目标、风险、约束和证据。Jev 只能返回候选 ID 或 `REQUEST_CLARIFICATION`；角色、模型和路径仍由确定性安全组件校验。迁移完成前，规则路由必须显式标记为 `RULE_FALLBACK`。

### 3. Probe 选择和 Replan 闭环

诊断阶段必须由宿主生成有限 Probe 候选，例如读取配置、检查日志、执行只读验证、请求用户补充信息或停止报告。Jev 选择下一步 Probe 后，Executor 执行并回写结果，形成：

```text
evidence → probe selection → controlled execution → verification → replan/stop
```

`NEED_REPLAN` 不能只作为终态枚举；它必须触发新的受限计划候选集合，再由 Jev 选择下一条路径。当前运行时已落地 `SELECT_RECOVERY_DIRECTION` 和 `SELECT_REPLAN_PLAN`：候选为收集证据、缩小范围、改变受限方法、切换已绑定角色、请求用户和停止报告；选择结果会传递给下一次 Executor，`change-approach` 要求避开既有动作摘要，`request-user` 要求先提出缺失的用户决策，`stop-and-report` 在下一次执行前终止恢复。候选必须带预算、权限、预期证据和失败回退。

### 4. 证据包质量

每次 Jev 调用的证据包应至少包含需求完成度、失败类型、已尝试步骤、候选能力/成本/延迟、验证覆盖率、未满足约束和历史失败摘要。可以传递结构化摘要和 digest，但不得传递隐藏思维链、凭据或不必要的原始用户内容。

### 5. 迁移验收标准

每个新增决策点只有同时满足以下条件才算迁移完成：

1. 有明确的有限候选和非法输出处理；
2. 有结构化证据来源、硬约束和保守 fallback；
3. 运行主链只有一个最终控制者，Decision Trace 能关联选择、执行和验证结果；
4. Jev 不可用时安全行为保持 fail-closed；
5. 有 replay/contract 测试覆盖成功、拒绝、超时、认证失败和候选为空等路径。

## 可扩展的 Jev 决策目录

在完成认证、任务分类、路由和执行拓扑迁移后，可以按以下顺序扩展 Jev。每项都必须遵循“宿主生成有限候选 → Jev 选择 → 确定性校验 → 受控执行 → 写入 Decision Trace”的协议。

### P0：直接提升任务完成率

#### 用户意图澄清

宿主根据缺失字段生成有限问题候选，Jev 选择最能减少不确定性的问题，或返回 `REQUEST_CLARIFICATION`。Jev 不得自行补全用户意图，也不能把未回答的问题当作授权。

#### Context / Memory 选择

宿主提供经过 scope、来源和冲突过滤的记忆候选，Jev 选择与当前目标最相关的记忆、历史失败摘要或 checkpoint。原始轨迹仍是只读证据；记忆激活、降级、撤回和删除不由 Jev 单独决定。

#### Probe 选择

宿主生成只读或已批准的 Probe 候选，例如读取配置、检查日志、运行只读验证、请求补充信息或停止报告。候选必须声明权限、预算、预期证据、超时和失败回退。Jev 只能选择候选 ID。

#### Replan 方向

当验证结果为不确定、停滞或需要重规划时，宿主生成缩小范围、补充证据、更换拓扑、更换角色/模型、请求确认和停止报告等候选。Jev 选择下一条方向，不能生成未经过滤的新计划。

### P1：提升复杂任务的协作质量

#### Multi-Agent 协作拓扑

在已批准的角色和 context 隔离策略中，Jev 可以选择单 Agent、Planner/Executor 分离、增加独立 Critic、并行候选或独立 Verifier。`RoleSessionManager`、并发上限、context 隔离、deadline 和 permission intersection 仍由宿主强制执行。

#### Context 装配策略

Jev 可以在“当前任务、checkpoint、相关 memory、失败轨迹摘要、验证规则说明”等有限组合中选择上下文层级。宿主负责长度上限、脱敏、来源标记和 prompt cache 隔离。

#### 模型和角色能力匹配

在模型注册表和安全过滤完成后，Jev 可以按风险、能力、成本、延迟和验证要求选择快速模型、强推理模型、代码模型或独立验证模型。模型身份、provider、协议和允许角色必须由 binding snapshot 固定。

#### 插件能力降级

Jev 可以在已批准插件候选中选择主插件、只读降级插件、重试或停止。Plugin manifest、版本锁、权限、依赖、quarantine 和网络范围仍由 plugin governance 确定性校验。

### P2：治理和持续演化

#### Memory Proposal 排序

对已通过来源和冲突检查的 proposal，Jev 可以选择创建、合并、supersede、延迟审核或跳过。只有 review gate 和确定性 verifier 都通过后，proposal 才能进入 active memory。

#### Evolution Proposal 评估

Jev 可以对 shadow、canary、promotion、继续收集样本和 rollback 候选进行排序。离线评估、holdout、容量门槛、发布审批和回滚规则不可被 Jev 覆盖。

## 全量设计复检后的新增决策项

以下决策点来自安全、状态机、部署、插件、评价和 UI 设计中的已有候选与权衡。它们都遵循有限候选协议，不改变硬规则的最终权威。

### P0：安全控制与恢复闭环

#### `SELECT_REQUIRED_CONTROLS`

在硬规则已经保留的安全候选内，Jev 可以选择 `MONITOR`、`CONFIRM`、`SANDBOX`、组合控制、`REQUEST_MORE_EVIDENCE` 或 `BLOCK`。Jev 不能把硬拒绝改为允许，也不能取消路径、网络、凭据、租约或审批限制。

#### `SELECT_RECOVERY_CONTROL`

把无进展、重复动作、测试振荡、目标冲突、预算接近上限和证据不足统一为恢复候选：`RETRY_CHEAP`、`COLLECT_EVIDENCE`、`CHANGE_APPROACH`、`CHANGE_MODEL`、`CHANGE_ROLE`、`REQUEST_USER`、`PAUSE`、`STOP_AND_REPORT`、`ESCALATE`。

#### `SELECT_CONTEXT_PACK`

在 `CURRENT_TASK_ONLY`、`ADD_CHECKPOINT`、`ADD_RELEVANT_MEMORY`、`ADD_FAILURE_HISTORY`、`ADD_VERIFICATION_RULES`、`ADD_RELATED_FILES` 和 `REQUEST_MORE_CONTEXT` 中选择上下文层级。宿主负责长度、脱敏、scope、来源 digest 和 prompt cache 隔离。

#### `SELECT_CLARIFICATION_REQUEST`

当存在多个信息缺口时，Jev 选择 `ASK_GOAL_SCOPE`、`ASK_ALLOWED_SIDE_EFFECTS`、`ASK_TARGET_PATH`、`ASK_EXPECTED_OUTPUT`、`ASK_NETWORK_SCOPE`、`ASK_RECOVERY_PREFERENCE` 或 `NO_QUESTION_CONTINUE`。未回答的问题不能被视为授权。

### P1：协作、部署与扩展治理

#### `SELECT_COLLABORATION_TOPOLOGY`

在 `SINGLE_AGENT`、`PLANNER_EXECUTOR`、`PLANNER_EXECUTOR_VERIFIER`、`ADD_CRITIC`、`PARALLEL_CANDIDATES`、`ISOLATED_DIAGNOSTIC_CONTEXT` 和 `PAUSE_DUE_TO_BUDGET` 中选择。RoleSessionManager 仍强制 context 隔离、并发、deadline 和 permission intersection。

#### `SELECT_DEPLOYMENT_FALLBACK`

当本地/远程能力或连接状态变化时，在 `LOCAL_EXECUTOR`、`REMOTE_EXECUTOR`、`READONLY_LOCAL`、`PAUSE_UNTIL_RECONNECT`、`REQUEST_USER_CHOICE` 和 `STOP_DUE_TO_CAPABILITY_MISMATCH` 中选择。endpoint identity、TLS、能力声明和权限校验仍由确定性组件完成。

#### `SELECT_PLUGIN_MIGRATION_ACTION`

在已签名和已批准的插件候选中选择 `KEEP_CURRENT`、`INSTALL_SIDE_BY_SIDE`、`RUN_SHADOW`、`DEFER_MIGRATION`、`USE_READONLY_PLUGIN`、`QUARANTINE`、`ROLLBACK` 或 `REQUEST_ADMIN_REVIEW`。签名变化、权限扩大、安全撤销和 quarantine 不能被 Jev 覆盖。

### P2：治理、发布与解释

#### `SELECT_EVOLUTION_ACTION`

在 `KEEP_BASELINE`、`COLLECT_MORE_SAMPLES`、`START_SHADOW`、`START_CANARY`、`PROMOTE`、`FREEZE_PROFILE`、`ROLLBACK` 和 `ABSTAIN` 中选择。最终发布、holdout、容量阈值和回滚门仍由评估与策略控制。

#### `SELECT_DECISION_SUMMARY`

从 `WHY_THIS_ROUTE`、`WHY_THIS_MODEL`、`WHY_ACTION_BLOCKED`、`WHAT_EVIDENCE_IS_MISSING`、`WHAT_USER_MUST_CONFIRM`、`WHY_TASK_STOPPED` 和 `WHAT_WILL_HAPPEN_NEXT` 中选择 UI 首要解释项。该决策只改变展示顺序，不改变运行结果。

## 现有决策的结构调整

### 拆分 `ACTION_GATE`

将动作语义适用性和安全许可拆成三层：

```text
ACTION_SUITABILITY (Jev)
  → SELECT_REQUIRED_CONTROLS (Jev, only within safe candidates)
  → HARD_POLICY_GATE (deterministic)
```

即使 Jev 返回 `ALLOW`，也必须继续经过 Runtime Safety、Approval、PolicyLease 和 Executor 检查。

### 重构诊断与恢复

将 `DIAGNOSE_VERIFICATION` 和 `RECOVER_TASK` 收敛为：

```text
DIAGNOSE_HYPOTHESIS
  → SELECT_PROBE
  → VERIFY_PROBE_RESULT
  → SELECT_RECOVERY_CONTROL
  → REPLAN_OR_STOP
```

每个 Probe 必须带权限、预算、预期证据、超时和失败回退；Jev 只能选择宿主生成的 Probe ID。

### 扩展 `CONSOLIDATE_MEMORY`

Memory Consolidation 候选扩展为 `CREATE_MEMORY`、`MERGE_WITH_EXISTING`、`SUPERSEDE_EXISTING`、`DEFER_REVIEW`、`LOWER_CONFIDENCE`、`REQUEST_SOURCE` 和 `SKIP_MEMORY`。来源事件、scope、冲突检查、人工审核和 active memory 激活仍是确定性门禁。

### 扩展 `SELECT_CANDIDATE`

候选选择允许返回 `REQUEST_MORE_EVIDENCE`、`NO_SAFE_CANDIDATE` 或 `ABSTAIN`，避免在所有候选质量不足时被迫选择一个候选。

### 拆分综合 `decide()`

运行时应逐阶段调用 failure classification、evidence sufficiency、probe selection、verification、recovery direction 和 stop/escalation，使证据包更小，Decision Trace 更容易解释和回放。

## 不接入 Jev 的决策

以下事项保持确定性控制：权限授予和审批、PolicyLease 签发、workspace/path/network/credential 硬规则、Rule Verifier 事实结论、不可逆操作的最终许可、预算和 deadline 上限、并发限制，以及插件 manifest 和权限校验。Jev 可以提出“请求审批”或“停止”的语义结果，但不能代替这些控制器。

## Jev 参与边界（收敛规范）

此前列出的扩展项不是“所有多选项都交给 Jev”。只有在语义理解能够带来实际增益、候选已经有限化、且结果可以经过确定性校验时，才接入 Jev。系统统一采用三层链路：

```text
确定性事实与硬约束
  → Jev 语义建议或有限选择
  → 确定性执行与状态提交
```

### Jev 的核心职责

以下决策需要结合目标、上下文和不完整证据，属于 Jev 的核心范围：

```text
CLASSIFY_TASK
SELECT_ROUTE
SELECT_TOPOLOGY
SELECT_CANDIDATE
ASSESS_EVIDENCE
VERIFY_BEHAVIOR
SELECT_PROBE
SELECT_RECOVERY_DIRECTION
STOP_OR_CONTINUE
ESCALATE_OR_REQUEST_USER
```

规则分类器、规则路由器和确定性 fallback 可以在 Jev 不可用时提供保守结果，但不得与 Jev 并行覆盖同一最终语义决策。每次 Jev 选择都必须引用决策前已存在的证据，并提交有限候选、约束快照、结果和后续 outcome。

### Jev 的辅助职责

以下场景可以使用 Jev 提供建议或在安全候选内排序，但 Jev 输出不得直接改变权限、状态或发布结果：

```text
SELECT_CONTEXT_PACK
SELECT_MEMORY_PROPOSAL_ACTION
SELECT_SAFE_MODEL_FALLBACK
SELECT_DEPLOYMENT_FALLBACK
SELECT_PLUGIN_MIGRATION_SUGGESTION
SELECT_EVOLUTION_SUGGESTION
SELECT_USER_FACING_EXPLANATION
```

这些输出必须标记为 `JEV_RECOMMENDATION`，并分别由 Context/Memory、Model Registry、Capability Manager、Plugin Governance、Evaluation/Release Gate 或 UI 优先级规则复核。

### 明确排除的职责

以下事项不进入 Jev 的最终控制范围：

```text
权限授予、Approval 结果、PolicyLease 签发
硬安全判断、事实验证、workspace/path/network/credential 规则
预算上限、deadline、并发上限和状态机迁移
取消是否成功、外部副作用是否发生、恢复对账事实
插件签名/hash/revocation/quarantine 校验
发布、promotion、rollback 和 kill switch 的最终决定
```

Jev 可以对这些事项提出“请求审批”“暂停”“补证据”或“建议回滚”等语义结果，但不能替代对应控制器。任何模型输出都不是权限凭证、事实证明、状态迁移授权或发布批准。

### 过度使用防护

- 能由简单规则、排序器、预算器或状态机稳定解决的问题，不调用 Jev；
- 安全候选、预算和能力先由确定性组件过滤，再交给 Jev 做语义选择；
- UI 的安全事件、审批和取消提示遵循确定性优先级，Jev 只能补充解释摘要；
- Jev 超时、认证失败、非法输出或证据不足时，采用保守 fallback，并记录 `JEV_UNAVAILABLE`、`JEV_INVALID_OUTPUT` 或具体原因码；
- 新增决策点必须先证明语义收益、定义有限候选、确定 fallback 和 outcome 评价，否则保持规则实现。

## Decision Trace 约束

所有候选、工具和行为判断都要记录：

1. decision type、run/step、约束快照和证据引用；
2. 完整候选集合、淘汰原因和 selected option；
3. Jev/rule 来源、fallback、原因码和延迟；
4. 后续 tool result、verification result、用户反馈或未执行状态。

普通记录只保存结构化摘要和 digest，不保存 prompt、凭据或隐藏思维链。Decision Record 不是权限凭证；真实执行仍必须经过 Safety Monitor、Approval 和一次性 Lease。

## 后续迁移顺序

已接入的顺序是：

```text
Stop / recovery
  → behavior evidence judgment
  → action/tool gate
  → candidate selection
```

task classification、route、planner 计划、诊断和停止方向必须继续迁移到同一有限选择协议；迁移期间每个决策点只能有一个最终控制者，禁止旧模型 verifier、独立 judge 或旧 Router 与 Jev 并行覆盖同一结果。未迁移的决策点必须明确标记为确定性规则或保守 fallback，不得隐式使用旧语义模型。

建议迁移顺序调整为：

```text
Jev 可用性与认证
  → task classification / route
  → execution topology
  → stop / recovery
  → behavior evidence judgment
  → action/tool gate
  → candidate selection
  → probe selection / replan
```

扩展目录的优先级为：

```text
P0 认证可用性 → task classification / route → topology
   → 意图澄清 → context/memory → Probe → Replan
P1 multi-agent topology → context assembly → model/role fit → plugin fallback
P2 memory proposal → evolution proposal
```

全量复检后的优先级补充为：

```text
P0 认证可用性 → CLASSIFY_TASK → SELECT_ROUTE → SELECT_TOPOLOGY
   → SELECT_REQUIRED_CONTROLS → SELECT_CONTEXT_PACK
   → SELECT_CLARIFICATION_REQUEST → SELECT_PROBE
   → SELECT_RECOVERY_CONTROL
P1 SELECT_COLLABORATION_TOPOLOGY → SELECT_DEPLOYMENT_FALLBACK
   → SELECT_PLUGIN_MIGRATION_ACTION
P2 SELECT_EVOLUTION_ACTION → SELECT_DECISION_SUMMARY
   → 扩展 CONSOLIDATE_MEMORY / SELECT_CANDIDATE
```

上述优先级是候选研究顺序，不代表全部项目都必须接入 Jev。实际落地前必须先通过“语义收益、有限候选、确定性复核、fallback 和 outcome 评价”五项门槛；未通过的项目继续使用规则、优化器或用户控制。
