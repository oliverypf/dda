# dda：Windows 桌面端（windows-desktop）代码 cell 设计

Status: **FROZEN (Grok GO)** — 开干 done; [#24](https://github.com/oliverypf/dda/pull/24) squash-merged to master as `2b97122` (2026-10-13). Decisions: **不捆绑** Node 24 (PATH/`resource_dir` fallback); SessionKeep wired in that PR. Pre-release Windows real-machine tests still pending (see §13).
Base: master `be06324`（#21 Phase-2b、#23 windows-cli 无沙箱 cell、#22 tool card 只认 toolName）。
前置文档: `docs/design/windows-cli-unsandboxed-cells.md`（CLI 版）。本稿是它的增补；CLI 稿同步修订见该稿 Amendment（desktop recheck #1 + #2 + #3）：desktop arm **先于** `CODE_CELLS_DISABLED`（仅 `win32 × windows-desktop`；其它 OS 上的 `windows-desktop` 仍走通用路径）、`sessionKeep` 定义与双次 `codeCellsAvailability` 传参、resident desktop attach **改写**既有断言、journal 默认路径与遗留迁移、Job Object 仅回收例外、READY `sandbox:'none'`、tool 文案独立分支、unset `DDA_PLATFORM` 不进 desktop arm。

Grok 4.7 recheck #1 BLOCKED (folded). #2 BLOCKED (folded). #3 GO-WITH-NITS (folded). #4: **GO**.

BOT2 六条评审清单（§1–§3、§4、§7、§9）均有对应节；五条拍板 + journal 分路径见 §11 Locked。Grok 4.7 recheck #1 / #2 BLOCKED 的 must-fix（及便宜 nits）与 recheck #3 GO-WITH-NITS 的六条 nit 已全部收进本稿。

## 0. 现状（以仓库为准）

- UI 技术栈是 **Tauri（Rust + TS/Vite）**，不是 Electron：`desktop/src-tauri/src/lib.rs`、`desktop/src-tauri/tauri.conf.json`、`desktop/src/main.ts`。
- 桌面端会以 Node 子进程的形式拉起 runtime：`runtime_command()`（`lib.rs` 约 2181 行）用的是 `DDA_NODE` 或 PATH 里的 `node`，并加 `CREATE_NO_WINDOW`；在 `lib.rs` 约 1595–1645 行 spawn（先占 slot，再 spawn）；取消时走 `taskkill`（约 1793、1979 行）。**今日默认生命周期是每次 invoke 一个新鲜 Node 进程**，桌面端不是常驻 kernel 宿主。
- 打包：`tauri.conf.json` 的 `resources` 已经带上 `runtime/src`、`runtime/node_modules`，也就是说 `runtime/src/kernel/cell-worker-windows.mjs` **已经在安装包里**。NSIS 安装模式是 `perMachine`。
- 门控：`runtime/src/kernel/cell-host.mjs` 里的 `codeCellsAvailability` 是唯一 cells 入口，`index.mjs` 约 2213 行只调用它。win32 上身份不是 `windows-cli` 时**今日**返回 `PLATFORM_IDENTITY_MISMATCH`。测试 `runtime/test/kernel-phase2b-windows-cells.test.mjs:72` 今日锁定 “win32 + windows-desktop → MISMATCH”；本稿 §2.1 / §9 把它改写为 `WINDOWS_DESKTOP_CELLS_REQUIRED`。
- 身份：`runtime/src/platform/platform-identity.mjs`。`DDA_PLATFORM` 不设时默认 `windows-desktop`。`paths.mjs:18` 的 `isLinuxCliPlatform` 依据的是 `PORTABLE_CLI_PLATFORMS`。
- worker：`runtime/src/kernel/cell-worker-windows.mjs` 今日发 `READY{backend:'unsandboxed', warning:'WINDOWS_NO_OS_SANDBOX'}`，没有 canary。**复用此文件，不另 fork。** 设计要求 READY **同时**带 `sandbox:'none'`（与 `warning:'WINDOWS_NO_OS_SANDBOX'` 并列；`backend:'unsandboxed'` 可保留），供 §4 badge 判定。
- journal：`runtime/src/kernel/effect-journal.mjs` 的状态是 REQUESTED→GATED→APPROVED|DECLINED→LEASED→STARTED→COMPLETED|FAILED|UNKNOWN；重启时 STARTED 会被转成 UNKNOWN（`RESTART_STARTED_WITHOUT_TERMINAL`）。今日默认路径经 `resolveStoreFile('kernel-effect-journal.json')` → `%LOCALAPPDATA%\hmCodex\kernel-effect-journal.json`（见 `runtime/src/platform/paths.mjs`、`index.mjs` 约 1989 行）。**CLI 与桌面若共用同一文件，一方 rehydrate 的 STARTED→UNKNOWN 会覆盖另一方**——必须分路径且 runtime 默认按身份落盘（§6.1）。
- UI：`desktop/src/main.ts` 约 2083 行的 tool card 只看 `item.toolName`（#22）；`renderApprovalCard` 在约 1903 行，已经在用 `approvalExpiresAt`、`requestDigest`、`pendingApprovalResolutions`；`models.ts:173` 的 `toolName?`。

## 1. 启用开关（BOT2 #1）— Locked: 全局确认一次 + 会话常驻横幅

- 桌面端用户不会去设环境变量。改为在 UI 设置页加一项「实验性：代码 cell（无 OS 沙箱）」，**默认关**。
- **全局确认一次**：勾选时弹出确认对话框（文案写明“不是安全沙箱，代码以你的 Windows 用户权限运行；Node vm 也不是安全边界”）。用户确认后写入桌面端配置；之后不再做「每个会话弹一次」的 modal（避免习惯性点过）。设置本身不算 per-cell 授权。
- **确认结果写入** `%LOCALAPPDATA%\hmCodex\desktop-settings.json` 的 `experimentalCodeCells`（默认 `false`），**不写入模型配置**（不进 `model-config.json`）。
- **每个会话开头常驻提示**：会话顶栏 / banner 固定显示「无 OS 沙箱」（只要本会话 cells 可用且 reason 为 `WINDOWS_NO_OS_SANDBOX`），不能关掉，也不是一次性 toast。与 §4 审批卡 / timeline badge 叠加，不互相替代。
- **Env 注入（cells 开关不拥有 resident / identity）**：
  - 每次桌面 runtime spawn 都设置 `DDA_PLATFORM=windows-desktop`，并 `env_remove("DDA_KERNEL_SANDBOX")`。
  - cells 勾选且本次是会话保持路径时，再注入 `DDA_KERNEL_CODE_CELLS=1`、`DDA_KERNEL_WINDOWS_UNSANDBOXED=1`、`DDA_KERNEL_WINDOWS_DESKTOP_CELLS=1`。
  - 未勾选时只 `env_remove` 这三个 cells 变量。
  - `DDA_RESIDENT_KERNEL` 只由会话保持路径注入或清除。
  - per-invoke 路径不注入 `DDA_RESIDENT_KERNEL`，cells 走 `DESKTOP_SESSION_KEEP_REQUIRED`，不得 spawn worker。
- runtime 侧 cells **不加新的门**，仍然只走 `codeCellsAvailability`；UI 设置只是这些 cells env 的来源。`residentKernelAvailability` 独立，不读 cells 标志（§2）。
- 设置页根据 runtime health 返回的 `cellsAvailability.reason` 显示状态，比如 `JOURNAL_UNAVAILABLE`、`KERNEL_NOT_ATTACHED`、`DESKTOP_SESSION_KEEP_REQUIRED`、`NODE_TOO_OLD`、`WINDOWS_DESKTOP_CELLS_REQUIRED`。
- **Health 可见性（recheck #3 nit）**：新鲜 `health` 命令（per-invoke spawn）**只**会呈现步骤 1–2（`NODE_TOO_OLD` / `DESKTOP_SESSION_KEEP_REQUIRED`）。步骤 3–5（`KERNEL_NOT_ATTACHED` / `JOURNAL_UNAVAILABLE` / `WINDOWS_DESKTOP_CELLS_REQUIRED`）只来自**活着的会话保持进程**；设置页对这两类来源分别标注，不要把 fresh health 的停点误读成「永远到不了步骤 3–5」。
- 每个会话首次真正执行带 effect 的 cell 前，仍需要 per-cell 审批（§5）。
- `DDA_KERNEL_WINDOWS_DESKTOP_CELLS` 使用与现有 flags 相同的 truthy 解析（`1` / `true` / `on` / `yes` / `enabled`）。

## 2. 身份与双门拆分（BOT2 #2）— Locked: 新增 `DDA_KERNEL_WINDOWS_DESKTOP_CELLS`；attach ≠ cells

`residentKernelAvailability` 不读 cells 标志。`win32 × windows-cli` 维持现状：`DDA_RESIDENT_KERNEL` + Node ≥ 24 即可 attach，`sandboxAvailable` 恒为 false；`DDA_RESIDENT_KERNEL_SANDBOX` 不能把 `sandboxAvailable` 点亮，也不是 cells 授权。新增 `win32 × windows-desktop` attach 臂，条件同为 resident 标志 + Node ≥ 24，同样不要求 `DESKTOP_CELLS` / `WINDOWS_UNSANDBOXED`。`codeCellsAvailability` 才使用下面的身份表。`windows-desktop` 仍不进入 `PORTABLE_CLI_PLATFORMS`。

### 2.0 Resident attach（不读 cells 标志）

| 组合 | 条件 | 结果 |
|------|------|------|
| `win32` × `windows-cli` | `DDA_RESIDENT_KERNEL` + Node ≥ 24 | attach 允许；`sandboxAvailable: false`（现状，CLI 稿保持不变） |
| `win32` × `windows-desktop` | 同上（**不**要求 `DESKTOP_CELLS` / `WINDOWS_UNSANDBOXED`） | 新增 attach 臂 |
| 其它 | — | 与现有 `residentKernelAvailability` 行为一致 |

`DDA_RESIDENT_KERNEL_SANDBOX=1` **不是** Windows cells 授权，也不能把 `sandboxAvailable` 点亮。

### 2.1 `codeCellsAvailability` 身份表（唯一 cells 门）

- `windows-desktop` **不进** `PORTABLE_CLI_PLATFORMS` / `isLinuxCliPlatform`，理由与 CLI 稿相同：影响路径、effects、executor。
- `codeCellsAvailability` 显式 `identity × platform` 表：
  - `linux` × `linux-cli`（以及现有的 portable 集合）→ 走 OS 沙箱路径
  - `win32` × `windows-cli` → 需要 `WINDOWS_UNSANDBOXED`（现状；**不要**认 `DESKTOP_CELLS`）；`windows-cli` + `DESKTOP_CELLS` → `PLATFORM_IDENTITY_MISMATCH`
  - `win32` × `windows-desktop` → 走 §2.2 desktop reason 顺序（需要 `DESKTOP_CELLS` + `WINDOWS_UNSANDBOXED` + sessionKeep / resident / journal / Node）
  - 其余组合一律 `PLATFORM_IDENTITY_MISMATCH`，包括 **`linux` × 显式 `DDA_PLATFORM=windows-desktop`**（关闭 fall-through 到 bwrap）；`linux-cli` / portable 仍走沙箱路径
  - **Unset `DDA_PLATFORM`（recheck #3 nit）**：fall-through 关闭的是**显式** `DDA_PLATFORM=windows-desktop` 在非 win32 上的组合。`codeCellsAvailability` 比较的是 env 里的**原始字符串** `windows-desktop`，**不**调用 `resolvePlatformIdentity`（后者会把 unset 解析成 `windows-desktop`）。因此 **unset 仍走通用路径**，不会进入 desktop arm；在 linux 上 unset 也不会被当成 `linux × windows-desktop` mismatch。
- **双向隔离**（CLI 授权不得漏到桌面，反之亦然）：
  - `windows-cli` 身份若带了 `DESKTOP_CELLS` → `PLATFORM_IDENTITY_MISMATCH`
  - `windows-desktop` 只有 `WINDOWS_UNSANDBOXED`、没有 `DESKTOP_CELLS` → `WINDOWS_DESKTOP_CELLS_REQUIRED`（见 §2.2 顺序）
  - Tauri **每次** spawn 显式设 `DDA_PLATFORM=windows-desktop`，不依赖默认值，也不在 cells 关时清掉它（§1）

### 2.2 Desktop arm reason 顺序（Locked；仅 desktop；Grok recheck #2）

**Desktop arm 必须排在 `CODE_CELLS_DISABLED` 之前（仅 `win32 × windows-desktop`）。** **`win32 × windows-desktop` 永不返回 `CODE_CELLS_DISABLED`。** 其它 OS 上带 `windows-desktop` 的组合仍走通用路径，因此 **`linux × windows-desktop` 在未设 `CODE_CELLS` 时仍是 `CODE_CELLS_DISABLED`**（走到 identity mismatch 之前会先停在通用第一道检查；要测 mismatch 须前置 `CODE_CELLS`+resident+journal，见 §9）。`CODE_CELLS` 作为第一道检查只出现在通用（CLI / Linux）路径上；desktop arm **不读** `DDA_KERNEL_CODE_CELLS`。完整伪代码见 CLI 稿 `codeCellsAvailability`。

**`sessionKeep` / `residentAvailable` 定义与传参（双次调用同一套）：**

- `sessionKeep === true` **仅当** `DDA_RESIDENT_KERNEL` 为 truthy。只有会话保持路径设置 / 清除该变量；cells 开关不拥有它（§1）。
- `residentAvailable === (residentKernel.attached === true)`。
- 当 **`win32` 且** `DDA_PLATFORM=windows-desktop` 时，`index.mjs` **即使** `DDA_KERNEL_CODE_CELLS` 未设置也调用 `codeCellsAvailability`（否则 win32 桌面永远只能看到 `CODE_CELLS_DISABLED`，与 arm-first 冲突）；调用前先按身份解析 journal 路径，使 `journalAvailable` 反映可写性。其它 OS 上的 `windows-desktop` 仍走通用路径（可返回 `CODE_CELLS_DISABLED`）。
- `CellHost.start` 第二次调用 `codeCellsAvailability` 时传入**同一** `sessionKeep` 与 `nodeVersion`。

仅当 `platform === 'win32' && DDA_PLATFORM === 'windows-desktop'` 时，在通用 CLI 顺序（含 `CODE_CELLS_DISABLED`）**之前**依次判断（`nodeVersion` 可注入，默认 `process.version`）：

1. Node < 24 → `NODE_TOO_OLD`
2. `!sessionKeep` → `DESKTOP_SESSION_KEEP_REQUIRED`
3. `!residentAvailable` → `KERNEL_NOT_ATTACHED`
4. `!journalAvailable` → `JOURNAL_UNAVAILABLE`
5. 无 `DDA_KERNEL_WINDOWS_DESKTOP_CELLS` → `WINDOWS_DESKTOP_CELLS_REQUIRED`
6. `DDA_KERNEL_SANDBOX` truthy → `SANDBOX_UNSUPPORTED_ON_WINDOWS`
7. 无 `WINDOWS_UNSANDBOXED` → `WINDOWS_UNSANDBOXED_REQUIRED`
8. 否则 `available: true`，`reason: 'WINDOWS_NO_OS_SANDBOX'`

**可见性（health vs 活会话）：** 步骤 3–5（`KERNEL_NOT_ATTACHED` / `JOURNAL_UNAVAILABLE` / `WINDOWS_DESKTOP_CELLS_REQUIRED`）只在**活着的会话保持进程**上才会走到。新鲜 health spawn 是 per-invoke，停在步骤 1–2（`NODE_TOO_OLD` 或 `DESKTOP_SESSION_KEEP_REQUIRED`），不会继续往下探。

`windows-cli` 成功路径的 reason 优先级**不变**（仍按 CLI 冻结伪代码：CODE_CELLS → resident → journal → identity → SANDBOX → UNSANDBOXED → `WINDOWS_NO_OS_SANDBOX`）。

测试改写 / 新增见 §9。

## 3. Worker 托管（BOT2 #3）— Locked: 只在会话保持模式下提供 cell；本轮不引入常驻 runtime 进程

- **复用** `runtime/src/kernel/cell-worker-windows.mjs`：由 runtime 内 `CellHost` spawn，与 CLI 共用 win32 spawn 路径；不 fork 第二份 worker，也不在 Rust 里另写 worker。Tauri 只负责拉起 runtime。
- **本轮不做**：为 cell 单独引入「常驻 / always-on resident runtime Node 进程」的架构改造。那是后续单独设计。
- **细胞状态与 epoch 需要活着的 worker**。今日桌面 `lib.rs` 约 1595–1645 的 **per-invoke 新鲜 Node 进程**路径无法保留 vm context / epoch → **该路径上 cell 必须硬拒**，reason 为 `DESKTOP_SESSION_KEEP_REQUIRED`（§2.2 顺序优先于 `KERNEL_NOT_ATTACHED`）；**不得尝试运行，不得 spawn worker**。
- **门控**：cell 仅在应用已处于 **会话保持 / resident-attach** 模式时可用——即已有一条活着的 runtime Node 进程，且 `DDA_RESIDENT_KERNEL=1` + `attachResidentKernel` 成功（`residentKernel.attached === true`，与 `codeCellsAvailability` 的 `residentAvailable` 一致）。若桌面尚无此模式，设置项说明「需要会话保持模式」，health 显示不可用；**不要**为了点亮 cell 而本轮新起常驻进程。
- 当会话保持 runtime **已经存在**时的回收（仍属本设计可写范围，因不引入新常驻架构，只约束已有长活进程的收尾）：
  - Rust 可把该 runtime（及其 CellHost 拉起的 worker 孙进程）放进 Windows **Job Object**，并设 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`。**只用做进程回收，不是沙箱**，与 `WINDOWS_NO_OS_SANDBOX` / CLI 稿 Non-goals 不冲突（见 CLI 稿 Non-goals 例外 + 本稿 §11 Q5）。
  - **Job Object 创建失败 ≠ cells 不可用**，也不是沙箱错误；回收回退到现有 cancel 后 `taskkill /T`。若 Tauri 进程已在某个 job 里，仅作为回收机制可文档化 `CREATE_BREAKAWAY_FROM_JOB` 或 nested-job 赋值。
  - 窗口关闭（`CloseRequested`）时，先发 cancel 让 CellHost 优雅关 worker 并递增 epoch；超时后再 `taskkill /T`。
  - runtime 重启时由 journal rehydrate：STARTED→UNKNOWN；CellHost 重新 spawn 时 epoch +1，旧 epoch 消息丢弃（`isValidCellEpoch`）。vm 状态丢失在 UI 上提示（§6）。

## 4. WINDOWS_NO_OS_SANDBOX 常驻提示（BOT2 #4）

- 只要当前会话的 cells 状态是 `WINDOWS_NO_OS_SANDBOX`，**每一张** kernel.exec 的审批卡和每一张 timeline tool card 上都固定显示警示 badge「无 OS 沙箱 · 以当前用户权限运行」，不能关闭，也不是一次性 toast。
- **Badge 判定**：审批卡与 timeline tool card **只认** payload 的 `warning === 'WINDOWS_NO_OS_SANDBOX'` 与 `sandbox === 'none'`（来自 worker READY）。`cell-worker-windows.mjs` 的 READY **必须**同时发送 `sandbox: 'none'`（与 `warning: 'WINDOWS_NO_OS_SANDBOX'` 并列；今日只有 `backend: 'unsandboxed'`，实现时补上）。`kernel.cells_ready` 可保留 `NOT_A_SECURITY_SANDBOX` 文案，**但不能当作卡片 badge 的判定值**。
- 与 §1 会话顶栏常驻横幅「无 OS 沙箱」同时存在。

## 5. 审批卡

- 复用 `renderApprovalCard`（`main.ts` ~1903）。新增字段：`cellOpIndex`（cell 内第 N 次 `host.request`）、`fingerprint`（代码 + 请求负载摘要，放在「核对信息」折叠区）、cell 代码预览（截断）。
- **`requestDigest` 覆盖代码、`cellOpIndex` 与本次 `host.request` 负载。批准只校验该 digest。`fingerprint` 是核对区里的同一摘要的展示名，不另做第二次比较。**
- TTL 120s，沿用 `approvalExpiresAt`；过期显示 EXPIRED；批准时校验 digest（`dispatchApproval` 已带 digest）。
- 纯计算 cell 不需审批（与 CLI 一致）；只有 `host.request` effect 需要。
- 审批卡上的 `WINDOWS_NO_OS_SANDBOX` badge 见 §4。

## 6. Timeline 流式与 journal 状态

- runtime 发出的 tool 事件必须带 `toolName: 'kernel.exec'`（#22 只按 toolName 识别）。stdout 与 `console.log`（worker 写 stderr）以增量事件追加到同一 `itemId`。
- 状态映射：STARTED → “运行中”；COMPLETED / FAILED 照常；UNKNOWN → “结果不确定（进程中断）”（醒目样式 + 「查看 journal」入口）。worker 重启时插入带 toolName 的 STATUS 卡：“cell 环境已重置，变量已丢失”。
- 输出截断并显示 digest，沿用 `evidence-command` 的 `truncated` 字段。

### 6.1 Journal 路径分家（BOT2 补充 — Locked；Grok should-fix 1）

- perMachine 安装目录（Program Files）只读 → journal / session 必须写 `%LOCALAPPDATA%`，否则 `JOURNAL_UNAVAILABLE`。
- **CLI 与桌面不得共用同一 journal 文件**，否则一方 rehydrate 把 STARTED 改成 UNKNOWN 会覆盖另一方。
- **Runtime 默认（不只靠宿主记 env）**：当 `DDA_PLATFORM` 为 `windows-cli` 或 `windows-desktop`，且未设置 `DDA_KERNEL_EFFECT_JOURNAL` / `--kernel-effect-journal` 时，runtime 默认写：
  - `%LOCALAPPDATA%\hmCodex\journal\<identity>\kernel-effect-journal.json`（及同目录 `.lock`）
  - **禁止**回落到 `hmCodex\kernel-effect-journal.json`
- 身份子目录：
  - **windows-cli**：`%LOCALAPPDATA%\hmCodex\journal\windows-cli\kernel-effect-journal.json`
  - **windows-desktop**：`%LOCALAPPDATA%\hmCodex\journal\windows-desktop\kernel-effect-journal.json`
- **遗留文件**：只由 **windows-cli** 迁移一次（桌面 cells 尚未写过 journal）；迁移时把其中 `STARTED` 收成 `UNKNOWN`。桌面端不负责迁遗留根目录文件。
- **`kernel-session.json`** 路径**仅**为 `%LOCALAPPDATA%\hmCodex\journal\<identity>\kernel-session.json`（与 journal 同 identity 子目录，不与另一身份共享；**无**「同级约定路径」变体）。
- Linux / portable 布局不在本轮改动范围。

## 7. 禁止 SANDBOX 模式（BOT2 #5）

- win32 桌面端 `DDA_KERNEL_SANDBOX` 为 truthy 时硬拒（`SANDBOX_UNSUPPORTED_ON_WINDOWS`，现有逻辑）。Tauri spawn **总是 `env_remove("DDA_KERNEL_SANDBOX")`**（§1）。
- UI **不提供**任何 “OS 沙箱” 选项，也不出现灰掉的选项，避免误以为将来能用。

## 8. 打包 — Locked: 捆绑 Node 24

- worker 已通过 `resources` 的 `runtime/src` 进包；CI 断言安装产物含 `runtime/src/kernel/cell-worker-windows.mjs` 与 `cell-protocol.mjs`。
- **安装包捆绑 Node 24**（≥24）。捆绑路径为 Tauri `resource_dir` 下的 `node/node.exe`（与安装架构一致）。`runtime_command()` 在未设置 `DDA_NODE` 时用该路径；`DDA_NODE` 仍可覆盖，但实际 major < 24 时 cells 为 `NODE_TOO_OLD`。
- 若未捆绑 / 实际 node < 24：`codeCellsAvailability` / health **硬拒** `NODE_TOO_OLD`（§2.2 第一位），设置项置灰并说明原因；**不得尝试运行** cell。
- Journal 路径见 §6.1。

## 9. 测试（BOT2 #6；Grok recheck #2）

- runtime 单测：注入 `platform: 'win32'` + env `DDA_PLATFORM=windows-desktop`，在 Linux CI 覆盖全矩阵（现有模式见 `:36`、`:72`）。
  - **改写 `:72`**：`win32` + `windows-desktop`（`baseWin` 已有 `WINDOWS_UNSANDBOXED`、无 `DESKTOP_CELLS`；且 `sessionKeep` + `residentAvailable` + `journalAvailable` 为真）→ 期望 `WINDOWS_DESKTOP_CELLS_REQUIRED`（仍然 `available: false`），不再期望 `PLATFORM_IDENTITY_MISMATCH`。
  - 新增：全部标志 + `sessionKeep` + `residentAvailable` → `available: true`，`reason: 'WINDOWS_NO_OS_SANDBOX'`。
  - 新增：`windows-cli` + `DESKTOP_CELLS` → `PLATFORM_IDENTITY_MISMATCH`。**前置**：设 `CODE_CELLS` + `residentAvailable` + `journalAvailable`，使通用路径能走到 identity mismatch（否则会先停在 `CODE_CELLS_DISABLED` / `KERNEL_NOT_ATTACHED` / `JOURNAL_UNAVAILABLE`）。
  - 新增：`linux` × `windows-desktop` → `PLATFORM_IDENTITY_MISMATCH`（不得 fall-through 到 bwrap）。**同样**需设 `CODE_CELLS` + `residentAvailable` + `journalAvailable`。
  - 其它：缺 `UNSANDBOXED`；带 `SANDBOX`；`!sessionKeep` → `DESKTOP_SESSION_KEEP_REQUIRED`；`residentAvailable: false` → `KERNEL_NOT_ATTACHED`；node < 24 → `NODE_TOO_OLD`；reason 顺序按 §2.2 锁定；**`win32 × windows-desktop`** 在未设 `CODE_CELLS` 时**不**返回 `CODE_CELLS_DISABLED`；`linux × windows-desktop` 未设 `CODE_CELLS` 时仍是 `CODE_CELLS_DISABLED`。
  - **Health 可见性**：新鲜 per-invoke health spawn 只断言停在 `NODE_TOO_OLD` 或 `DESKTOP_SESSION_KEEP_REQUIRED`；步骤 3–5 的断言只在活着的会话保持进程夹具上跑。
  - `windows-cli` 成功路径 reason 优先级回归（不变）。
- **Resident attach（`kernel-feature.test.mjs`；recheck #3 nit — 改写既有断言，不另加第二条）**：把现有「`win32` × `windows-desktop` resident → `available: false`」（嵌在 windows-cli 相关用例里的那条）**改写为**新的 attach 用例：`win32` × `windows-desktop` × `DDA_RESIDENT_KERNEL` × Node ≥ 24，且 `DESKTOP_CELLS` 与 `WINDOWS_UNSANDBOXED` **均未设** → `available: true`，`sandboxAvailable: false`。同条再覆盖：加 `DDA_RESIDENT_KERNEL_SANDBOX=1` 仍保持 `sandboxAvailable: false`（不是 cells 授权，也不点亮 sandbox）。**不要**在旁边再新增第二条平行测试。
- worker 进程级测试只在 Windows runner 上跑（spawn、epoch、kill / Job Object 回收；Job Object 创建失败回退 `taskkill /T`；READY 含 `sandbox: 'none'` + `warning: 'WINDOWS_NO_OS_SANDBOX'`）。
- Rust：env 组装单测——每次 spawn 设 `DDA_PLATFORM=windows-desktop` 且 `env_remove(DDA_KERNEL_SANDBOX)`；勾选且 session-keep 时注入三 cells 变量；未勾选只清三 cells 变量；**不清** `DDA_PLATFORM`；`DDA_RESIDENT_KERNEL` 仅 session-keep 路径；journal 路径指向 `journal\windows-desktop\...`。
- UI：渲染快照——badge 只认 `WINDOWS_NO_OS_SANDBOX`+`sandbox:'none'`、会话横幅、UNKNOWN 样式、过期审批、无 toolName 不出 tool card、无 SANDBOX 选项、`desktop-settings.json` 读写；桌面 tool 文案走独立分支键（§12）。

## 10. Out of scope

- Job Object / AppContainer 作为**沙箱**（KILL_ON_JOB_CLOSE **仅回收**见 §3 / §11，不是沙箱）
- 本轮引入 always-on / 为 cell 新起的常驻 runtime Node 进程（会话保持模式若已有则门控使用；常驻进程架构另案）
- macOS；Phase-2a 写类 effect 在 Windows 上启用；cell 多会话并行；远程/云端 worker
- 改 Linux / portable journal 布局

## 11. Locked answers（BOT2 五条 + journal；Grok #1/#2 must-fix + #3 nits 已 fold）

1. **启用方式**：全局设置确认一次 + 每个会话常驻横幅「无 OS 沙箱」。**不做**每会话 modal 确认。确认存 `%LOCALAPPDATA%\hmCodex\desktop-settings.json` → `experimentalCodeCells`。
2. **标志**：新增 `DDA_KERNEL_WINDOWS_DESKTOP_CELLS`（现有 truthy 解析）。双向隔离靠两边各用自己的标志。attach 门与 cells 门拆分（§2）。
3. **Worker / 生命周期**：**只在会话保持 / resident-attach 模式下提供 cell**。本轮**不**引入常驻 runtime 进程；per-invoke 路径 → `DESKTOP_SESSION_KEEP_REQUIRED`，不 spawn worker。
4. **Node**：**捆绑 Node 24**（`resource_dir/node/node.exe`）。未捆绑或 major < 24 → `NODE_TOO_OLD` 硬拒。
5. **Job Object**：允许 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` **仅用于进程回收**；创建失败回退 cancel+`taskkill /T`，不等于 cells 不可用。
6. **Journal**：runtime 按身份默认 `%LOCALAPPDATA%\hmCodex\journal\<identity>\`；禁止回落根目录；遗留文件仅 windows-cli 迁一次；`kernel-session.json` 同 identity 子目录。
7. **Desktop reason 顺序**：§2.2 Locked。`:72` → `WINDOWS_DESKTOP_CELLS_REQUIRED`。
8. **Env 所有权**：§1 — cells 开关不拥有 `DDA_RESIDENT_KERNEL` / 不清 `DDA_PLATFORM`。
9. **Badge / digest / tool 文案**：§4 / §5 / §12。
10. **Desktop arm 先于 `CODE_CELLS_DISABLED`**（recheck #2 must-fix 1；#3 nit 收窄）：**仅 `win32 × windows-desktop`** 永不返回 `CODE_CELLS_DISABLED`；其它 OS 上的 `windows-desktop` 仍走通用路径（`linux × windows-desktop` 未设 `CODE_CELLS` → `CODE_CELLS_DISABLED`）；§2.2。
11. **`sessionKeep` / 双次 availability 传参**（recheck #2 must-fix 2）：`sessionKeep` ⇔ `DDA_RESIDENT_KERNEL` truthy；`residentAvailable` ⇔ `attached === true`；desktop 下 `index.mjs` 在 `CODE_CELLS` 未设时仍调用 availability，且先解析身份 journal；`CellHost.start` 传入同一 `sessionKeep`/`nodeVersion`。
12. **Resident desktop 测试**（recheck #2 must-fix 3；#3 nit）：§9 — **改写**既有 `win32×windows-desktop` → `available:false` 断言为新 attach 用例，不另加第二条。
13. **READY `sandbox:'none'`**；mismatch 用例前置 `CODE_CELLS`+resident+journal；health 只见步骤 1–2；桌面 tool 文案独立分支键（§12）。
14. **Unset `DDA_PLATFORM`**（recheck #3 nit）：availability 比原始字符串，不经 `resolvePlatformIdentity`；unset 走通用路径，不进 desktop arm（§2.1）。
15. **`kernel-session.json`**（recheck #3 nit）：路径仅 `%LOCALAPPDATA%\hmCodex\journal\<identity>\kernel-session.json`（§6.1）。
16. **`DDA_KERNEL_CODE_CELLS`**（recheck #3 nit）：只在通用路径当总开关；desktop arm 不读它。

## 12. Tool 文案（Grok should-fix 6；recheck #2 nit）

- 当桌面 cells **可用**时，`registerKernelExecTool` 需要**独立分支键**（例如按 `DDA_PLATFORM === 'windows-desktop'` 或 `DESKTOP_CELLS` 可用态选型），文案写明 `windows-desktop` + `DDA_KERNEL_WINDOWS_DESKTOP_CELLS`，并保留 “NOT a security sandbox”。
- **禁止**只用 `windowsUnsandboxed` 布尔覆盖 CLI 字符串——那样会把 `windows-cli` 文案抹成桌面文案（或反过来）。CLI / 桌面各保留自己的描述分支。
- `kernel.cells_ready` 可继续带 `NOT_A_SECURITY_SANDBOX` 文案；卡片 badge 仍只认 §4 的 worker READY 字段（含 `sandbox: 'none'`）。

## 13. 发版前必须补的 Windows 真机测试（BOT2，#24 合并后）
1. worker 能起，READY 带 `sandbox:'none'` + `warning:'WINDOWS_NO_OS_SANDBOX'`
2. 一个 cell 跑完
3. 关窗口后 Job Object 回收 worker，无残留进程
4. Job Object 绑定失败 → 回退 `taskkill /T`
5. 旧版 CLI 根目录 journal 正常迁移到 `journal\windows-cli\`（STARTED→UNKNOWN）
