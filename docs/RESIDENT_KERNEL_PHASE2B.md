# Resident kernel Phase-2b: crash journal + OS sandbox + code cells

Status: implemented, **default OFF**. Linux CLI = OS-sandboxed cells; Windows
`windows-cli` = optional unsandboxed cells (Prime-aligned follow-on). Frozen
design: [`dda-prime-phase2b-design.md`](../../dda-prime-phase2b-design.md)
(FROZEN F1–F12 + §5b–§5aj wins) + Windows amendment in
[`RESIDENT_KERNEL_PHASE2_DESIGN.md`](./RESIDENT_KERNEL_PHASE2_DESIGN.md).

## Enable (Linux — OS sandbox)

All of these must hold for Linux cells; otherwise `kernel.exec` is not registered and
`kernel.cells_unavailable` is emitted:

| Variable | Value | Default |
|---|---|---|
| `DDA_RESIDENT_KERNEL` | `1` | off |
| `DDA_PLATFORM` | `linux-cli` | – |
| `DDA_KERNEL_CODE_CELLS` | `1` | off |
| `DDA_KERNEL_SANDBOX` | `1` | off |
| journal path writable | `--kernel-effect-journal` / `DDA_KERNEL_EFFECT_JOURNAL` or runtime store `kernel-effect-journal.json` | store path |
| native addon | `runtime/native/kernel-sandbox` built (`node-gyp rebuild`) | – |
| `/usr/bin/bwrap` | required for MVP (Landlock fallback is fail-closed/`LANDLOCK_INCOMPLETE` until fully implemented) | – |

Optional:

| Variable | Meaning | Default |
|---|---|---|
| `DDA_KERNEL_CELL_TIMEOUT_MS` | compute-only cell timeout (pauses during `host.request`) | `30000` |
| `DDA_KERNEL_SANDBOX_OP_WORKER` | sandbox the Phase-1 op worker (F10) | **off** until mount denylist walk is ready |
| `DDA_KERNEL_EFFECTS` | Phase-2a write kinds; **may be empty** while cells run pure compute + Phase-1 readonly bridge | empty |

Write-class `host.request` kinds still need the full Phase-2a effects gate
(`DDA_KERNEL_EFFECTS` + CONTROLLED + lease). Empty effects ⇒ pure compute +
readonly bridge only (`KERNEL_READ_OPS` + optional `host.ping` /
`host.capabilities`).

## Enable (Windows — unsandboxed, Prime-aligned)

Native Windows has **no** bwrap / Job Object / AppContainer path in this release.
Cells may still run under user permissions when every gate below holds. This is
**not a security sandbox**; Node `vm` is also not a security boundary. Prefer
Linux + bwrap when isolation matters.

| Variable | Value | Default |
|---|---|---|
| `DDA_RESIDENT_KERNEL` | `1` | off |
| `DDA_PLATFORM` | `windows-cli` (**reuse**; not folded into `PORTABLE_CLI_PLATFORMS` / `isLinuxCliPlatform`) | – |
| OS | `win32` (paired with identity; mismatch → `PLATFORM_IDENTITY_MISMATCH`) | – |
| `DDA_KERNEL_CODE_CELLS` | `1` | off |
| `DDA_KERNEL_WINDOWS_UNSANDBOXED` | `1` (explicit confirm; CODE_CELLS alone is not enough) | off |
| `DDA_KERNEL_SANDBOX` | must be **unset/off** — truthy → `SANDBOX_UNSUPPORTED_ON_WINDOWS` | off |
| journal path writable | same as Linux | store path |

`windows-cli` stays out of `PORTABLE_CLI_PLATFORMS`. `sandbox.available` stays
**false**; success reason is `WINDOWS_NO_OS_SANDBOX`.

### Amendment: windows-desktop cells

`win32` × `windows-desktop` is a separate cells arm (not a CLI flag reuse).
`codeCellsAvailability` checks that arm **before** `CODE_CELLS_DISABLED`, and only
for that pair: unset `DDA_PLATFORM` stays on the generic path, and
`linux` × explicit `windows-desktop` does not fall through to bwrap.
Desktop success still reports `WINDOWS_NO_OS_SANDBOX` with `sandbox.available`
false. Resident attach for `win32` × `windows-desktop` needs
`DDA_RESIDENT_KERNEL` and Node ≥ 24 only; it does not read cells flags.
Per-invoke desktop spawns return `DESKTOP_SESSION_KEEP_REQUIRED` and do not
start a worker. This round does not add an always-on resident process.

Journal defaults, when the platform is `windows-cli` or `windows-desktop` and
no explicit journal path is set, are
`%LOCALAPPDATA%\hmCodex\journal\<identity>\kernel-effect-journal.json` plus
`kernel-session.json` in that same directory. There is no fallback to
`hmCodex\kernel-effect-journal.json`. Legacy root migration runs only for
`windows-cli` and rewrites `STARTED` to `UNKNOWN`. Desktop does not migrate it.

A Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` may reap an
already-living session-keep runtime. It is not a sandbox. If the job cannot be
created, cancel still uses `taskkill /T`. Tool copy for desktop cells is its
own branch (`windows-desktop` / `DDA_KERNEL_WINDOWS_DESKTOP_CELLS`) and does not
overwrite the `windows-cli` description.
(callers key off boolean `available`). Phase-2a write effects stay refused on
Windows. Phase-1 read kernel tools register the same surface as Linux (readonly
bridge). Worker entrypoint is separate (`cell-worker-windows.mjs`); protocol
`ready` only — no FS/net/exec canary.

## What landed

1. **Crash / lifecycle journal** (`runtime/src/kernel/effect-journal.mjs`)
   - Host-owned; ≠ audit JSONL; ≠ SessionState (empty body uses `journalSchema` /
     `effects` / `uncertainClears` only).
   - States `REQUESTED → … → STARTED → COMPLETED|FAILED|UNKNOWN`.
   - ALS bit (`journal-als.mjs`) entered before `invokeTool`; `STARTED` fsync is
     the last successful `onLeaseStarted` step; `COMPLETED`/`FAILED` after scope
     checks; restart rehydrates `STARTED` → `UNKNOWN` and arms uncertain.
2. **OS sandbox** (`runtime/src/kernel/sandbox.mjs` + `runtime/native/kernel-sandbox/`)
   - bwrap preferred (`--unshare-all`, no whole-workspace ro-bind, `--seccomp` with
     raw `sock_filter[]` from shared C builder via N-API `emitStage1Filter`).
   - Stage-2 via `--require require-shim.cjs` → `require(.node)` → sync
     `installFromHandoff()` (NO_NEW_PRIVS + seccomp TSYNC; deny socket/socketpair/
     connect/io_uring_*/execve/execveat with `SECCOMP_RET_ERRNO`).
   - Real canary; unlock only on cell-protocol `ready` (no Phase-1 pending ring,
     no exit-0 unlock).
3. **Node vm code cells** (`kernel.exec`)
   - Persistent vm context; host-authoritative epoch (16-byte CSPRNG → 32-char
     lowercase hex); reject frames from dead cells before any dispatch (incl.
     readonly bridge).
   - Side effects via existing Phase-2a dispatcher + per-effect #15 approval.
4. **F6**: batch business caps (`maxItems` / `maxBytes` / `perRound`) removed;
   transport ceilings (`KERNEL_MAX_MESSAGE_BYTES` 2MB, payload string 1MB) kept.
   `kernel.exec` is exempt from the 32KB tool-arg cap only (hard top = cell frame).

## Manual smoke

```bash
cd runtime/native/kernel-sandbox && npm run build   # needs Node >=24 headers
cd ../../
DDA_RESIDENT_KERNEL=1 DDA_PLATFORM=linux-cli \
DDA_KERNEL_CODE_CELLS=1 DDA_KERNEL_SANDBOX=1 \
node --test test/kernel-phase2b-*.test.mjs
```

## Deferred / partial vs freeze

- Full Landlock ABI3 C launcher with private-root allow-list FS rules: **not
  claimed available**. Missing bwrap ⇒ `LANDLOCK_INCOMPLETE` / cells stay off
  (fail-closed; no half-sandbox). Stage-2 N-API path remains for the bwrap worker.
- CoordinatorPath (A)/(B) full PJS plant+hold for every excluded body under a
  live run lock window: required-path validation + mode A (skip coordinator)
  are implemented; production plant still uses private-tmp sentinels plus
  absolute deny paths. Deny-write canary no longer treats ENOENT as pass.
- Journal on-disk transitions currently persist `REQUESTED → STARTED →
  COMPLETED|FAILED|UNKNOWN`. Intermediate `GATED` / `APPROVED` / `LEASED`
  disk states are **Deferred** (schema allows them; wiring not yet fsynced).
  `recordRequested` is fail-closed when the journal is enabled (same as STARTED).
- Cell `host.request` writes journal with `JOURNAL_BITS.CELL` (overrides the
  host dispatcher default `KERNEL` bit).
- Committed `runtime/native/kernel-sandbox/build/Release/dda_kernel_sandbox.node`
  is a linux-x64 prebuild for the CI/Node ABI it was built with; rebuild with
  `npm run build:kernel-sandbox` (Node >=24) when the ABI drifts.
- F9 digest unification is applied on the model `kernel.host_request` path and
  batch digest; cell path reuses the same dispatcher digests when effects run.
- `DDA_KERNEL_SANDBOX_OP_WORKER` remains default off (F10).
