# ADR-0024: 以 HarnessFacade 作为稳定入口，分步从单体 runtime 抽取共享包

- Status: Accepted
- Date: 2026-10-11
- Deciders: dda architecture
- Related: [ADR-0001](0001-ports-and-adapters.md), [ADR-0006](0006-multi-platform-clients.md), [ADR-0023](0023-linux-cli-client.md), [多平台架构基线](../MULTI_PLATFORM_ARCHITECTURE.md), [单体抽取状态](../MONOLITH_EXTRACTION_STATUS.md)

## Context

当前几乎全部运行时行为集中在单体 `runtime/src/index.mjs`（约 6.7k 行）。该文件：

- 在 import 时就通过顶层 `await` 执行 CLI 分发，因此**无法被当作库 import**；
- 没有任何 `export`，只能以子进程 `node src/index.mjs <command>` 方式驱动；
- 把平台无关的契约（退出码、事件词汇、版本标识）与 Windows/Linux 平台假设混在一起。

[ADR-0023](0023-linux-cli-client.md) 决定 Linux 采用无界面 CLI 并复用该 runtime。若 `linux-cli` 直接依赖单体内部实现，任何一次重构都会波及 CLI，跨平台语义也会漂移。多平台架构基线（§4）已规划 `packages/harness-model` 与 `packages/harness-core`，但此前仓库里并不存在这两个包。

本 ADR 记录“架构拆分启动件（starter）”这一步：先建立稳定入口面与包骨架，再逐步搬运行为，而不是一次性重写单体。

## Decision

1. 新增 `packages/harness-model`：平台无关、零依赖，承载版本词汇、CLI 退出码契约（见 [LINUX_CLI_CONTRACT](../LINUX_CLI_CONTRACT.md) §5）和 `runtime_event` 词汇/终态判定。它是这些值的**唯一事实源**。
2. 新增 `packages/harness-core`，导出 `HarnessFacade`：平台壳（首先是 `linux-cli`）驱动 runtime 的**稳定编程入口面**。壳层只依赖 facade，不触碰 runtime 内部。
3. `HarnessFacade` 当前以**受监管子进程**方式驱动单体 runtime——这与架构基线 §3“运行时可以是同进程模块，也可以是客户端拉起的受监管子进程”一致。行为从单体抽取到 `harness-core` 后，对应方法可在**不改变 facade 入口面**的前提下，从 spawn 切换为同进程调用。
4. 第一处真实抽取是版本词汇：常量迁入 `harness-model`，`runtime/src/harness-event-store.mjs` 重新导出以保持既有 API，`runtime/src/index.mjs` 直接从 `harness-model` import。单体由此开始**依赖**抽取出的包，而非相反。
5. 安全语义不下放到壳层：Approval fail-closed、Phase 1.5 门控、Jev opt-in 与 `RULE_FALLBACK` 仍由 runtime 权威裁决。facade 只转发调用意图，默认 `READ_ONLY`，不注入自动审批，并在结果映射上 fail-closed。
6. HarmonyOS 的 `entry/` 仍连接已取消的远程 App Server（`AppServerWebSocketTransport.ets` / `CodexSession.ets`）。本阶段**不重写 ArkUI**，仅在文档中记录通往共享 harness 的迁移路径（见 [HARMONYOS_PLATFORM](../HARMONYOS_PLATFORM.md) §14 与 [MONOLITH_EXTRACTION_STATUS](../MONOLITH_EXTRACTION_STATUS.md)）。

## Architecture

```text
linux-cli (future)        desktop (Tauri)        entry (ArkUI, App Server 兼容)
        │                        │                         │  (文档记录的迁移路径)
        ▼                        ▼                         ▼
                      @dda/harness-core  ──►  HarnessFacade (稳定入口面)
                                │  spawn (当前) / in-process (抽取后)
                                ▼
                      runtime/src/index.mjs  (仍为单体)
                                │ import
                                ▼
                      @dda/harness-model  (版本 / 退出码 / 事件词汇)
```

依赖方向始终指向 `harness-model`；壳层永远只看见 `HarnessFacade`。

## Consequences

### 正面结果

- `linux-cli` 可以针对稳定 facade 编码，不被单体重构波及；
- 退出码、事件词汇、版本标识有了单一跨平台事实源；
- 行为可以在不改动壳层的情况下逐步搬离单体；
- facade 的 fail-closed 契约（缺失结果→`PROTOCOL_ERROR`、超时→`RUNTIME_ERROR`）有单元与端到端测试守护。

### 工程代价与诚实边界

- **绝大多数行为仍在单体**：所有 `run*Command` 函数、argv 解析、任务编排、Safety、Approval、Jev 装配都还在 `runtime/src/index.mjs`；本阶段只物理搬离了版本词汇；
- facade 以子进程驱动 runtime，带有一次进程启动开销，属于过渡形态；
- 包之间、runtime 与包之间暂用相对路径 import，尚未引入仓库级 workspace 链接；
- HarmonyOS 仅有文档路径，没有代码改动。

详细清单见 [MONOLITH_EXTRACTION_STATUS.md](../MONOLITH_EXTRACTION_STATUS.md)。

## Alternatives considered

### 一次性重写单体为模块化包

拒绝。6.7k 行、692 项测试，单次重写风险高，且会与并行进行的 Jev 决策面迁移冲突。分步抽取可持续保持测试绿灯。

### 让 `linux-cli` 直接 import runtime

拒绝。单体在 import 时执行 CL 分发，无法作为库使用；直接依赖内部实现也会造成跨平台语义漂移。

### facade 以同进程方式 require 单体

拒绝（暂时）。单体没有导出、且有顶层副作用，当前只能子进程驱动。待行为抽取到 `harness-core` 后再在 facade 内切换为同进程，壳层无感。

## Verification

- `packages/harness-model`：`node --test`（Node 24）覆盖退出码表、fail-closed 结果映射、未知事件保留与版本常量；
- `packages/harness-core`：单元测试以注入的假 `spawn` 验证事件解析、fail-closed 退出码、超时与 spawn 失败分类；端到端测试以真实 runtime `health` 命令验证入口面；
- runtime 回归：改动前后 `node --test` 均为 685 通过 / 5 失败（5 项为与本改动无关的既有 Windows/环境相关失败），无新增失败；
- 安全不变量：Approval fail-closed、Phase 1.5、Jev opt-in / `RULE_FALLBACK` 的 runtime 逻辑未被改动。
