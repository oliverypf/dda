# Resident kernel Phase-2b: crash journal + OS sandbox + code cells

Status: implemented, **default OFF**, Linux CLI only. Frozen design:
[`dda-prime-phase2b-design.md`](../../dda-prime-phase2b-design.md) (FROZEN F1–F12 + §5b–§5aj wins).

## Enable

All of these must hold for cells; otherwise `kernel.exec` is not registered and
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
- CoordinatorPath (A)/(B) plant rules and full PJS plant+hold serialization for
  every excluded body during canary: required-path validation + mode A (skip
  coordinator) are implemented; production plant+hold for every PJS body under
  a live run lock window is best-effort (canary probes private-tmp sentinels +
  absolute deny paths).
- F9 digest unification is applied on the model `kernel.host_request` path and
  batch digest; cell path reuses the same dispatcher digests when effects run.
- `DDA_KERNEL_SANDBOX_OP_WORKER` remains default off (F10).
