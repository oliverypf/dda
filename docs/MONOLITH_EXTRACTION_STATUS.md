# Monolith Extraction Status — honest ledger

Version: v0.1 (architecture split **starter**)
Related: [ADR-0024](adr/0024-harness-facade-and-package-split.md), [MULTI_PLATFORM_ARCHITECTURE](MULTI_PLATFORM_ARCHITECTURE.md), [LINUX_CLI_CONTRACT](LINUX_CLI_CONTRACT.md)

This document exists so nobody over-reads the architecture split. It states
plainly what has been extracted from the monolithic `runtime/src/index.mjs`
(~6,700 lines) and what has **not**.

## TL;DR

The split is a *starter*. We established the stable entry surface
(`HarnessFacade`) and the shared model package, and physically moved exactly one
thing out of the monolith (the version vocabulary). **Essentially all runtime
behaviour still lives in `runtime/src/index.mjs`.**

## What exists now

| Package | Status | Contents |
| --- | --- | --- |
| `packages/harness-model` | New, standalone, tested | Version constants (canonical source), CLI exit-code table + fail-closed mapper, `runtime_event` kind vocabulary + envelope/terminal-state helpers. Zero dependencies, zero platform code. |
| `packages/harness-core` | New, tested | `HarnessFacade`: stable entry surface for shells. Drives the runtime as a supervised child process today. |

## Extracted from the monolith

- **Version vocabulary only.** `HARNESS_PROTOCOL_VERSION`, `HARNESS_STORAGE_SCHEMA_VERSION`, `HARNESS_APP_VERSION`, `HARNESS_PRODUCER_VERSION`, `HARNESS_POLICY_VERSION` now live in `@dda/harness-model`.
  - `runtime/src/harness-event-store.mjs` re-exports them (unchanged public API).
  - `runtime/src/index.mjs` imports them directly from `@dda/harness-model`, so the monolith now depends on the extracted package.
  - Values are byte-for-byte identical; stored events, migrations and release manifests are unaffected.

## NOT extracted — still monolithic in `runtime/src/index.mjs`

All of the following remain in the monolith and are only reachable via the
subprocess CLI:

- argv parsing and the top-level command dispatch (`task`, `thread`, `health`, `recovery`, `tools`, `dashboard`, diagnostics, plugin/evolution/dream/read-model/harness-events, …);
- the entire task run pipeline: classification, safety precheck, routing, role binding, context assembly, candidate fanout, verification, recovery;
- **Approval fail-closed** handling, **Phase 1.5** release/controlled gating, and the **Jev opt-in + `RULE_FALLBACK`** decision wiring — these were intentionally left untouched by the split;
- Runtime Safety, PolicyLease, Rule Verifier, Memory Journal, Decision Trace, event store orchestration;
- the `emitEvent` / `runtime_event` producer (the vocabulary is shared via `harness-model`, but the emitter is still in the monolith).

## Known seams / debts introduced by the starter

- `HarnessFacade` spawns `node runtime/src/index.mjs`; it does not call runtime code in-process. This is deliberate (the monolith runs its CLI at import time and exports nothing) and is the migration lever: as logic lands in `harness-core`, methods switch from spawn to in-process **without changing the facade surface**.
- Cross-package and runtime→package imports use **relative paths** (`../../packages/harness-model/src/...`). No repo-level npm workspace is wired yet.
- No build step: everything is plain Node 24 ESM `.mjs`.

## HarmonyOS

`entry/` still connects to the **cancelled remote App Server** via
`AppServerWebSocketTransport.ets` / `CodexSession.ets` (the `CodexTransport`
abstraction). This starter does **not** rewrite ArkUI. The documented path toward
the shared harness is in [HARMONYOS_PLATFORM.md §14](HARMONYOS_PLATFORM.md). No
HarmonyOS code was changed.

## Next steps (not done here)

1. Scaffold `linux-cli/` as the first real consumer of `HarnessFacade`.
2. Extract a first pure behaviour slice (e.g. argv/options parsing or the
   `runtime_event` emitter) from the monolith into `harness-core`, keeping the
   facade surface stable.
3. Introduce a repo-level workspace so packages resolve by name instead of by
   relative path.
4. For HarmonyOS, implement a `HarnessFacade`-backed `CodexTransport` once the
   shared-harness boundary is stable (see ADR-0024 and HARMONYOS_PLATFORM §14).

## Verification baseline

On Node 24, `runtime` tests report **685 pass / 5 fail** both before and after
this change. The 5 failures are pre-existing and unrelated (Windows-specific
config/sidecar paths, a model-request task, and a `workspace.focus` tool-list
expectation). The split added **no new failures**. The two new packages are fully
green.
