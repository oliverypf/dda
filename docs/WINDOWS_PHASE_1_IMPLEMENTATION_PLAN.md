# Windows Phase 1 实施计划

版本：v1.0  
状态：实施中，M0 发布门控已实现，尚未完成 Phase 1 验收  
定位：Windows 全功能计划 W0–W7 的细化说明；执行范围和平台启动条件以 `WINDOWS_ALL_FEATURES_IMPLEMENTATION_PLAN.md` v1.1 为准。  
适用范围：Windows 本地客户端、Tauri bridge、Node/Cordis runtime  
前置版本：`Windows MVP / Phase 1 前置版本`

## 1. 目标与发布边界

本阶段先完成 Windows 版本的 Phase 1 闭环。HarmonyOS、Linux、Gateway 和跨设备能力暂不进入实现主线；它们只保留现有契约和接口边界。Phase 1 验收后继续总计划 W8–W10，Windows 全功能版本验收和实际使用观察期完成后再开始其他平台实现。

Phase 1 目标构建采用只读发布策略：

- 允许模型调用、工作区读取、文本预览、摘要、验证和只读工具；
- 禁止工作区写入、shell、测试执行和外部网络副作用；
- `CONTROLLED` 的安全执行实现暂时保留，但在 Phase 1 发布配置和桌面 UI 中禁用；
- `CONTROLLED` 只有在 Phase 1.5 的威胁测试、Executor 权威复核和未授权副作用率为零之后重新开放；
- 当前开发版本明确标记为 `Windows MVP / Phase 1 前置版本`，不宣称已经通过 Phase 1 发布门。

Phase 1 不改变长期架构原则：`contracts/` 仍是跨平台领域契约，Windows 只先实现其中一套完整适配；平台差异不能反向污染 Harness Event、TaskRun、Decision Trace 或 ReadModel 语义。

## 2. 完成定义

Windows Phase 1 只有同时满足以下条件才算完成：

1. 所有 TaskRun 事实进入唯一的 durable Harness Event Store，事件具备唯一 ID、run 内序列、aggregate version、payload digest、record digest 和版本元数据。
2. 影响状态、成本、权限、审批或副作用的下游路径，在动作发生前等待对应事件 durable commit。
3. ReadModel 可以从事件表清空后全量重建，重建过程校验序列、aggregate version 和 projection checksum。
4. 只读 TaskRun 支持取消、超时、进程崩溃、存储损坏和恢复后的确定性回放；恢复不会重复执行任何动作。
5. Planner、Council、Verifier、诊断/停止和 Memory Proposal 的 Decision Trace 保存真实候选、事前证据、快照引用、选择和实际结果事件。
6. `decisionCoverage=100%`；`optionCoverage`、`evidenceLinkRate` 和 `decisionOutcomeLinkRate` 达到发布阈值，缺失数据不能进入学习或导出流程。
7. 最小 retention、删除、导出、Support Bundle、容量阈值和本地指标能力上线。
8. Windows runtime、Tauri bridge、桌面 ReadModel 的回归、故障注入和手工使用验收全部通过。

## 3. 当前基线

当前实现已具备以下基础：

- Windows `runtime -> Tauri -> desktop ReadModel` 主链路；
- 默认 `READ_ONLY` 和工作区只读工具；
- RuntimeSafetyMonitor、Approval、PolicyLease、Restricted Executor、Verifier 和 recovery 基础模块；
- TaskRun、Thread、Trajectory、Decision Trace、Execution State 等独立 JSON/JSONL 持久化模块；
- 历史基线：runtime `210/210`、desktop `19/19`、Tauri Rust `14/14` 测试通过；当前 runtime 已扩展并验证为 `359/359`，desktop/Tauri 结果以最近一次独立命令为准。

当前基线仍存在以下 Phase 1 阻断项：

- 多个持久化事实源没有统一事件事务；
- Coordinator 事件会异步写入，不能作为统一 durable commit；
- Trajectory 和 TaskRun 历史存在硬上限，没有不丢事实的 compaction；
- 桌面 replay 只恢复最多 512 条 timeline 事件，不能重建完整 ReadModel；
- 实际 Decision capture 使用空 evidence、单一 selected option 和虚拟 snapshot ID；
- Memory Proposal 没有对应 MemoryConsolidator Decision；
- 没有 `decisionCoverage` 等发布指标验收命令；
- retention、删除、导出、Support Bundle 和容量治理尚未形成完整产品能力。

## 4. 实施阶段

### M0：冻结 Windows Phase 1 发布范围

目标：先消除产品定位和安全边界歧义。

交付内容：

- 增加明确的 release channel / feature gate，例如 `WINDOWS_MVP_PRE_PHASE1` 和 `WINDOWS_PHASE1_READ_ONLY`；
- Phase 1 配置拒绝 `CONTROLLED`，runtime、Tauri command 和 desktop UI 三层都 fail-closed；
- 保留受控执行代码和单元测试，但把重新开放条件写入 Phase 1.5 门槛；
- 在 health、dashboard 和支持信息中显示当前 release channel；
- 为旧 JSON/JSONL store 定义迁移或只读导入策略，禁止新旧事实源并行写入。

验收：

- Phase 1 配置下任何写入、shell、测试或网络副作用都在执行前被拒绝；
- `CONTROLLED` 不再从桌面 UI 暴露；
- 现有只读回归不受影响。

依赖：无。M0 完成后才进入核心存储改造。

### M1：建立唯一 durable Harness Event Store

目标：将 `hmcodex.db` 作为 Windows Phase 1 的唯一事件事实源，查询投影和兼容缓存不能取代它。

建议新增或重构：

- `runtime/src/harness-event-store.mjs`：事件追加、加载、序列、digest、事务和恢复；
- `runtime/src/harness-store-schema.mjs`：Storage Schema、migration 和完整性检查；
- `runtime/src/harness-event-store.test.mjs`：并发、重复、损坏和迁移测试；
- 由 Tauri/desktop 通过 runtime 读取，不在 UI 侧另建事实源。

最低能力：

- `trajectory_events`、`command_dedup`、`schema_metadata` 和必要的 run/projection 表；
- `UNIQUE(run_id, sequence)`、`UNIQUE(aggregate_type, aggregate_id, aggregate_version)`；
- payload digest、record digest、producer/policy/storage/protocol 版本；
- 单写入队列和事务提交确认；
- command/event 幂等、版本冲突、重复提交和未知事件保留；
- 启动完整性检查、显式 migration、迁移失败保护和备份 checkpoint；
- 从旧 Trajectory/TaskRun 文件导入时只生成带来源标记的新事件，不覆盖原文件。

验收：

- 事件追加返回 durable commit receipt；
- 进程在写入各阶段中断后，重启不会产生半条可见事件或错误序列；
- 重复 command 不重复产生事件；
- 任何损坏、版本冲突或空间不足都会 fail-closed，不继续执行后续动作。

依赖：M0。M1 完成前不进行大范围 runtime 事件迁移。

### M2：统一 commit-before-effect 写入路径

目标：所有会影响状态、成本、权限或外部结果的路径都经过同一 durable commit。

实施范围：

- 将 `coordinator.recordEvent()` / `transition()` 的直接调用收敛到 `recordEventAndFlush()` / `transitionAndFlush()` 或等价的统一 facade；
- 所有 `trajectory.append()`、approval、execution state、role context 和 thread checkpoint 的权威事件改由 Event Store 提交；
- runtime event 推送给 Tauri 前先确保关键事件已提交；
- UI 流式 delta 可以作为临时显示数据，但不得作为状态事实或授权依据；
- 每个关键事件返回 `eventId`，并将该 ID 传给 Decision Trace、Outcome、Verifier 和 Credit/Blame；
- 在动作前提交 intent/decision/approval/lease 的必要事件，在动作后提交 outcome，再允许状态进入终态。

关键覆盖点：

- TaskRun 创建、分类、预检、路由、角色绑定和模型路由；
- Planner 计划、Council review、plan step 状态；
- 只读工具选择、读取结果和验证；
- 取消、超时、诊断、停止和恢复；
- 线程 checkpoint、恢复来源和最终结果；
- Phase 1 中仍需记录并拒绝的受控副作用 intent。

验收：

- 通过故障注入证明“事件未 durable commit 时不会发生下游状态变化或副作用”；
- Tauri 收到的关键事件都能在 Event Store 中按 event ID 查到；
- 运行失败时可以区分“未执行”“执行结果未知”和“执行后验证失败”。

依赖：M1。

### M3：实现 rebuild-read-model 和确定性回放

目标：桌面 ReadModel 从事件重建，而不是依赖前端进程中的增量状态。

建议新增或重构：

- `runtime/src/read-model-rebuilder.mjs`；
- `runtime/src/read-model-projection.mjs`；
- `runtime` 的 `rebuild-read-model`、`replay-run` 和 `projection-check` 命令；
- desktop 启动、线程打开和恢复路径改为读取 projection/rebuild 结果。

重建流程：

1. 进入只读维护模式，停止新的写入和新 TaskRun；
2. 创建临时 projection；
3. 按 `(runId, sequence)` 回放全部事件；
4. 校验事件序列连续、aggregate version 连续、event digest 正确；
5. 对未知关键事件保留 envelope 并将聚合标记为 `PAUSED_UNSUPPORTED`；
6. 计算 projection checksum 和 lastEventSequence；
7. 与保存的 projection checksum 比较；
8. 通过后原子切换 projection，失败则保留旧 projection 并输出无内容诊断。

验收：

- 同一事件集重复重建得到相同终态、checksum 和 lastEventSequence；
- ReadModel 不再依赖固定 512 条事件或前端本地增量状态；
- run、timeline、approval、decision、memory、workspace 和 verifier 状态都可以从事件/投影关系恢复；
- 未知事件不会被静默跳过。

依赖：M1、M2。

### M4：重写 Decision capture 和发布指标

目标：让实际 runtime 产生的 Decision Trace 满足规范，而不是只通过独立模块测试。

Decision capture 要求：

- Classifier：记录分类候选、风险标签、能力需求和低置信分支；
- Router/Coordinator：记录角色、模型、Executor、fallback、预算和拒绝候选；
- Planner：记录真实 plan candidates、依赖、假设、信息缺口和选择；
- Council/Judge：记录 proposals、质疑、反例、排序、选中、淘汰和 ABSTAIN；
- Execution：记录只读操作、参数 digest、scope、重试/停止和对应 Action/Read event；
- Verifier：记录证据采信/排除、verdict、缺口、继续/诊断/停止选择；
- Diagnostician：记录假设、区分性证据、probe 建议和排序；
- MemoryConsolidator：在写入 Memory Proposal 前先提交 decision，记录来源、冲突和合并/撤回建议。

每个 Decision 必须：

- 引用真实、不可变的 decision-time feature/binding/constraint snapshot；
- 至少包含实际考虑过的候选和结构化淘汰原因；
- 引用已经存在的事前 evidence event；
- 在 downstream effect 前完成 `COMMITTED`；
- 在结果产生后通过真实 `executionEventIds`、`verifierReportIds` 或 `userFeedbackEventIds` 追加 Outcome；
- 不保存 prompt 原文、隐藏思维链或凭据。

新增验收命令建议：

- `runtime evaluate --run-id <id> --metric decision-coverage`；
- `runtime evaluate --run-id <id> --metric trace-integrity`；
- `runtime evaluate --run-id <id> --metric replay-checksum`；
- `runtime export-learning --run-id <id>`，缺失 coverage、证据、snapshot 或 outcome 时拒绝导出。

最低指标：

- `decisionCoverage=100%`；
- `evidenceLinkRate=100%`（允许明确标记为 `NO_EVIDENCE_REQUIRED` 的纯规则决策）；
- 有真实分支的决策 `optionCoverage=100%`；
- 已结算决策 `decisionOutcomeLinkRate=100%`；
- outcome、Verifier 结论和后续证据不能回写或改变 decision-time snapshot。

依赖：M2、M3。

### M5：故障注入、恢复和容量测试

目标：验证 Phase 1 的恢复不是“正常路径测试通过”，而是异常中断后仍保持事实一致。

必须覆盖：

- runtime 在事件写入前、写入中、提交后、UI 推送前崩溃；
- JSON/JSONL 旧 store 尾部损坏和新 Event Store 页/事务损坏；
- 磁盘空间不足、单事件超限、数据库锁冲突和迁移中断；
- cancel、timeout、provider disconnect、approval denial 和 heartbeat watchdog；
- 只读任务进程重启、恢复、显式 resume 和未知结果；
- duplicate、out-of-order、late event、unknown event 和版本冲突；
- 多次 recovery 不重复执行、不重复写入 outcome、不重复激活 memory；
- 10 倍目标事件规模的启动恢复、回放和 timeline 分页。

验收：

- 每个故障点都有明确状态、错误码和恢复动作；
- 未完成 run 不会被错误标为成功；
- Phase 1 没有任何写入、shell 或网络副作用；
- 重建前后 checksum 一致；
- 数据库满或损坏时停止新任务，允许安全诊断、恢复、导出和删除。

依赖：M1、M2、M3。

### M6：最小运维、隐私和容量能力

目标：满足 Phase 1 的最小可用治理，而不是把数据治理推迟到多平台阶段。

交付内容：

- 按 run、thread、project 和全部本地数据的脱敏导出；
- Support Bundle：版本、设备能力、配置 schema、组件状态、错误码、trace/decision 关系元数据、性能/容量和脱敏日志；
- retention index、异步 purge、删除进度、tombstone 和失败重试；
- 本地指标：事件提交成功率、投影延迟、未终态 run、回放耗时、存储占用、Decision 数量和未关联 Outcome；
- 70%/85%/95% 容量阈值行为；
- 关键字段扫描，确保 prompt 原文、reasoning、凭据和完整源码不会进入普通事件、导出或 Support Bundle；
- schema migration、备份 checkpoint 和恢复校验。

验收：

- 导出和 Support Bundle 默认不含源代码、用户输入、模型全文、命令正文和原始 Trajectory；
- 删除后只保留最小 tombstone，不能通过旧 projection 或缓存恢复原文；
- 容量达到硬阈值时阻止新 run，但允许恢复、删除和导出；
- 指标和日志本身不泄露敏感内容。

依赖：M1、M3、M5。

### M7：Windows Phase 1 发布验收

发布前必须完成：

- runtime、desktop、Tauri 测试和 Windows 构建；
- runtime、desktop、TypeScript 和 Tauri 的独立测试套件必须通过 `desktop` 下的 `npm run test:all:parallel` 并行启动并汇总全部结果；共享安装进程/本地 store 的 UI 套件在其后顺序执行（详见 `WINDOWS_TESTING_WORKFLOW.md`）；
- Phase 1 read-only build 的自动化副作用拒绝测试；
- regression、holdout、recovery、capacity 和 privacy fixture；
- 完整 ReadModel rebuild 与 checksum 报告；
- Decision Trace 指标报告；
- Support Bundle 内容扫描；
- 手工使用场景：新线程、连续任务、模型断线、取消、超时、进程重启、重建 projection、导出和删除；
- release channel、storage schema、protocol、policy 和 producer 版本记录。

发布结果分为：

- `WINDOWS_MVP_PRE_PHASE1`：当前开发/调试版本，允许继续修复和观测，不满足 Phase 1 声明；
- `WINDOWS_PHASE1_READ_ONLY`：通过本计划 M0-M7，只有只读能力；
- `WINDOWS_PHASE1_5_CONTROLLED`：另行通过 Phase 1.5 安全门后，才允许 Controlled executor。

## 5. 依赖和禁止事项

实现顺序固定为：

`M0 发布边界 → M1 Event Store → M2 提交顺序 → M3 回放投影 → M4 Decision Trace → M5 故障测试 → M6 运维治理 → M7 Windows 验收`

在 M1-M3 完成前，不做以下工作：

- 不新增更多平台实现；
- 不扩展自动 Dream、自动 Memory 激活、自动 Router 或自动 Plugin 放权；
- 不把 desktop 增量状态继续扩展成新的事实源；
- 不通过增加摘要、重试或 UI fallback 掩盖事件丢失；
- 不在 Phase 1 重新开放 `CONTROLLED`。

## 6. Windows 验收后的平台路线

Windows Phase 1 通过后继续完成全功能计划 W8–W10；只有 `WINDOWS_FULL_LOCAL` 发布并完成实际使用观察期后，再按以下顺序推进：

1. 将 contracts fixture、Harness Event、ReadModel replay 和 Decision Trace 验收抽取为跨平台行为测试；
2. 实现 Linux 的本地存储、Executor 和 Tauri 适配；
3. 实现 HarmonyOS 的 relationalStore、ArkUI ReadModel 和平台能力门控；
4. 最后接入远程 Gateway、跨设备接续和企业策略场景。

其他平台必须复用 Windows 已验收的领域事件、状态机、回放和安全契约，不能为绕过 Windows 阶段的缺口而单独发明一套语义。

## 7. 参考规范

- [长期设计索引](LONG_TERM_DESIGN_INDEX.md)
- [数据模型](DATA_MODEL.md)
- [状态机](STATE_MACHINE.md)
- [Decision Trace](DECISION_TRACE_SPEC.md)
- [评价与发布治理](EVALUATION_PLAN.md)
- [运维与隐私](OPERATIONS_AND_PRIVACY.md)
- [安全模型](SECURITY_MODEL.md)
- [多平台架构](MULTI_PLATFORM_ARCHITECTURE.md)
