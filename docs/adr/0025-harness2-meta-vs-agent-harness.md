# ADR-0025: Harness² meta loop 与 Agent Harness runtime 的边界

- Status: Proposed
- Date: 2026-10-27
- Deciders: dda architecture (pending architecture review)
- Related: [ADR-0024](0024-harness-facade-and-package-split.md), [Agent Harness 设计](../AGENT_HARNESS_DESIGN.md), [offloop README](../../offloop/README.md)

本 ADR（架构决策记录）定义 **Harness² / Harness2（元环）** 与 **Agent Harness（代理运行时）** 的边界。Harness² 是仓库 `offloop/` 下的 off-loop meta / contrast-probe 产品；Agent Harness 是运行时、共享包、审批、Memory 与安全闸组成的执行系统。名字相近不构成运行时依赖或权限继承。

## Context

[ADR-0024](0024-harness-facade-and-package-split.md) 为 Agent Harness 建立了 `HarnessFacade` 稳定入口，并分步抽取 `packages/harness-core` 与 `packages/harness-model`。它明确了壳层如何受监管地驱动 `runtime/`，以及安全、审批和 fail-closed 结果仍由 runtime 权威裁决。

[Agent Harness 设计](../AGENT_HARNESS_DESIGN.md) 则把 `ActionIntent → RuntimeSafetyMonitor → PolicyLease → ExecutorPort` 定义为强制路径：模型、UI（user interface，用户界面）、插件和 facade 都不能绕过它。运行时还拥有审批、工作区、轨迹和本地 Memory Journal。Harness² 来自独立的 off-loop contrast-probe 工具集合；它只能整理有界证据，不能因为同名而并入 runtime 或获得执行权限。

如果两个面被混合，`MISS（未命中）` 证据就可能被误当成在线策略，`EXPERIENCE（经验）` 可能绕过审阅进入 Memory，或 `CANDIDATE（候选）` 直接改变执行行为。本 ADR 固化目录、数据流、tip 审计和人工 PR（pull request，合并请求）闸，防止这种权限和治理倒置。

## Decision

### 1. 产品位置与职责

Harness² lives at the product repo root under `offloop/`. It owns bounded ingest, path-signals, contrast probes, `run-from-miss`, and the decision-grade record (DGR，决策级记录) that explains an off-loop result. It may produce `EXPERIENCE（经验）` or a reviewable `CANDIDATE（候选）`; it does not host runtime execution, approvals, Memory, PolicyLease, or the hard gate（硬闸）. The directory is deliberately **not** renamed to `packages/harness2`.

The Agent Harness remains the authority for `runtime/`, `packages/harness-core`, `packages/harness-model`, execution, approvals, Memory, PolicyLease, and the hard gate. Harness² may consume bounded evidence and documented CLI/output contracts, but it has no reverse online policy write into those authorities.

### 2. Directory ownership and dependency direction

| Directory | Authority and boundary | Allowed direction |
| --- | --- | --- |
| `offloop/` | Harness² meta loop; reads bounded bench/log evidence and writes auditable off-loop output only. | May depend on its own off-loop modules and documented evidence/CLI contracts. It must not import runtime internals or write runtime policy, Memory, approvals, or executor state. |
| `runtime/` | Agent Harness runtime; owns task execution, approvals, Memory, PolicyLease, Runtime Safety, and the fail-closed hard gate. | May consume canonical vocabulary from `packages/harness-model`. It never depends on `offloop/` for a runtime decision. |
| `packages/harness-core` | `HarnessFacade` and domain-facing entry surface for platform shells; it forwards intent and supervises the runtime as documented by ADR-0024. | May depend on `packages/harness-model` and the documented runtime entry. It has no Harness² bypass or approval-grant API. |
| `packages/harness-model` | Platform-agnostic values, event vocabulary, and stable CLI result mapping; zero runtime dependencies and no platform code. | It is the lower-level shared contract. `runtime/` and `packages/harness-core` may depend on it; it does not depend on either implementation or on `offloop/`. |

The intended topology is:

```text
platform shells ──► packages/harness-core ──► supervised runtime entry
                         │                         │
                         └──────────────► packages/harness-model
runtime/ ────────────────────────────────────────► packages/harness-model

offloop/ ──► bounded evidence / documented contracts
offloop/ ──✕──► runtime/, packages/harness-core, packages/harness-model policy or executor state
```

The arrows describe authority, not a promise that all future extraction is in-process. A runtime-to-package vocabulary import and a core-to-runtime supervised call are compatible with ADR-0024; an off-loop reverse write is not.

### 3. Bounded data flow and review gate

The only supported off-loop progression is:

```text
MISS（未命中） / path-anomaly（路径异常）
  → run-from-miss
  → ingest / path-signals
  → DGR（decision-grade record，决策级记录）
  → EXPERIENCE（经验） or CANDIDATE（候选）
  → human PR gate（人工 PR 闸）
```

In compact form, `MISS → run-from-miss → EXPERIENCE/CANDIDATE → 人工 PR` is the reviewable path. `EXPERIENCE` remains `adopted=false` with `reason=experience_only`; it is reusable off-loop evidence, **not** runtime Memory or adopted policy. A `CANDIDATE` is a proposal for a human PR only. There is no reverse online policy write, automatic promotion, automatic merge, or `CANDIDATE → FROZEN` transition. The hard gate remains fail-closed in Agent Harness even when a bounded run is green.

### 4. Tip and path contract

- The fixed tip pin is the non-empty SHA（secure hash algorithm，安全哈希算法） `2258685ce9793639ebc9698c8961dcedccf6e49b`. Every example and verification record must show the resolved `tipSha`, its source (`tip-path`, explicit option, or explicit environment), and `pinEqual`.
- The default tip source is the product repo root (`repoRoot`); an external tip path or SHA requires an explicit option or environment value. A tip-path audit records the source and resolved SHA before MISS work begins.
- Generated `out-*` directories are local evidence sinks and are not committed. Their contents cannot become runtime Memory by being present on disk.
- An empty tip, missing SHA, or `pinEqual=false` is a failed verification. **空 tip 不是 PASS（an empty tip is not PASS）.**

### 5. Governance, live use, and accounting

`CANDIDATE` always stops at the human PR gate. A reviewer checks the DGR, source evidence, fixed tip, hard gate invariants, tests, and diff before deciding whether any product change may merge. `EXPERIENCE` never means adopted policy. Live calls are explicit opt-in and remain separate from core evidence; the default knife and core checks make zero live requests and keep Main OpenRouter at 0×.

### 6. Security boundary

Agent Harness owns the fail-closed hard gate, Runtime Safety Monitor, approvals, PolicyLease, ExecutorPort, and Memory. Harness² has no bypass API（application programming interface，应用程序接口）, cannot grant executor privilege, cannot inject an approval, and cannot mutate runtime policy or Memory. Any future live adapter must still enter through the same Agent Harness gate; a successful off-loop DGR cannot weaken it.

## Consequences

- Harness² can be tested, audited, and released as a bounded off-loop product without changing runtime behavior or the Agent Harness extraction plan.
- Agent Harness retains one authority for execution, approvals, Memory, and hard-gate semantics; ADR-0024 can continue moving behavior behind `HarnessFacade` without a meta-loop dependency.
- The product must keep the tip/path contract, bounded evidence schema, DGR provenance, and human PR review records current. This maintenance cost is preferable to an implicit policy or permission bridge.
- The boundary does not make EXPERIENCE a learning system. Any adoption remains a separate, reviewed product change with its own ADR and tests.

## Alternatives rejected

1. **Embed Harness² in `runtime/`.** Rejected because it would mix evidence generation with execution authority and make a MISS path capable of influencing the hard gate.
2. **Rename the product to `packages/harness2`.** Rejected because Harness² is an off-loop product surface, while `packages/harness-core` and `packages/harness-model` are Agent Harness architecture packages with different ownership and dependency rules.
3. **Register EXPERIENCE as runtime Memory.** Rejected because reusable evidence is not an adopted policy; doing so would bypass the human PR gate and Memory governance.
4. **Bulk-import the drive or historical out-* tree.** Rejected because evidence must stay bounded, traceable to a tip and source run, and free of generated output and secrets.

## Verification

- Read the [Agent Harness design](../AGENT_HARNESS_DESIGN.md) for the runtime safety, approval, Memory, and executor boundaries, and [ADR-0024](0024-harness-facade-and-package-split.md) for the facade/package dependency direction.
- Run `node --test offloop/test/harness2-meta-vs-agent-harness-adr-r1.test.mjs` through the core-only `npm --prefix offloop test` allowlist. The test checks the directory boundary, the MISS gate, the docs-only cross-link, the fixed non-empty pin `2258685ce9793639ebc9698c8961dcedccf6e49b`, and the empty-tip rule. `CLI（command-line interface，命令行接口）` invocation is the documented check surface.
- Verify the product branch retains the fixed tip as an ancestor and that the knife diff contains only this ADR, ADR index/cross-links, the docs assertion, and its allowlist entry. No runtime, harness package behavior, wave14, tip rewrite, online self-modification, auto-merge, or push is part of this decision.

This knife is docs-only: it records architecture and audit contracts without changing product behavior.

Status remains **Proposed** until architecture review accepts this boundary.
