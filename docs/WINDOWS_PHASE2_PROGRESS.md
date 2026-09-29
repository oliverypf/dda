# Windows 阶段二进度记录

本文件按阶段二工作包记录已落地的增量；验收结论只引用可复现的测试/构建证据，不引用意图或摘要。

## 2026-09-11 S2-11 连续验证配置跨层补齐、build-5 全本地构建与真实提权安装生命周期

- 修复配置跨层缺口：runtime 的 `runtime/src/model-config.mjs` 早已接受 `model.verifier` 段并把未知字段按 `MODEL_CONFIG_UNKNOWN_FIELD` 拒绝，但桌面端既没有表单入口，Rust 侧 `ModelConfig` 也没有该字段、`persist_model_config` 白名单同样缺失，操作员手工写入的 `verifier` 会在下一次“保存配置”时被静默丢弃。现在三层补齐：新增 `desktop/src/domain/verifier-config.ts`（判定标准、重复次数、最大比较数、支点数、提示长度上限、随机种子、PASS/FAIL 阈值的格式化与解析，边界逐条镜像 `normalizeContinuousVerifierConfig`），设置弹窗新增“连续验证（LLM as a Verifier）”分组，Rust `ModelConfig` 增加可选 `verifier` 值对象并按原样双向透传。
- 语义细节：留空的字段整体省略，运行时继续套用默认值（重复 2、比较 32、支点 2、上限 60000 字符、PASS 0.9 / FAIL 0.5）；清空全部项会从已有配置文件删除该段，而 `models`、`roleBindings` 等高级字段保持不变；PASS ≤ FAIL 按运行时“先归一化省略侧再比较”的语义在写盘前拒绝，避免写出运行时无法加载、导致后续启动 fail-closed 的配置。
- 测试证据：`cd desktop && node ./node_modules/vitest/vitest.mjs run --configLoader native --dir src --exclude "scripts/**/*.test.mjs"` 6 个文件 41/41 通过（含新增 `src/domain/verifier-config.test.ts` 7 项：空表单、全字段、部分字段、越界拒绝、单边阈值反转拒绝、条数/长度上限、往返）；`cd desktop/src-tauri && cargo test` 24/24 通过（新增 `model_config_save_round_trips_verifier_section`，并扩展 `model_config_uses_runtime_json_field_names` 与 `model_config_save_preserves_advanced_fields_and_replaces_existing_file` 断言未配置时整体省略 `verifier`）；`node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` exit=0；`node ./scripts/build.mjs` 通过。
- 全量并行回归门 `../phase2-parallel-validation-7.log`：`[parallel] SUMMARY total=5 passed=5 failed=0`，runtime 544 项（543 过、0 失败、1 既有 skip）、desktop Vitest 41/41、desktop-scripts 22/22、TypeScript exit=0、tauri-rust 24/24。该轮覆盖本轮全部源码改动，作为最新全量证据。
- 因源码在本轮继续演进，安装候选从 build-4 移到 build-5：重新执行 `npm run build:windows:full-local`（日志 `../phase2-fulllocal-build-5.log`，exit=0），产物 `runtime/src/index.mjs` 摘要 `86d3738d…`（本轮未改 runtime）、release EXE `ada6b225…`（9,757,184 B）、MSI `b8be107a…`、NSIS setup `5f6c80fa…`（2,605,741 B）。
- 用户授权后完成**真实提权** NSIS per-machine 生命周期（`phase2-nsis-lifecycle-5-launcher.log` `elevatedExitCode=0`）：6 个步骤全部 `elevated=true`、`ok=true`。upgrade 在既有 build-3 per-machine 安装上就地升级，安装后二进制 `1a80ebd9…`（9,757,184 B）、已安装 runtime `86d3738d…`、installer setup `5f6c80fa…`，其中“已安装二进制不等于 release 产物”成立是因为 Tauri 按 bundle 类型就地打补丁；rollback 先装回上一版再恢复本候选，最终二进制与 upgrade 安装逐字节一致；uninstall 后安装目录与注册表项移除；fresh install 在干净状态下重装并与 upgrade 安装逐字节一致。migration 步骤用已安装 runtime 导入 2,543 条事件，receipts 2,543、tombstones 0、`PRAGMA user_version=1`、channel `WINDOWS_FULL_LOCAL`，`verify` 通过。
- 证据固化到 [WINDOWS_PHASE2_INSTALL_LIFECYCLE_2026-09-11_R2](artifacts/WINDOWS_PHASE2_INSTALL_LIFECYCLE_2026-09-11_R2)：聚合 `nsis-lifecycle-result.json`（`aggregation.mode=REGENERATED_FROM_STEP_FILES`，逐步骤列出 sha256）加 6 个 step 文件与 6 个日志；`supersedes` 记录它取代 build-3 目录与 r1 阶段目录。
- W10 证据重生成（`../phase2-w10-evidence-regen-3.log`，`--install-lifecycle=` 指向 R2 聚合）：`install.status=OBSERVED`（已安装二进制 `1a80ebd9…`、runtime `86d3738d…`、uninstaller 摘要）、`install.lifecycle.status=VERIFIED`（required steps install/upgrade/migration/rollback/uninstall 全部 VERIFIED、`elevated=true`、每一步 stepFile 摘要校验通过）；并发、recoverySLO、备份恢复、隐私删除、kill switch、容量演练均 PASS；长运行 `observedMinutes=151`（要求 1440，采样容忍 120 秒）；`releaseDecision` 仍为 `NOT_READY`，四项外部阻断未变。
- 发布链产物刷新：以**已安装的 build-5 运行时**（`HMCODEX_BAKED_RELEASE_CHANNEL=WINDOWS_FULL_LOCAL`）对真实 store 执行 `release-check`，`passed=true`，releaseChannel/sideEffectRejection/eventStore/readModelChecksum/hasRuns/decisionMetrics/privacy/capacity 8 项全 true（`../phase2-release-check-b5.log`）；`release-manifest` 重新生成 manifest/SBOM/plugin lock/model lock/decision，manifest.artifacts 摘要指向 build-5 产物，SBOM 组件数 126、模型锁 15、插件锁 0，decision 仍 `NOT_READY` 且唯一阻断为 `w10Evidence_W10_NOT_READY`。build-4 轮次的同名产物先备份为 `docs/artifacts/backup-2026-09-11-pre-releasecheck-fix/*.build4.json`，未覆盖丢失。
- 本轮未声明全计划完成：24 小时长运行窗口、30 天 retention 日历观察、运维签署的发布决策报告和真实 Windows 工作区观察期仍未满足，G4 保持 `NOT_READY`。

## 2026-09-11 S2-13 长运行 store 物理身份、插件撤销列表与全量回归复核

- 定位并修复长运行事件计数长期不一致（5119 vs 16023）的根因：Codex desktop 以 MSIX 包运行，包内进程读取 `%LOCALAPPDATA%\hmCodex\hmcodex.db` 时被重定向到包本地影子 `%LOCALAPPDATA%\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Local\hmCodex\hmcodex.db`；包外 Task Scheduler 进程看到的是真实 profile 文件。同一“路径”实为两个物理文件，而不是同一 store 的计数漂移。用临时计划任务在该路径写入 marker 验证包外进程落进包影子、包内模块读到真实 profile 文件，任务与 marker 均已清理。
- 新增 `desktop/scripts/windows-store-identity.mjs`：`describeStorePath` 用 inode/dev 判定物理身份，识别 `redirection.kind=MSIX_PACKAGE_LOCAL_CACHE`，列出其他现存包副本和绕过重定向的 `unredactedProfileAlias`（`\\localhost\C$\...`）；`desktop/scripts/windows-store-identity.test.mjs` 4/4 通过。
- 新增 `desktop/scripts/harness-store-snapshot.mjs`：一次快照同时给出物理身份、事件/收据/墓碑计数与 `additionalStores`。`longrun-sampler.mjs` 与 `w10-evidence-harness.mjs` 改为复用该快照；W10 harness 新增“evidence record names the physical store file it read”用例，harness 8/8、sampler 3/3、identity 4/4 共 15/15 通过。
- 最新真实观测（2026-09-11，Task Scheduler `hmCodex Long Run Sampler`，Last Result 0）：真实 profile 文件 `C:\Users\User\AppData\Local\hmCodex\hmcodex.db` 13,221,888 字节、`eventCount=5119`；包本地影子 53,846,016 字节、`eventCount=16035`。W10 证据的 `execution.storeIdentity` 明确记录包内进程实际读取的是包影子（`redirection.kind=MSIX_PACKAGE_LOCAL_CACHE`、`unredactedProfileAlias` 指向真实 profile 文件），sampler 的 `lastSample.additionalStores` 明确记录两个物理副本及其各自计数，两处都不再混淆。
- S2-10 撤销列表落地：新增 `runtime/src/plugin-revocations.mjs`，支持 `HMCODEX_PLUGIN_REVOCATIONS` 与 `HMCODEX_PLUGIN_REVOCATION_FILE`，条目接受 `sha256:<64hex>`、裸 64 位 hex 或 `<pluginId>@<version>`（JSON 数组或 `{entries:[...]}`）；非法条目抛 `PLUGIN_REVOCATION_LIST_INVALID`，配置文件不可读抛 `PLUGIN_REVOCATION_LIST_UNAVAILABLE`（fail-closed）。`plugin-loader.mjs` 在 `discover` 阶段即拒绝 `PLUGIN_PACKAGE_REVOKED` / `PLUGIN_VERSION_REVOKED`，在 `load` 命中时先 `governance.revoke(...)` 再抛错，活动插件转 `QUARANTINED`，每次操作重新解析列表因此支持运行中撤销。
- S2-10 验收复核：`cd runtime && node --test test/plugin-revocation.test.mjs test/dynamic-plugin-runtime.test.mjs test/plugin-context.test.mjs test/plugin-signature.test.mjs` 共 10/10 通过（撤销列表格式与 fail-closed、撤销命中拒绝与隔离、未签名开发插件在发布频道被拒、permission ceiling 交集）。UI 侧 `pluginVersionCopy`/`pluginGrantCopy`/`pluginQuarantineCopy` 展示活跃版本、历史版本与失败码、权限与上限、摘要、状态证据条数以及 quarantine 原因，数据源为持久化 lifecycle snapshot 与 read model。
- S2-11 复核：`cd runtime && node --test test/continuous-verifier.test.mjs test/model-config.test.mjs test/agent-turns.test.mjs test/read-model-rebuilder.test.mjs` 共 49/49 通过；阈值可配置（`passThreshold` 默认 0.9、`failThreshold` 默认 0.5，非法配置 `VERIFIER_THRESHOLD_INVALID`），映射为 PASS / FAIL / ABSTAIN（`PROCESS_VERIFICATION_UNCERTAIN`），read model projection 暴露 `source` 供 UI 展示证据来源。
- 改动后全量并行门 `../phase2-parallel-validation-6.log`：`[parallel] SUMMARY total=5 passed=5 failed=0`。runtime 543 项（542 过、0 失败、1 既有 skip）、desktop Vitest 5 文件 34/34、desktop-scripts 通过、TypeScript `tsc --noEmit` exit=0、tauri-rust 23/23 通过。该轮包含 plugin-revocation、harness-store-snapshot 等本轮全部改动，可作为最新全量证据。
- W10 证据重生成：`../phase2-w10-evidence-regen-2.log` exit=0；`docs/artifacts/WINDOWS_PHASE2_W10_EVIDENCE.json` 仍为 `NOT_READY`，`install.status=OBSERVED`、`lifecycle.status=VERIFIED`、备份恢复/隐私删除/kill switch/容量演练 PASS；长运行 `observedMinutes=31`（要求 1440）、sessions=5、samples=43、间隔容忍 120 秒。schedule 侧 `hmCodex Long Run Sampler` 每分钟运行、Last Result 0、Next Run Time 正常；`hmCodex Retention Worker` 今日 12:00:01 运行 Last Result 0、Next Run Time 2026-09-12 12:00、观察窗口至 2026-10-09。
- 为让安装候选对应当前源码，12:14–12:46 再次执行 build:windows:full-local（日志 ../phase2-fulllocal-build-4.log，exit=0）：release EXE 6292a2a671e0f7dad8f5b86872f6cf19fef1c7409a900cffc77352f855f3fb8e（9,765,888 字节）、随包 runtime 86d3738d8c7ce88f5feb768b69ff63a4e335d74cfeac7f84af3ebda37d813035、MSI 8fc1b0d0dcaaf27616b302f444c05b00b098d76dfc2dcfcb69ace4ece46289bd、NSIS setup 2929006c8204291bb45afd50c4596647257e41bc1345e8effffc6ab1a4e9ed95（2,600,547 字节）。按新哈希生成的 v5 提权生命周期脚本已就绪；在本轮结束前该候选的 install/upgrade/rollback/uninstall 尚未执行，现有安装生命周期证据仍对应 build-3（ff06de17…），在 v5 完成前不得把 W10 的 install 证据当作 build-4 的安装证据。
- 新增逐项验收审计 [WINDOWS_PHASE2_ACCEPTANCE_AUDIT.md](WINDOWS_PHASE2_ACCEPTANCE_AUDIT.md)：S2-01…S2-12 均有可复现证据，G2/G3 通过；S2-00 已补 [WINDOWS_PHASE1_5_CONFIG_MATRIX.md](WINDOWS_PHASE1_5_CONFIG_MATRIX.md)、S2-02 已补 20 字段 scope 失配矩阵测试，S2-13/G4 因长运行、retention、运维签署报告与真实工作区观察期保持 NOT_READY，build-4 安装证据待 v5 生命周期。
- 保持 `NOT_READY`，阻断项为 ["LONG_RUN_WINDOW_INCOMPLETE","RETENTION_PARTIAL","RELEASE_DECISION_REPORT_MISSING","REAL_WORKSPACE_OBSERVATION_MISSING"]。24 小时长运行窗口、30 天 retention 日历、运维签名的 release decision 报告与真实 Windows 工作区观察期尚未完成，不提前标记发布通过。

## 2026-09-11 S2-13 WINDOWS_FULL_LOCAL 构建、真实安装生命周期与发布链缺陷修复

- 重新构建 `WINDOWS_FULL_LOCAL`（`cd desktop && npm run build:windows:full-local`，日志 `../phase2-fulllocal-build-3.log`，exit=0），本构建包含下述两个发布链缺陷修复：
  - `desktop/src-tauri/target/x86_64-pc-windows-msvc/release/hmcodex-desktop.exe` `b32474708e681bba8f76dfccd560b697d0bcad717b27e8ac41114f3f970db82b`（9,765,376 字节）
  - `.../release/runtime/src/index.mjs`（随包分发的运行时，与仓库 `runtime/src/index.mjs` 字节一致）`ff06de17eb10d33d5b08d3bb399737655783278e25e9fc4f5ee0814a7606c9c4`（288,830 字节）
  - `.../bundle/msi/hmCodex_0.1.0_x64_en-US.msi` `f79f684e5d10477cfd2210135d4c035b682aaefc696d750563546261c3cfaf95`；`.../bundle/nsis/hmCodex_0.1.0_x64-setup.exe` `1731e0b0d9d98b6583dbf47540ee26239ab6d610271ee65b3d8ae772c0583353`（2,600,919 字节）
- 真实缺陷 1（`runtime/src/index.mjs`）：`release-check` 只把 `WINDOWS_PHASE1_READ_ONLY`/`WINDOWS_PHASE1_5_CONTROLLED` 当作发布频道，导致 `WINDOWS_FULL_LOCAL` 安装包对自己的 release-check 判 `releaseChannel:false`（失败现场：`docs/artifacts/WINDOWS_PHASE2_RELEASE_CHECK_FULL_LOCAL_PROBE_2026-09-11.json`）。现改为“除 `WINDOWS_MVP_PRE_PHASE1` 之外的已批准频道即为发布候选”，并在 `runtime/test/release-check.test.mjs` 增加 2 项用例（FULL_LOCAL 通过、pre-phase-1 仍失败）。
- 真实缺陷 2（`runtime/src/release-manifest.mjs`）：发布供应链的 `controlledChannel` 检查硬编码 `WINDOWS_PHASE1_5_CONTROLLED`，使 FULL_LOCAL 候选在自己的目标频道上被阻断。现抽出 `CONTROLLED_RELEASE_CHANNELS`/`isControlledReleaseChannel` 接受 FULL_LOCAL，并在 `runtime/test/release-manifest.test.mjs` 增加频道门用例。
- 真实安装生命周期（NSIS per-machine，提权执行，`evidenceClass=REAL_EXECUTION`，host=USER-SNTTJQ3HLT）：`install` exit=0、断言 5/5 通过；`upgrade` exit=0、断言 6/6 通过；`rollback` exit=0、断言 3/3 通过；`uninstall` exit=0、断言 3/3 通过；`migration` 演练把 legacy `trajectory.jsonl`（2,546,688 字节）导入已安装运行时 store，导入 2543 条、store 事件 2543 条、verify 2543 条，`PRAGMA user_version=1`，channel=`WINDOWS_FULL_LOCAL`。聚合证据 `docs/artifacts/WINDOWS_PHASE2_INSTALL_LIFECYCLE_2026-09-11/nsis-lifecycle-result.json`（六个步骤 JSON 与六份日志已从临时目录固化到仓库，只重写路径、内容字节不变）记录六个步骤文件的 sha256，W10 harness 判定 `install.status=OBSERVED`、`missing=[]`、`lifecycle.status=VERIFIED`（install/upgrade/migration/rollback/uninstall 全部 VERIFIED）。
- 用**已安装**的 FULL_LOCAL 运行时对真实 harness store 执行 release-check（`HMCODEX_BAKED_RELEASE_CHANNEL=WINDOWS_FULL_LOCAL`、`--harness-event-store C:\Users\User\AppData\Local\hmCodex\hmcodex.db`）：`passed:true`，8 项检查全为 true；产物 `docs/artifacts/WINDOWS_PHASE2_RELEASE_CHECK_FULL_LOCAL_2026-09-11.json`。
- 发布供应链产物（同一已安装运行时生成）：`WINDOWS_PHASE2_SBOM.json`（126 个组件，覆盖 runtime 17 + desktop 109）、`WINDOWS_PHASE2_PLUGIN_LOCK.json`、`WINDOWS_PHASE2_MODEL_LOCK.json`（15 个模型）、`WINDOWS_PHASE2_RELEASE_MANIFEST.json`（channel `WINDOWS_FULL_LOCAL`，含 setup/MSI/EXE 三个产物的 sha256）、`WINDOWS_PHASE2_RELEASE_DECISION.json`：`decision=NOT_READY`，阻断项 ["w10Evidence_W10_NOT_READY"]。
- W10 harness（`desktop/scripts/w10-evidence-harness.mjs`）现在消费真实安装生命周期证据：新增 `LIFECYCLE_REQUIRED_STEPS`、`readInstallLifecycle()`、`--install-lifecycle=` 以及 `INSTALL_LIFECYCLE_EVIDENCE_MISSING/_INCOMPLETE/_INVALID`、`INSTALL_LIFECYCLE_STEP_ASSERTION_FAILED` 阻断码，并校验每个步骤文件的 sha256 与 `elevated=true`。
- 巡检脚本自身缺陷：v3 脚本在函数定义之前调用 `New-Hash`，使 `upgrade` 步骤的安装包摘要取到 `$null`（与输入包摘要 `1731e0b0…` 无关）；v4 修正求值顺序后 `upgrade` 断言通过。附带事实：Tauri 会按 bundle 类型给 `hmcodex-desktop.exe` 打补丁，已安装 EXE 与 `release/` 下 EXE 不字节相同，因此断言链改为“安装包摘要 + 已安装 runtime 与构建产物字节一致 + 重复安装的 EXE 身份一致”。
- 测试证据：`runtime/test/release-check.test.mjs` 5/5；`runtime/test/release-manifest.test.mjs` 4/4；`desktop/scripts/w10-evidence-harness.test.mjs` 7/7。全量并行回归 `../phase2-parallel-validation-4.log`：runtime 531 项（530 过、0 失败、1 既有 skip）、desktop-scripts 14 项 0 失败、TypeScript `tsc --noEmit` exit=0、tauri-rust 23 项通过；同轮 desktop Vitest 因 worker 启动超时（`Test Files no tests`）失败，单独重跑 `../phase2-desktop-rerun.log` 为 5 文件 33/33 通过，属资源竞争而非断言失败。
- 保持诚实：W10 仍为 `NOT_READY`，阻断项 ["LONG_RUN_WINDOW_INCOMPLETE","RETENTION_PARTIAL","RELEASE_DECISION_REPORT_MISSING","REAL_WORKSPACE_OBSERVATION_MISSING"]；24 小时长运行窗口、30 天 retention 日历（至 2026-10-09）与运维签名的 release decision 报告仍未完成。

## 2026-09-10 S2-11 过程轨迹连续验证与状态映射（Stanford LLM-as-a-Verifier）

- semantic verifier 的过程验证从模型自述 `status`/`progress`/小数切换为宿主派生的连续 A–T 期望：`runtime/src/agent-turns.mjs` 的 `runIsolatedModelTurn` 新增 `logprobs` 选项，把 provider 的 `score-logprobs` 位置收集为 `scorePositions`；角色提示要求先输出 `{"summary","evidenceRefs","failureCodes"}`，再输出恰好一个 `<score> LETTER </score>` 标签，并显式禁止模型自述状态或分数。`normalizeSemanticVerdict` 保留用于既有 Council/兼容路径。
- `runtime/src/continuous-verifier.mjs` 新增 `PROCESS_SCORE_TAG`、`PROCESS_VERDICT_THRESHOLDS`（`passThreshold=0.9`、`failThreshold=0.5`）、`mapContinuousScoreToVerdict` 与 `extractProcessScore`；`extractScoreDistribution` 现同时接受 `<score>`、`<score_A>`、`<score_B>`。`score ≥ 0.9` → PASS，`score ≤ 0.5` → FAIL（`PROCESS_VERIFICATION_REJECTED`），中间区间 → ABSTAIN（`PROCESS_VERIFICATION_UNCERTAIN`）。
- 失败关闭：缺失 logprobs 或评分位置不明时返回 ABSTAIN，reason `SEMANTIC_VERIFIER_LOGPROBS_UNAVAILABLE`、source `LOGPROBS_MISSING`；成功时 source `TOKEN_LOGPROB_EXPECTATION`。宿主绝不回退到模型自述的字母或数字，因此仅返回文本的响应无法伪造成分数。
- 事件与结果接线：`runtime/src/index.mjs` 的 `SemanticVerificationCompleted` 携带 `stepId/method/score/variance/distribution/thresholds/source`，`RoleTurnCompleted`（semanticVerifier）与任务结果 `verification.semantic` 同步携带 `score`/`variance`/`distribution`/`method`/`thresholds`；`runtime/src/read-model-rebuilder.mjs` 的 `verifier` 投影通过有界 `scoreDistribution` 暴露同名字段。
- 测试证据：`runtime/test/agent-turns.test.mjs` 13/13（含 “scores from token probabilities”、“a text-only process verdict cannot become a score”、“a low process expectation fails the step and a mid expectation abstains”）；`runtime/test/read-model-rebuilder.test.mjs` 12/12（新增 host 派生过程验证投影用例，含敌意 token 与越界质量）；`runtime/test/plan-step-runtime.test.mjs` 3/3（真实 CLI 断言 semanticVerifier 回合携带 host 分数 0.97、分布 token `['A','T']`，并断言 UNCERTAIN 分支保留 `VERIFIER_EVIDENCE_INSUFFICIENT`）；`runtime/test/candidate-fanout-runtime.test.mjs` 4/4（semantic verifier 分支改为真实 logprobs 通道）。
- 全量并行回归：`cd desktop && npm run test:all:parallel` 报告 `[parallel] SUMMARY total=5 passed=5 failed=0 elapsedMs=595509`，日志 `../phase2-parallel-validation-3.log`。runtime `tests 528 / pass 527 / fail 0 / skipped 1`（1 项为既有 skip）、desktop Vitest 5 个文件 33/33、`desktop-scripts` 11/11、TypeScript `tsc --noEmit` exit=0、tauri-rust `test result: ok. 23 passed`。
- 本轮未声明全计划完成。真实 Windows 安装/升级/回滚/卸载、24 小时长运行（每 2 分钟采样）、操作者签署的发布报告与工作区观察、30 天 retention 日历观察仍未完成，`docs/artifacts/WINDOWS_PHASE2_W10_EVIDENCE.json` 保持 `NOT_READY`。

## 2026-09-10 S2-11/S2-12 长运行测试、脚本测试入口、端口故障类别与连续验证配置化

- 修复 `desktop/scripts/w10-evidence-harness.test.mjs` 长运行用例：原用例以 5 分钟步进探测，步进本身超过 `LONG_RUN_GAP_TOLERANCE_MS = 120000`，把一段连续观察误判为两段。现按 1 分钟步进断言单会话累计，再用 1 小时真实缺口断言开启第二会话，最后断言两段合计 2 分钟；容差保持收紧不变。`node --test scripts/w10-evidence-harness.test.mjs` 4/4 通过。
- 新增 `desktop/scripts/run-script-tests.mjs` 与 `npm run test:scripts`，把此前游离在 Vitest 之外的 `scripts/**/*.test.mjs` 接入回归入口；`desktop/scripts/test-all-parallel.mjs` 增加第 5 个套件 `desktop-scripts`。`npm run test:scripts` 11/11 通过，并行入口报告 `total=5`。
- 定位真实环境故障类别：本机 `netsh int ipv4 show dynamicport tcp` 报告临时端口从 1024 起、共 64511 个，Windows 因此会分配 6000/6666/6697/2049/4045/10080 等 Fetch 规范禁止的端口，undici 随即以 `TypeError: fetch failed` / `cause: bad port` 失败。这是此前被记为“环境抖动”的 `model-openai.test.mjs` 与 `model-openai-tools.test.mjs` 的真实根因。新增 `runtime/test/helpers/listen-loopback.mjs`（`isFetchBlockedPort` / `listenOnFetchablePort`），并把 9 个测试文件中 29 处 `server.listen(0, '127.0.0.1')` 改为可重绑定监听。新增 `runtime/test/listen-loopback.test.mjs`：除断言 `fetch('http://127.0.0.1:6000/')` 以 `bad port` 失败、49999 端口可正常取回内容外，还执行 25 次重绑定。定向重跑 model-openai、model-openai-tools、thread-runtime、dynamic-plugin-runtime 共 14/14 通过。
- 修复真实崩溃缺陷 `verifierGate is not defined`：`runtime/src/index.mjs` 中 `verifierGate` 是 `verify` 回调内的 `const`，但组装任务结果时再次引用，导致所有多智能体运行返回 `{"ok":false,...}`。现把独立门禁结果提升为 `semanticVerifierGate` 并在回调内赋值，结果组装读取 `required: semanticVerifierGate?.required ?? false`。candidate-fanout-runtime 与 plan-step-runtime 定向重跑 6/6 通过；并行回归中的 6 项失败全部来自该缺陷。
- 连续 Verifier 配置化（S2-12 剩余缺口）：`runtime/src/model-config.mjs` 的 `ALLOWED_KEYS` 增加 `verifier`，按 `criteria/repetitions/maxComparisons/pivots/seed/maxPromptChars` 白名单校验；未知字段返回 `MODEL_CONFIG_UNKNOWN_FIELD:verifier.<key>`，非法值返回 `MODEL_CONFIG_INVALID_FIELD:verifier`；`resolveModelConfig` 透传 `fileConfig.verifier`；`runtime/src/index.mjs` 的 judge 调用把配置交给 `runCandidateJudgeTurn`。`candidate-fanout-runtime.test.mjs` 新增 `configured` 场景，断言评测调用数为 `3 × criteria × repetitions`、`CandidateVerificationCompleted.config` 携带实际生效的 `repetitions/criteria.length/seed/pivots/maxComparisons`，4/4 通过（约 87 s）。
- 读模型暴露 A–T 分布证据：`PROJECTION_VERSION` 8 → 9；`runtime/src/read-model-rebuilder.mjs` 新增有界且仅含 token 的 `scoreDistribution` 归一化，候选验证样本投影增加 `leftDistribution`/`rightDistribution`。越界 probability/value、非 A–T token、非数字字段一律丢弃，prompt、输出和推理文本无法通过该通道进入 UI。桌面端 `ContinuousVerificationRecord` 增加同名字段，`renderContinuousVerification` 在分数旁显示有界百分比分布；`contracts/v1/harness-read-model.schema.json` 补齐 `continuousVerification` 与相邻 `verificationDistribution` 定义。新增 runtime 投影用例（含敌意 token 与越界质量）和契约用例（拒绝非 A–T token、超范围概率、多余字段）。
- 验证：`runtime/test/read-model-rebuilder.test.mjs` 11/11；desktop `npm run test` 5 个文件 33/33（含新契约用例）；`npx tsc --noEmit` 通过；`npm run build` 通过。
- 全量并行回归门：`cd desktop && npm run test:all:parallel` 报告 `[parallel] SUMMARY total=5 passed=5 failed=0 elapsedMs=525500`，日志 `../phase2-parallel-validation-2.log`。runtime `tests 525 / pass 524 / fail 0 / skipped 1`（1 项为既有 skip）；desktop Vitest 5 个文件 33/33；`desktop-scripts` 11/11；TypeScript `tsc --noEmit` exit=0；tauri-rust `test result: ok. 23 passed`。上一轮的 6 项 runtime 失败均已由 `verifierGate` 修复消除。
- 本轮未声明全计划完成。真实 Windows 安装/升级/回滚/卸载、24 小时长运行（每 2 分钟采样）、操作者签署的发布报告与工作区观察、30 天 retention 日历观察仍未完成，`docs/artifacts/WINDOWS_PHASE2_W10_EVIDENCE.json` 保持 `NOT_READY`。

## 2026-09-10 S2-12 失败候选与连续验证出域审计

- 候选出域账本写入移至选择成功判断之前：所有候选失败时仍记录实际尝试；取消结果映射为 CANCELLED，避免错误计为普通失败。
- 连续验证新增逐调用 onInvocation 完成事实，成功、失败和取消均记录 prompt digest 与延迟；成功分布样本保持单独证据。原始 provider 错误、草稿和推理不进入账本。预先取消且未调用 provider 时不生成出域事实。
- 契约说明见 `adr/0021-candidate-failed-egress.md`。新增真实 HTTP runtime 测试覆盖候选全失败和 judge 缺失概率证据，验证失败调用不再遗漏；专项 12/12 通过。
- 全量并行回归见 `../phase2-failed-egress-validation.log`：4/4 套件通过；runtime 502 项（501 通过、1 既有 skip）、desktop、TypeScript、Tauri Rust 全部通过。
- 本轮未声明全计划完成。尚需完成连续验证配置/过程链/UI、插件多版本生命周期、W10 实际安装和长期运行证据；30 天 retention 日历观察仍未结束。没有 provider 用量时不推断实际账单金额。

## 2026-09-10 用户明确 Stanford 连续 Verifier 要求

- 用户确认以 arXiv:2607.05391 和官方实现为准，禁止整数 judge；保留独立模型判断。模型直接输出小数同样不满足该要求。
- 已将候选评分切换为真实 token logprobs 期望，增加三准则/两次重复/换位和 PPT，详见 [连续 Verifier 实施记录](LLM_VERIFIER_IMPLEMENTATION.md)。候选过程不再解析 JSON score 为模型验证分数。
- UNC 修复后的上一版完整并行回归 4/4 通过（`phase2-validation-fixed.log`）；该结果发生在连续 Verifier 接线完成前，不能替代最新代码全量回归。

## 2026-09-10 S2-12/S2-13 候选审计与验证入口修复

- 多候选网关现在检查预先取消并停止后续排队调用；自身通过 abort race 强制结束等待，provider 忽略信号也不会无限挂起或将取消结果记为成功。新增预先取消、忽略 abort 的超时和运行中取消三项回归；`node --test runtime/test/candidate-fanout.test.mjs` 19/19 通过。此边界终止本地等待，不声称能撤销 provider 已收到的远端请求。
- 修复独立 judge 只收到 digest、无法按草稿内容评审的问题：安全过滤后的草稿仅在评审调用内传递，judge 收到本步目标和各候选有界文本；按候选均分文本预算并显式标记截断，过大上下文失败并回退确定性排序，避免截断 JSON。普通结果与事件仍只记录 digest、分数和选中草稿。候选/角色专项 29/29 通过，真实 runtime 端到端 1/1 通过，断言 judge 收到双方草稿、无工具，未选中草稿不进入出域持久化记录。
- 修复 ModelEgressLedger 将列表 2,048 条展示上限误用于汇总和持久化的问题：成本汇总与缓存保存现在包含全部账本记录；非 durable 写入同样执行 16,384 条容量检查。
- 新增 2,050 条调用的回归，验证总成本、按 run 汇总以及保存后重新加载均不遗漏末尾候选。`node --test runtime/test/model-egress-ledger.test.mjs` 6/6 通过。
- 修复 Support Bundle 扫描与脱敏遗漏嵌套数组内字符串秘密的问题，并验证违规记录最多返回 32 条。`node --test runtime/test/support-bundle-privacy.test.mjs` 4/4 通过，包含真实 CLI 导出与候选成本汇总。
- 全量并行入口改用既有 `projectPaths` 统一映射 UNC 工作区，避免 npm/CMD 在 UNC cwd 下切换到 Windows 目录和 TypeScript 找不到源码。首轮全量测试暴露这两个路径问题，不作为通过证据；修复后的完整回归仍待确认。
- 全计划尚未完成；上述专项通过不替代真实安装包、长期运行、retention 和发布后观察证据。

## 2026-09-10 S2-12 多候选扇出与选择（契约、扇出、选择、决策投影与多角色执行接入）

- 新增 `runtime/src/candidate-fanout.mjs`：`normalizeCandidateSetSpec`（`CANDIDATE_SET` 模式，`candidateBindings/fanout/selectionPolicyRef/fanoutBudget`，`fanout` 默认 1）、`planCandidateFanout`（风险上限 + 预算 + 候选池三重确定性截断，记录 `RISK_POLICY_CEILING`/`FANOUT_BUDGET_LIMIT`/`CANDIDATE_POOL_LIMIT`）、`CandidateSafetyFilter`（被拒候选不进入评分集合）、`runCandidateFanout`（并发上限、单候选超时、去重、统一错误映射；≥1 个候选成功即逻辑调用成功，仅返回 digest 与有界元数据）、`CandidateSelectionPolicy`（确定性硬淘汰 → 独立 judge 排序 → 选择）、`buildCandidateSelectionDecision`（`SELECT_CANDIDATE` 决策，每个候选一个 option）。
- 选择语义按设计收敛：judge 与候选同源、judge 不可用或 judge 返回未知候选时，降级为成本/延迟确定性排序并记录 `degradationReason`；候选自报置信度不参与排序；硬淘汰候选不能被评分放回；未选中候选标记 `NOT_EXECUTED`，硬淘汰标记 `ELIMINATED`。
- `RoleBindingResolver` 新增 `CANDIDATE_SET` selector：规范化候选集、按风险规划扇出、逐个解析候选绑定；`fanout` 报告实际解析成功的候选数，被隔离或不可用候选以 `rejectedCandidateBindings` 显式保留而不静默丢弃；`fanout=1` 时行为与单候选一致。
- `decision-evaluation` 把 `SELECT_CANDIDATE` 纳入证据决策类型，候选选择必须关联证据并进入 `evidence-link-rate`。
- Read model 决策投影新增有界候选集：`options`（`optionId`、`actionKind`、`expectedQuality`、`expectedCost`、`expectedLatencyMs`、`rejectionReasonCodes`）、`reasonCodes`、`selectionCriteria`；分数按候选真实来源保留，不复制给所有候选。
- Desktop Decision DAG 面板渲染候选集合、每个候选的选中/硬淘汰/未执行状态、评分分量与选择理由。
- 新增 `runtime/src/candidate-draft-stage.mjs` 并把扇出接入 `agentMode=multi` 的真实执行路径：`executor` 角色绑定为 `CANDIDATE_SET` 且有效扇出 ≥2 时，先并发跑只读候选草稿（候选一律 `tools: []`、无 lease、无副作用），再由独立 judge（`critic`/`semanticVerifier` 绑定，且模型身份不得属于候选集合）排序选择，写入 `SELECT_CANDIDATE` 决策，最后只把选中草稿交给唯一的工具执行回合。有效扇出为 1 时完全跳过，保持现有单候选成本。
- 风险策略落到代码：`inspect` 在只读下为 LOW（不扇出），未分类任务类别为 MEDIUM（对应设计中的“任务类别无历史”触发），受控非 inspect 步骤为 HIGH。
- 修复两处真实缺陷：候选 provider 未被构建导致所有候选回退到主 provider（`providerModelIds` 未包含 `candidateBindings`）；resolver 未收到风险提示导致扇出被默认 LOW 截断为 1。模型配置新增 `CANDIDATE_SET` role binding 校验（`candidateBindings`/`fanout`/`selectionPolicyRef`/`fanoutBudget`）。
- 验证：`runtime node --test test/candidate-fanout.test.mjs` 16/16；`node --test test/model-registry.test.mjs` 10/10；`node --test test/read-model-rebuilder.test.mjs` 11/11；`node --test test/candidate-fanout-runtime.test.mjs` 通过（真实 `--agent-mode multi` 端到端：两个候选各自独立 provider 被调用、候选回合无工具、独立 judge 排序、`SELECT_CANDIDATE` 决策含 2 个选项且分数按候选归因、未选中候选草稿从未进入执行回合）；`cd desktop && npm run test:all:parallel` 4/4 套件通过（runtime 480 项、479 过、1 既有 skip、0 失败；desktop Vitest 32/32；TypeScript；Rust lib 20/20）。
- 同时把 `approval-events.test.mjs` 的 30 秒墙钟预算改为 120 秒：该 CONTROLLED 子进程在健康机器上本就需要约 26 秒，原预算几乎无余量，会在并行套件负载下因环境原因失败；超时仍会 kill 子进程，真实挂起依然失败。
- S2-12 尚未完成：候选粒度的成本/出域记录展开到 Support Bundle、judge 走独立 role context 的绑定解析、以及候选集合的真实安装包 UI 验收。

## 2026-09-10 S2-11 Dashboard Decision DAG 与 Support Bundle 就绪面

- Runtime read-model projection 现在把每条 `DecisionTraceEvent` 投影为有界 DAG 节点：新增 `stepId`、`agentInstanceId`、`parentDecisionIds`（去重、丢弃自引用、上限 64）和 `supersedesDecisionId`；`PROJECTION_VERSION` 提升到 `7`。
- Dashboard payload 新增 `supportBundle` 就绪面：复用与真实导出同一套 `scanSupportBundle` 脱敏扫描，暴露 `privacy.scan`、各事实源计数、导出调用和证据来源；扫描命中时 `supportBundle.ok=false` 并列出违规路径，但不改变顶层 `ok`。
- Desktop 新增 `RuntimeDecisionNode` 与 `RuntimeSupportBundleReadiness` 契约类型、`HarnessReadModel.decisions/supportBundle` 字段，并渲染「Decision DAG」决策图（节点 + parent/supersede 边，父节点不在当前窗口时显式标注）与「Support Bundle」诊断导出就绪度两段面板。
- `contracts/v1/harness-read-model.schema.json` 补齐 `decisions`/`feedback`/`evolutionControl` 三个此前缺失的顶层事实面与对应 `$defs`；`contract.test.ts` 新增用例拒绝越界 `optionCount`、超长 `parentDecisionIds` 和未知字段。
- 验证：`runtime node --test test/read-model-rebuilder.test.mjs` 9/9 通过；`node --test test/dashboard-event-sources.test.mjs` 通过（真实 dashboard CLI 断言 DAG 边与 supportBundle 扫描）；`cd desktop && npm run test:all:parallel` 4/4 套件通过（runtime 459 项、458 过、1 既有 skip、0 失败；desktop Vitest 31/31；TypeScript；Rust lib）。

## 2026-09-10 计划变更：新增 S2-12 多候选扇出与选择

- 总体设计新增 5.3.2「多候选扇出与选择（LLM as a Service）」：同角色同问题并行扇出多个模型候选，`CandidateSelectionPolicy` 先确定性硬淘汰、再由独立 judge 排序选择；`ModelSelector` 增加 `CANDIDATE_SET` 模式，Decision Trace 增加 `SELECT_CANDIDATE` 决策类型和 `CandidateBatchInvoked/CandidateScored/CandidateSelected` 事件。
- 阶段二计划新增 S2-12（进入 W9，依赖 S2-08），原 W10 发布包顺延为 S2-13，并同步更新并行轨道表、G3 发布门、禁止事项和参考文件。
- 该项为设计与计划变更，尚未产生实现或测试证据。

## 2026-09-10 S2-11 Evolution 控制与版本漂移

- 新增 Harness Event Store 承载的 Evolution 全局 kill switch：`evolution kill`/`evolution enable` 是幂等安全事实；阻断后新的 outcome、proposal、replay、shadow、canary、promotion 和在线监测都 fail-closed，而既有候选的紧急 `rollback` 仍可执行。Dashboard 暴露全局阻断状态。
- Evolution 在线监测新增 proposal 版本/package digest 漂移检查；任何漂移都会写入 `VERSION_DRIFT` 原因并自动 `ROLLED_BACK`，不会因样本量不足而暂缓。
- 专项验证：`node --test runtime/test/evolution-control.test.mjs` 2/2；Evolution/Registry/Dashboard 合并验证 26/26；Tauri/Rust `build-openviking-sidecar.mjs --debug --test` 20/20；TypeScript `tsc --noEmit` 通过。

## 2026-09-10 S2-09 OpenViking 本地运行时降级证据

- Tauri 宿主现在在托管 sidecar 启动前生成或绑定 64 hex loopback Bearer key，并通过 `HMCODEX_OPENVIKING_API_KEY_ENV=HMCODEX_OPENVIKING_API_KEY` 传给 runtime；sidecar API 对缺少/错误 Bearer 的请求返回 401，`/ready` 仍保留为无认证健康探针。已覆盖 loopback-only URL、有界请求/响应、和 401/403/503 边界。
- 索引损坏故障注入：`node scripts/openviking-corruption-e2e.mjs` 写入非法 JSON 后启动真实 sidecar，返回 `{"status":"ok","result":{"ready":true,"degraded":true}}`，并将原文件备份为 `openviking-store.corrupt-1789009300217.json`。
- release sidecar 与 supervisor 端到端：`node scripts/openviking-server-e2e.mjs` 通过 health/recall/record/used/commit；`node scripts/openviking-supervisor-e2e.mjs` 通过故障后换 PID 重启和 supervisor 退出清理。
- Rust sidecar/bin 回归：`cargo test --features sidecar` 23 项通过（lib 20、server bin 3）。

## 2026-09-10 S2-10/S2-13（原 S2-12）供应链与全本地构建门

- 动态插件 discover 现在在 `WINDOWS_PHASE1_5_CONTROLLED` / `WINDOWS_FULL_LOCAL` 下要求 Ed25519 签名；签名必须绑定 manifest digest、公钥必须命中 `HMCODEX_PLUGIN_TRUST_KEY(S)`，否则分别返回 `PLUGIN_SIGNATURE_REQUIRED`、`PLUGIN_SIGNATURE_TRUST_UNAVAILABLE` 或 `PLUGIN_SIGNATURE_INVALID`。
- 新增 `governance.revoke()`，ACTIVE/ENABLED/DEGRADED 记录命中撤销会转成 `QUARANTINED` 并保留 reason/revocation 元数据，`assertLoadable` 因此 fail-closed。
- 新增 `npm run build:windows:full-local`，和 controlled 构建一样删除可污染前端构建的 NAPI 覆盖变量，并在构建期固定 `HMCODEX_BUILD_RELEASE_CHANNEL=WINDOWS_FULL_LOCAL`。
- 验证：`node --test test/plugin-signature.test.mjs` 2/2；`node --test test/plugin-signature.test.mjs test/dynamic-plugin-runtime.test.mjs test/plugin-cli.test.mjs` 9/9；`node --test scripts/build-controlled.test.mjs` 3/3。

## 2026-09-10 S2-11 Memory 删除与不可训练边界

- Memory 新增 `delete` 生命周期：真实删除现在把 statement 脱敏为 `[DELETED]`、清空 source links、置信度归零，并写入 `untrainable=true` / `untrainableAtMs`；删除事实作为 Harness `MemoryStateChanged` 提交，read model 同步显示 PRUNED 且不再复活原内容。schema 增加对应字段。
- Desktop 增加删除入口和类型；Tauri `memory_action` 允许 `delete` 并固定使用 runtime 的 durable 通道。重复 delete 是幂等的。
- 验证：`node --test test/governance-memory-dream.test.mjs` 26/26；`node --test test/read-model-rebuilder.test.mjs` 8/8；desktop contract 8/8；TypeScript `tsc --noEmit` 通过。

## 2026-09-10 G2 发布门结论

- `WINDOWS_PHASE1_5_CONTROLLED` 的受控链路、真实安装包、UI 安全场景、安装生命周期和 release-check 证据已闭环；G2 通过。
- 可以进入 W9，但 W9 必须继续使用同一 Harness Event Store/ReadModel，并保持 OpenViking、Plugin、Thread、Memory/Dream/Evolution 的 feature gate 与失败关闭边界。

## 2026-09-10 S2-08 受控链路与安装包发布验收

- Runtime read-model projection 现在识别 `ActionRequested`，不再把等待审批的受控 run 误投影为 `PAUSED_UNSUPPORTED`；`PROJECTION_VERSION` 提升到 `6`，并新增“controlled `ActionRequested` 不暂停 run projection”回归测试。
- `desktop/scripts/ui-security-test.mjs` 使用套件级 `HMCODEX_DATA_DIR` 隔离 threads、role contexts、recovery 和事件投影，避免历史全局数据造成跨场景审批状态串扰。S04 的语义 Verifier 证据等待和 S06 断线失败证据等待提高到 180 秒；S04 在任务已自然终态时不再强制点击取消按钮。
- 完成 x64 受控发布构建，产物：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/hmcodex-desktop.exe`（SHA-256 `2F8C7D33CBF80CD255C44C9110BC711165D5A3F6FD1B7849061868D5250CB6F6`）、MSI（`7F2DED4CA9FE9AA90A13E711B024762BB311C00DA908A62E6326B9BB7E077F10`）、NSIS（`EBCDF1C2B476BE22FE0760EE80BE1D080B1FAC0640639F854101D6CA5EB6101F`）。
- 受控 UI 安全套件 6/6 通过：调试 EXE、release EXE、已安装 MSI EXE 分别验证受控门控、非法网络 JSON、审批拒绝、审批批准、副作用超时和断线恢复。release 与已安装 MSI 场景中，S04 显示 `语义 Verifier 证据`、独立 `verifier-fixture` 身份和 PASS verdict，S04 文件内容保持 `controlled-ui-ok`。
- 受控 release EXE 的 UI 功能回归 7 过、0 失败、6 按条件跳过；MSI 复装后的已安装 EXE 再次通过同一 UI 功能回归。
- MSI per-user 生命周期：`REINSTALL=ALL REINSTALLMODE=vomus` 升级 exit=0；`msiexec /x {F99F8F9D-7E0B-46A4-A52A-466A10D28B25}` 卸载 exit=0 且应用文件移除；`MSIINSTALLPERUSER=1 ALLUSERS=2` 复装 exit=0，复装后 EXE SHA-256 为 `CC1A2135F3A20DBB1963380B953CFA63A11D3BD874043130BD6E16C211FD2CC9`。
- source 与已安装 runtime 的 `release-check` 均 `passed=true`，检查包括 controlled channel、event store、read model checksum、decision metrics、隐私和容量；报告见 [WINDOWS_PHASE2_RELEASE_CHECK_2026-09-10.json](artifacts/WINDOWS_PHASE2_RELEASE_CHECK_2026-09-10.json) 和 [WINDOWS_PHASE2_INSTALLED_RELEASE_CHECK_2026-09-10.json](artifacts/WINDOWS_PHASE2_INSTALLED_RELEASE_CHECK_2026-09-10.json)。
- 最终并行回归门：`cd desktop && npm run test:all:parallel` 4/4 通过；runtime 453 项（452 过、1 既有 skip、0 失败）、desktop Vitest 30/30、TypeScript、Rust lib 测试通过。

## 2026-09-09 S2-05 网络适配器（受控）

- 新增 `RestrictedNetworkAdapter`（`runtime/src/restricted-network-adapter.mjs`）：显式 host/port/scheme/method/path 目标、默认仅 HTTPS、literal IP 与 DNS 解析结果的私网/metadata 地址拒绝、`redirect: manual` 且重定向一律 fail-closed（一次性 lease 无法授权下一跳）、响应字节/字符上限截断、超时与外部取消、输出脱敏并仅返回 `targetDigest`。
- `RuntimeSafetyMonitor` 新增 `network_request` 动作与 `network.request` capability；lease 绑定显式 networkTargets，monitor 配置与 lease 双重 allowlist，任一不匹配返回 `SAFETY_NETWORK_NOT_ALLOWED`；新增 `SAFETY_NETWORK_*` 错误码与 `isPrivateNetworkAddress`。
- `controlled-tools` 注册 `network.request` 模型工具（无 lease 拒绝、一次审批一个 lease）；`createExplicitLeaseProvider` 支持 networkTargets；runtime 受控任务通过 `--network-targets`/`HMCODEX_NETWORK_TARGETS` 显式配置，缺省关闭；审批 risk=HIGH，capability snapshot 记录 networkTargets。
- 契约同步：`contracts/v1/action-intent.schema.json` requestSummary 增加 host/port/scheme/method；`execution-state-store` requestSummary 记录网络目标字段，保持 intent/lease 事件链完整。
- 测试：新增 `runtime/test/network-adapter.test.mjs`（无 lease 拒绝、一次性消费、scope/scheme/method/IP 拒绝、DNS 私网解析拒绝、重定向阻断、响应截断、超时、工具链 lease 闭环）。
- 验证：`cd desktop && npm run test:all:parallel` 全部通过（runtime 437 项 436 过 1 skip 既有、desktop 26 项、typescript、tauri-rust）。

尚未完成（保持 G2 门未过）：受控 release channel 的真实安装包 UI 场景验收、`--network-targets` 的桌面设置/审批卡片透出、S2-07 网络威胁矩阵的真实 DNS rebinding/重定向故障注入、以及 S2-06 的 LLM Verifier 独立 provider 发布门。

## 2026-09-09 S2-01/S2-03/S2-08 网络跨层接线（桌面端）

- Tauri `run_model_task` 新增 `leaseNetworkTargets` 透传：serde_json 序列化后以 `--network-targets` 传入 runtime；Phase 1 渠道仍由既有 `validate_release_mode` 拒绝 CONTROLLED，无法经桌面开启网络。
- `RuntimeTaskOptions.leaseNetworkTargets` 类型与 `ApprovalReadModel.host/port/scheme/method` 字段落进 `desktop/src/domain/models.ts`；审批卡片展示网络请求的方法/协议/host:port，运行时事件中的网络目标字段已透传。
- Controlled 模式下“能力边界”面板新增网络 allowlist 编辑器（JSON，留空禁用），解析器下沉为 `desktop/src/domain/network-targets.ts` 并新增 4 个单元测试；非法 host/port/scheme/method 即时报错，不影响只读模式。
- 验证：`tsc --noEmit` 通过；desktop vitest 30 项通过；`cargo test --lib` 19 项通过。runtime 套件未受本轮改动影响（上一轮 437 项基线仍有效）。

## 2026-09-09 S2-06 Workspace 写互斥与独立 Verifier 门

- 新增 `WorkspaceLeaseRegistry` 并接入 runtime monitor：同一 workspace 同时只允许一个 mutating lease（`file.write`、`shell.execute`、`test.execute`）持有；网络只读目标不占用该写槽。注册键使用 Windows canonical mapped path 规则，mapped drive 与对应 UNC 路径可识别为同一 workspace。锁记录通过 `O_EXCL` 文件跨 runtime 进程共享；持有进程崩溃后，过期 lease 仍可在签发阶段安全回收。
- `PolicyLease` 携带 workspace guard，`controlled-tools` 在副作用成功或失败后释放；若泄漏未释放，lease 过期时间会使 registry 条目失效，避免永久死锁。第二个 mutating lease 在签发前被 `SAFETY_WORKSPACE_LEASE_BUSY` 拒绝。
- 新增 `semantic-verifier-gate`：CONTROLLED 任务以及 modify/test 高风险任务要求 semantic verifier 使用独立 provider 实例和不同模型身份。不满足时 verdict 硬失败为 `FAIL`，失败码 `SEMANTIC_VERIFIER_INDEPENDENCE_REQUIRED`，不会降级成 `ABSTAIN`，也不能覆盖 deterministic `FAIL`。
- runtime 事件与任务输出记录 semantic verifier 的 provider/model 身份、verifier gate 结果和失败码；Council 集成测试改用 executor/verifier 双模型配置，保持测试符合独立 verifier 门而不是放宽门禁。
- 新增/更新测试：workspace 互斥、网络 lease 不占写槽、controlled 工具调用后释放 workspace guard、独立 registry 实例共享锁、真实子进程竞争与释放恢复、低风险不要求独立 verifier、高风险独立 provider/model 满足、复用 provider 或 model identity 失败关闭。
- 验证：runtime `npm test` 448 项，447 过、1 既有 skip、0 失败；`cd desktop && npm run test:all:parallel` 4/4 套件通过（runtime 448 项、desktop vitest 30 项、TypeScript `tsc --noEmit`、`cargo test --lib` 19 项）。

## 2026-09-09 S2-07 网络硬化与资源故障注入

- 网络适配器新增受控并发上限（默认 2，上限 16）；超过 `SAFETY_NETWORK_CONCURRENCY_LIMIT` 的请求在占用一次性 lease 前拒绝。
- `RuntimeSafetyMonitor` 在进入 fetch 前扫描 string body；匹配 token、authorization、bearer 或 private key 等泄漏模式时返回 `SAFETY_NETWORK_SECRET_REJECTED`，避免把审批用途变成秘密外泄通道。
- `RestrictedWindowsExecutor` 的超时/取消清理升级为 Windows 递归进程树回收：先用 CIM 发现 descendant PID，再逐个 `taskkill /F`，并在结果返回前等待清理完成；detached 孙进程不再逃逸。
- 新增 S2-07 故障注入用例：并发第三请求拒绝且不消费 lease；泄漏模式 body 在 lease 消费前拒绝。
- 新增 detached 孙进程超时清理故障注入用例，确认 `taskkill /T` 不可依赖时仍能回收逃逸进程。
- 验证：`cd runtime && node --test test/network-adapter.test.mjs` 12 项全部通过；`node --test test/safety-executor.test.mjs` 14 项全部通过。

## 2026-09-09 S2-01 构建期 Channel 锁定

- Runtime release channel 解析现在优先使用 `HMCODEX_BAKED_RELEASE_CHANNEL`；存在该构建期事实时，`HMCODEX_RELEASE_CHANNEL` 不能把受控安装包降级为只读或改成非法 channel。
- Tauri runtime 子进程现在把编译期 `HMCODEX_BAKED_RELEASE_CHANNEL` 传递给 Node runtime；开发构建没有该事实时仍保持原行为。
- 新增端到端拒绝用例：同时提供 `HMCODEX_BAKED_RELEASE_CHANNEL=WINDOWS_PHASE1_5_CONTROLLED` 和 `HMCODEX_RELEASE_CHANNEL=WINDOWS_PHASE1_READ_ONLY` 时，runtime health 仍报告 controlled channel。
- 验证：`cd runtime && node --test test/release-channel.test.mjs` 6 项全部通过；`cd desktop/src-tauri && cargo test --lib` 19 项全部通过。

## 2026-09-09 S2-08 受控安装包与 UI 门控

- 成功生成 `WINDOWS_PHASE1_5_CONTROLLED` 编译期固定 channel 的 Windows 安装包：MSI 与 NSIS 产物均来自 `npm run build:windows:phase15`。
- UI 功能测试脚本现在支持只读与受控两种 release channel；受控安装包可验证初始门控、模式切换回环、工作区导航、只读预览、线程恢复、时间线分页、治理/执行状态刷新和无渲染错误。
- `release-check` 现在接受 controlled channel 作为受控发布基线，并在该 channel 下把 `sideEffectRejection.blocked=false` 视为符合预期，而不是把检查错误地判失败。
- 验证：`cd runtime && node --test test/release-check.test.mjs` 3 项全部通过；使用受控 release 可执行文件运行 UI 功能套件 11 项通过、0 失败、2 项真实模型流程按约定跳过。
- 最终并行回归门：`cd desktop && npm run test:all:parallel` 4/4 套件通过；runtime 452 项（451 过、1 既有 skip、0 失败）、desktop 30 项、TypeScript、Rust 19 项。

- 2026-09-10: 新增 desktop/scripts/w10-evidence-harness.mjs，生成明确区分模拟与真实安装的 W10 证据；当前 artifact 标记 NOT_READY，安装/长运行/备份恢复/隐私删除/kill switch 仍需真实已安装主机观察。

- 2026-09-10: 全量并行回归 `../phase2-current-validation.log`（起始 20:33:27，日志落盘 20:39）：`[parallel] SUMMARY total=4 passed=3 failed=1`。desktop Vitest 5 个文件 32/32 通过；typescript `tsc --noEmit` 通过（exit=0）；tauri-rust `test result: ok. 23 passed; 0 failed`；runtime 未通过（exit=1）：tests 515、pass 512、fail 2、skipped 1。该日志不是 4/4 全绿证据，不能作为全量回归通过门。
- 2026-09-10: 上述 2 项失败均为 provider 真实 HTTP 用例的网络层错误，非断言逻辑失败：`runtime/test/model-openai-tools.test.mjs:181`（`TypeError: fetch failed`，`cause: bad port`）与 `runtime/test/model-openai.test.mjs:43`（`fetch failed`，错误计数 `1 !== 0`）。随后专项重跑 `../phase2-provider-recheck.log`（20:41）：tests 12、pass 12、fail 0，上述两个用例名均转绿。专项重跑不替代一次完整的 4/4 并行回归；最新代码的全量全绿证据仍待重跑确认。
