# Windows 阶段二进度记录

本文件按阶段二工作包记录已落地的增量；验收结论只引用可复现的测试/构建证据，不引用意图或摘要。

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
