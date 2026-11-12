# ADR-0026 影响面清单（移除 READ_ONLY 执行模式）

> 配套 [0026-remove-read-only-execution-mode.md](0026-remove-read-only-execution-mode.md)。
> 统计口径：在 `master`（与 `origin/master` 一致，2026-11-06）上对 `READ_ONLY` / `WINDOWS_PHASE1_READ_ONLY` / `只读模式` 的 `git grep`，排除 `docs/artifacts/` 与 `desktop/src-tauri/target-b199/` 构建副本。
> **合计 132 个文件、394 处匹配**；另有 `docs/artifacts/` 下 202 个历史证据文件含只读渠道字面量（建议只归档不改）。

## 0. 五个不同层面（不可混为一谈）

| 层面 | 例子 | 本次是否删除 |
| --- | --- | --- |
| L1 执行模式（用户/CLI 选定） | `EXECUTION_MODES`、`--execution-mode`、`index.mjs` 默认 | **删**（A/B） |
| L2 安全标签（动作分类） | `actionClass: READ_ONLY`、`requiredControls`、插件 `permissionCeiling` | **待决 Q1**，建议改名不删 |
| L3 发布渠道（构建期烘焙） | `WINDOWS_PHASE1_READ_ONLY`、`release-channel.mjs`、Rust `validate_release_mode`、`build-phase1*.mjs` | **停止发布**，字面量保留作历史归档（C） |
| L4 阶段门/历史验收证据 | `LONG_TERM_DESIGN_INDEX §8`、`WINDOWS_PHASE1_ACCEPTANCE_MATRIX.md`、`WINDOWS_PHASE1_BUILD_2026-09-*.md` | **重定级/标注**，不删历史 |
| L5 跨平台契约默认值 | `LINUX_CLI_CONTRACT.md`、contracts schema enum、`HarnessFacade` 默认、linux-cli 壳 | **改**，需迁移 |

## 1. 文件分布（132）

| 区域 | 文件数 | 关键内容 |
| --- | --- | --- |
| `runtime/src/` | 22 | 模式枚举、默认值、硬拦、提示词、恢复、插件权限上限、发布渠道 |
| `runtime/test/` | 33 | 模式相关单测与端到端（含本次会话改动过的 `platform`、`kernel-readonly-gate`、`post-agent-miss-terminal` 等） |
| `desktop/scripts/` | 20 | 构建渠道烘焙、UI 测试 fixture、goal-evidence 脚本默认 READ_ONLY |
| `desktop/src/` | 4 | `main.ts` 任务提交选项、`store.ts` 模式切换、`models.ts`、`store.test.ts` |
| `desktop/src-tauri/src/` | 1 | `lib.rs` 渠道/模式校验与 `--execution-mode` 传参 |
| `contracts/v1/` | 3 | `harness-read-model.schema.json` 的 `mode` enum + 2 个 fixture |
| `packages/harness-core/` | 3 | `HarnessFacade` 默认 READ_ONLY（ADR-0024 §5）、单测、README |
| `linux-cli/` | 7 | 首期默认 READ_ONLY、参数解析、契约测试 |
| `docs/`（非 artifacts） | 35 | 规范 35 份（见 §4） |
| `docs/artifacts/` | 202 | 历史证据，**建议只增不改** |

## 2. runtime/src 明细（22）

`agent-turns.mjs`、`context-assembler.mjs`、`controlled-tools.mjs`、`decision/evidence-claim.mjs`、`decision/readonly-fast-path.mjs`、`decision/readonly-resume-observations.mjs`、`index.mjs`、`kernel/kernel-tools.mjs`、`mcp-host.mjs`、`platform/platform-identity.mjs`、`plugin-context.mjs`、`plugin-loader.mjs`、`plugin-permissions.mjs`、`plugins/registry.mjs`、`plugins/task-runner.mjs`、`release-channel.mjs`、`role-binding-resolver.mjs`、`rule-router.mjs`、`rule-verifier.mjs`、`runtime-safety-monitor.mjs`、`side-effect-step-reconcile.mjs`、`task-safety-precheck.mjs`。

其中直接构成"模式级硬拦"的锚点：

- `runtime-safety-monitor.mjs:15` `EXECUTION_MODES`、`:531` 默认、`:568/:638` 非 CONTROLLED 即拒
- `index.mjs:338-340` CLI 解析与默认、`:3779-3781` `toolReadOnly` / `hardModeBlock`、`:5943-5944` 工具清单按模式过滤
- `plugins/task-runner.mjs:159-161` `toolSchemas` 只读过滤、`:389` 系统提示词、`:643-650` READ_ONLY 拒绝分支
- `rule-router.mjs:101-102` `READ_ONLY_MODE` 路由拦截
- `release-channel.mjs` 全文、`platform/platform-identity.mjs` 渠道→策略映射
- `decision/readonly-fast-path.mjs`、`decision/readonly-resume-observations.mjs`、`side-effect-step-reconcile.mjs`（只读观察恢复）
- `kernel/kernel-tools.mjs:230,233` `kernel.host_request` 在 READ_ONLY 下必拦的注释与 `readOnly` 标记

## 3. 契约 / 跨平台锚点

- `contracts/v1/harness-read-model.schema.json:562` `"mode": { "enum": ["READ_ONLY","CONTROLLED"] }`
- `contracts/v1/fixtures/harness-read-model.ready.json`、`trajectory-record.task-created.json`
- `PROTOCOL_SPEC.md:53` `requestedMode`、`DATA_MODEL.md:65` `requested_mode`、`STATE_MACHINE.md:62` actionClass
- `packages/harness-core/src/harness-facade.mjs:207` 默认 `executionMode = 'READ_ONLY'`（ADR-0024 §5 fail-closed 条款）
- `LINUX_CLI_CONTRACT.md:71,152,295` 默认 READ_ONLY；`LINUX_CLI_IMPLEMENTATION_PLAN.md:106` 明确不因无审批 GUI 而自动放权
- `linux-cli/src/{main,parse-args,resolve-prompt}.mjs` + 3 个 test
- `SECURITY_MODEL.md:63,82,114` 安全标签（**L2，待决 Q1**）
- `PLUGIN_SPEC.md:56` `permissionCeiling: READ_ONLY`
- `UI_UX_SPEC.md:97` 默认 READ_ONLY

## 4. docs 规范明细（35）

`AGENT_GOAL_TESTING.md`、`AGENT_HARNESS_DESIGN.md`、`DATA_MODEL.md`、`HARMONYOS_PLATFORM.md`、`JEV_SPEED_MVP.md`、`JEV_TIMEOUT_REPAIR.md`、`LINUX_CLI_CONTRACT.md`、`LINUX_CLI_IMPLEMENTATION_PLAN.md`、`LINUX_PLATFORM_ADAPTER_DESIGN.md`、`PLUGIN_SPEC.md`、`PROTOCOL_SPEC.md`、`RESIDENT_KERNEL_PHASE2A.md`、`RESIDENT_KERNEL_PHASE2_DESIGN.md`、`SECURITY_MODEL.md`、`STATE_MACHINE.md`、`UI_COMPETITOR_BASELINE_2026-09-18.md`、`UI_UX_SPEC.md`、`WINDOWS_ALL_FEATURES_IMPLEMENTATION_PLAN.md`、`WINDOWS_BAYESIAN_FEEDBACK_DESIGN_PLAN.md`、`WINDOWS_GIT_AUDIT_DESIGN_PLAN.md`、`WINDOWS_PHASE1_5_CONFIG_MATRIX.md`、`WINDOWS_PHASE1_ACCEPTANCE_MATRIX.md`、`WINDOWS_PHASE1_BUILD_2026-09-07/08/09.md`、`WINDOWS_PHASE1_MANUAL_ACCEPTANCE.md`、`WINDOWS_PHASE1_PROGRESS.md`、`WINDOWS_PHASE2_IMPLEMENTATION_PLAN.md`、`WINDOWS_PHASE2_PROGRESS.md`、`WINDOWS_PHASE4_ACCEPTANCE_MATRIX.md`、`WINDOWS_PHASE4_IMPLEMENTATION_PLAN.md`、`WINDOWS_PHASE_1_IMPLEMENTATION_PLAN.md`、`adr/0023-linux-cli-client.md`、`adr/0024-harness-facade-and-package-split.md`、`design/prime-phase2b-cells-sandbox.md`。

## 5. 历史证据（202 个文件，建议只增不改）

`docs/artifacts/` 下含 `WINDOWS_PHASE1_READ_ONLY` / `READ_ONLY` 的日志、JSON、构建记录。按 `docs/adr/README.md:60-62` 对 0021 的处理原则（既有证据链引用不重编号、不改写），这些文件应保留原值；新证据注明"历史渠道，已停止发布"。直接批量替换会污染既有 VERIFIED 证据。

## 6. 必审不变量（D5，逐条签字）

1. 默认拒绝：工作区外路径、凭据目录、系统目录、未授权网络。
2. 每次副作用一次性 `PolicyLease`（ADR-0003），审批过期/拒绝/撤销/崩溃恢复/未知副作用 fail closed。
3. 删除 `hardModeBlock` / `toolSchemas` 过滤后，`kernel.host_request`、`readonly-fast-path`、resume/recovery、plugin ceiling 无绕过路径。
4. Jev Decision Plane 仍只能在有限候选中选择，不能执行动作/授权/签租约/覆盖硬规则。
5. Approval 不默认选中、无倒计时自动批；审计与 Decision Trace 不降级。
6. `SECURITY_MODEL.md:114`："读秘密/越权路径/敏感外传仍可被拒绝"——改名或删标签后该语义必须有等价承载。

## 7. 待决问题（阻塞实现）

- **Q1** `actionClass: READ_ONLY` 类安全标签是否也在"全去掉"范围内？（D2 建议改名 `OBSERVE`/`NON_MUTATING`）
- **Q2** Linux CLI 无图形审批页，全部 CONTROLLED 后的审批通道？是否暂缓 Linux 线？
- **Q3** Phase 1 历史验收矩阵/构建证据：保留归档 + 标注停止发布，还是全部重写？（建议前者）
- **Q4** 契约 `mode` 字段：deprecated 周期，还是随 Harness Protocol major 一次性删？（§6 倾向前者）
- **Q5** 用户所说"已经去掉"的成果是否位于另一份 checkout/分支？（当前 master 与 origin/master 一致，全历史/分支/stash 均无相关提交）若是，先合入或指明路径。

## 8. 实施顺序（ADR Accepted 后，遵守 §7）

1. 威胁与兼容评审，回答 Q1–Q5，§6 签字。
2. 更新专项规范（§4 所列 35 份 + LONG_TERM_DESIGN_INDEX §8 Phase 1 门 + 阶段四矩阵）。
3. 契约 deprecated / Reader 兼容 / 迁移测试 / 安全测试。
4. 分层改代码：contracts → packages/harness-core → runtime → Rust 桥 → desktop → linux-cli → 测试。
5. `desktop/npm run test:all:parallel` 全绿 + UI 套件串行 + Linux CLI 契约测试。
6. shadow/canary 灰度，保留旧渠道产物回放与回滚方案。
