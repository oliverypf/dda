# Prime-style Resident Kernel — Phase-1 MVP Design

Status: Phase-1 MVP (read-only). Feature default **OFF**. Linux-only.
Scope owner: `runtime/src/kernel/`. Base: `master` (268d4d6+).

## 1. Goal

Introduce a **Prime-style resident kernel**: a per-session Node (>=24) subprocess
that becomes the model's primary tool surface. The kernel runs ops in one
long-lived, isolated process instead of re-entering the host for every discrete
tool call. Phase-1 delivers the end-to-end skeleton with a strictly read-only
capability set so the architecture can land without widening the side-effect
attack surface.

This document records the frozen MVP decisions and how the code implements them.
No uploaded design doc was supplied for this run; the frozen decisions below are
the authority.

## 2. Frozen MVP decisions

- Node >=24 resident kernel subprocess is the primary model tool surface.
- `workspace.list` / `workspace.read` / `workspace.focus` remain registered as a
  read-only **fallback** surface alongside the kernel.
- The kernel is **per-session**. On crash, the host rebuilds it from durable
  `SessionState`; it **never auto-replays side effects**.
- **Phase-1 is read-only only**: read kernel ops plus session-state read/write.
  No write / shell / network / test side effects (those are Phase-2).
- Feature default **OFF**; **Linux-only** for the MVP; if the sandbox is
  unavailable, callers **fall back to the discrete read-only tools**.
- A `host_request` bridge stub exists for future side effects but **must refuse
  side-effect requests in Phase-1**.
- Existing guarantees are preserved unchanged: approval fail-closed (#15/#16),
  Phase 1.5 side-effect gating, and Jev opt-in. The kernel is additive and
  read-only; it does not touch those paths.

## 3. Architecture

All modules live under `runtime/src/kernel/`.

| Module | Responsibility |
| --- | --- |
| `protocol.mjs` | Dependency-free wire protocol: newline-delimited JSON framing, the operation set, op classification (read / session-write / bridge / replay-safe), `host_request` kind tables, and the `KERNEL_*` error vocabulary. |
| `kernel-worker.mjs` | The resident subprocess. Serves read-only workspace inspection, an in-memory session-state mirror, and the `host_request` stub. Never crashes on bad input; answers with structured failures. Holds **no** side-effect capability. |
| `resident-kernel.mjs` | Host-side supervisor `ResidentKernel`: subprocess lifecycle, request/response correlation, timeouts, and the crash-recovery invariants. |
| `session-state.mjs` | `SessionStateStore`: the durable, host-owned, bounded key→JSON record the kernel is rebuilt from. |
| `feature.mjs` | Availability gating: default-off flag, Linux-only sandbox detection, Node>=24 check. |
| `kernel-tools.mjs` | Registers the kernel ops on the provider-neutral `ToolRegistry` as `kernel.*` tools, and `attachResidentKernel()` which wires everything or returns a no-op fallback handle. |

### 3.1 Transport

Host and worker exchange newline-delimited JSON frames over the worker's
stdin/stdout. Each frame is a single JSON object (`request` or `response`) with a
correlating `id`. A hard per-frame byte ceiling (`KERNEL_MAX_MESSAGE_BYTES`,
2 MiB) prevents either side from exhausting memory on untrusted model output.

### 3.2 Operation surface (Phase-1)

Read ops (pure, deterministic): `workspace.list`, `workspace.read`,
`workspace.focus`, `session_state.get`, `session_state.list`.

Session writes (host-owned metadata, **not** a workspace side effect):
`session_state.set`, `session_state.delete`.

Bridge: `host_request` — answers only inert probes (`host.ping`,
`host.capabilities`) and refuses every side-effecting kind (and any unknown kind,
fail-closed) with `KERNEL_SIDE_EFFECT_REFUSED`.

Model-facing tool names: `kernel.workspace_list`, `kernel.workspace_read`,
`kernel.workspace_focus`, `kernel.session_get`, `kernel.session_list`,
`kernel.session_set`, `kernel.session_delete`, `kernel.host_request`. Every one
is `readOnly: true` at the registry boundary.

### 3.3 Crash recovery invariants

The two freeze invariants are enforced by the supervisor:

1. **Rebuild from durable SessionState.** `SessionStateStore` is the authority.
   A session write is persisted durably *before* the worker ever sees it. On a
   worker crash the supervisor reloads the durable store, re-spawns the worker,
   and re-initializes it from the durable snapshot, so committed session state is
   never lost.
2. **Never auto-replay side effects.** Only replay-safe ops (pure reads and
   already-persisted, idempotent session writes) are transparently retried after
   a rebuild. A `host_request` in flight at crash time is **not** retried; it
   surfaces `KERNEL_OUTCOME_UNCERTAIN`. This keeps the contract correct once
   Phase-2 routes real side effects through the bridge.

### 3.4 Availability and fallback

`residentKernelAvailability(env)` returns `available` only when all hold:
feature enabled (`HMCODEX_RESIDENT_KERNEL` truthy), portable Linux CLI identity
(`HMCODEX_PLATFORM`), Node >=24, and a sandbox. Every failure carries a stable
reason (`DISABLED`, `NODE_TOO_OLD`, `NON_LINUX_PLATFORM_IDENTITY`,
`NON_LINUX_PLATFORM`, ...). When unavailable, `attachResidentKernel()` returns a
no-op handle and the discrete read-only tools remain the surface.

## 4. Host integration

`runtime/src/index.mjs` calls `attachResidentKernel()` immediately after the
discrete read-only workspace tools are registered, **guarded by
`isResidentKernelEnabled(process.env)`** so the default-off path is byte-for-byte
unchanged. The returned handle's `stop()` is invoked in the existing task cleanup
block next to the MCP and Playwright hosts. Attachment emits a `kernel.attached`
or `kernel.unavailable` runtime event with the availability reason.

## 5. Configuration

| Variable / flag | Meaning | Default |
| --- | --- | --- |
| `HMCODEX_RESIDENT_KERNEL` | Enable the resident kernel | off |
| `HMCODEX_RESIDENT_KERNEL_SANDBOX` | Force/disable the sandbox check (testing) | auto |
| `HMCODEX_KERNEL_SESSION_STORE` / `--kernel-session-store` | Durable session-state file | `kernel-session.json` under the data dir |

## 6. Security boundaries preserved

- The kernel subprocess has no executor, no lease provider, and no network
  adapter. It cannot write, run commands, or reach the network.
- Child environment is built with `buildRuntimeEnv`, so provider secrets are not
  forwarded to the worker.
- Workspace reads reuse the hardened `ReadonlyWorkspace` (traversal, sensitive
  path, and binary guards), so the kernel cannot read more than the discrete
  tools could.
- Session keys and values are bounded and validated; durable records are
  digest-checked and rejected if tampered or written for a different session.

## 7. Explicit non-goals (deferred to Phase-2)

- Any write / shell / network / test side effect, and routing approved effects
  through `host_request` and the lease/approval chain.
- OS-level sandboxing (namespaces, seccomp, cgroups). The Phase-1 "sandbox" is
  process-level isolation with a restricted environment and no side-effect
  capability.
- Windows / HarmonyOS kernel hosting.

## 8. Testing

Runs on Node 24. Suites under `runtime/test/`:

- `kernel-protocol.test.mjs` — framing, op classification, error vocabulary.
- `kernel-session-state.test.mjs` — durable R/W, reload, bounds, tamper/foreign-session rejection.
- `kernel-feature.test.mjs` — default-off, Node>=24, Linux-only availability.
- `kernel-resident.test.mjs` — end-to-end ops, side-effect refusal, crash rebuild from durable state, never-replay for the bridge.
- `kernel-tools.test.mjs` — availability gating, fallback coexistence, tool invocation, read-only boundary.
