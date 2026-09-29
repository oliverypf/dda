# Windows 阶段二实施计划

版本：v1.1  
制定日期：2026-09-09  
更新：2026-09-10 增加 S2-12「多候选扇出与选择」，原 W10 发布包改为 S2-13  
状态：阶段一完成后的执行计划  
上位计划：[Windows 全功能优先实施计划](WINDOWS_ALL_FEATURES_IMPLEMENTATION_PLAN.md)

> **架构更新（2026-09-22）**：本文的阶段二工作包和历史状态保留用于追溯，不再把 OpenViking、LLM-as-a-Verifier、独立语义 Verifier 或 Candidate Judge 作为当前需求。当前运行时决策基线是 [Jev Decision Plane 设计](JEV_DECISION_PLANE_DESIGN.md)：证据 → Jev → 硬安全边界 → 执行。

## 1. 阶段定位

阶段一按 W0–W7 完成并发布为 `WINDOWS_PHASE1_READ_ONLY`。阶段一已经覆盖只读任务、唯一 Harness Event Store、commit-before-effect 基础、全量回放、崩溃恢复、Decision Trace、运维/隐私/容量能力，以及 Windows 安装包和 UI 验收。

30 天 retention 日历观察作为发布后的持续运维项继续运行，不阻塞阶段二开发；观察任务结束后仍需把 M6 矩阵的 `PARTIAL` 更新为 `PASS`。它不改变阶段二的副作用安全门。

阶段二的第一发布目标是 `WINDOWS_PHASE1_5_CONTROLLED`：在 Windows 上开放受严格约束的文件写入、命令、测试和明确允许的网络动作。只有 W8 安全门全部通过后，才进入 W9 的全功能集成；W9 完成后再做 W10 的稳定性和实际使用验收，最终目标为 `WINDOWS_FULL_LOCAL`。

```text
阶段一：WINDOWS_PHASE1_READ_ONLY       已完成（retention 观察继续）
    │
    ▼
阶段二 W8：WINDOWS_PHASE1_5_CONTROLLED 安全门
    │
    ▼
阶段二 W9：Windows 计划内功能完整集成
    │
    ▼
阶段二 W10：稳定性、实际使用和 WINDOWS_FULL_LOCAL 发布
```

## 2. 当前未完成项

### 2.1 W8：受控副作用安全门尚未发布

代码中已经有 `RuntimeSafetyMonitor`、`ActionIntent`/执行状态、Approval、PolicyLease、`RestrictedWindowsExecutor`、受控工具和恢复测试，但这些能力仍处于开发/单元测试状态，尚未以 `WINDOWS_PHASE1_5_CONTROLLED` 完成跨层发布验收。缺口是：

- 受控 release channel 的构建、安装、升级、回滚和桌面门控；
- 每个副作用从候选、Decision、ActionIntent、SafetyDecision、Approval、一次性 PolicyLease、Executor 到 Outcome/Verifier 的完整事件链；
- Executor 最后时刻重新校验 canonical path、命令、cwd、环境、网络目标、workspace snapshot、binding 和 lease，防止 TOCTOU 或 UI 状态过期；
- lease 的持久化、compare-and-set 消费、过期、撤销、断线、取消、策略收紧和 double-spend 处理；
- Windows 文件、命令、测试和网络边界的 P0/P1 threat、mutation、property、故障注入测试；
- 受控 UI 的审批详情、一次性语义、过期/拒绝/替代、取消和未知结果恢复；
- 多进程并发写入同一 workspace、进程树清理和副作用恢复的真实 Windows 验收。

### 2.2 W9：已有模块尚未完成全功能集成（历史计划口径）

- 旧版 OpenViking ContextPort/sidecar 方案已从当前架构移除；当前上下文使用本地 Memory Journal，Jev 通过 DecisionEngine 接收有界证据；旧 sidecar 条目仅用于历史证据追溯；
- Plugin manifest、loader 和 governance 已存在，但动态插件在阶段一关闭，尚未完成生产级签名/撤销、side-by-side 升级、配置迁移、self-test、shadow、quarantine、回滚和 UI 管理闭环；
- Thread/Turn 基础和本地 fork/checkpoint 已有实现，仍需补齐完整的 list/resume/fork、外部 Adapter 身份变化、跨进程恢复和用户输入请求语义；
- Feedback/ModelScenarioProfile/Bayesian 已有 runtime 基础，桌面目前主要展示脱敏摘要，尚未完成用户提交/修订/撤回、模型/角色精确归因、shadow 结果进入安全候选排序和完整评估报告；
- Dream/Memory 目前保持“生成提案、人工确认”的安全边界，尚未完成撤回、冲突、证据删除后的不可训练标记、完整 UI 和稳定后台策略；
- Evolution 已有 proposal/evaluator 的 replay、shadow、canary、promotion、monitor、rollback 基础，尚未完成真实 Windows 发布流程、kill switch、自动回滚和版本漂移监控；
- Dashboard 已有核心治理摘要，尚未覆盖完整 Decision DAG、Approval/Lease 详情、Verifier 证据、Recovery、OpenViking、Plugin、Memory、Dream 和 Evolution 的交互验收；
- runtime 当前仍按任务短命启动，长期驻留、并发 TaskRun、资源预算和跨组件生命周期仍需 W10 验收。

### 2.3 旧 LLM as a Verifier 状态（已废弃）

这项能力属于历史候选版本的实现记录，不是当前 runtime 设计：

- `runtime/src/agent-turns.mjs` 已实现 `runSemanticVerifierTurn`，它使用配置的模型 provider 发起独立、无工具权限的语义验证回合；
- `runtime/src/index.mjs` 在 `agentMode=multi` 的每个计划步骤中先运行确定性 `RuleVerifier`，再调用语义 Verifier；模型输出被解析为结构化 `PASS`/`FAIL`/`ABSTAIN`，无效或调用失败会安全降级为 `ABSTAIN`；
- 语义结果会进入 Verification 事件、Decision/Outcome 关联和最终脱敏任务结果；已有 `agent-turns.test.mjs`、`plan-step-runtime.test.mjs` 和恢复用例覆盖独立上下文、无工具、结构化输出、ABSTAIN 和“不能覆盖硬规则”等行为；
- 默认 `agentMode=single` 不调用 LLM Verifier；多角色模式下如果没有可用 binding 也只会 `ABSTAIN`。当前默认语义 Verifier 可能与 Planner/Executor 使用同一个模型配置，虽然上下文隔离，但还没有完成高风险场景必须使用独立模型或独立 provider 的发布门；
- 当前 LLM verdict 是语义证据之一，不能替代 RuleVerifier、Safety Monitor、Approval、PolicyLease 或独立执行事实；它还没有完成受控副作用场景的真实 Windows 验收、P0/P1 对抗测试、完整 Verifier 状态映射（`CONTINUE/STALLED/UNCERTAIN`）和完整 UI 证据展示。

因此，LLM as a Verifier 不再进入后续实现、配置或发布验收；当前行为判断统一迁移到 Jev Decision Plane，Rule Verifier 和 Runtime Safety 保留为硬边界。

### 2.4 多候选扇出与选择（已迁移到 Jev）

历史版本的 `ModelSelector` 只解析单个模型；当前候选并发生成后，由 Jev Decision Plane 基于证据在有限集合中选择：

- `ModelSelector` 没有 `CANDIDATE_SET` 扇出模式，`ModelInvocationGateway` 只有单次调用语义；
- `CandidateSelectionPolicy` 不再调用独立 judge；硬淘汰由确定性检查完成，选择/拒绝/补证据由 Jev 完成，并有显式保守 fallback；
- Decision Trace 没有 `SELECT_CANDIDATE` 决策类型，候选草稿只以 `outputDraftDigest` 字段预留；
- 成本、出域记录和 Support Bundle 边界尚未按候选粒度展开。

现有 `RANK_PROPOSALS` 决策类型和 `outputDraftDigest` 字段可以复用，但契约需要先补齐。因此该能力属于“契约已预留、实现未开始”，阶段二在 W9 集成轨道内完成，见 S2-12。

### 2.5 W10：全功能发布证据尚未形成

- `WINDOWS_FULL_LOCAL` 构建、安装、升级、迁移、回滚和卸载全流程；
- 长运行、并发任务、数据库增长、恢复时间、UI 帧率和事件 backlog 的 SLO 证据；
- 真实 Windows 工作区上的只读和受控任务试用；
- 模型切换、Thread 连续任务、插件治理、Memory/Dream、Evolution、审批、取消、恢复、导出、删除和 Support Bundle 全流程；
- 失败数据、隐私扫描、容量阈值、备份恢复和 rollback 演练；
- 30 天 retention 观察闭项以及发布后实际使用观察期。

HarmonyOS、Linux、Gateway、跨设备和其他平台功能继续遵守总计划约束：在 W10 完成并通过 Windows 实际使用观察期前，只维护契约和设计，不启动产品功能实现。

## 3. 阶段二工作包

工作包编号用于任务、分支、测试报告和发布证据命名。括号中的“并行”表示可以由独立 agent/分支同时开发；“依赖”表示必须先完成的接口或发布门。

### S2-00 基线冻结与安全门准备（串行起点）

交付：

- 固定阶段一发布包、Event Store schema、Protocol/Policy/Producer 版本和 Phase 1 数据备份；
- 建立 `WINDOWS_PHASE1_5_CONTROLLED` 的配置矩阵，明确默认关闭、显式启用、开发模式和发布模式的差异；
- 将现有 controlled 单测、真实 UI 测试、Phase 1 并行测试入口纳入阶段二 CI；
- retention 观察单独记录，不把观察进度写入受控授权逻辑。

验收：阶段一 `npm run test:all:parallel` 仍通过，所有阶段一回归和 read-only 副作用拒绝结果可复现。

### S2-01 Controlled channel 与跨层 feature gate（串行）

交付：

- runtime、Tauri bridge、desktop UI 三层只接受合法 channel/mode 组合；
- Phase 1 永远拒绝 `CONTROLLED`，Controlled 版本必须在构建期固定 channel，环境变量不能覆盖发布包安全边界；
- 未配置 capability、workspace grant、Policy 或模型 binding 时默认拒绝；
- health、dashboard、Support Bundle 和日志显示实际 channel、policy、executor、plugin/model registry 版本。

验收：Phase 1、Controlled、非法 channel、非法 mode、缺失配置、过期配置各有跨层拒绝用例；拒绝发生在创建副作用 operation 之前。

### S2-02 ActionIntent 与 Safety Monitor 权威校验（可与 S2-03/S2-04 并行）

交付：

- 为文件、补丁、命令、测试、网络和进程动作定义统一 canonical intent；
- intent 固定 run/step/operation、role、model、plugin、workspace snapshot、path/command/network scope、参数 digest、policy 和 capability snapshot；
- 将候选过滤、SafetyDecision、风险等级、required controls 和拒绝原因写入 Event Store；
- Executor 侧在实际动作前重新规范化并比较所有 digest，任何不一致都 fail-closed；
- 将 secrets、完整 prompt、reasoning、完整命令环境和不必要源码排除在普通事件之外。

验收：路径、cwd、argv、环境、scope、snapshot、binding、policy、channel 任一字段改变都会拒绝旧 intent/lease，并生成可回放的安全事件。

### S2-03 ApprovalPort 与桌面审批闭环（可与 S2-02/S2-04 并行，依赖 S2-01 的 gate）

交付：

- Approval 请求只展示本次动作的类型、目标、cwd、命令/diff 摘要、网络目标、风险、sandbox、策略版本和有效期；
- `displayDigest` 覆盖用户实际看到的关键字段，回传 digest 不一致、过期、重复、跨 run 或已 supersede 均拒绝；
- UI 支持批准一次、拒绝、取消、过期、替代和断线后重新展示；
- Approval 状态先 durable commit，再唤醒等待中的 runtime；反馈失败不能把任务误标为已批准。

验收：审批前无副作用；拒绝/过期后零 Executor 调用；批准只允许当前 intent 重新经过 Safety Monitor，不能直接放行未来动作。

### S2-04 PolicyLease 生命周期与一次性消费（可与 S2-02/S2-03 并行）

交付：

- lease 绑定 intent、主体、Executor、workspace snapshot、scope、policy、channel 和 capability snapshot；
- `PROPOSED → ACTIVE → CONSUMING → CONSUMED` 与 `REVOKED/EXPIRED` 全部持久化；
- Executor 使用 compare-and-set 消费，`maxUses=1`；
- cancel、pause、断线、身份变化、策略收紧、workspace 变化和 recovery 立即撤销未消费 lease；
- 数据库失败、重复消费、进程崩溃和结果未知时 fail-closed，不复用原 lease。

验收：lease double-spend、scope mismatch、identity mismatch、channel mismatch、过期、撤销、重启和未知结果用例全部通过。

### S2-05 Windows Executor 与网络适配器（依赖 S2-02/S2-04）

交付：

- `RestrictedWindowsExecutor` 完成文件写入、patch、结构化命令、测试命令和进程树清理；
- 文件操作实现 canonical real path、symlink/junction/TOCTOU 检查、临时文件+原子替换、前后 digest 和 scope 复核；
- 命令使用 `executable + argv + cwd + envDelta`，禁止隐式 shell；需要 shell 时独立 action type 和更高风险级别；
- 子进程继承 timeout、输出大小、秘密扫描、取消和清理限制；
- 网络 capability 只允许显式 host/port/scheme/method/目标范围，DNS 解析、重定向、私网/metadata、响应大小和超时全部重新检查；
- Executor 只接受已验证的 lease presentation，不能从模型或插件输入生成 lease。

验收：真实 Windows workspace 上完成一个批准的安全写入、命令和测试；越权、路径穿越、链接替换、命令注入、环境泄密、网络绕过和超限全部阻断。

### S2-06 Coordinator、Verifier 与 Recovery 收敛（依赖 S2-02–S2-05）

交付：

- 将受控任务固定为 `intent → safety → approval → lease → execute → outcome → verifier` 顺序；
- 每个动作事件关联 `decisionId/eventId/intentId/approvalId/leaseId/operationId`；
- 取消、超时、断线、崩溃、未知结果、用户拒绝和 Verifier 不确定进入规定状态机；
- Recovery 只做状态查询、lease 撤销、证据校验和用户可见恢复，不直接重放副作用；
- 同一 workspace 同时最多一个持有可写 lease 的 ExecutionRole；
- 副作用已发生但结果未知时生成补偿/验证路径，不把失败消息当成“没有执行”。
- 将 Jev Decision Plane 纳入受控链路：高风险任务必须收集完整证据并经过 Action Gate；Jev 结果与 RuleVerifier 事实分开记录，不能覆盖硬失败；
- 统一 `PASS/FAIL/ABSTAIN` 与 `CONTINUE/STALLED/UNCERTAIN` 的映射，语义 Verifier 不能覆盖确定性硬失败，也不能单独授予成功或权限。

验收：重启和 recovery 任意重复执行都不会新增副作用；所有成功受控 run 都有独立 Verifier 证据，所有未知结果都保持 UNKNOWN/RECOVERING 语义。

### S2-07 Phase 1.5 安全测试与故障注入（可与 S2-06 后半段并行，依赖 S2-02–S2-05）

测试组：

- 路径：`..`、编码绕过、UNC/映射盘、symlink/junction、挂载、TOCTOU、设备名和 workspace 外路径；
- 命令：shell 元字符、重定向、命令替换、提权、后台进程、环境泄密、子进程逃逸和资源耗尽；
- 网络：DNS rebinding、重定向、私网/metadata、非 TLS、上传秘密、响应/带宽/并发超限；
- 授权：approval 内容替换、过期、重复、跨 run、lease 伪造、撤销和 double-spend；
- 内容：prompt injection、恶意仓库、跨 Agent 权限指令、恶意插件 manifest、秘密/PII/源码扫描；
- 恢复：写入前/中/后崩溃、数据库锁/损坏/空间不足、断线、取消、超时、未知结果和多次 recovery；
- 并发：多个 run 竞争 workspace lease、旧 UI command、迟到事件、重复 command 和 out-of-order event。

验收门：已知 P0/P1 case 阻断率 100%，`unauthorizedSideEffectCount=0`，`secretExposureCount=0`，Approval integrity 100%，恢复不重复副作用。

### S2-08 Controlled UI 与真实安装包验收（依赖 S2-06/S2-07）

交付：

- Controlled 模式设置、workspace grant、模型/角色 capability、审批卡片、执行/验证/恢复状态和安全历史；
- 只读与受控状态视觉上明确区分，不能通过过期 UI 状态直接执行；
- 真实安装包执行批准的安全动作和被阻断动作；
- UI 测试覆盖新任务、连续任务、批准/拒绝/过期、取消、超时、断线、重启、未知结果和恢复；语义 Verifier 的模型身份、结构化 verdict、证据引用和降级原因可查看。

验收：Controlled 安装包通过 `release-check`、安装/升级/卸载、UI 回归和安全场景后，才允许发布 `WINDOWS_PHASE1_5_CONTROLLED`。

### S2-09 本地 Memory Journal、Jev 与长期运行时（进入 W9，依赖 S2-08）

交付：

- 将 Memory Journal、证据快照和 Jev Decision Engine 纳入 Windows runtime；
- runtime 的 Jev 超时、不可用、证据不足和保守 fallback；
- evidence/decision/outcome 与 Thread/Turn、Memory、Dream 的事件和权限边界；
- 长期驻留 supervisor、心跳、资源预算、退出清理和故障恢复。

验收：Jev 或 Memory Journal 不可用时明确降级但不影响安全和只读会话；可用时上下文证据有来源、scope、digest 和使用记录。

### S2-10 Plugin 生产生命周期（进入 W9，依赖 S2-08）

交付：

- 签名、来源、manifest、API/protocol 兼容、package digest 和撤销列表；
- side-by-side 安装、配置 dry-run、self-test、shadow、原子激活和上一版本保留；
- capability/PermissionCeiling 交集、配额、异常映射、quarantine、恢复和回滚；
- UI 展示插件版本、权限、健康、证据和 quarantine 原因；
- 动态代码的 Windows 供应链边界明确，未签名开发插件不能进入发布模式。

验收：插件 hash/签名变化、越权、异常、超时、升级迁移失败和撤销命中均自动隔离；插件不能创建 Approval、PolicyLease 或直接调用 Executor。

### S2-11 Thread、Feedback、Memory、Dream、Evolution 完整集成（进入 W9，依赖 S2-08）

交付：

- Thread list/resume/fork/checkpoint、连续任务和外部 Adapter 身份变化；
- Feedback 提交、修订、撤回、幂等和用户可见状态；
- ModelScenarioProfile/Bayesian 只在安全过滤后的候选集合内做 shadow/advisory 排序，记录 cohort、版本、evidence window 和回退原因；
- Memory source、冲突、过期、撤回、删除和不可训练标记；Dream 仍受空闲/预算/锁/取消门控；
- Evolution 的 replay、shadow、canary、monitor、kill switch、promotion 和 rollback；
- Dashboard 展示 Decision DAG、Rule Verifier/Jev、Approval/Lease、Plugin、Memory、Dream、Evolution 和 Support Bundle。

验收：每个模块都从 Event Store/ReadModel 读取事实；任何 Bayesian、Dream 或 Evolution 异常都回退规则基线，不扩大权限；删除、导出、回滚后 UI 不复活已清理内容。

### S2-12 多候选扇出与选择（进入 W9，依赖 S2-08）

交付：

- 扩展 `ModelSelector` 契约增加 `CANDIDATE_SET`（候选绑定、`fanout`、`selectionPolicyRef`、`fanoutBudget`），默认 `fanout=1` 保持现有单候选行为；
- 将 `ModelInvocationGateway` 升级为扇出语义：并发上限、部分失败、超时、限流、去重和统一错误映射，至少一个候选成功即视为调用成功；
- 实现 `CandidateSelectionPolicy`：确定性检查硬淘汰 → Jev 基于证据选择；Jev 不可用时降级为确定性加成本/延迟排序并记录原因；
- 扇出规模按风险自适应并受预算约束；超预算时按确定性顺序截断候选集并记录截断原因；
- 新增 `SELECT_CANDIDATE` 决策类型，每个候选映射为一个 `DecisionOption`，选中项关联 Outcome，未选中项标记 `NOT_EXECUTED`；
- 安全回归：所有候选先过 `TaskSafetyPrecheck` 和 `CandidateSafetyFilter`，被拒候选不进入评分集合，选中项副作用仍走 intent/approval/lease 链；
- 成本、出域记录、脱敏和 Support Bundle 按候选粒度展开；候选评分按真实来源归因，不把选中项分数复制给所有参与模型；
- UI 展示候选集合、评分分量、淘汰原因和选择理由。

验收：默认 `fanout=1` 时行为与现状一致且无额外成本；`fanout>1` 时每个候选都有独立事件、评分和归属，未选中候选不产生副作用也不产生 Outcome；评分不能覆盖确定性硬失败；`unauthorizedSideEffectCount` 保持 0。

### S2-13 W10 稳定性与 `WINDOWS_FULL_LOCAL` 发布（依赖 S2-09–S2-12）

交付：

- 发布候选全量并行测试、回归/holdout/Safety Red Team、安装升级迁移回滚和卸载；
- 长运行、并发 TaskRun、事件增长、恢复时间、数据库锁、UI frame/jank、网络/模型延迟和成本报告；
- 真实 Windows 工作区的只读/受控任务观察期；
- 30 天 retention 观察结项、备份恢复、隐私删除、容量阈值和 kill switch 演练；
- 版本、SBOM、plugin/model lock、protocol/storage/policy/producer 以及发布决策报告。

验收结果：`WINDOWS_FULL_LOCAL`，并完成发布后的实际使用观察期；随后才启动 Linux、HarmonyOS、Gateway 和跨设备的产品实现。

## 4. 并行开发与测试规则

阶段二继续执行既定测试约定：runtime、desktop、TypeScript、Tauri 和独立安全测试必须并行启动并等待全部结果；UI 套件若共享同一个安装进程或本地 store，则在基础套件完成后顺序执行。规则见 [WINDOWS_TESTING_WORKFLOW.md](WINDOWS_TESTING_WORKFLOW.md)。

推荐的 agent/分支分工：

| 轨道 | 负责工作包 | 可并行条件 | 汇合点 |
| --- | --- | --- | --- |
| A Runtime Safety | S2-02、S2-04、S2-05 | S2-01 接口冻结后 | S2-06 |
| B Coordinator/Recovery | S2-06、事件链和 projection | S2-02 的事件/intent schema 冻结后 | S2-08 |
| C Tauri/Desktop | S2-03、S2-08 | S2-01 的 channel 和 Approval DTO 冻结后 | S2-08 |
| D Security/Evaluation | S2-07、fixture、release gate、指标 | S2-02–S2-04 的拒绝码和事件字段冻结后 | S2-08、S2-13 |
| E W9 Integration | S2-09–S2-12 | S2-08 发布门通过后 | S2-13 |

跨轨道修改必须先更新 contracts/fixture 或 ADR，再改实现；禁止各轨道私自定义同名状态、错误码、事件或事实源。每次合并前运行：

```powershell
cd C:\work\hmCodex\desktop
npm run test:all:parallel
```

然后顺序运行受影响的 UI、安全和真实安装包回归。任何一个并行套件失败都阻止阶段门，不能只报告通过的套件。

## 5. 发布门与指标

### G2：`WINDOWS_PHASE1_5_CONTROLLED`

- Phase 1 read-only 拒绝回归仍为 100%；
- 受控动作完整链路覆盖率 100%；
- 未授权副作用数为 0；
- P0/P1 安全用例阻断率为 100%；
- Approval integrity、lease 一次性消费、scope/identity/channel 绑定为 100%；
- secret/PII/source/prompt/reasoning 扫描无泄露；
- cancel/timeout/disconnect/crash/recovery 不重复副作用；
- 真实 Windows 安装包和 UI 场景通过。

### G3：Windows 计划内功能集成

- Memory Journal、Jev、Plugin、Thread、Feedback/Bayesian、Memory/Dream、Evolution 和 Dashboard 都使用同一 Event Store/ReadModel；
- 每个自动能力都有 feature gate、版本、回滚点和安全失败路径；
- Bayesian 只影响安全候选内部排序，不能放宽权限；
- 多候选扇出与选择可用：候选扇出、扇出预算、Jev 选择和 `SELECT_CANDIDATE` 决策记录落地，且选择不改变安全语义；
- Plugin/Evolution/Memories 的异常能 quarantine、撤回或回退规则基线。

### G4：`WINDOWS_FULL_LOCAL`

- W0–W10 的自动化、故障注入、安装迁移、长运行和实际使用证据齐全；
- `decisionCoverage=100%`，其他 Decision Trace 指标达到发布阈值；
- `taskSuccessRate` 不低于既定 B1 基线，安全指标不退化；
- p95 性能、恢复、存储和 UI SLO 有真实 Windows 数据；
- retention、删除、导出、Support Bundle、容量、备份和 rollback 演练通过；
- 发布后观察期完成，发布决策和可回滚版本被保存。

## 6. 禁止提前做的事

- G2 安全门通过前，不在发布包开放写入、命令、测试或网络；
- 不用 Approval UI、模型评分、Bayesian posterior、插件状态或用户偏好替代 Runtime Safety Monitor；
- 不因为对同一问题扇出多个候选就放宽候选集合、跳过 Approval 或复用 PolicyLease；每个候选仍需独立通过安全过滤；
- 不把动态插件、Dream、Memory、Evolution 或 Council 的成功摘要当成权限证据；
- 不在 W10 前启动其他平台产品功能；
- 不把阶段一 retention 观察、单元测试通过或 mock 结果当成受控执行或全功能发布证据。

## 7. 参考文件

- [Windows 全功能优先实施计划](WINDOWS_ALL_FEATURES_IMPLEMENTATION_PLAN.md)
- [Windows Phase 1 验收矩阵](WINDOWS_PHASE1_ACCEPTANCE_MATRIX.md)
- [协议规范](PROTOCOL_SPEC.md)
- [Agent Decision Trace 规范](DECISION_TRACE_SPEC.md)
- [安全模型](SECURITY_MODEL.md)
- [状态机](STATE_MACHINE.md)
- [Plugin 规范](PLUGIN_SPEC.md)
- [评价与发布治理](EVALUATION_PLAN.md)
- [运维与隐私](OPERATIONS_AND_PRIVACY.md)
- [Windows 测试执行约定](WINDOWS_TESTING_WORKFLOW.md)
