# dda Prime 常驻内核 Phase-2 设计：副作用经 host_request 走审批链

## FROZEN（用户拍板 + grok-4.7 必改合并，2026-10-11）

状态：**FROZEN**。基线仍是 `oliverypf/dda` master `93674d1`（含 #17 / #18 / #19）。只是设计，**还没写代码**。

**张力已消解**：用户**坚持**无人可审时内核副作用可 AUTO-APPROVE；但范围收窄到 **master `resolveApprovalOutcome` 已经会 AUTO_APPROVE 的安全子集**（预授 lease、非危险）。危险硬规则、Jev `REQUIRE_APPROVAL`、缺 lease、READ_ONLY 在无人时**仍拒绝**——不得比离散工具更松。事后 denylist **只加拒、永不放行**。

| # | 冻结选择 | 说明 |
|---|---|---|
| 1 | **做 2b，但等 2a 稳了再开** | 2a 先统一入口 / Journal / 批量少问人；2b（真 code cell + OS 沙箱）才是墙钟和模型成本的大头。 |
| 2 | **无人可审 → AUTO-APPROVE（仅 master 安全子集）+ 审计** | 见下方「无人自动批合同」。 |
| 3 | **批量以少问人为目标；2a 只开文件写批** | 显式 `fs.write_batch`；**2a 拒绝 `shell.exec` / `net.fetch`**（延后到 2a 稳后或 PR-B+）；`test.run` 永不进批。配额起步 ≤10 项 / ≤256KB / 每轮 1 批。 |
| 4 | **2a 开启 effects 后整轮隐藏离散副作用工具** | `file.write` / `text.patch` / `shell.execute` / `test.execute` / `network.request` 对模型不可见；只走 `kernel.host_request` + 只读工具。内核丢失 → **仅回退只读工具**（不重新露出离散写/壳/网）。 |
| 5 | **做不到真事务 → 不回滚** | 批内任一项失败：停止、报告已提交前缀、其余 `SKIPPED`；不假装事务回滚。 |
| 6 | **#16 与内核 outcome 分两条线** | **#16**：仅 verifier `UNCERTAIN\|STALLED` 武装到干净 `PASS`（同 `verifierStateRequiresReapproval`）；**不**把 `TIMEOUT`/`FAIL` 当 #16 武装。**另**：`host_request` 上 `KERNEL_OUTCOME_UNCERTAIN` 或 `KERNEL_TIMEOUT` → 拒下一笔副作用自动批（仅追加，不清除/不替代 #16）。该 op 不重放。 |
| 7 | **2b 沙箱优先 bubblewrap** | 缺 bwrap 时退 Landlock+seccomp；两者都不可用则 **fail-closed**（不开 code cell）。 |
| 8 | **effects 门控必须同时满足全部** | `DDA_RESIDENT_KERNEL` + `DDA_KERNEL_EFFECTS` + Linux（`DDA_PLATFORM=linux-cli`）+ CONTROLLED + 对应 capability lease。缺一即拒副作用（只读内核可仍开）。 |

### 无人自动批合同（FROZEN #2，grok-4.7 必改 + 用户坚持）

1. **AUTO-APPROVE 仅发生在 master 已允许之处**：与离散工具同一条 `resolveApprovalOutcome`——已预授 lease、且 `assessRequestRisk` 非 dangerous 时，无人可审可 `AUTO_APPROVE`（`EXPLICIT_HOST_POLICY` / `host-policy-audit`）。
2. **无人可审时仍必须 REFUSE**（不得绕过）：
   - `assessRequestRisk` 判定危险；
   - Jev / 规则 `REQUIRE_APPROVAL` 或 `BLOCK`；
   - 缺 capability lease / 未 CONTROLLED；
   - READ_ONLY 通道。
3. **事后 denylist 只加拒、永不放行**：审计或人工复核标「有风险」后，键入 denylist / `require-live`；下次该类不得再自动批。清除需显式运维动作。denylist **不能**把本来会拒的变成批。
4. **denylist 键**（取代模糊的 scene / behaviorClass）：`(executionMode, effectKind, riskClass)`  
   - `executionMode`：如 `CONTROLLED` / 通道身份；  
   - `effectKind`：规范 kind（`fs.write` / `fs.patch` / `test.run` / …）；  
   - `riskClass`：稳定风险桶（如 `workspace_write` / `secret_path` / `dangerous_cmd` / `network_target`——实现时写死枚举）。  
5. **denylist 宿主拥有**：宿主持有存储、带摘要校验；**不得**放进可被模型改的 `session_state`。审计日志另记 digest、intent/lease/journal id、结果。
6. 标志：`DDA_KERNEL_APPROVAL=host-policy-audit`（`host-policy` 别名）。可选 `per-request` = 没人可问就拒（更严部署）。`--approval-mode deny` 仍全部拒绝。

### #16 / 不确定 outcome 合同（FROZEN #6）

两条独立机制，互不替代：

1. **Verifier reapproval（#16，同 `verifierStateRequiresReapproval`）**：仅当 verifier 为 `UNCERTAIN` 或 `STALLED` 时武装，保持到验证干净 `PASS`。**不得**把 verifier `TIMEOUT` / `FAIL` 当作 #16 武装。武装期间：下一笔副作用须单独审批；正在进行的批强制作废未执行项。
2. **内核 host_request outcome（追加，非 #16）**：该 op 上出现 `KERNEL_OUTCOME_UNCERTAIN` 或 `KERNEL_TIMEOUT`（桥接/执行超时）时——该 op **绝不重放**；下一笔副作用**拒绝自动批**，须单独 live 审批（无人则拒）。本条**仅追加**约束，**不清除、不替代、不提前结束** #16 武装。

### 执行与 lease 合同（FROZEN #3 / #5）

- **宿主执行**副作用；worker 永不执行写/壳/网/测。
- **每个副作用各消耗一次**一次性 PolicyLease；`fs.write_batch` = N 项 → **先做 N 次 lease 准入检查**，再执行；任一项失败 → 停止并报告已提交前缀，**不回滚**。
- **2a：`shell.exec` / `net.fetch` 拒绝**（kind 未启用或显式拒）；永不进批。`test.run` 可启用但不进批。

### 工具可见性合同（FROZEN #4）

- `DDA_KERNEL_EFFECTS` 开启的整轮：隐藏离散 write/patch/test/shell/network。
- 内核丢失 / 不可用：回退为 **只读工具 only**；不重新露出离散副作用工具。

下文 §2–§9 凡与上列冲突的「建议默认」均以 **FROZEN** 为准。

---

## 0. 先说现实：Phase-1 实际落地和 v3 设计不一样

v3 设想的是 **code cell REPL**：`execute{code}`，在内核里跑代码，代码里再 `await host_request(...)`。#17 实际合进去的是一个**按 op 调用的 worker**：

| 方面 | v3 设计 | #17 实际 |
|---|---|---|
| 模型入口 | 一个 `kernel` 工具，一次跑一个 code cell | 8 个离散 `kernel.*` 工具（`workspace_list/read/focus`、`session_get/list/set/delete`、`host_request`） |
| 跑代码 | 有（持久 JS 上下文） | **没有**，worker 只认固定 op |
| host_request 方向 | worker → host（cell 跑到一半发起） | model → host → worker，worker 直接拒（`KERNEL_SIDE_EFFECT_REFUSED`） |
| 沙箱 | bwrap/Landlock + seccomp | 只是子进程 + `buildRuntimeEnv` 过滤 env（`feature.mjs` 写明 OS 隔离推到 Phase-2） |
| 崩溃语义 | 从 SessionState 冷重建，不重放 | 已实现：先落盘再 dispatch；只有 read 和 session 写可以重试；`host_request` 碰上崩溃报 `KERNEL_OUTCOME_UNCERTAIN` |

**结论**：Phase-2 应拆成两段。
- **Phase-2a（本稿 MVP）**：在现有 op 形态上，把写入 / 测试接进**宿主现有**的 lease/审批链（**shell/net 2a 拒，延后**）。副作用**由宿主执行，不经 worker**。所以 worker 的沙箱强度不在关键路径上，Linux 上现在就能做。
- **Phase-2b（以后）**：真正的 code cell（Prime 的核心价值：一轮里跑多步逻辑、少走模型往返）。前提是 OS 沙箱。这一段才是加速的大头。

---

## 1. 目标 / 非目标

**目标（Phase-2a）**
1. `kernel.host_request` 支持封闭类型集；**2a 启用** `fs.write`、`fs.patch`、`test.run`（及 `fs.write_batch`）；**2a 拒绝** `shell.exec`、`net.fetch`。启用的每一种都走和离散工具**完全同一条**闸门：READ_ONLY 硬拦 → ACTION_GATE（Jev/规则）→ `assessRequestRisk` → `gateDecisionFor`（#15 + #16）→ `resolveApprovalOutcome` / `requestApproval` → 一次性 PolicyLease → 宿主 executor → ExecutionStateStore/账本。
2. 写入支持逐个审批与低风险文件写**受限批量**（**FROZEN #3**）；无人可审时按 **FROZEN #2** 仅在 master 安全子集 AUTO-APPROVE 并审计。
3. 崩溃：从 SessionState 重建。outcome 没落定的、不能安全重放的请求**绝不重放**，标 `pendingOutcome`，交给模型只读复核。
4. 全部 feature flag 默认关，fail-closed，只开 Linux（`DDA_PLATFORM=linux-cli`）。
5. 不动：#15 / #16 语义、Phase 1.5 通道（`LINUX_CLI_CONTROLLED → WINDOWS_PHASE1_5_CONTROLLED`）、Jev 显式 opt-in、`DDA_*` 命名、`DDA_LEASE_CAPABILITIES` / `DDA_LEASE_COMMANDS` / `DDA_NETWORK_TARGETS` 的授权语义。

**非目标（2a）**：code cell / 持久 JS 上下文 / 后台 task；OS 沙箱；`agent.spawn`；`tool.call`（MCP 走内核）；Windows / 鸿蒙；自动压缩；`/refine`。

---

## 2. 架构（Phase-2a）

```
Model ──tool call──▶ kernel.host_request{kind,payload}
                         │
            index.mjs 工具循环（不变）：READ_ONLY 硬拦 → ACTION_GATE（unwrap 之后，见 §3.2）
                         │
                  HostRequestDispatcher（新，宿主内，packages/harness-core 边界）
                   ├─ 惰性类 host.ping / host.capabilities ─▶ worker（同 Phase-1）
                   ├─ 未知 kind / schema 不合法 ─▶ KERNEL_SIDE_EFFECT_REFUSED（fail-closed）
                   └─ 副作用类 ─▶ HostRequestJournal(REQUESTED)
                                   → 映射到 capability（file.write / shell.execute / test.execute / network.request）
                                   → 复用 leaseProvider（assessRequestRisk + gateDecisionFor + requestApproval）
                                   → 执行：复用现有离散工具的 executor 代码路径（不另写执行逻辑）
                                   → Journal(STARTED → COMPLETED | FAILED | UNKNOWN)
                                   → SessionState.pendingOutcomes（只放 UNKNOWN 的）
worker：不拿 lease、不碰 executor、不碰网络（Phase-1 原样）
```

要点：**副作用执行在宿主侧，worker 永远不参与**。这样 worker 崩溃不可能把副作用弄到一半。真正的「执行到一半」只剩宿主进程本身崩溃这一种，交给现有的 ExecutionStateStore UNKNOWN + `task-recovery-controller` 处理（linux-cli `contract-nits` 已经覆盖了超时写 UNKNOWN 的情况）。

### 2.1 类型表（封闭集合）

| kind | 映射 capability | 基础风险 | 可批量 | 备注 |
|---|---|---|---|---|
| `fs.write` | `file.write` | HIGH（沿用现有） | 是（§4，满足低风险条件时） | payload 必须带 `expectedBaseDigest`（新建文件为 `null`），作前置条件 |
| `fs.patch` | `file.write` | HIGH | 是 | 复用 `text-patch.mjs`；base digest 对不上就失败、不硬覆盖 |
| `test.run` | `test.execute` | MEDIUM | 否 | 命令必须在 `DDA_LEASE_COMMANDS` 里 |
| `shell.exec` | `shell.execute` | HIGH | **永不** | **2a 拒绝启用**（kind 未开或显式拒）；危险命令硬检查照旧。延后。 |
| `net.fetch` | `network.request` | HIGH | **永不** | **2a 拒绝启用**；目标须在 `DDA_NETWORK_TARGETS`。延后。 |

Phase-1 `KERNEL_BRIDGE_SIDE_EFFECT_KINDS` 里的别名（`write_file`、`shell`、`file.write` 等）在 2a **继续拒绝**，只认上表这些规范名。**2a MVP 允许的 kind 仅** `fs.write` / `fs.patch` / `test.run`（加 `fs.write_batch`）；`shell.exec` / `net.fetch` 出现即 `KERNEL_SIDE_EFFECT_REFUSED`。

### 2.2 和离散工具的关系（**FROZEN #4：2a 隐藏离散副作用**）

- 默认（`DDA_KERNEL_EFFECTS` 不开）：完全是现状。离散副作用工具照常可见，`kernel.host_request` 照常拒绝。
- 开启后（**FROZEN #4**）：**整轮隐藏**离散副作用工具（`file.write` / `text.patch` / `shell.execute` / `test.execute` / `network.request`），模型只能经 `kernel.host_request`（及只读工具）产生副作用。
- **内核丢失 / 不可用**：回退为 **只读工具 only**；**不**重新露出离散写/壳/网/测工具。
- 闸门实现仍复用同一套 `pendingApprovals`、`gateApprovalDecisions`、`verifierReapproval` 和 lease provider / executor，所以 **#15 / #16 语义不变**（入口只剩内核）。
- **effects 门控（FROZEN #8）**：必须同时满足 `DDA_RESIDENT_KERNEL` + `DDA_KERNEL_EFFECTS` + Linux + CONTROLLED + 对应 capability lease；缺一即拒副作用。

---

## 3. 审批链细节

### 3.1 审批默认值（**FROZEN #2：无人 AUTO-APPROVE = master 安全子集**）

现状：CONTROLLED 下，已经预授权（lease 范围内）、又不危险的动作，在**没有 live approver** 时走 `EXPLICIT_HOST_POLICY` 自动批准（`resolveApprovalOutcome` → `AUTO_APPROVE`）。

**用户坚持无人自动批；范围锁定为 master 已允许的子集**（见文首合同）：

- 默认意图：`DDA_KERNEL_APPROVAL=host-policy-audit`（`host-policy` 别名）。
- 有 live approver（TTY / jsonl）时：按风险与批规则弹卡；批量见 §4。
- **没人可问**且 `resolveApprovalOutcome` 本就会 `AUTO_APPROVE`（预授 lease、非 dangerous）、且 denylist 未命中：允许 `AUTO_APPROVE`，写**审计日志**（`(executionMode, effectKind, riskClass)`、digests、journal/lease/intent ids、结果）。
- **没人可问时仍 REFUSE**：`assessRequestRisk` 危险、Jev/`REQUIRE_APPROVAL`/`BLOCK`、缺 lease、READ_ONLY——与离散工具一致，不得更松。
- 事后 denylist：键 `(executionMode, effectKind, riskClass)`；**只加拒、永不放行**；宿主持有 + digest 校验；**不**进 `session_state`。
- `--approval-mode deny`：全部拒绝。可选 `per-request` = 没人可问就拒。
- #15 / #16 / `KERNEL_OUTCOME_UNCERTAIN` 武装期：**永远不可**被无人自动批绕过。

### 3.2 Jev / ACTION_GATE 必须看 unwrap 后的内容

现在 ACTION_GATE 看到的工具名是 `kernel.host_request`，payload 对它来说是不透明的。Phase-2a 的做法：
- 进门禁前把 `kernel.host_request{kind:'fs.write',payload}` **规范化**成等价的 `{capability:'file.write', request:{path,…}}` 证据。Jev / 规则看到的东西和离散 `file.write` 完全一样（`untrustedProposedInput` 结构相同）。
- `gateApprovalDecisions` 仍按**外层 toolCallId / argumentsDigest** 记，`gateDecisionFor` 用同一个 key 查，这样 #15 的 `REQUIRE_APPROVAL` 能精确落到这一个请求上。
- Jev 关着时只走规则（不变）；Jev 超时 / 出错按现有 fail-closed 回退。

### 3.3 #16 / Phase 1.5 / READ_ONLY（**FROZEN #6 / #8**）

- `verifierReapproval.active`（UNCERTAIN / STALLED）→ 下一个副作用 host_request 必须单独审批，**同时作废正在进行的批**（§4）。**#16 武装保持到验证干净 PASS**；不得被内核「只拦下一笔」逻辑拆掉或提前清掉。
- 桥接 / 执行 **TIMEOUT** ≡ `KERNEL_OUTCOME_UNCERTAIN`：该 op 不重放；下一笔副作用拒自动批，须单独审批（无人则拒）。
- READ_ONLY 通道：`kernel.host_request` 已经被硬拦（`index.mjs` L3214 特判），保持不变；无人自动批不得绕过。
- 非 CONTROLLED 或 lease 没授予这个 capability：`SAFETY_LEASE_REQUIRED`，根本到不了审批，和离散工具一致（FROZEN #8 缺一即拒）。

### 3.4 和 Jev 加速 MVP（#19）的交互

- `DDA_JEV_READONLY_FAST_PATH`：白名单**不扩**。`kernel.host_request` 无论什么 kind 都不走快路径（现有代码已经排除，加回归测试锁住）。
- `DDA_JEV_PLAN_TIER_ENABLED`：CONTROLLED + modify/test 强制 PLAN_COUNCIL，不变。内核副作用不会让选档变松。
- `jev-metrics`：新增 `hostRequest.{kind}.{gate,approval,lease,exec}` 计数和延迟，外加 `batch.{size,granted,invalidated}`。这样能直接比较内核路径和离散路径的墙钟。
- 速度上要说实话：2a 每次写入还是一个 tool call 加一次审批，**墙钟和模型成本基本不变**。省时间只能靠（a）批量少问几次人，（b）2b 的 code cell 少走模型往返。

---

## 4. 受限批量（D4 的落地，改成显式 batch kind）

D4 原来是在 cell 内开一个短时间窗口收集请求。2a 没有 cell，时间窗口又有竞态，所以改成**显式**的 `fs.write_batch{items:[{op:'write'|'patch', path, content|patch, expectedBaseDigest}]}`：

- 硬限（起步）：≤ 10 项、内容合计 ≤ 256 KB、每个模型轮次最多 1 批（同一条 assistant 消息里的工具调用算一轮）。超限**整批拒绝**，让模型拆开，不会悄悄降成逐个。**FROZEN #3** 允许为可用性上调配额，但必须在本规格写死新上限与理由后再改代码。
- 低风险的条件：每一项都**不**命中 `assessRequestRisk`（没越出工作区、不是密钥路径），路径相对且在工作区内，不在 `excludedPaths` 里；每一项的 ACTION_GATE 都不是 `REQUIRE_APPROVAL` / `BLOCK`。有任何一项不满足，整批回到逐个审批（有人可问）或拒绝（没人可问）。
- 只在 CONTROLLED 且 `DDA_KERNEL_WRITE_BATCH=1` 时可用（**FROZEN #3**）。有 live approver 时出批卡；**没人可问**时：仅当整批每项都落在 master `AUTO_APPROVE` 子集（预授 lease、非危险、denylist 未命中）才可整批自动批并审计；任一不合格 → **整批拒绝**（不降级拆开偷偷逐个自动批）。`--approval-mode deny` 时批量一律拒绝。配额起步 ≤10 / ≤256KB / 每轮 1 批。`shell` / `net` / `test.run` 永不进批；**2a 根本不启用 shell/net**。
- 审批卡：逐项列出路径、操作、字节数、diff 摘要（截断）、每项 digest，**外加一个整批 digest**。选项是「本批同意 / 全部拒绝 / 逐个审」。`approval_response` 的 `displayedDigest` 必须等于整批 digest。
- 执行（**FROZEN #3 / #5**）：`write_batch` = N 项 → **先做 N 次 lease 准入检查**，再执行；每一项各自 intent / 一次性 lease / 记账；批记 `ApprovalBatchGranted{batchId, itemDigests, approvalId}`。按序执行，**任一项失败就停**，报告已提交前缀，其余 `SKIPPED`，**不回滚**。
- 立即失效：#16 武装、某项 Jev REQUIRE_APPROVAL/BLOCK、审批过期（`APPROVAL_TTL_MS`=120s）、工作区快照 digest 在审批与执行间变化、`KERNEL_OUTCOME_UNCERTAIN` 武装。

---

## 5. 崩溃与不重放

### 5.1 HostRequestJournal（复用 ExecutionStateStore，不新建库）

每个副作用 host_request 的状态：`REQUESTED → GATED → APPROVED|DECLINED → LEASED → STARTED → COMPLETED|FAILED|UNKNOWN`。字段：`requestId`、`toolCallId`、`kind`、`argsDigest`、`batchId?`、`intentId`、`approvalId`、`leaseId`、`expectedBaseDigest`、`resultDigest?`。

### 5.2 replay-safe 分类（扩 `isReplaySafeKernelOp`）

| 类别 | 崩溃后 |
|---|---|
| read op、session 写（先落盘、幂等） | 透明重试（Phase-1 不变） |
| `host.ping` / `host.capabilities` | 透明重试 |
| 副作用 host_request，`STARTED` 之前（还没领 lease 或刚领到） | **作废 lease**，标 `ABORTED`，不执行，告诉模型可以重新发起（要**重新审批**） |
| 副作用 host_request，`STARTED` 之后、没有终态 | **UNKNOWN**，绝不重放，写进 `SessionState.pendingOutcomes` |
| 批 | 已 COMPLETED 的保留；STARTED 的那项 → UNKNOWN；后面的 → ABORTED |

### 5.3 重建流程

1. 进程重启或 worker 重启 → `sessionStore.reload()` →（宿主重启时）扫 Journal：所有 STARTED 但没有终态的 → UNKNOWN。
2. 上下文 Session 段置顶 `pendingOutcomes`：kind、path / command、`expectedBaseDigest`、当时的 digest。
3. 写入类可以**只读复核**：宿主算一次当前文件 digest，和 `expectedBaseDigest` / 目标内容 digest 对比，把结果标成 `LIKELY_APPLIED` / `NOT_APPLIED` / `DIVERGED`。这只是提示，**不自动重做也不自动回滚**。
4. shell / test / net：没法复核，只能交给模型或人判断。想再跑一次，就是一个新请求，走完整审批。
5. 有 pendingOutcome / TIMEOUT 时：该 op **绝不重放**；下一笔副作用**拒绝自动批**，须单独 live 审批（无人则拒）。`reasonCode: KERNEL_OUTCOME_UNCERTAIN`（含桥接超时）。**#16 验证器武装保持到干净 PASS**，不被本逻辑拆掉（**FROZEN #6**）。

---

## 6. Feature flags（全部默认关，前提依次叠加）

| 变量 | 取值 | 默认 | 说明 |
|---|---|---|---|
| `DDA_RESIDENT_KERNEL` | bool | off | 已有，前提 |
| `DDA_KERNEL_EFFECTS` | 逗号列表；2a 仅认 `fs.write,fs.patch,test.run`（`shell.exec`/`net.fetch` 出现即拒） | 空 | **FROZEN #8**：须同时有 `DDA_RESIDENT_KERNEL` + Linux + CONTROLLED + 对应 `DDA_LEASE_*`；缺一即拒副作用 |
| `DDA_KERNEL_APPROVAL` | `host-policy-audit` \| `host-policy` \| `per-request` | `host-policy-audit`（**FROZEN #2**） | §3.1；master 安全子集 AUTO-APPROVE；`per-request` = 没人可问就拒 |
| `DDA_KERNEL_WRITE_BATCH` | bool | off | §4；无人时可按 master 子集整批自动批（非「必须 live」） |
| `DDA_KERNEL_CODE_CELLS` | bool | off | 2b 预留；2a 里设了也拒，并在 `kernel.unavailable` 里说明原因 |

可用性检查在 `residentKernelAvailability` 基础上加 `effectsAvailability`（**FROZEN #8 五项齐全**）。原因码稳定：`EFFECTS_DISABLED`、`NOT_CONTROLLED`、`NON_LINUX_PLATFORM_IDENTITY`、`LEASE_NOT_GRANTED`、`JOURNAL_UNAVAILABLE`、`KERNEL_NOT_ATTACHED`。不满足时**只关副作用**；若内核丢失则工具面缩为只读（FROZEN #4）。`dda health` 显示当前状态。

---

## 7. 取舍：内核 host_request vs 离散工具

| 维度 | 离散工具（现状） | 内核 2a | 内核 2b（code cell） |
|---|---|---|---|
| 安全闸门 | 完整 | 完整，同一条链 | 完整，另外依赖 OS 沙箱 |
| 墙钟 / 模型成本 | 基线 | ≈ 基线（多一次规范化，可忽略） | 明显下降（一个 cell 做多步） |
| 少问人 | 逐个 | 逐个 + 可选批量 | 同 2a |
| 崩溃语义 | ExecutionStateStore UNKNOWN | 同上 + pendingOutcomes 进上下文 | 同 2a，外加 cell 中途失败 |
| 复杂度 / 风险 | 低 | 中（unwrap 门禁、batch 卡） | 高（沙箱、协议反向通道、后台 task） |

**2a 的价值**：统一入口和账本；批量少问人；崩溃上下文；为 2b 铺好反向通道和 Journal。单看速度，2a 不划算。2a 值不值得做，取决于走到 2b（已 FROZEN #1：做）。

---

## 8. MVP 切片 vs 以后

**2a-MVP（建议 2 个 PR，Linux only，默认关）**
- PR-A：HostRequestDispatcher + 类型表（仅 `fs.write`/`fs.patch`/`test.run`；shell/net 拒）+ unwrap 门禁 + 复用 lease/`resolveApprovalOutcome` + Journal + 崩溃/TIMEOUT→`KERNEL_OUTCOME_UNCERTAIN` + pendingOutcomes + 只读复核；**整轮隐藏离散副作用；内核丢失→只读 only（FROZEN #4）**；`host-policy-audit` + 宿主持有 denylist 键 `(executionMode, effectKind, riskClass)`（**FROZEN #2**）；FROZEN #8 五项门控；metrics。
- PR-B：`fs.write_batch`（N 次 lease 先准入）+ 批量审批卡（TTY/jsonl）+ 失效规则 + 失败停并报告前缀、不回滚。**shell/net 仍拒**（延后，不进本 PR）。
- 测试（Node 24）：缺任一门控即拒；READ_ONLY / 危险 / Jev REQUIRE_APPROVAL / 缺 lease 无人时拒；master 安全子集无人可 AUTO_APPROVE 并审计；denylist 只加拒；#16 武装保持到 PASS 且下一次单独审批并作废批；TIMEOUT≡UNCERTAIN 不重放；批量配额/跨轮不合并/一项危险整批拒/digest 不一致拒；崩溃（lease 前 / STARTED 后 / 批中间）→ ABORTED / UNKNOWN / 不重放；快路径永不放行 host_request；隐藏离散工具 + 内核丢失不露离散写；整包无回归。真模型冒烟：CONTROLLED + jsonl，一次写入 + 一批 3 文件。

**以后**
- 2b（**FROZEN #1 / #7**，2a 稳后再做）：OS 沙箱（**优先 bubblewrap** → Landlock+seccomp → 都不行就 fail-closed）+ `execute{code}` 持久上下文 + worker→host 反向 host_request + 后台 task 归属。离散副作用隐藏已在 2a 完成（FROZEN #4）。
- Phase 3：`agent.spawn`、`tool.call`(MCP)、HarnessState、自动压缩。
- Phase 4：daemon / attach、Windows / 鸿蒙。

---

## 9. 原开放问题 → 已冻结（见文首 FROZEN）

1. **要不要做 2b？** → **做，2a 稳后再开**（FROZEN #1）。
2. **没人可问时自动批？** → **坚持 AUTO-APPROVE，但仅 master `resolveApprovalOutcome` 安全子集**；危险 / REQUIRE_APPROVAL / 缺 lease / READ_ONLY 无人仍拒；denylist 键 `(executionMode, effectKind, riskClass)`，宿主拥有、只加拒（FROZEN #2）。张力已消解。
3. **批量？** → **少问人**：`fs.write_batch`；N 次 lease 先准入；**2a 拒 shell/net**；`test.run` 不进批（FROZEN #3）。
4. **2a 隐藏离散副作用？** → **整轮隐藏；内核丢失→只读 only**（FROZEN #4）。
5. **批失败回滚？** → **不回滚，停并报告已提交前缀**（FROZEN #5）。
6. **pendingOutcome / TIMEOUT？** → **不重放该 op；拒下一笔副作用自动批；#16 保持到 PASS**（FROZEN #6）。
7. **2b 沙箱？** → **优先 bubblewrap → Landlock+seccomp → fail-closed**（FROZEN #7）。
8. **effects 门控？** → **五项齐全**：resident + effects + Linux + CONTROLLED + lease（FROZEN #8）。

仍待实现阶段再定（不挡冻结）：审计日志存储与保留期；`riskClass` 枚举终表；denylist 路径与清除 UX；批量配额上调数字与评审门槛；shell/net 启用的后续 PR 门槛。
