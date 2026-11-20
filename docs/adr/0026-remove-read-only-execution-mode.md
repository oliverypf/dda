# ADR-0026: 移除 READ_ONLY 执行模式，统一为 CONTROLLED + 审批租约

- Status: Accepted
- Date: 2026-11-06
- Deciders: 用户于 2026-11-06 明确要求实现 ADR-0026；实现采用下述兼容与安全边界
- Supersedes: ADR-0023 / ADR-0024 中默认 READ_ONLY 的条款；ADR-0003 的一次性副作用租约要求继续有效
- Related: [LONG_TERM_DESIGN_INDEX §2/§7](../LONG_TERM_DESIGN_INDEX.md), [SECURITY_MODEL](../SECURITY_MODEL.md), [ADR-0003](0003-policy-lease-for-side-effects.md)

> 本决策已获用户授权实现。先同步安全与兼容规则，再修改实现和测试；验收结果不等于 shadow/canary 或正式发布已完成。

## Context

用户指示：**A B C 全部去掉只读模式**——产品 UI/默认入口不再提供只读/受控切换、底层 READ_ONLY 执行模式整套废弃、发布渠道/默认值也不再保留只读分支。运行时只剩 `CONTROLLED`。副作用统一走 `ActionIntent → RuntimeSafetyMonitor → PolicyLease → ExecutorPort`；观察操作继续由受限 Workspace/Tool Port 校验路径、秘密与输出边界，不因统一模式而获得副作用租约。

现状核查（`master` 与 `origin/master` 一致，2026-11-06）：

- 全历史、全分支、stash 中**没有**"整体删除 READ_ONLY"的提交；本 checkout 里 READ_ONLY 仍完整存在。
- `READ_ONLY` 在仓库里不是单一开关，而是五个不同层面的概念，**不能一次性整体删除**：
  1. **执行模式（用户/CLI 选定）**：`EXECUTION_MODES = { READ_ONLY, CONTROLLED }`（`runtime-safety-monitor.mjs:15`），CLI `--execution-mode`，`index.mjs` 默认 `READ_ONLY`。← 本次要删的对象
  2. **安全标签/能力上限（actionClass / requiredControls / permissionCeiling）**：`SECURITY_MODEL.md:63,82,114`、`PLUGIN_SPEC.md`、`plugin-permissions.mjs` 的 `READ_ONLY` 是"不改变外部状态、不签发副作用 lease"的动作分类，与是否给用户切换无关。
  3. **发布渠道（构建期烘焙）**：`WINDOWS_PHASE1_READ_ONLY`、`release-channel.mjs`、Rust 桥 `validate_release_mode`、构建脚本 `build-phase1*.mjs`。← 用户 C 指向的对象
  4. **阶段发布门与历史验收证据**：`WINDOWS_PHASE1_ACCEPTANCE_MATRIX.md`、`WINDOWS_PHASE1_BUILD_2026-09-*.md` 等把只读渠道记为已发布里程碑；删名会切断既有证据链（与 README 里"0021 不重编号"同理）。
  5. **平台/契约默认值**：`LINUX_CLI_CONTRACT.md` 默认 READ_ONLY、`contracts/v1/harness-read-model.schema.json` 的 `mode` enum、`packages/harness-core` facade 默认 READ_ONLY、`linux-cli` 路线文档。

项目硬约束（无法绕过）：

- `LONG_TERM_DESIGN_INDEX.md §2`：`SECURITY_MODEL.md` 是权限/信任边界的最高权威。
- `§4` 稳定契约：副作用链 `ActionIntent → RuntimeSafetyMonitor → PolicyLease → ExecutorPort`、Safety deny precedence、权限上限、Profile 放权必须基于可回放证据。
- `§6` 弃用政策：删除字段前至少经历一个发布周期的 deprecated；Reader 先兼容、Writer 后停写、最后迁移删除；未识别事件 kind 必须保留并 `PAUSED_UNSUPPORTED`。
- `§7`：改变依赖方向/信任边界/副作用链/权限放权逻辑、降低确认或审计要求，**必须新增 ADR**，顺序为 ADR → 威胁与兼容评审 → 更新专项规范 → 契约/迁移/安全测试 → shadow/canary → 发布。
- `ADR-0003`：每个副作用必须经一次性 PolicyLease；`SECURITY_MODEL.md:114` 明确"READ_ONLY 不等于绝对安全，读秘密/越权路径/敏感外传仍可被拒绝"。

## Decision

**D1 — 删除"执行模式"这一维度**：`EXECUTION_MODES` 只保留 `CONTROLLED`；CLI、`index.mjs`、task-runner、role/rule-router、desktop `store.ts`/`main.ts`、Rust 桥、Linux CLI 契约中"选择 READ_ONLY"的分支全部移除。默认即 CONTROLLED，**但默认值改变不等于放权**：没有 workspace grant + capability + 显式审批 + 租约时，任何副作用仍 fail closed（ADR-0003 / §4 不变）。

**D2 — 保留"安全标签"语义，改名而非删除**：新产生的非变更动作和插件观察权限上限使用 `OBSERVE`，副作用分类仍为 `SIDE_EFFECT`，插件执行权限上限仍为 `CONTROLLED`。旧插件 manifest 的 `READ_ONLY` 作为 deprecated 输入按 `OBSERVE` 求交，绝不能转换为 `CONTROLLED` 权限上限。工具的 `readOnly: boolean` 描述动作性质，继续保留；它不是执行模式。

**D3 — 发布渠道**：`WINDOWS_PHASE1_READ_ONLY`、`LINUX_CLI_READ_ONLY` 和前期 `WINDOWS_MVP_PRE_PHASE1` 不再作为可构建/可运行渠道；保留字面量作为**历史归档标识**。默认构建/运行渠道为 `WINDOWS_PHASE1_5_CONTROLLED`，`WINDOWS_FULL_LOCAL` 保留其独立发布门，CLI 使用其现有受控别名。旧 Phase 1 构建脚本停止构建并给出受控构建入口。历史验收证据保留，矩阵标注停止发布。

**D4 — 兼容与迁移**：`requestedMode` / `mode` / `executionMode` 字段按 §6 走：历史 Reader 保留原值，当前任务投影使用 `CONTROLLED`，Writer 停写旧值，至少一个发布周期后再删 schema 的 deprecated 枚举。新命令显式传入 `READ_ONLY` 时拒绝为 `EXECUTION_MODE_INVALID`，不把调用方要求只读的命令静默升级。旧事件 envelope、digest、身份和渠道不重写；旧插件权限按 D2 收紧读取。恢复动作必须依据实际 intent、lease、工具记录与 journal，不能仅凭旧模式或 Planner 的 READ 标签判断可重试。

**D6 — 无界面审批**：CLI 复用现有 `prompt` / `jsonl` / `deny`。stdin 与 stderr 都为终端时默认 `prompt`，否则默认 `deny`；`jsonl` 必须显式选择并独占 stdin 审批流。`deny` 可从 stdin 读取任务文本，但不会批准任何副作用。统一默认模式不注入 capability、命令、网络目标或自动审批。

**D5 — 安全不变量（不可协商）**：删除执行模式**不得**降低以下任一项——默认拒绝工作区外路径/凭据/网络、每次副作用一次性 PolicyLease、Approval fail-closed、崩溃恢复/过期/撤销/未知副作用 fail closed、Jev 只能在有限候选中选择、审计与 Decision Trace。全部 CONTROLLED 后，`toolSchemas` 的过滤、`hardModeBlock` 的硬拦、`readonly-fast-path` 等机制必须重新评估：要么删除、要么改写为"基于动作分类 + 审批租约"的等价门禁，**不能出现无审批即可写/执行/联网的路径**。

## Consequences

### 正面

- 消除"只读/受控"双模式带来的分支矩阵、UI 切换、发布渠道烘焙与文档矛盾；
- 用户心智与实现统一：所有任务同一条受控链，权限由审批+租约逐项授予，而非由模式预设；
- 减少约 23 个 runtime 源文件、Rust 桥、contracts、大量 UI/证据测试里的条件分支。

### 代价与风险（必须在评审中逐条回应）

- **信任边界变化**：从"默认禁止副作用"变为"默认 CONTROLLED 但无审批仍拒绝"，安全论证从"模式级硬拦"转移到"逐动作租约"。需证明不存在绕过路径（尤其 `kernel.host_request`、`readonly-fast-path`、resume/recovery、plugin ceiling）。
- **Phase 1 发布门失效**：`LONG_TERM_DESIGN_INDEX.md:124`、`WINDOWS_PHASE1_ACCEPTANCE_MATRIX.md` 的"无任何写/网络副作用"验收项不再适用，需更新专项规范与阶段四矩阵（当前 16 包全 PARTIAL / G4 NOT_READY）。
- **Linux CLI 首期路线冲突**：`ADR-0023`、`LINUX_CLI_CONTRACT.md`、`LINUX_CLI_IMPLEMENTATION_PLAN.md:106` 明确"Linux 首期默认 READ_ONLY、不因无图形审批页而自动放开"。若无头 CLI 没有审批界面，全部 CONTROLLED 需要定义新的审批通道（或明确 Linux CLI 暂缓/降级）。
- **契约破坏**：`contracts/v1/harness-read-model.schema.json` 的 `mode` enum、`trajectory-record.task-created.json` fixture、`PROTOCOL_SPEC.md` 的 `requestedMode`、`DATA_MODEL.md` 的 `requested_mode` 都是跨端硬契约，改 major 需按 §6/§7 迁移。
- **历史证据链**：`docs/artifacts/`、Phase1 构建记录、UI 测试 fixture 大量以 `WINDOWS_PHASE1_READ_ONLY` 为真值；若直接删字面量会污染既有 VERIFIED 证据，必须只增不改。
- **Facade 默认值**：`packages/harness-core` 的 `HarnessFacade` 默认 READ_ONLY（`harness-facade.mjs:207`），与 ADR-0024 §5"facade 默认 READ_ONLY、fail-closed"绑定，需同步改写并回归 facade 单元测试。

## Alternatives considered

### A. 只删 UI 切换，底层保留 READ_ONLY

拒绝（相对用户指示）：用户明确 A+B+C 全去掉。且底层保留会让 UI 与实现继续漂移。

### B. 保留 READ_ONLY 作为"无审批观察模式"，仅改默认值

拒绝：这正是当前"去掉了但又还在"的根源；`a98a013` 已尝试在 UI 层弱化，底层未动导致测试与文档继续引用。

### C. 把 READ_ONLY 标签一并删除，副作用链只按"是否需要 lease"判断

风险过高，列为**待决项**：`SECURITY_MODEL.md:114` 与 `STATE_MACHINE.md:62` 依赖动作分类表达"读也可能被拒（秘密/越权/外传）"。若删标签，必须新增等价机制，属协议 major 变更。建议 D2 的改名方案。

### D. 直接改代码，不写 ADR

拒绝：`LONG_TERM_DESIGN_INDEX.md §7 / §111` 明确"代码先于规范合入属于流程错误"，且本改动命中"改变信任边界 + 权限放权逻辑 + 降低确认要求"三条必审条件。

## Verification（实现阶段的准入条件，非本 ADR 完成项）

1. 威胁与兼容评审：逐条签字 D5 的六项不变量，特别是"无审批即可写/执行/联网"零路径。
2. 专项规范同步：SECURITY_MODEL / STATE_MACHINE / PROTOCOL_SPEC / DATA_MODEL / PLUGIN_SPEC / UI_UX_SPEC / LINUX_CLI_* / WINDOWS_PHASE4_* / LONG_TERM_DESIGN_INDEX 的 Phase 1 门。
3. 契约与迁移测试：schema enum deprecated、旧事件回放 `READ_ONLY` 不丢、Reader 兼容两个 minor、Writer 停写、未识别 kind 保留。
4. 安全测试：删除 `hardModeBlock` / `toolSchemas` 过滤后，等价门禁覆盖 workspace 外路径、`.env` 敏感路径、`kernel.host_request`、网络目标、审批过期/拒绝/崩溃恢复、插件 ceiling。
5. 回归：`desktop/npm run test:all:parallel` 全绿（含 tsc / vitest / Rust / phase3-evidence）、UI 套件串行、Linux CLI 契约测试；阶段四矩阵相应条目重定级。
6. shadow/canary：新渠道灰度，旧渠道构建产物仍能回放，回滚方案保留。

## 威胁、兼容与回滚评审

- 去掉工具列表过滤不构成授权：副作用工具仍由 capability、审批、一次性租约、Executor 路径/命令/网络检查约束。默认空 capability 的拒绝、明确批准后的单次执行、拒绝/过期/不确定结果都需回归。
- Jev fast path 仅适用于注册为非变更的有限工作区读取工具，不能包含 `kernel.host_request`、`kernel.exec` 或插件执行能力。Jev 不签发租约。
- 恢复不能仅用 `READ_ONLY → CONTROLLED` 的字段转换放行。观察事实仅在来源链和工具记录完整且没有副作用证据时使用；已执行或未知的副作用继续阻断自动重放。
- 原始历史事件和旧 schema fixture 保留；新 read model 和任务输出只写 `CONTROLLED`。旧权限标签收敛到 `OBSERVE`，不会扩大插件权限。
- 既有 CLI 审批通道已经实现，无需暂缓 Linux。无终端默认 deny 使检查任务可运行，同时没有自动批准入口。
- 回滚使用此前安装包和升级前数据备份。新字段是兼容性增加，历史证据不改写；shadow/canary 和安装包验收仍是发布前的独立门槛。
