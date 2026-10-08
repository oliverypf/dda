# dda 跨平台数据模型与迁移规范

版本：Storage Schema 1  
状态：Phase 1 实现基线

## 1. 存储原则

dda 使用平台无关的数据模型保存结构化事实。HarmonyOS 适配 `relationalStore`、`preferences` 和 Asset Store；Windows/Linux/Gateway 使用等价的 SQLite、系统安全存储和服务端凭据适配器。UI 状态不能替代数据库，模型上下文不能成为唯一事实源。

数据模型采用“追加式事件 + 可重建投影”：

- `trajectory_events` 是 run 状态和审计的权威来源；
- `runs`、`run_timeline`、`active_approvals` 等是查询投影；
- Profile、Policy 和 Plugin 注册表是版本化配置聚合，有独立证据链；
- 大文本、diff 和工具输出与事件元数据分离，可压缩、加密和按策略删除。

## 2. 数据库与写入模型

- 数据库名：`hmcodex.db`。
- 所有数据库写入经过单一 `HarnessStoreWriter` 串行队列，避免 UI、Worker、Adapter 多点写入。
- 一个领域命令产生的 event、dedup 记录和关键 projection 在同一事务提交。
- 数据库初始化先读取 `schema_metadata`，按顺序执行显式 migration；禁止依赖运行库自动推断升级。
- SQLite/relationalStore 外键、唯一约束和事务必须在启动自检中验证为启用状态。

HarmonyOS 官方将 relationalStore 定位为关系型业务数据存储；数据库版本迁移仍由应用显式维护。平台基线见 [HarmonyOS 数据存储方案](https://developer.huawei.com/consumer/cn/doc/doccenter-dev-faq/faqs-local-database-management-38)。

## 3. 核心表

以下字段为长期最低契约。实现可以增加索引或派生列，不得省略身份、版本、时间和 digest 字段。

### 3.1 schema_metadata

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK，固定 1 | 单行元数据 |
| `schema_version` | INTEGER NOT NULL | 当前 Storage Schema |
| `min_reader_version` | INTEGER NOT NULL | 最低兼容 Reader |
| `app_version` | TEXT NOT NULL | 最近成功迁移的 App |
| `migration_state` | TEXT NOT NULL | CLEAN/RUNNING/FAILED |
| `last_migration_id` | TEXT | 最近迁移 |
| `updated_at_ms` | INTEGER NOT NULL | 更新时间 |

### 3.2 workspaces

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `workspace_id` | TEXT PK | 内部 ID |
| `display_name` | TEXT NOT NULL | UI 名称 |
| `adapter_id` | TEXT NOT NULL | 权威 WorkspacePort |
| `root_ref` | TEXT NOT NULL | 路径/URI 引用；敏感时加密 |
| `canonical_root_digest` | TEXT NOT NULL | 规范化根 digest |
| `trust_class` | TEXT NOT NULL | LOCAL/REMOTE/ENTERPRISE |
| `created_at_ms`、`updated_at_ms` | INTEGER | 生命周期 |
| `deleted_at_ms` | INTEGER NULL | 软删除/清理任务 |

### 3.3 tasks

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `task_id` | TEXT PK | 用户目标 |
| `thread_id` | TEXT NULL | UI 会话 |
| `workspace_id` | TEXT FK | 工作区 |
| `input_blob_id` | TEXT FK | 加密/分级输入 |
| `input_digest` | TEXT NOT NULL | 去重与审计 |
| `requested_mode` | TEXT NOT NULL | READ_ONLY/CONTROLLED_WRITE |
| `created_at_ms` | INTEGER NOT NULL | 创建时间 |
| `sensitivity` | TEXT NOT NULL | 数据分类 |

### 3.4 runs

这是 `TaskRun` 投影，不是事件权威表。

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `run_id` | TEXT PK | run ID |
| `task_id` | TEXT FK NOT NULL | 所属任务 |
| `state` | TEXT NOT NULL | 当前投影状态 |
| `run_version` | INTEGER NOT NULL | 乐观锁版本 |
| `last_sequence` | INTEGER NOT NULL | 最新事件序号 |
| `route_id` | TEXT NULL | 当前 route |
| `role_resolution_snapshot_id` | TEXT NULL | 绑定快照 |
| `policy_version` | TEXT NOT NULL | 当前策略 |
| `resume_state` | TEXT NULL | Pause 恢复参考 |
| `deadline_at_ms` | INTEGER NOT NULL | 绝对 deadline |
| `budget_json` | TEXT NOT NULL | 固定预算快照 |
| `started_at_ms`、`updated_at_ms` | INTEGER | 时间 |
| `completed_at_ms` | INTEGER NULL | 终态时间 |
| `terminal_reason_code` | TEXT NULL | 终止原因 |
| `external_outcome_unknown` | INTEGER NOT NULL DEFAULT 0 | 恢复标记 |

索引：`(task_id, started_at_ms)`、`(state, updated_at_ms)`、`(workspace_id via task join)`。

### 3.5 trajectory_events

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `event_id` | TEXT PK | 幂等 ID |
| `run_id` | TEXT FK NOT NULL | run |
| `sequence` | INTEGER NOT NULL | run 内顺序，UNIQUE(run_id, sequence) |
| `aggregate_type`、`aggregate_id` | TEXT NOT NULL | 聚合 |
| `aggregate_version` | INTEGER NOT NULL | UNIQUE(type,id,version) |
| `kind` | TEXT NOT NULL | 事件 kind |
| `schema_version` | TEXT NOT NULL | Harness Protocol |
| `operation_id` | TEXT NULL | Port operation |
| `correlation_id`、`causation_id` | TEXT | 因果 |
| `actor_type`、`actor_id` | TEXT NOT NULL | 产生者 |
| `payload_json` | TEXT NULL | 小 payload |
| `payload_blob_id` | TEXT NULL FK | 大/敏感 payload |
| `payload_digest` | TEXT NOT NULL | 完整性 |
| `sensitivity` | TEXT NOT NULL | 分类 |
| `policy_version`、`producer_version` | TEXT NOT NULL | 回放版本 |
| `emitted_at_ms`、`observed_at_ms` | INTEGER NOT NULL | 时序 |
| `redaction_state` | TEXT NOT NULL | RAW/REDACTED/PURGED |

高频 delta 不逐 token 永久保存；使用 `stream_chunks` 临时表或 Blob 聚合，并在完成时生成最终内容事件。

### 3.6 command_dedup

| 字段 | 约束 |
| --- | --- |
| `command_id` | TEXT PK |
| `payload_digest` | TEXT NOT NULL |
| `run_id` | TEXT NULL |
| `receipt_json` | TEXT NOT NULL |
| `status` | TEXT NOT NULL |
| `created_at_ms`、`expires_at_ms` | INTEGER NOT NULL |

相同 command ID 不同 digest 是安全冲突，永不覆盖。

### 3.7 operations

保存 Port 调用的生命周期：`operation_id` PK、`run_id`、`step_id`、`port_type`、`adapter_id`、`request_digest`、`state`、`attempt`、`retry_of`、`deadline_at_ms`、`provider_operation_ref`（加密/脱敏）、`started_at_ms`、`completed_at_ms`、`outcome_digest`、`error_category/code`。

### 3.8 approvals

`approval_id` PK、`run_id`、`intent_digest`、`state`、`display_blob_id`、`display_digest`、`requested_decision`、`resolution`、`actor_id`、`policy_version`、`requested_at_ms`、`presented_at_ms`、`resolved_at_ms`、`expires_at_ms`、`superseded_by`。

### 3.9 policy_leases

只保存 lease 元数据和 token digest，不保存可重放 token：`lease_id` PK、`run_id`、`intent_digest`、`subject_context_id`、`executor_id`、`workspace_id`、`snapshot_id`、`scope_json`、`state`、`policy_version`、`approval_id`、`token_digest`、`issued_at_ms`、`expires_at_ms`、`consumed_at_ms`、`revoked_at_ms`、`revoke_reason`、`max_uses`、`use_count`、`version`。

### 3.10 role_bindings 与 role_binding_resolutions

- `role_bindings` 保存用户/系统配置及版本，不保存解析后的动态默认值。
- `role_binding_resolutions` 是每个 run 的不可变快照：provider/model/effort、Agent、Skill、Executor、预算、权限上限、配置来源、fallback 原因、capability snapshot hash。
- 历史 resolution 不因模型注册表变化而修改。

### 3.11 agent_decisions、decision_options、decision_edges 与 decision_outcomes

`agent_decisions` 保存每个 Agent 语义决策的不可变内容和可重建生命周期投影。目标、快照、证据、候选、选择、理由和预期写入后不可修改；`status`/`committed_at_ms` 只能由追加式 Decision 事件 reducer 推进，事件仍是权威来源。最低字段如下：

| 字段 | 约束 | 说明 |
| --- | --- | --- |
| `decision_id` | TEXT PK | 决策 ID |
| `schema_version` | TEXT NOT NULL | Decision Trace schema |
| `run_id`、`step_id` | TEXT FK | 所属 run/step |
| `operation_id` | TEXT NULL FK | 产生决策的 Agent/模型 operation；确定性 Agent 可为空 |
| `agent_instance_id`、`agent_role` | TEXT NOT NULL | Agent 身份与角色 |
| `role_context_id`、`binding_snapshot_id` | TEXT NOT NULL | 隔离上下文和模型/Agent/Skill 绑定快照 |
| `model_invocation_id`、`prompt_template_version` | TEXT NULL | 模型调用与模板版本；不保存 prompt 原文 |
| `decision_type`、`status` | TEXT NOT NULL | 类型及 PROPOSED/COMMITTED/REJECTED/ABSTAINED/INVALIDATED |
| `supersedes_decision_id` | TEXT NULL FK | 修订链；其余父子关系进入 `decision_edges` |
| `objective_ref`、`constraint_snapshot_id`、`constraint_snapshot_digest` | TEXT NOT NULL | 当时目标和不可变约束快照 |
| `feature_snapshot_blob_id`、`feature_snapshot_digest` | TEXT FK/TEXT | 决策时特征，防止结果泄漏 |
| `selected_option_id` | TEXT NULL | 选择项；abstain 时为空 |
| `criteria_json`、`reason_codes_json` | TEXT NOT NULL | 可枚举标准和原因码 |
| `uncertainty_json`、`claimed_confidence` | TEXT/REAL | 已知未知项和自报置信度 |
| `summary_blob_id`、`summary_digest` | TEXT FK/TEXT | 结构化、可展示摘要，不含隐藏思维链 |
| `expectation_json`、`output_refs_json` | TEXT | 可检验预期和输出引用 |
| `sensitivity` | TEXT NOT NULL | 数据分类 |
| `created_at_ms`、`committed_at_ms` | INTEGER | 生命周期 |
| `record_digest` | TEXT NOT NULL | 不含 lifecycle/outcome 的不可变规范化内容摘要 |

配套表：

- `decision_options`：`(decision_id, option_id)` 联合主键，保存候选描述引用、可行性、能力/成本/风险预测、拒绝原因和候选排序；未选候选仍保留。
- `decision_evidence_links`：`(decision_id, evidence_id)` 唯一，`stance` 为 SUPPORTS/CONTRADICTS/CONTEXT，保存来源类型、范围、freshness 和当时可见性。
- `decision_edges`：`edge_id` PK、`from_node_type/id`、`to_node_type/id`、`edge_type`，唯一约束覆盖两端和类型；表达 DEPENDS_ON/REFINES/SUPERSEDES/CRITIQUES/SELECTS/PRODUCES/OUTCOME_OF/CREDIT_FOR/BLAME_FOR。Decision-to-Decision 子图必须无环，Outcome/产物节点只能作为终点。
- `decision_outcomes`：`outcome_id` PK、`decision_id` FK、状态、execution/verifier/user evidence refs、实际成本/时延、安全事件、预测误差、credit/blame、evaluator version/digest 和 `linked_at_ms`。Outcome 只能追加，不覆盖原决策字段。
- `learning_sample_assessments`：追加式保存 `assessment_id`、decision/outcome/feature digests、`eligible`、exclusion reason codes、cohort key、evaluator version/digest 和时间。资格变化创建新 assessment，不改写原 Decision/Outcome；学习导出只采用最新有效评估。

完整类型、采集时点和学习样本规则见 [Agent Decision Trace 规范](./DECISION_TRACE_SPEC.md)。大摘要、特征快照和敏感证据进入加密 Blob；普通表不保存 prompt、reasoning token、隐藏思维链或可重放凭据。

### 3.12 route_decisions 与 verifier_reports

`route_decisions` 是面向 Router 查询和聚合的投影，必须引用产生它的 `decision_id`；它保存安全候选集、评分分量、成本估计、选择原因和 Router 版本。`verifier_reports` 必须引用 Verifier `decision_id`，保存 verdict、证据 event IDs、确定性检查、语义评分、置信度、未决风险、下一动作和 verifier 版本。两者都不能替代 `agent_decisions` 权威记录。

### 3.13 profiles

`capability_profiles`、`safety_profiles` 仅保存当前投影；每次更新必须对应 `profile_evidence` 和 `profile_updates` 追加记录，包括旧值、新值、算法版本、样本窗口、credit/blame、置信区间和回滚标识。

### 3.14 plugins 与 policies

- `plugin_registry`：plugin id/version/hash/source/trust/lifecycle/capabilities/permission ceiling/quarantine。
- `policy_versions`：不可变策略文档 digest、签发者、激活时间、父版本。
- `policy_transitions`：治理阶段变化、证据、人工决定和恢复条件。

### 3.15 memory

`memory_proposals`、`memory_items`、`memory_sources` 分离：Proposal 未批准前不进入 active memory；每条 item 有 source event IDs、confidence、valid_from/to、sensitivity、supersedes/revokes 和 verifier status。原 Trajectory 不被 Memory 覆盖。

### 3.16 blobs

| 字段 | 说明 |
| --- | --- |
| `blob_id` PK | 内容 ID |
| `content_type`、`encoding`、`compression` | 解码信息 |
| `cipher_suite`、`key_ref`、`nonce` | 加密元数据，不含密钥 |
| `content_digest` | 明文 digest 的 HMAC 或按分类选择 |
| `size_bytes` | 容量 |
| `storage_class` | HOT/WARM/COLD |
| `retention_until_ms` | 清理时间 |
| `created_at_ms`、`purged_at_ms` | 生命周期 |

大 Blob 可以放在应用沙箱文件中，数据库保存路径引用和完整性；路径不能来自用户输入，删除时事务性标记并由清理器幂等执行。

## 4. 事务与幂等

处理一个命令的事务步骤：

1. 查询 `command_dedup`；重复且 digest 相同返回原 receipt；
2. 读取 run version 并验证 `expectedRunVersion`；
3. 计算新事件、聚合版本和投影变更；Agent 决策命令同时校验 option、evidence、feature snapshot 和 record digest；
4. 插入 event；
5. 更新关键 projection；
6. 插入 dedup receipt；
7. commit 后才发布内存通知。

如果 commit 失败，不能向 Adapter 启动新的副作用。对于“先收到外部事件后落库”的流，EventSink 在持久化失败时施加背压并暂停 run；禁止仅保存在内存后继续执行。

副作用采用本地事务无法覆盖远端系统，因此使用 intent/lease/outcome 协议：先持久化 intent 和 lease，再调用 Executor，再持久化 outcome；中间崩溃进入 `RECOVERING`，不能假设回滚。

Agent 决策使用“decision-before-effect”协议：`AgentDecisionCommitted`、`agent_decisions` 和必要候选/证据链接在同一事务提交；commit 后才能发布 route、ActionIntent、Verifier verdict、Probe 或 Memory Proposal。实际执行和验证完成后，在新事务追加 `DecisionOutcomeLinked` 与 `decision_outcomes`。任何 outcome 都不得回填或重算决策时特征快照。

## 5. Read Model

UI 只读取：

- `run_summary_view`：state、版本、当前角色/route、预算、连接和 Verifier；
- `run_timeline_view`：分页时间线、聚合 delta、审批和证据；
- `decision_trace_view`：按 Agent/step/type/status 分页的决策 DAG、候选、证据、预期、结果和 Credit/Blame；
- `active_approval_view`：当前可操作审批及 display digest；
- `workspace_view`：授权 root、snapshot、浏览状态；
- `profile_explanation_view`：画像值、证据窗口和策略变化；
- `memory_view`：active/proposed/revoked memory。

每个 read model 带 `projectionVersion` 和 `lastEventSequence`。UI 命令不得只根据 projection 做授权判断。

全量重建：清空可重建投影 → 按 `(runId, sequence)` 回放事件 → 校验 aggregate version 连续 → 对比保存的 projection checksum → 原子切换新投影。重建时应用进入只读维护模式。

## 6. 数据分类与保留

| 分类 | 示例 | 默认处理 |
| --- | --- | --- |
| `PUBLIC` | 模型显示名、公开设置 | 可记录 |
| `INTERNAL` | route 分数、状态、错误码 | 本地保存 |
| `SOURCE` | 项目代码、diff、命令输出 | 加密，按项目保留 |
| `SENSITIVE` | 用户输入、路径、身份、网络目标 | 加密、脱敏导出 |
| `SECRET` | token、密码、私钥、cookie | 不进入 DB/Trajectory，仅 Asset Store 或短期内存 |
| `SECURITY_AUDIT` | 拒绝、越权、策略变化 | 追加式、受保留策略保护 |

默认保留期由 `OPERATIONS_AND_PRIVACY.md` 定义。删除内容后保留最小 tombstone（ID、删除时间、类别、digest 不可逆摘要）以防旧同步/恢复重新导入；tombstone 不保留原文。

## 7. 迁移、备份与恢复

迁移文件命名 `V<from>_to_V<to>_<name>`，具备：precheck、up、verify、可选 down（仅开发环境）。生产迁移遵循 expand → backfill → switch reader/writer → contract。

- 迁移前创建经过加密的本地备份或可靠 checkpoint，并检查可用空间。
- `migration_state=RUNNING` 时崩溃，启动后按 migration id 决定幂等继续或恢复备份。
- 不允许在一次迁移中同时重写全部大 Blob；使用后台分批任务和双读期。
- 降级到不支持当前 schema 的 App 时拒绝打开数据库，不做破坏性自动降级。
- 备份恢复后运行事件连续性、Blob digest、外键、projection checksum 和 key availability 检查。

## 8. 容量与性能

- 每个 run 的永久 delta 聚合目标不超过 1,000 条事件；超出时进行不丢事实的 compaction。
- 单个文本 Blob 默认上限 10 MiB，单 run 默认 100 MiB，可由企业策略收紧；超限只保存摘要、范围和外部 artifact 引用。
- Timeline 使用 `(run_id, sequence)` 游标分页，不使用大 offset。
- Profile 聚合按固定窗口，不在 UI 请求时扫描全部 Trajectory。
- 达到容量软阈值时提示清理并停止自动 Dream；达到硬阈值时禁止新 run，但允许导出、删除和恢复。

实际阈值由目标 PC 性能基准调整，调整不改变安全和数据完整性规则。

## 9. 数据模型测试

必须包括：

- 每个 schema 版本从最老受支持版本逐步迁移；
- 迁移每个事务点崩溃与重启；
- command/event 重复、版本冲突和 digest 冲突；
- 事件全量回放得到相同 projection checksum；
- Blob 丢失、损坏、密钥不可用和空间不足；
- 敏感/秘密字段扫描；
- 删除、tombstone、备份恢复和保留期清理；
- 10 倍目标规模的查询、启动恢复和 timeline 分页性能；
- 非终态 run 恢复后没有 active 可重放 lease。
- Agent 关键决策 100% 存在 committed record，且 route/intent/verdict/probe/memory 事件可追溯到对应 `decisionId`；
- 决策候选、证据和 feature snapshot 在 outcome 写入后保持字节级不变；
- 决策 DAG 拒绝非法环、跨 run 引用和伪造 Agent 身份；
- 常规表、事件 payload、导出和支持包扫描不到 prompt、reasoning token、隐藏思维链或秘密。
- learning sample assessment 的版本切换、证据删除失效、cohort 隔离和 outcome-leakage fixture。
