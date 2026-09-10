# Phase 1 Windows 构建记录（2026-09-09）

本次构建在本地 NTFS 副本 `C:\work\hmCodex` 完成。共享盘（`Z:` / UNC）仍无法运行 Tauri 原生 CLI，因此继续采用“源码在 `Z:\DevEcoStudioProjects\hmCodex`、构建在本地副本”的方式。

## 源码同步

使用 `robocopy /MIR` 镜像以下目录到本地副本，未复制 `node_modules`、`target`、`dist` 等构建缓存：

- `runtime/src`、`runtime/test`
- `desktop/src`、`desktop/src-tauri/src`、`desktop/scripts`
- `contracts`、`docs`

## 构建环境

| 项 | 值 |
| --- | --- |
| 构建目录 | `C:\work\hmCodex` |
| 构建命令 | `node desktop/scripts/build-phase1.mjs` |
| 发布渠道 | `WINDOWS_PHASE1_READ_ONLY`（构建期烘焙） |
| Node | v24.19.0 |
| 目标 | `x86_64-pc-windows-msvc` |
| Rust release 编译 | 约 3m 16s（第四次构建，含 `release-check`、thread title 隐私修复和 M2 eventId 关联） |

## 产物（2026-09-09 01:38 +08:00）

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9565184 | `EBFE9ED8E99D68D53CE3D708BD5879E002ACEE06FBD05AC654CE1BCD4B93CFED` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3830312 | `ADE57303523C5D27B9E0B055C01F37A51E4AD8DA1511FE81AD1C6BAE1B2CB9E1` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2444360 | `D1ABF5C7C67E201BF801029DE5FF63B3F664475FA62BAA717D8593E5815C2E42` |

产物根目录：`C:\work\hmCodex\desktop\src-tauri\target\x86_64-pc-windows-msvc\release`。

## 渠道与运行时烟测

- `hmcodex-desktop.exe` 内含字符串 `WINDOWS_PHASE1_READ_ONLY`，不含 `WINDOWS_MVP_PRE_PHASE1`。
- 使用打包后的 `release\runtime\src\index.mjs` 运行：
  - `health`：`ok:true`，`releaseChannel=WINDOWS_PHASE1_READ_ONLY`，模型 `mimo-v2.5-pro`；
  - `recovery`：`ok:true`，`reconciled=0`；
  - `dashboard`：`ok:true`，渠道正确，projection/threads/plugins/memories/dreams 字段可读。
- Phase 1 副作用拒绝：`task --execution-mode CONTROLLED` 在创建 run 前返回 `ok:false`、`error=RELEASE_CHANNEL_READ_ONLY`、`runId` 为空。
- 打包 runtime `release-check` 可执行：`ok:true`、渠道/版本/拒绝/checksum/隐私/容量检查通过；空数据目录下仅 `hasRuns=false`，因此 `passed=false` 符合预期。
- 打包 runtime provider-unreachable 场景：run 失败并写入 `TaskRunFailed`；`ThreadCreated` 只含 `titleDigest`，durable events 不含原始 prompt。
- 打包 runtime `release-check`：渠道/版本/拒绝/隐私/容量检查通过；空数据目录下仅 `hasRuns=false`。

## 自动化验证

| 范围 | 结果 |
| --- | --- |
| runtime 全量（工作区源码，含 release-check / provider-unreachable） | 408/408 |
| desktop TypeScript | 通过 |
| desktop vitest | 26/26 |
| `cargo check` / `cargo fmt --check` | 通过 |

## 尚未完成

- 未安装本轮 MSI/NSIS，未执行安装、升级、卸载和快捷方式启动验收；
- 未执行桌面 UI 手工场景（新建线程、连续任务、模型断线、取消、超时、进程重启、重建 projection、导出和删除）；
- 未做真实设备容量压力与长期 retention 观察。

因此本轮结果是 **构建与运行时烟测通过**，不等于 M7 Windows Phase 1 发布验收完成。

## 第二次构建（含独立 cancel / >100k 事件分页）

在完成 M5 独立任务级 cancel 和 M3 >100,000 事件 keyset 分页后，重新同步 `runtime/src`、`runtime/test`、`desktop/*`、`contracts`、`docs` 到 `C:\work\hmCodex` 并重建。构建命令仍为 `node desktop/scripts/build-phase1.mjs`，Rust release 约 3m16s，前端 vite 构建成功，MSI/NSIS 均生成。

### 产物（2026-09-09 02:20 +08:00 左右）

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9565184 | `4D21BD0FEC3551D3CC7C0E60542D8377012C9DEEEE91AC3108377988E0E9B36C` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3838520 | `FFD9F40F86F74E812127D7C738FA3D414439EF426862A542667169E83649B6EA` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2448517 | `28DEC57F92A78177CEE4D5FB8113D31B60AF7423BE181676395A0E9A8AE6DD13` |

### 打包 runtime 烟测

- EXE 内含 `WINDOWS_PHASE1_READ_ONLY`，不含 `WINDOWS_MVP_PRE_PHASE1`；打包 runtime 目录含 `task-cancel-registry.mjs`。
- `health`：`ok:true`，渠道 `WINDOWS_PHASE1_READ_ONLY`，模型 `mimo-v2.5-pro`。
- `recovery`：`ok:true`，`reconciled=0`。
- `dashboard`：`ok:true`，projection/threads/plugins/memories/dreams 可读。
- `task --execution-mode CONTROLLED`：创建 run 前返回 `ok:false`、`RELEASE_CHANNEL_READ_ONLY`。
- 新增 cancel 命令：`cancel --run-id smoke-run` 返回 `CANCEL_REQUESTED`，`cancel list` 返回同一 pending 请求，sidecar 只含 reason digest。
- provider-unreachable 任务：退出码 1，写入 66 个 durable 事件（含 `TaskRunFailed`），durable envelope 不含 prompt 原文；`release-check` 可执行，`hasRuns=true`，该失败 run 的 `decisionCoverage=80`（失败路径未产生全部决策类型），因此 `passed=false` 符合失败 run 的预期，不代表发布检查失效。
- 空数据目录下 `release-check` 仅 `hasRuns=false`，`passed=false`；`release-check.test.mjs` 的真实成功 run 用例仍验证 `passed=true`。

### 本轮自动化

| 范围 | 结果 |
| --- | --- |
| runtime 默认全量 | 416 tests / 415 pass / 1 skipped（>100k 规模用例按设计跳过）/ 0 fail |
| runtime >100k 显式规模用例 | `HMCODEX_SCALE_TEST=1`，100,001 事件、101 页分页、verify、投影重建 checksum 一致，约 596s，通过 |
| desktop vitest | 26/26 |
| 前端 vite 生产构建 | 通过（构建内） |
| Rust release 编译 | 通过（构建内） |

### 仍未完成

- 未安装/升级/卸载 MSI/NSIS；
- 未执行桌面 UI 手工场景（新建线程、连续任务、模型断线、取消、超时、进程重启、重建 projection、导出和删除）；
- 未做真实设备容量压力与长期 retention 观察。

## 第三次构建（含 holdout fixture / 发布门控）

在补齐 holdout 数据集与 `--require-holdout` 发布门控后，再次同步 `runtime/src`、`runtime/test`、`docs` 到 `C:\work\hmCodex` 并重建。构建命令、目标与渠道同上，Rust release 约 3m14s，vite 前端构建成功，MSI/NSIS 均生成。

### 产物（2026-09-09 03:0x +08:00）

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9565184 | `FC4786FE9D39C0D935595CC02C7086C6547CB63F4277AA22A416B5B4615B48D2` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3838520 | `A96F44D52A0764DD6AD95CA11640059E1B5D3257731B4DB7632F755067ABAC81` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2450418 | `1C0757F14EB68DA3883926AEA0DA61674CF5F1AB8E32FB526079CFED120662C3` |

### 打包 runtime 烟测

- `health` / `recovery` / `dashboard` 均 `ok:true`，渠道 `WINDOWS_PHASE1_READ_ONLY`；
- `task --execution-mode CONTROLLED` 返回 `RELEASE_CHANNEL_READ_ONLY`；
- `cancel --run-id smoke-run` 返回 `CANCEL_REQUESTED`；
- 打包 runtime 含 `EVOLUTION_HOLDOUT_REQUIRED` / `datasetKind` / `--require-holdout` / `task-cancel-registry.mjs`；
- 真实 CLI holdout 流程：创建 proposal → VALIDATING → SHADOW → CANARY，`promote --require-holdout` 先返回 `EVOLUTION_HOLDOUT_REQUIRED`；`evolution replay --fixtures runtime/test/fixtures/holdout-dataset.json` 返回 `datasetKind=HOLDOUT`、`datasetVersion=1.0.0`；再次 `promote --require-holdout` 返回 `status=ACTIVE` 且绑定 HOLDOUT 报告。

### 本轮自动化

| 范围 | 结果 |
| --- | --- |
| runtime 默认全量 | 418 tests / 417 pass / 1 skipped（>100k 规模用例按设计跳过）/ 0 fail |
| runtime >100k 显式规模用例 | `HMCODEX_SCALE_TEST=1`，100,001 事件、101 页分页、verify、投影重建 checksum 一致，约 596s，通过 |
| desktop vitest | 26/26 |
| cargo fmt --check / desktop 路径测试 | 通过 / 2/2 |

## 第四次构建（Git observer 大仓库性能修复）

桌面 UI 手工测试发现大仓库任务约 102.8s。定位为 Git observer 的 `--untracked-files=all` 在网络盘 + 大依赖/构建目录上耗时约 29.6s（任务前后各一次）。`GitObserver` 默认改为 `normal`（可显式 `all`/`no`），runtime task / audit snapshot / recovery 三处入口都支持 `--git-observer-untracked`。同一大仓库 `hello` 任务：源码版 102.8s → 23.4s，打包 runtime 24.4s，均 `ok=true`。

### 产物（2026-09-09 09:19 +08:00）

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9565184 | `5F23F1D0EC6FF919E054274C80C33C4DF1E5A0F15738BD853D6B857FF7F708F8` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3838520 | `0CCE11B895BDAD16DE8135ED096D5B7C4F840F48AC680F23BE7A6971D478FA60` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2447589 | `AB633FDB45D0D9B577B0FB36FA190AB12AA28391C229400726E69C1DB9988677` |

### 验证

- runtime 默认全量：420 tests / 419 pass / 1 skipped / 0 fail（整套耗时从 344s 降到 271s）；
- `git-audit.test.mjs` 10/10，含新增的 `normal` / `all` 对照用例；
- 新 App 启动后 `health` / `recovery` / `dashboard` 均成功；
- 打包 runtime 大仓库 `hello` 任务 24.4s、`ok=true`。

## 本地构建提速（UI 迭代）

完整 Phase 1 release 构建（Rust release + MSI/NSIS）增量约 **1m33s**，适合最终验收；日常 UI 迭代不必每次跑完整包。

| 方式 | 命令 | 实测增量耗时 | 产物 |
| --- | --- | ---: | --- |
| 完整 release（最终验收） | `npm run build:windows:phase1` | 约 1m33s | `target\...\release\hmcodex-desktop.exe` + MSI/NSIS |
| 快速迭代（debug，不打包） | `npm run build:windows:phase1:fast` | 约 **20.9s**（Rust 14.6s + 前端 0.1s） | `target\...\debug\hmcodex-desktop.exe` |
| 前端热重载（可选） | `npm run dev:vite` + `tauri dev --no-dev-server` | 前端改动不重编 Rust | 开发窗口 |

说明：

- debug 首次构建需要编译 debug 依赖，约 4m33s；之后改前端/资源约 20s。
- `build:windows:phase1:fast` 仍会烘焙 `WINDOWS_PHASE1_READ_ONLY`，UI 的只读门控与正式包一致；debug 二进制里可能同时看到 `WINDOWS_MVP_PRE_PHASE1` 这个未优化掉的 fallback 字符串，但实际渠道由 `HMCODEX_BAKED_RELEASE_CHANNEL` 决定。
- 实测把 linker 换成 `rust-lld` 会触发全量重编（约 5m26s），不建议用于日常增量构建；默认 MSVC `link.exe` 已足够。

## 第五次构建（流式渲染 + 任务监督诊断日志）

在修复桌面 UI 流式渲染卡顿、增加取消/任务监督诊断日志后重新构建 release 产物。注意：之前一次 `rust-lld` 链接器实验使 release 指纹失效，本次触发全量重编（约 6m24s）；后续回到默认 `link.exe` 的增量构建会恢复。

### 产物（2026-09-09 09:55 +08:00）

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9572864 | `B7F4932E4B577068989BB003A597A2307D860D6B06D6A2CD1751D7617E4DDF51` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3916360 | `20330F4C2052C8B48CCDA726BE53A1DFA36C0E5A370174AF6A357F4268CE72D7` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2450536 | `C63B716975F7E0E464B7CBFD36170ECB27878B625807125871E1D61CB3C480FD` |

### 包含的修复

- Git observer 默认 `--untracked-files=normal`，大仓库任务 102.8s → 约 24–35s；
- `model.text_delta` 按 `requestAnimationFrame` 合并渲染，避免全量 `innerHTML` 每 delta 重绘导致 WebView 卡死；
- `cancel_runtime_process` 与任务监督日志（spawn/stdout EOF/child wait status/stderr/最终解析）；
- EXE 含 `WINDOWS_PHASE1_READ_ONLY` 和 `cancel_runtime_process invoked` 诊断字符串。

### 默认数据修复（非产物）

- `%LOCALAPPDATA%\hmCodex\trajectory.jsonl` 尾部 41,160 字节 NUL 已备份并截断（保留 2543 条有效事件）；
- `trajectory.jsonl` 2543 条 + `harness-events.json` 67 条已导入 `hmcodex.db`，现 2934 事件、verify 通过；
- App 完全相同的命令 + 默认 store 复测（debug runtime）：`exit=0`、`ok=true`、34.7s；
- 最终 release runtime + 修复后的默认 store 复测：`exit=0`、`ok=true`、23.2s、runId `run-c6037d59-4bf4-46de-a434-49076ede7016`。

## 第六次构建（decision-trace 诊断 + UI 端到端成功）

桌面 UI 首次端到端成功：App 发送 `hello`，真实模型返回工作区识别结果。随后补入 `decision-trace.mjs` 的 replay 事件级诊断，并重建 release 产物（增量约 2m01s）。

### 产物（2026-09-09 11:35 +08:00）

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9572864 | `E7A7C9F9855670FACA48A5B4465FFB4DA36C2EB8B9B3B765E26028DFA1CC03D4` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3912264 | `1472DBF261633C8FCEF9087341B94F02D83407E6602AC5DF1C243F32715610FD` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2451396 | `B081A517BD2A066CA3FDE8F854CF7DA80BA7042A3D94E4468C234A27B9249CE2` |

### 验证

- 打包 runtime 的 `decision-trace.mjs` 已包含 `replayUnavailableDetail` 诊断；
- 桌面 UI：新建线程 + `hello` 只读任务成功，真实模型返回工作区识别结果；
- 验收矩阵“桌面 UI 手工场景”更新为 PARTIAL（其余场景待测）。

## 第七次构建（常驻取消按钮 + stdout 断管守卫）

在修复“取消按钮只在运行期间渲染、空闲时被发送按钮替换导致用户看不到”和“桌面强杀/重启时 runtime 子进程抛 `EPIPE` FATAL”后重建 release 产物（增量约 2m06s）。

### 产物（2026-09-09 12:14 +08:00）

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9572864 | `5A778428D0CA7B0292300CD94C0C0E9AB847AF68088A9AEDB9CD588470738787` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3920456 | `50BB2E1F04418EBA11784C83752B00B1A2CCD58B57F7171291BC3089F77812F4` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2452980 | `66938EB4A9D204EB603BC03AE31F33D47B4CDFAE190594C71A9B560E54F4CE08` |

### 包含的修复

- 底部输入区新增常驻“取消任务”按钮：空闲时禁用置灰，任务运行中变红可点；发送按钮在运行中禁用。通过 WebView2 CDP 直读 DOM 验证 idle/running/cancel 三态，点击后 UI 进入 `任务已取消`，原生日志 `cancel_runtime_process invoked`。
- `runtime/src/index.mjs` 新增 `writeStdout` 和 `process.stdout.on('error')` 守卫：桌面 shell 退出导致 stdout 断管时 runtime 子进程干净退出，不再产生 `EPIPE` FATAL 或孤儿 node 进程；重启后 recovery 取消陈旧 run。
- 打包 runtime 资源已复核：`release\runtime\src\index.mjs` 含 `writeStdout`（6 处）和 `EPIPE` 守卫。

### 验证

- `health` / `recovery` / `dashboard` 均 `ok:true`，`dashboard.releaseChannel=WINDOWS_PHASE1_READ_ONLY`；
- `task --execution-mode CONTROLLED` 返回 `RELEASE_CHANNEL_READ_ONLY`；
- 手工场景 3.1–3.9 全部 PASS，详见 [手工验收清单](WINDOWS_PHASE1_MANUAL_ACCEPTANCE.md) 的 3.10；
- MSI/NSIS 安装、升级、卸载仍需用户授权后执行。

## 第八次构建（release-check 语义修正，最终 Phase 1 候选）

默认库 `runtime release-check` 暴露出 `decisionMetrics=false`：原实现把失败/中断 run 也按 100% coverage 要求，`minDecisionCoverage=80`、`minDecisionOutcomeLinkRate=0`。按计划“缺失数据不能进入学习或导出流程”的语义修正后重建 release 产物（增量约 1m42s）。第八次构建取代第七次构建作为最终 Phase 1 候选。

### 产物（2026-09-09 12:28 +08:00）

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9572864 | `33CCF337696E58BBF0D36C30B90E1819D880622491A99B86A98B8FB406EC4D6D` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3912264 | `FD6ABC02CE5C7161AE3A43402CBCE84B3328771ED7B5C8F7359B77E89DCC8954` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2452633 | `35C5FBD957A2C28D1A63030BFD7FFEA5B19EEFF8E4B1D218EC64264046CCDD0B` |

### 包含的修复

- release-check 把 run 分为 learning-eligible / ineligible：eligible run 必须 `decisionCoverage`、`optionCoverage`、`evidenceLinkRate`、`decisionOutcomeLinkRate` 全 100%；ineligible run 必须带 `learningExclusionReasons` 且 `eligibleForLearning=false`，`exportLearningSample` 抛 `LEARNING_EXPORT_INCOMPLETE`。门控要求至少一个 eligible run、全部 eligible 100%、全部 ineligible 显式排除。
- 新增 `release-check.test.mjs` 回归用例（2/2），覆盖“不完整 run 不导致发布门失败但被显式排除”。
- 打包 runtime 含 `eligibleRunCount` / `allIneligibleExcluded` / EPIPE 守卫；`writeStdout` 6 处。

### 验证

- 打包 runtime 默认库 `release-check`：`passed=true`，`eligible=8`（全部 100%）、`ineligible=2`（`run-0440abb6` provider fetch failed、`run-ceb9be12` 被强杀中断），八项 checks 全 true；
- `health` / `recovery` / `dashboard` 均 `ok:true`，`dashboard.releaseChannel=WINDOWS_PHASE1_READ_ONLY`；
- `task --execution-mode CONTROLLED` 返回 `RELEASE_CHANNEL_READ_ONLY`；
- runtime 全量 421 tests / 420 pass / 1 skipped / 0 fail；
- MSI/NSIS 安装、升级、卸载仍需用户授权后执行。

### 发布检查报告（2026-09-09 12:30 +08:00）

- 产物：[release-check 报告](artifacts/WINDOWS_PHASE1_RELEASE_CHECK_2026-09-09.json)（16,021 bytes）、[metrics 摘要](artifacts/WINDOWS_PHASE1_METRICS_2026-09-09.json)（439 bytes）；
- `release-check`：`passed=true`；`storageSchemaVersion=1`、`protocolVersion=1.0`、`policyVersion=runtime-safety-1`、`producerVersion=hmcodex-runtime@0.1.0`、`appVersion=0.1.0`；readModel checksum `sha256:709a2fc052ea37eeab73f8d4295bdb2c3bf0b18359eb4ea8f3ec1d37beb4e7e6`；decisionTrace 10 run / 137 decisions，eligible=8 全部 100%，ineligible=2 显式排除；八项 checks 全 true；
- `metrics`：events=4101、receipts=4101、commitAttempts=1128、commitSuccessRate=1、decision=137、outcome=133、unlinkedOutcome=4、run=174、timeline=4101、storageBytes=18,653,538、replayDurationMs=935、nonTerminalRuns=91（历史/恢复 run，未错误标为成功）；
- 跨层测试：runtime 421/420 pass/1 skipped、desktop 26/26、Tauri Rust 19/19；
- `export-learning` 门控：eligible run 导出成功（6 decisions / 6 outcomes），ineligible run 返回 `LEARNING_EXPORT_INCOMPLETE:DECISION_REQUIRED_TYPE_MISSING,DECISION_OUTCOME_MISSING`；
- Support Bundle：`support-bundle` ok、privacy scan ok、0 violations、31,191 bytes。

## 第九次构建（metrics 未终态口径修正，最终 Phase 1 候选）

默认库 `metrics` 原先 `nonTerminalRuns=91`，其中 85 个是 `recovery-*` 维护 run、1 个 `dream-lost-owner`、1 个 `model-registry` 聚合，并非用户 TaskRun。修正为只统计含 `TaskRunCreated` 的 run，并把维护 run 单列。第九次构建取代第八次构建作为最终 Phase 1 候选。

### 产物（2026-09-09 12:44 +08:00）

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9572864 | `74BC1BE05FAF523A63DDFEEF187D7A24A75464BA6E1C7373FAD0A2BEA45384A2` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3916360 | `59FF66104FDAAEA76C01B57226FED8DEB1A3B836B9CF1690932C391F7DD919AD` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2450618 | `1A78FFFEEBF70196B383094EC1FCA68ADBF51FAB6813A741965A7A473D58FF7D` |

### 验证

- 打包 runtime `metrics`：`nonTerminalRuns=1`（仅 `run-ceb9be12` 被强杀中断）、`nonTerminalMaintenanceRuns=92`、`taskRunCount=84`；`metrics.test.mjs` 1/1；
- 打包 runtime `release-check`：`passed=true`、eligible=8、ineligible=2、checksum `sha256:75b3447a33173eaca573fae333c2fdf6bad2b795841b240ce8437a25d0586208`；
- `health` / `recovery` / `dashboard` 均 `ok:true`，`dashboard.releaseChannel=WINDOWS_PHASE1_READ_ONLY`；
- runtime 全量 421 tests / 420 pass / 1 skipped / 0 fail；desktop 26/26；Tauri Rust 19/19；
- 发布报告产物已刷新：[release-check 报告](artifacts/WINDOWS_PHASE1_RELEASE_CHECK_2026-09-09.json)、[metrics 摘要](artifacts/WINDOWS_PHASE1_METRICS_2026-09-09.json)；
- MSI/NSIS 安装、升级、卸载仍需用户授权后执行。

## 第十次构建（NSIS perMachine，安装验收收口）

安装验收发现：NSIS 默认 `currentUser` 会把程序文件安装到 `%LOCALAPPDATA%\hmCodex`，与 runtime 数据目录相同，属于生产布局隐患。将 `bundle.windows.nsis.installMode` 改为 `perMachine` 后重建 release 产物（增量约 1m55s）。第十次构建取代第九次构建作为最终 Phase 1 候选。

### 产物（2026-09-09 14:01 +08:00）

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9572864 | `91C5CEA8CAD6D945B84313562AB1EB462D165034C114B9660ACAC9D9CD3C00A4` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3920456 | `AA0B9EEBE611829C06F702094B48938A2497528D24D978FE9073A07FC4A04FAB` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2451510 | `7AB3630F212335167792258C3D947A220CB0FD6150B9649538D60E847B34C2D9` |

### 安装验收

- MSI（perMachine）：首次安装/升级/卸载 exit=0；卸载项 1→1→0；安装目录 `C:\Program Files\hmCodex` 与 runtime 资源正确安装和移除；用户数据目录 `%LOCALAPPDATA%\hmCodex` 文件数和 `hmcodex.db`/`threads.json` 哈希全程不变；未提权安装返回 1603/`Error 1925`，提权后通过。
- NSIS（perMachine，本次修复）：首次安装/升级/卸载 exit=0；安装目录 `C:\Program Files\hmCodex`，卸载项在 HKLM，快捷方式创建/移除正确；用户数据目录哈希全程不变；安装后可启动。
- 两种安装包卸载后均保留用户数据，重新安装后原有线程/事件可见。

## 第十一次构建（可恢复工具错误修复，最终 Phase 1 候选）

桌面 UI 自动化 T13 暴露出 `workspace.read` 对不支持文件返回 `WORKSPACE_UNSUPPORTED_FILE` 后，verifier 把工具错误当硬失败，plan step 直接 `PLAN_STEP_FAILED`。根因：`plugins/task-runner.mjs` 的 `tool.result` 用 `safeErrorCode(output)` 重新推导，把真实错误码丢成 `TOOL_EXECUTION_FAILED`；`rule-verifier.mjs` 把所有失败动作计入 `hardFailure`。修复后重建 release 产物（增量约 2m00s）。第十一次构建取代第十次构建作为最终 Phase 1 候选。

### 产物（2026-09-09 14:53 +08:00）

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9572864 | `E801BA3D810FE30E472CFB373049E97B5D42917926830FFF2B48531BB9467530` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3924552 | `3E346330D3929CDB8468244C6CD5B903F4871AD89FBC6D55EA640262971D39DE` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2454428 | `9C5D3E342B274A3684A064605FD69BB4B0957CBA5BC08D56891CB49B9FE50217` |

### 修复与验证

- `plugins/task-runner.mjs` 的 `tool.result` 透传 `output.errorCode`，不再丢成 `TOOL_EXECUTION_FAILED`；
- `rule-verifier.mjs` 对 `WORKSPACE_UNSUPPORTED_FILE` / `WORKSPACE_FILE_TOO_LARGE` / 路径错误 / `TOOL_DUPLICATE_REQUEST` 等可恢复错误返回 `CONTINUE`，并把这些错误视为进展证据；
- 新增 `task-runner-tools.test.mjs` 确定性回归用例：第一轮读不支持文件、第二轮换可读文件，verifier=`CONTINUE`；
- runtime 全量 423 tests / 422 pass / 1 skipped / 0 fail；`rule-verifier.test.mjs` + `plan-step-runtime.test.mjs` 11/11；
- 第十一次 NSIS perMachine 安装后重跑 `npm run test:ui:task`：T01–T13 **13 passed / 0 failed / 0 skipped**，T13 真实任务以 `只读检查完成` 结束（236 timeline items · 8 threads）。

## 第十二次构建（流式抖动修复，最终 Phase 1 候选）

用户反馈“显示过程中不停地抖动”。根因是 `model.text_delta` 每个 delta 都触发全量 `app.innerHTML` 重建、`createIcons()` 重新生成图标并重置滚动位置。修复为：流式期间只按 `requestAnimationFrame` 更新流式时间线项的 `.timeline-body` 文本、补/删 `stream-caret`，并在用户停留底部时跟随滚动；回合完成时再走一次全量渲染。重建 release 产物（增量约 1m37s）。第十二次构建取代第十一次构建作为最终 Phase 1 候选。

### 产物（2026-09-09 15:03 +08:00）

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9574400 | `FD955FB61A4D272ACD5B04B1EC158DFF2A68B1ED8520E4DA67A0DCD93BC81196` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3920456 | `F3F6342CF593208BE00BA1DC8DD4EC4410932259ADAF0398E82BEA44E3D3A0B1` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2454373 | `52B9BDD87F737A09C08D20102EB782AF06079F20CF01C06A1FA1538A02129930` |

### 验证

- 新增 `desktop/scripts/ui-streaming-test.mjs`：提交真实任务后持续采样，断言流式文本增长期间 App 根节点标记不丢失。安装包实测 `samples=139`、`maxStreamingLength=648`、`markerKeptWhileGrowing=139`、终态 `只读检查完成`；
- `npm run test:ui:task`：T01–T13 13/13（T13 `只读检查完成` · 232 timeline items · 8 threads）；
- `npm run test:ui:disconnect`：T14 模型断线 UI 错误渲染 + T15 恢复配置后任务继续，2/2；
- desktop vitest 26/26、`tsc --noEmit` exit 0。
