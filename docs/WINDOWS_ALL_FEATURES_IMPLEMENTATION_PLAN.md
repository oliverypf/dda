# Windows 全功能优先实施计划

版本：v1.1  
状态：当前执行计划  
执行确认：2026-09-05，用户确认以本计划 W0–W10 为当前实施和验收目标。  
适用范围：Windows 本地客户端、Tauri bridge、Node/Cordis runtime  
前置状态：`Windows MVP / Phase 1 前置版本`

## 2026-09-15 执行补充

Windows 阶段二、三及 durable/反馈/Git 专项的剩余工作统一见 [阶段四实施计划](WINDOWS_PHASE4_IMPLEMENTATION_PLAN.md) 和 [阶段四验收矩阵](WINDOWS_PHASE4_ACCEPTANCE_MATRIX.md)。阶段四仅覆盖 Windows，保留本文件的 W0–W10 完成定义与既有发布门；下文初始阶段描述不作为当前逐项完成状态。2026-09-15 按用户要求取消 Windows App Server 接入，Windows 继续使用自研 Node/Cordis runtime；旧文档中的 App Server 设想不再构成本阶段开发或发布前置条件。

## 1. 总原则

本文件是当前执行总计划；`WINDOWS_PHASE_1_IMPLEMENTATION_PLAN.md` 是 W0–W7 的细化说明。发生范围或依赖冲突时以本文件为准。当前从 W0 开始，现有功能保留为开发基线，不视为已通过相应发布阶段。W1–W3 完成前暂停扩展自动 Dream、Memory 激活、Router 和 Plugin 放权，优先补齐事件、提交顺序和回放基础。

项目采用严格的单平台优先路线：先把 Windows 版本的全部计划内功能实现、集成、调试、实际使用和稳定性验收完成，再开始 HarmonyOS、Linux、Gateway 和跨设备能力。

在 Windows 全功能版本达到发布条件之前：

- 其他平台只维护领域契约、接口文档和必要的设计，不实现产品功能；
- 不为其他平台复制尚未在 Windows 验收的事件、状态机、安全或 ReadModel 语义；
- 不与 Windows 并行开发同一项能力；
- Windows 版本是唯一的功能验证平台和产品行为基线。

## 2. Windows 发布分层

Windows 版本按以下顺序推进：

| 阶段 | 发布标识 | 能力范围 |
| --- | --- | --- |
| 当前 | `WINDOWS_MVP_PRE_PHASE1` | 开发、调试和功能集成，不宣称通过 Phase 1 |
| Phase 1 | `WINDOWS_PHASE1_READ_ONLY` | 只读任务、事件持久化、全量回放、崩溃恢复、Decision Trace 和治理闭环 |
| Phase 1.5 | `WINDOWS_PHASE1_5_CONTROLLED` | 通过安全门后的受控写入、命令和网络能力 |
| Windows 全功能 | `WINDOWS_FULL_LOCAL` | Windows 计划内能力全部集成、稳定运行并经过实际使用验收 |

Phase 1 构建必须禁用 `CONTROLLED`。受控执行代码可以继续保留和测试，但不能在 Phase 1 发布配置或桌面 UI 中开放。只有 Phase 1.5 的安全测试和 Executor 权威复核全部通过后，才在 Windows 上重新开放。

## 3. Windows 全功能完成定义

`WINDOWS_FULL_LOCAL` 只有满足以下条件才能发布：

1. 所有 TaskRun 事实进入唯一 durable Harness Event Store，具备 event ID、run sequence、aggregate version、payload digest、record digest 和版本元数据。
2. 所有影响状态、成本、权限、审批或副作用的路径都遵守 commit-before-effect，并等待 durable commit。
3. ReadModel 可以从事件表清空后全量重建，校验事件序列、aggregate version、lastEventSequence 和 projection checksum。
4. 只读和受控 TaskRun 都支持取消、超时、崩溃、存储损坏和恢复；恢复不会重复执行动作或副作用。
5. Planner、Council、Verifier、诊断/停止、Memory Proposal、ActionIntent 和安全决策均保存真实候选、证据、快照、选择和结果事件。
6. `decisionCoverage=100%`，并达到 `optionCoverage`、`evidenceLinkRate`、`decisionOutcomeLinkRate` 发布阈值。
7. retention、删除、导出、Support Bundle、容量阈值、本地指标、迁移和恢复能力上线。
8. Windows runtime、Tauri bridge、桌面 ReadModel、模型适配、本地 Memory Journal、Jev Decision Plane、Thread、Plugin、Memory、Dream、Evolution 和 Controlled Executor 集成完成。
9. Phase 1.5 的 P0/P1 安全测试、PolicyLease 一次性消费、Executor 权威复核、恢复幂等和未授权副作用率为零全部通过。
10. Windows 版本通过自动化回归、故障注入、构建、安装升级、长运行和实际使用观察期。
11. 同角色多候选能力可用：候选扇出、扇出预算、确定性硬淘汰和 Jev Decision Plane 选择落地，选择与 fallback 不改变安全语义、不产生额外权限。

## 4. 实施阶段

### W0：冻结 Windows 产品范围和发布开关

交付内容：

- 增加 `WINDOWS_MVP_PRE_PHASE1`、`WINDOWS_PHASE1_READ_ONLY`、`WINDOWS_PHASE1_5_CONTROLLED` 和 `WINDOWS_FULL_LOCAL` release channel；
- runtime、Tauri command 和 desktop UI 三层实现 Phase 1 的 `READ_ONLY` fail-closed；
- Phase 1 隐藏或禁用 Controlled mode；
- health、dashboard 和 Support Bundle 显示 release channel；
- 定义旧 JSON/JSONL store 的只读导入和迁移策略，禁止新旧事实源并行写入。

验收：Phase 1 配置下工作区写入、shell、测试执行和外部网络副作用全部在执行前拒绝。

### W1：建立唯一 durable Harness Event Store

目标：将 `hmcodex.db` 作为 Windows 唯一事件事实源。

交付内容：

- Event Store 的追加、加载、序列、digest、事务、恢复和完整性检查；
- `trajectory_events`、`command_dedup`、`schema_metadata` 及必要的 run/projection 表；
- `UNIQUE(run_id, sequence)` 和 aggregate version 约束；
- payload/record digest、protocol/storage/app/policy/producer 版本；
- 单写入队列、事务提交 receipt、幂等、版本冲突和未知事件保留；
- 显式 migration、备份 checkpoint、迁移失败保护和旧数据导入工具。

验收：重复 command 不重复产生事件；中断、损坏、版本冲突和空间不足均 fail-closed，不继续后续动作。

### W2：统一 commit-before-effect

目标：不允许异步未提交事实成为后续状态或动作的依据。

改造范围：

- 将 `coordinator.recordEvent()` / `transition()` 收敛到 `recordEventAndFlush()` / `transitionAndFlush()` 或统一 facade；
- Trajectory、approval、execution state、role context、thread checkpoint 统一进入 Event Store；
- Tauri 只接收已提交的关键事件；
- 每个关键事件返回 event ID，并传递给 Decision Trace、Verifier、Outcome 和 Credit/Blame；
- 动作前提交 intent/decision/approval/lease，动作后提交 outcome，再允许进入终态。

覆盖 TaskRun 创建、分类、预检、路由、角色绑定、模型路由、Planner、Council、plan step、只读工具、Verifier、取消、超时、诊断、停止、恢复和最终结果。

### W3：实现 rebuild-read-model 和确定性回放

交付内容：

- runtime 的 `rebuild-read-model`、`replay-run` 和 `projection-check` 命令；
- ReadModel projection 和原子切换；
- desktop 启动、线程打开和恢复路径改为读取 projection/rebuild 结果；
- 全量回放按 `(runId, sequence)` 执行，校验序列、aggregate version、digest 和未知关键事件；
- 保存 `projectionVersion`、`lastEventSequence` 和 projection checksum。

验收：相同事件集重复重建得到相同终态和 checksum；run、timeline、approval、decision、memory、workspace 和 verifier 状态都可恢复。

### W4：重写 Decision capture 和验收指标

Decision Trace 必须覆盖：

- Classifier：分类候选、风险标签和能力需求；
- Router/Coordinator：角色、模型、Executor、fallback、预算和拒绝候选；
- Planner：真实计划候选、依赖、假设和信息缺口；
- Council/Judge：proposal、质疑、反例、排序、选中、淘汰和 ABSTAIN；
- Execution：只读操作、参数 digest、scope、重试/停止和实际 event ID；
- Verifier：证据采信/排除、verdict、缺口和继续/诊断/停止选择；
- Diagnostician：假设、区分性证据、probe 建议和排序；
- MemoryConsolidator：Memory Proposal 来源、冲突、合并和撤回建议。

每条 Decision 必须使用真实不可变的 decision-time snapshot，保存真实 candidates、evidence 和淘汰原因，在下游 effect 前完成 `COMMITTED`，结果后通过真实 event ID 追加 Outcome，不保存 prompt 原文、隐藏思维链或凭据。

新增验收能力：

- `runtime evaluate --run-id <id> --metric decision-coverage`；
- `runtime evaluate --run-id <id> --metric trace-integrity`；
- `runtime evaluate --run-id <id> --metric replay-checksum`；
- `runtime export-learning --run-id <id>`，缺失 coverage、证据、snapshot 或 outcome 时拒绝导出。

发布阈值：`decisionCoverage=100%`；有分支决策的 `optionCoverage=100%`；需要证据的决策 `evidenceLinkRate=100%`；已结算决策 `decisionOutcomeLinkRate=100%`。

### W5：故障注入、恢复和容量测试

必须覆盖：

- 事件写入前、中、提交后和 UI 推送前崩溃；
- 旧 JSON/JSONL 尾部损坏和 Event Store 事务损坏；
- 磁盘空间不足、单事件超限、数据库锁冲突和迁移中断；
- cancel、timeout、provider disconnect、approval denial 和 heartbeat watchdog；
- 进程重启、显式 resume、未知结果、duplicate、out-of-order、late event 和 unknown event；
- 多次 recovery 不重复写入 outcome、不重复激活 memory、不重复执行副作用；
- 10 倍目标规模的启动恢复、回放和 timeline 分页。

### W6：Phase 1 运维、隐私和容量能力

交付内容：

- run、thread、project 和全部本地数据的脱敏导出；
- Support Bundle，默认不包含源代码、用户输入、模型全文、命令正文和原始 Trajectory；
- retention index、异步 purge、删除进度、tombstone 和失败重试；
- 事件提交成功率、projection 延迟、未终态 run、回放耗时、存储占用、Decision 数量和未关联 Outcome 指标；
- 70%/85%/95% 容量阈值行为；
- prompt、reasoning、凭据和完整源码扫描；
- schema migration、备份 checkpoint 和恢复校验。

### W7：Windows Phase 1 只读发布

必须完成 W0-W6，并通过：

- runtime、desktop、Tauri 测试和 Windows 构建；
- Phase 1 自动化副作用拒绝测试；
- regression、holdout、recovery、capacity 和 privacy fixture；
- ReadModel rebuild/checksum 报告；
- Decision Trace 指标报告；
- 新线程、连续任务、模型断线、取消、超时、进程重启、projection 重建、导出和删除手工验收。

验收结果：`WINDOWS_PHASE1_READ_ONLY`。这不是其他平台开发的启动条件，必须继续完成 W8-W10。

### W8：Windows Phase 1.5 Controlled 安全门

阶段二的细化执行顺序、并行轨道和验收门见 [Windows 阶段二实施计划](WINDOWS_PHASE2_IMPLEMENTATION_PLAN.md)。

在 Windows 上完成并验证受控写入、命令和网络能力：

- ActionIntent、Approval、PolicyLease、Restricted Executor、Verifier 和 recovery 的统一事件记录；
- Executor 权威侧重新校验路径、命令、网络目标、scope、lease、policy 和 binding snapshot；
- lease 一次性消费、过期、撤销、拒绝、执行未知和恢复幂等；
- P0/P1 threat、mutation、property、路径穿越、命令注入、网络绕过和秘密扫描测试；
- Windows Controlled UI、审批、取消和失败恢复。

验收：所有副作用都有 intent/approval/lease/outcome/evidence 链，未授权副作用率为零，重试和 recovery 不重复副作用。之后才能发布 `WINDOWS_PHASE1_5_CONTROLLED`。

### W9：Windows 计划内功能完整集成

将所有 Windows 计划内功能接入同一套 Event Store、ReadModel、权限和运维链路：

- OpenAI Responses、Chat Completions、兼容网关和 DeepSeek Harness；
- 同角色多候选扇出与选择：候选扇出、扇出预算、硬淘汰、Jev 选择和 `SELECT_CANDIDATE` 决策记录；
- Thread 创建、恢复、fork、checkpoint、取消、超时和 watchdog；
- workspace snapshot、只读工具、Controlled Executor、Rule Verifier、Jev 和 recovery；
- Plugin manifest、权限、治理、quarantine、加载和升级；
- Memory Journal、Jev 证据判断、Dream maintenance、retention 和撤回；
- Evolution proposal、replay、shadow、canary、promotion、monitor 和 rollback；
- Tauri dashboard、trajectory、decision、approval、memory、dream、plugin、evolution、recovery 和 Support Bundle UI；
- 本地 Memory Journal、Jev 超时/不可用降级和 Decision Trace。

验收：每个模块没有绕过 Event Store 的第二事实源；每个自动能力都有 feature gate、版本、回滚点和安全失败路径。

### W10：Windows 全功能稳定性和实际使用验收

必须完成：

- Windows 全量构建、安装、升级、迁移和卸载验证；
- 长运行、并发 TaskRun、存储增长、恢复时间和 UI 性能测试；
- 真实 Windows 工作区的只读和受控任务试用；
- 新线程、连续任务、模型切换、插件治理、Memory/Dream、Evolution、审批、取消、恢复、导出、删除和 Support Bundle 全流程；
- 失败数据、隐私扫描、容量阈值和回滚演练；
- protocol、storage、policy、producer、plugin 和 model registry 版本记录。

验收结果：`WINDOWS_FULL_LOCAL`。发布并完成实际使用观察期后，才允许创建其他平台的功能实现任务。

## 5. 严格依赖顺序

`W0 发布边界 → W1 Event Store → W2 提交顺序 → W3 回放投影 → W4 Decision Trace → W5 故障测试 → W6 运维治理 → W7 Phase 1 只读 → W8 Phase 1.5 受控 → W9 Windows 功能集成 → W10 Windows 全功能验收`

W10 完成前禁止：

- 实现 HarmonyOS、Linux、Gateway 或跨设备产品功能；
- 为其他平台复制 Windows 尚未验收的能力；
- 通过摘要、重试或 UI fallback 掩盖事件丢失；
- 在 Phase 1 重新开放 Controlled；
- 拆分平台专属实现分支来绕过 Windows 验收。

## 6. Windows 完成后的平台路线

`WINDOWS_FULL_LOCAL` 发布并完成实际使用观察期后，才开始：

1. 抽取 Windows 已验收的 contracts fixture、Harness Event、ReadModel replay、Decision Trace、安全和运维验收为跨平台行为测试；
2. 实现 Linux 本地存储、Executor、Tauri 和运维适配；
3. 实现 HarmonyOS relationalStore、ArkUI ReadModel、设备能力门控和生命周期适配；
4. 最后接入 Gateway、跨设备接续和企业策略场景。

所有其他平台必须复用 Windows 已验收的领域事件、状态机、回放、安全、隐私和运维契约。

## 7. 参考规范

- [长期设计索引](LONG_TERM_DESIGN_INDEX.md)
- [数据模型](DATA_MODEL.md)
- [状态机](STATE_MACHINE.md)
- [Decision Trace](DECISION_TRACE_SPEC.md)
- [评价与发布治理](EVALUATION_PLAN.md)
- [运维与隐私](OPERATIONS_AND_PRIVACY.md)
- [安全模型](SECURITY_MODEL.md)
- [多平台架构](MULTI_PLATFORM_ARCHITECTURE.md)
