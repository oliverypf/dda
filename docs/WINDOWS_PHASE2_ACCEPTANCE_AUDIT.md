# Windows 阶段二验收审计（S2-00 … S2-13 / G2–G4）

审计时间：2026-09-11
> **历史记录说明**：本文记录的是当时候选版本的验收证据，不是当前架构要求。文中 OpenViking、LLM-as-a-Verifier、独立语义 Verifier 或 Candidate Judge 的描述均已被 [Jev Decision Plane 设计](JEV_DECISION_PLANE_DESIGN.md) supersede；当前以 Jev + Rule Verifier + Runtime Safety 为准。

审计对象：[WINDOWS_PHASE2_IMPLEMENTATION_PLAN.md](WINDOWS_PHASE2_IMPLEMENTATION_PLAN.md) v1.1
审计口径：只有当前代码上可复现的测试、真实执行证据或生成物才能记为 VERIFIED；实现存在但缺少计划要求的现场/窗口证据记为 PARTIAL；需要时间流逝或外部签署的记为 BLOCKED_EXTERNAL。本审计不替代发布门，也不改变 `NOT_READY` 结论。

状态说明：

- `VERIFIED`：有当前代码上的自动化或真实执行证据，且覆盖该工作包验收语句。
- `PARTIAL`：实现与部分证据已存在，但计划要求的现场、逐项或文档证据不完整。
- `PENDING`：尚未执行或证据缺失。
- `BLOCKED_EXTERNAL`：需要日历时间、外部签署或人工环境动作，代码改动无法完成。

## 1. 工作包逐项审计

| 工作包 | 状态 | 主要证据 | 缺口 / 下一步 |
| --- | --- | --- | --- |
| S2-00 基线冻结与安全门准备 | VERIFIED | `docs/WINDOWS_PHASE1_ACCEPTANCE_MATRIX.md`；`docs/artifacts/WINDOWS_PHASE1_RELEASE_CHECK_2026-09-09.json`；`docs/artifacts/WINDOWS_PHASE1_METRICS_2026-09-09.json`；`phase2-parallel-validation-6.log` 5/5 | —（配置矩阵见 [WINDOWS_PHASE1_5_CONFIG_MATRIX.md](WINDOWS_PHASE1_5_CONFIG_MATRIX.md)） |
| S2-01 Controlled channel 与跨层 gate | VERIFIED | `runtime/test/release-channel.test.mjs` 6/6（含构建期 baked channel 不能被环境变量降级）；`docs/artifacts/WINDOWS_PHASE2_RELEASE_CHECK_FULL_LOCAL_2026-09-11.json` passed=true 8/8 | — |
| S2-02 ActionIntent 与 Safety Monitor 权威校验 | VERIFIED | `runtime/test/execution-scope-snapshot.test.mjs` 6/6，含新增“every execution scope field mismatch is detected”对 20 个 scope 字段逐一失配；`runtime/test/execution-state-store.test.mjs` 的 `EXECUTION_LEASE_DIGEST_MISMATCH`/`EXECUTION_LEASE_OPERATION_MISMATCH`（request digest 覆盖 capability+request，故 argv/env/cwd 变化在 lease claim 时拒绝）；`runtime/test/controlled-task.test.mjs`；`runtime/test/safety-executor.test.mjs` | — |
| S2-03 ApprovalPort 与桌面审批闭环 | VERIFIED | `runtime/test/approval-events.test.mjs`（审批回执持久化后消费一次性 lease）；`runtime/test/controlled-task.test.mjs`；受控安装包 UI 安全套件 6/6（批准、拒绝、副作用超时、断线恢复） | — |
| S2-04 PolicyLease 生命周期与一次性消费 | VERIFIED | `runtime/test/execution-state-store.test.mjs`（CAS 仅认领一次、EXPIRED、REVOKED 后不可复活、乐观摘要、跨进程记录、未知结果对账）；`runtime/test/safety-executor.test.mjs` 14/14 | 取消/暂停/断线触发撤销的安装包侧现场证据目前包含在受控 UI 安全套件中，未单列 lease 撤销矩阵 |
| S2-05 Windows Executor 与网络适配器 | VERIFIED | `runtime/test/safety-executor.test.mjs` 14/14（真实 Windows 写入、命令、测试、路径穿越、链接替换、分离孙进程回收）；`runtime/test/network-adapter.test.mjs` 12/12（DNS 私网、重定向、超时、并发上限） | — |
| S2-06 Coordinator、Verifier 与 Recovery 收敛 | VERIFIED | `runtime/test/task-recovery-controller.test.mjs`（CONTINUE 恢复、硬失败不恢复、预算）；`runtime/test/crash-recovery-runtime.test.mjs`（重启进入 recovery 并阻断中断副作用）；`runtime/test/execution-state-store.test.mjs`；`docs/WINDOWS_PHASE2_PROGRESS.md` 2026-09-09 workspace 互斥与独立 verifier 门 | — |
| S2-07 安全测试与故障注入 | VERIFIED | `runtime/test/network-adapter.test.mjs` 12/12；`runtime/test/safety-executor.test.mjs` 14/14；`unauthorizedSideEffectCount=0`、`secretExposureCount=0` 由 release-check 报告固化 | — |
| S2-08 Controlled UI 与真实安装包验收 | VERIFIED（build-3 基线） | 受控 MSI/NSIS 安装包；`desktop/scripts/ui-security-test.mjs` 6/6；已安装 EXE UI 回归 11 项；`docs/WINDOWS_PHASE2_PROGRESS.md` 2026-09-10 G2 结论 | 上述安装包证据对应 build-3（runtime `ff06de17…`）；build-4 源码演进后需要 v5 安装生命周期才能覆盖新候选 |
| S2-09 OpenViking 与本地长期运行时 | VERIFIED | `runtime/test/openviking-sidecar-supervisor.test.mjs`；`runtime/test/openviking-context-port.test.mjs`；`runtime/test/context-assembler.test.mjs`；`docs/WINDOWS_PHASE2_PROGRESS.md` 2026-09-10 不可用降级证据；runtime 心跳长驻用例 | 真实 Windows 工作区观察期未完成，已列入 G4 阻断 |
| S2-10 Plugin 生产生命周期 | VERIFIED（含本轮撤销列表） | `runtime/test/plugin-signature.test.mjs`、`runtime/test/plugin-version-lifecycle.test.mjs` 5/5、`runtime/test/plugin-revocation.test.mjs` 4/4、`runtime/test/plugin-permissions.test.mjs`；撤销/动态插件/权限上下文/签名共 10/10；UI `pluginVersionCopy`/`pluginGrantCopy`/`pluginQuarantineCopy` | — |
| S2-11 Thread/Feedback/Memory/Dream/Evolution/Dashboard 集成 | VERIFIED（连续验证配置本轮补齐） | `runtime/test/continuous-verifier.test.mjs`、`model-config.test.mjs`、`agent-turns.test.mjs`、`read-model-rebuilder.test.mjs` 共 49/49；`feedback-registry.test.mjs`、`model-scenario-profile.test.mjs`、`bayesian-assessment.test.mjs`、`governance-memory-dream.test.mjs`、`evolution-control.test.mjs`、`evolution-evaluator.test.mjs`、`dashboard-event-sources.test.mjs`、`support-bundle-privacy.test.mjs` | 高风险任务使用独立 provider/model 的真实模型现场（非 fixture）尚未单独留证；语义 verifier 的 UI 证据展示由 desktop 契约/类型与受控 UI 套件覆盖 |
| S2-12 多候选扇出与选择 | VERIFIED | `runtime/test/candidate-fanout.test.mjs` 19/19（默认单候选、预算截断、安全过滤、部分失败、去重、judge 降级、SELECT_CANDIDATE 真实 Decision Trace）；`runtime/test/candidate-fanout-runtime.test.mjs`；`runtime/test/model-egress-ledger.test.mjs` | — |
| S2-13 W10 稳定性与 WINDOWS_FULL_LOCAL 发布 | PENDING / BLOCKED_EXTERNAL | build-3 真实提权 NSIS per-machine 生命周期：install/upgrade/migration/rollback/uninstall 全部 VERIFIED（`docs/artifacts/WINDOWS_PHASE2_INSTALL_LIFECYCLE_2026-09-11/nsis-lifecycle-result.json`）；发布链产物 SBOM/plugin lock/model lock/release manifest/release decision；release-check FULL_LOCAL passed=true | build-4 候选已构建，v5 安装生命周期待 UAC 批准；24 小时长运行、30 天 retention、运维签名发布决策报告、真实工作区观察期未完成 |

## 2. 发布门审计

| 门 | 状态 | 依据 |
| --- | --- | --- |
| G2 `WINDOWS_PHASE1_5_CONTROLLED` | VERIFIED | 受控副作用完整链路、真实安装包、UI 安全 6/6、安装生命周期、release-check；见 `docs/WINDOWS_PHASE2_PROGRESS.md` 2026-09-10 G2 结论 |
| G3 Windows 计划内功能集成 | VERIFIED | 各模块从同一 Event Store/ReadModel 读取（`dashboard-event-sources.test.mjs`、`harness-event-store.test.mjs`、`read-model-rebuilder.test.mjs`）；feature gate 与回滚（`plugin-version-lifecycle.test.mjs`、`evolution-control.test.mjs`、`governance-memory-dream.test.mjs`）；多候选 `CANDIDATE_SET`/`SELECT_CANDIDATE`（S2-12） |
| G4 `WINDOWS_FULL_LOCAL` | NOT_READY | `docs/artifacts/WINDOWS_PHASE2_W10_EVIDENCE.json` 的 `releaseDecision=NOT_READY`，阻断项四项；发布决策报告为 NOT_READY |

## 3. 当前阻断项与权威状态

| 阻断项 | 权威状态 | 完成条件 |
| --- | --- | --- |
| `LONG_RUN_WINDOW_INCOMPLETE` | `docs/artifacts/WINDOWS_PHASE2_W10_EVIDENCE.json.longrun.json`：`observedMinutes=86`、要求 1440、采样容忍 120 秒；计划任务 `hmCodex Long Run Sampler` Last Result 0 且持续运行 | 累计有效观察 ≥ 1440 分钟且采样间隔 ≤ 120 秒 |
| `RETENTION_PARTIAL` | `docs/artifacts/WINDOWS_PHASE2_RETENTION_OBSERVATION.json`：elapsed 约 2.5 天 / 30 天；`hmCodex Retention Worker` 每日 12:00 运行 | 30 天日历观察结项（当前窗口至 2026-10-09） |
| `RELEASE_DECISION_REPORT_MISSING` | `WINDOWS_PHASE2_W10_EVIDENCE.json` 的 `releaseEvidence.decisionReport.ok=false` | 运维签署的 `ok:true` 发布决策报告；不得由代码或模型伪造 |
| `REAL_WORKSPACE_OBSERVATION_MISSING` | `WINDOWS_PHASE2_W10_EVIDENCE.json` 的 `releaseEvidence.workspaceObservation.ok=false` | 真实 Windows 工作区上的只读/受控任务观察期记录 |
| build-4 安装证据 | build-4 候选已构建（runtime `86d3738d…`、setup `2929006c…`）；v5 生命周期脚本已就绪，提权执行等待 UAC 批准 | v5 install/upgrade/migration/rollback/uninstall 全部 VERIFIED 并将 W10 安装证据指向新候选 |

## 4. 结论

阶段二计划中除 build-4 安装现场证据外，S2-01 … S2-12 的实现与自动化验收均有可复现证据；G2、G3 已通过。G4 仍为 `NOT_READY`，原因是长运行窗口、30 天 retention、运维签署发布决策报告和真实工作区观察期四项外部条件未满足。本审计不把目标标记为完成，也不把 build-3 的安装证据当作 build-4 的证据。
