# Windows Phase 1 验收矩阵

状态：`PASS` / `PARTIAL` / `PENDING`。本矩阵只记录当前工作区可复现的证据，不把“代码存在”当成验收通过。

## M0 发布边界

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| release channel 与 feature gate | PASS | `release-channel.test.mjs`；构建产物含 `WINDOWS_PHASE1_READ_ONLY`，不含 `WINDOWS_MVP_PRE_PHASE1` |
| Phase 1 拒绝 CONTROLLED | PASS | `release-channel.test.mjs`；打包 runtime `task --execution-mode CONTROLLED` 返回 `RELEASE_CHANNEL_READ_ONLY` |
| desktop UI 不暴露 CONTROLLED | PASS | desktop vitest 26/26；Phase 1 模式门控 |
| 旧 JSON/JSONL 导入策略 | PASS | `WINDOWS_STORE_MIGRATION_POLICY.md`；`harness-events import` |

## M1 唯一 durable Harness Event Store

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 唯一事件事实源、run 序列、aggregate version、digest、版本元数据 | PASS | `harness-event-store.test.mjs`、`harness-store-schema.test.mjs` |
| 单写入队列、事务提交、COMMITTED 回执 | PASS | `harness-store-schema.test.mjs`、`harness-database-crash.test.mjs` |
| 幂等、重复提交、版本冲突、未知事件保留 | PASS | `harness-event-store.test.mjs`、`read-model-rebuilder.test.mjs` |
| 启动完整性检查、迁移保护、备份 checkpoint | PASS | `harness-store-migration-guard.test.mjs`、`harness-store-checkpoint.test.mjs` |
| 旧 trajectory/harness JSON 导入且不改源文件 | PASS | `harness-event-store.test.mjs` |
| Coordinator 收敛到事件库、COMMITTED receipt、重开恢复 | PASS | `task-run-coordinator.persistence.test.mjs` 16/16 |
| 进程崩溃前后事务边界 | PASS | `harness-database-crash.test.mjs` 5/5 |
| 数据库页级损坏 fail-closed | PASS | `harness-store-schema.test.mjs` |
| 多进程并发 append 竞争 fail-closed | PASS | `harness-database-crash.test.mjs` |

## M2 commit-before-effect

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 状态/成本/权限/副作用路径等待 durable commit | PASS | `runtime.test.mjs` 使用 `transitionAndFlush` / `recordEventAndFlush`；`crash-recovery-runtime.test.mjs` |
| Tauri 推送不早于 commit | PASS | `task-run-coordinator.persistence.test.mjs` 的 commit-before-notify 用例 |
| 关键事件 eventId 传给 Decision/Outcome/Verifier/Credit-Blame | PASS | Classifier/Router/Allocation/Planner/Council/Tool/Verifier/Diagnostician/Recovery 产生的关键事件 ID 现在显式写入对应 Decision 的 Outcome `executionEventIds`；`runtime.test.mjs` 断言 CLASSIFY_TASK outcome 链接到 TaskClassified 事件。MemoryConsolidator 通过任务 Outcome 事件链接 |
| 动作前 intent/decision/approval/lease，动作后 outcome | PASS | `approval-events.test.mjs`、`controlled-task.test.mjs`、`execution-state-store.test.mjs`、`durable-commit-facade.test.mjs` |
| 区分未执行/结果未知/验证失败 | PASS | `plan-step-coordinator.test.mjs`、`crash-recovery-runtime.test.mjs` |

## M3 rebuild / 确定性回放

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 事件表清空后可全量重建、checksum 稳定 | PASS | `read-model-rebuilder.test.mjs` 7/7 |
| 序列/aggregate version/digest 校验 | PASS | `read-model-rebuilder.test.mjs` |
| 未知关键事件保留并 `PAUSED_UNSUPPORTED` | PASS | `read-model-rebuilder.test.mjs` |
| 不再依赖 512 条固定上限、支持 timeline 分页 | PASS | `thread-events-sqlite.test.mjs`、`read-model-rebuilder.test.mjs` 10k 用例 |
| run/timeline/approval/decision/memory/workspace/verifier 可恢复 | PASS | `read-model-rebuilder.test.mjs` |
| dashboard 各治理字段切到事件源 | PASS | `dashboard-event-sources.test.mjs`（threads/memories/execution/plugins/evolution/dreams） |
| >100,000 事件存储分页 | PASS | `harness-store-scale.test.mjs` 显式 100,001 事件用例：SQLite 存储、`listPage`/`iterate` keyset 分页、`verify()`、流式 ReadModel rebuild、timeline 首尾分页和 checksum 复现 |

## M4 Decision Trace 与指标

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| Classifier/Router/Planner/Council/Execution/Verifier/Diagnostician/MemoryConsolidator 记录候选、证据、淘汰原因 | PASS | `plan-step-runtime.test.mjs`、`runtime.test.mjs`、`decision-evaluation.test.mjs` |
| `decisionCoverage=100%`（learning-eligible runs） | PASS | `runtime.test.mjs`、`release-check.test.mjs`；默认库 `release-check`：8 个 eligible run 全部 100% |
| `optionCoverage=100%`（含结构化淘汰原因） | PASS | `decision-evaluation.test.mjs`、`runtime.test.mjs`；默认库 eligible run 全部 100% |
| `evidenceLinkRate=100%` | PASS | `runtime.test.mjs`、`release-check.test.mjs`；默认库 eligible run 全部 100% |
| `decisionOutcomeLinkRate=100%` | PASS | `runtime.test.mjs`、`release-check.test.mjs`；默认库 eligible run 全部 100% |
| 不完整 run 不进入学习/导出 | PASS | `release-check` 把 run 分为 eligible/ineligible；ineligible run 必须带 `learningExclusionReasons` 且不满足 `eligibleForLearning`，`exportLearningSample` 抛 `LEARNING_EXPORT_INCOMPLETE`；`release-check.test.mjs` 新增“ineligible run 不导致发布门失败但被显式排除”用例 |
| Decision-time snapshot 真实不可变 | PASS | `index.mjs` 使用 content-addressed `snapshot-<sha256>`；`runtime.test.mjs` 断言 |
| `export-learning` 缺失数据拒绝 | PASS | `decision-evaluation.test.mjs`、`runtime.test.mjs`；默认库实测 eligible run 导出成功（6 decisions/6 outcomes），ineligible run `run-ceb9be12` 返回 `LEARNING_EXPORT_INCOMPLETE:DECISION_REQUIRED_TYPE_MISSING,DECISION_OUTCOME_MISSING` |

## M5 故障注入与恢复

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 写入前/中/后崩溃 | PASS | `harness-database-crash.test.mjs` |
| 页损坏、锁冲突、容量耗尽 | PASS | `harness-store-schema.test.mjs`、`harness-database-crash.test.mjs`、`storage-capacity.test.mjs` |
| duplicate/out-of-order/late/unknown/version 冲突 | PASS | `harness-event-store.test.mjs`、`read-model-rebuilder.test.mjs` |
| 恢复不重复执行/不重复写 outcome | PASS | `runtime-recovery.test.mjs`、`plan-step-runtime.test.mjs` |
| 10 倍事件规模回放与 timeline 分页 | PASS | `read-model-rebuilder.test.mjs` 10k 用例 |
| provider disconnect | PASS | `runtime.test.mjs` provider-unreachable 用例：run 失败、`TaskRunFailed` 落库、prompt 不落事件 |
| task timeout | PASS | `runtime.test.mjs` task-timeout 用例：`--task-timeout-ms` 触发 AbortSignal，错误码 `TASK_TIMEOUT`，`TaskRunFailed` 落库 |
| cancel（桌面终止子进程 + 独立任务级 cancel） | PASS | `task-cancel-registry.test.mjs` 4/4；`runtime.test.mjs` 真实 CLI 取消用例（hung provider、独立 cancel 子进程、`TASK_CANCELLED`、durable `TaskRunFailed.outcomeStatus=CANCELLED`、prompt 不落事件）；桌面终止子进程与 `crash-recovery-runtime.test.mjs` 恢复 |
| desktop shell 退出/重启时 runtime stdout 断管 | PASS | 2026-09-09 强杀桌面进程用例：runtime 子进程不再抛 `EPIPE` FATAL，干净退出且无孤儿 node 进程；重启后 recovery 取消陈旧 run。实现见 `runtime/src/index.mjs` 的 `writeStdout` / `process.stdout.on('error')`；`runtime.test.mjs` 13/13、runtime 全量 421/420 pass/1 skipped |
| 可恢复工具错误（不支持/过大/路径错误/重复请求） | PASS | `rule-verifier.mjs` 将 `WORKSPACE_UNSUPPORTED_FILE` 等错误码从硬失败降为 `CONTINUE`，允许模型换路径；`plugins/task-runner.mjs` 的 `tool.result` 透传真实 `errorCode`（此前被 `safeErrorCode(output)` 丢成 `TOOL_EXECUTION_FAILED`）；`task-runner-tools.test.mjs` 确定性用例：第一轮读不支持文件、第二轮换可读文件后 verifier=`CONTINUE`。真实 `run-53b69128` 事件显示模型第 2 轮已换用可读文件并成功读取；修复后 UI 真实任务 T13 以 `只读检查完成` 成功结束 |
| heartbeat watchdog | PASS | `desktop/src-tauri/src/lib.rs` 的 `runtime_heartbeat_is_stale` / `detects_a_stale_runtime_heartbeat_with_a_bounded_timeout` 单测；`runtime.test.mjs` 心跳单调性用例 |
| approval denial | PASS | `approval-events.test.mjs`、`controlled-task.test.mjs`：审批拒绝使 run fail-closed，不产生未授权副作用 |
| Git observer 大仓库性能 | PASS | `GitObserver` 默认 `--untracked-files=normal`（可显式 `all`/`no`）；大仓库实测 `all` 29.6s → `normal` 0.187s，`hello` 任务 102.8s → 23.4s；`git-audit.test.mjs` 10/10 |

## M6 运维、隐私与容量

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| 按 run/thread/全部脱敏导出 | PASS | `export-data.test.mjs` |
| Support Bundle 与敏感字段扫描 | PASS | `support-bundle-privacy.test.mjs`；默认库实测 `support-bundle` ok、privacy scan ok、0 violations、31,191 bytes |
| retention index、异步 purge、tombstone、失败重试 | PASS | `retention-worker.test.mjs`、`harness-event-store.test.mjs` |
| 本地指标 | PASS | `metrics.test.mjs`、`commit-metrics.test.mjs`；默认库 metrics：events=4119、commitSuccessRate=1、decision=137、outcome=133、run=181、timeline=4119；`nonTerminalRuns=1` 只统计 TaskRun，`nonTerminalMaintenanceRuns=97`（recovery 维护 run 单列），`taskRunCount=84` |
| 70/85/95 容量阈值 | PASS | `storage-capacity.test.mjs`；`runtime.test.mjs` 真实任务链路硬阈值用例：`STORAGE_CAPACITY_HARD_LIMIT` 阻止新 run，未创建 Harness DB，`recovery` / `export-data` 在硬阈值下仍可用 |
| 完整删除不可被缓存/导出复活 | PASS | `deletion-acceptance.test.mjs` |
| 真实设备容量压力（70/85/95 阈值） | PASS | 2026-09-09 本机临时目录 100 MiB 实际文件：`--storage-max-bytes` 140MB→WARNING(0.749)、120MB→CRITICAL(0.8738)、110MB→HARD_LIMIT(0.9533)、104MB→HARD_LIMIT(1.0082)；HARD_LIMIT 下 task 返回 `STORAGE_CAPACITY_HARD_LIMIT` 且未创建 Harness DB，`recovery` / `export-data` 仍 `ok:true` |
| 长期 retention 观察（真实 30 天周期） | PARTIAL | 本机 retention index + `--purge-expired --purge-limit 1` round-trip 通过；2026-09-09 retention-worker 真实进程连续运行 4 个周期（1s 间隔、每周期 purge 1、progress 持久化 `completed=4`/`failed=0`）后干净停止。已创建 Windows 计划任务 `hmCodex Retention Worker`：每日 12:00 运行，结束日期 2026-10-09，单次最长 1 小时、失败重试 3 次；首次手动运行 `LastTaskResult=0`、进度文件 `updatedAtMs` 已更新、`NextRunTime=2026-09-10 12:00`。30 天观察进行中，完成后可将本行更新为 PASS |

## M7 Windows 发布验收

| 要求 | 状态 | 证据 |
| --- | --- | --- |
| runtime / desktop / Tauri 测试 | PASS | runtime 423 tests / 422 pass / 1 skipped（>100k 规模用例显式运行通过）、desktop 26/26、Tauri Rust `cargo test --lib` 19/19、TypeScript、`cargo check`、`cargo fmt --check` |
| Phase 1 Windows 构建 | PASS | `WINDOWS_PHASE1_BUILD_2026-09-09.md` 第十二次构建（最终 Phase 1 候选：常驻取消按钮 + stdout EPIPE 守卫 + release-check/metrics 语义修正 + NSIS perMachine + 可恢复工具错误修复 + 流式抖动修复），EXE/MSI/NSIS SHA-256 已记录 |
| 构建期烘焙 release channel | PASS | EXE 含 `WINDOWS_PHASE1_READ_ONLY`，不含前置渠道 |
| 打包 runtime 启动链路 | PASS | `health` / `recovery` / `dashboard` 均 `ok:true` |
| CONTROLLED 副作用拒绝 | PASS | 打包 runtime 返回 `RELEASE_CHANNEL_READ_ONLY` |
| 自动化发布检查报告 | PASS | `release-check.test.mjs` 2/2；默认库 `runtime release-check` `passed=true`（[报告产物](artifacts/WINDOWS_PHASE1_RELEASE_CHECK_2026-09-09.json)）：8 个 eligible run 全部 100%，2 个 ineligible run 显式排除；versions storageSchema=1/protocol=1.0/policy=runtime-safety-1/producer=hmcodex-runtime@0.1.0/app=0.1.0 |
| regression/holdout fixture / 发布门控 | PASS | `runtime/test/fixtures/holdout-dataset.json`（`datasetKind=HOLDOUT`、`datasetVersion=1.0.0`、3 个 case、datasetDigest）；`runtime/test/fixtures/regression-dataset.json`（`datasetKind=REGRESSION`、`datasetVersion=1.0.0`、3 个 case）；`evolution-evaluator.test.mjs` 16/16 断言 REGRESSION fixture 通过、safety regression 被拒绝、DEV 报告不能满足 `--require-holdout`、HOLDOUT 报告可提升 ACTIVE、非法 datasetKind fail-closed |
| 桌面流式渲染稳定性 | PASS | 流式 delta 不再全量重建 `app.innerHTML` / `createIcons` / 滚动；改为按 `requestAnimationFrame` 只更新流式时间线项的 `.timeline-body` 文本并保持底部跟随，完成时再全量渲染。`desktop/scripts/ui-streaming-test.mjs`：139 次采样中 App 根节点标记全程保留（`markerKeptWhileGrowing=139`），流式文本增长到 648 字符，终态 `只读检查完成`；desktop vitest 26/26 |
| MSI/NSIS 安装、升级、卸载 | PASS | 第十次构建实测：MSI perMachine 安装/升级/卸载 exit=0，卸载项 1→1→0，安装目录 `C:\Program Files\hmCodex` 正确移除，用户数据保留；NSIS 改为 perMachine 后同样通过；未提权 MSI 返回 1603/Error 1925，提权后通过。详见 [WINDOWS_PHASE1_MANUAL_ACCEPTANCE.md](WINDOWS_PHASE1_MANUAL_ACCEPTANCE.md) 的 2.5 |
| 桌面 UI 自动化功能测试 | PASS | `desktop/scripts/ui-functional-test.mjs`（`npm run test:ui` / `npm run test:ui:task`）：真实安装 App + WebView2 CDP，T01–T13 13/13；另含 `ui-disconnect-test.mjs` 2/2（模型断线 UI 错误渲染 + 恢复配置后任务继续）和 `ui-streaming-test.mjs` PASS（流式期间不重建 App 根节点）。覆盖初始渲染与 READ ONLY 门控、上下文面板开关、工作区目录导航、文件只读预览、新建任务重置、线程选择与时间线恢复、时间线分页（22→222）、治理面板刷新、执行状态刷新、无渲染错误、真实任务取消、真实任务终态（`只读检查完成` · 232 timeline items · 8 threads） |
| 桌面 UI 手工场景 | PASS | 3.1 新建线程 + 3.2 连续任务（`thread-e644cbc3` `turnCount=3`）；3.3 模型断线（UI 显示“任务未完成”+`fetch failed`；CLI `run-0936837f` exit=1、63 事件含 `TaskRunFailed`、prompt 未落事件；恢复后 `run-730a59fb` exit=0）；3.4 取消（UI `CANCELLED`，日志 `cancel_runtime_process invoked`）；3.5 超时（`run-a89478b4` exit=1、`TASK_TIMEOUT:500`、`TaskRunFailed`、prompt 未落事件）；3.6 进程重启（强杀后无 EPIPE FATAL、恢复取消陈旧 run）；3.7 重建 projection（checksum 一致）；3.8 导出（run/thread/all，privacy ok）；3.9 删除（临时副本 purge、tombstone、late append `HARNESS_RUN_TOMBSTONED`、旧 projection 失效、dashboard 移除）。交互类场景已由“桌面 UI 自动化功能测试”覆盖；证据见 [WINDOWS_PHASE1_MANUAL_ACCEPTANCE.md](WINDOWS_PHASE1_MANUAL_ACCEPTANCE.md) |

## 结论

当前自动化实现与验收证据已覆盖 M0–M6 的核心要求以及 M7 的构建、渠道、启动链路和自动化发布检查。M2 关键事件 eventId 显式传递、M3 >100,000 事件分页和 M5 独立任务级 cancel 已补齐。剩余项集中在：

1. M6 长期 retention 的 30 天日历观察。
