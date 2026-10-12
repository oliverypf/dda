# Resident kernel Phase-2a: host-executed side effects via `kernel.host_request`

Status: implemented, **default OFF**, Linux CLI only. Frozen design:
[`RESIDENT_KERNEL_PHASE2_DESIGN.md`](./RESIDENT_KERNEL_PHASE2_DESIGN.md) (FROZEN section wins).

## Enable

All of these must hold (FROZEN #8); otherwise effects stay off with a stable reason
(`EFFECTS_DISABLED`, `KERNEL_NOT_ATTACHED`, `NON_LINUX_PLATFORM_IDENTITY`, `NOT_CONTROLLED`,
`LEASE_NOT_GRANTED`) reported in the `kernel.effects` runtime event:

| Variable | Value | Default |
|---|---|---|
| `DDA_RESIDENT_KERNEL` | `1` | off |
| `DDA_PLATFORM` | `linux-cli` | – |
| `DDA_KERNEL_EFFECTS` | comma list of `fs.write`, `fs.patch`, `test.run` (`shell.exec` / `net.fetch` are refused) | empty |
| `--execution-mode CONTROLLED` + `--lease-capabilities file.write[,test.execute]` (+ `--lease-commands` for tests) | | |
| `DDA_KERNEL_APPROVAL` | `host-policy-audit` (alias `host-policy`) or `per-request`; unknown values fail closed to `per-request` | `host-policy-audit` |
| `DDA_KERNEL_WRITE_BATCH` | `1` enables `fs.write_batch` | off |
| `DDA_KERNEL_EFFECT_AUDIT` / `--kernel-effect-audit` | audit JSONL path | runtime store `kernel-effect-audit.jsonl` |
| `DDA_KERNEL_EFFECT_DENYLIST` / `--kernel-effect-denylist` | denylist JSON path | runtime store `kernel-effect-denylist.json` |

## Behavior

- **Host executes, worker never does.** `kernel.host_request{kind,payload}` for an effect kind is
  handled by the host dispatcher (`runtime/src/kernel/effects.mjs`), which invokes the existing
  discrete executor tool (`file.write` / `file.patch` / `test.execute`) through the registry's
  host-only path. Same lease provider, `assessRequestRisk`, `gateDecisionFor`, unchanged
  `resolveApprovalOutcome`, ExecutionStateStore intents/approvals/leases and git audit.
  Inert probes (`host.ping`, `host.capabilities`) and Phase-1 aliases still go to the worker.
- **Tool surface (FROZEN #4).** Whenever `DDA_KERNEL_EFFECTS` is set, every discrete side-effect
  tool (`file.write`, `file.patch`, `shell.execute`, `test.execute`, `network.request`, and any
  other non-read-only non-kernel tool) is hidden for the whole run: not advertised and
  `TOOL_NOT_FOUND` if called. If the kernel is unavailable/lost, only read-only tools remain.
  With effects available, `kernel.host_request` is registered as a side-effect tool
  (`readOnly:false`), so READ_ONLY never sees it as read-only and the Jev read-only fast path
  never applies to it.
- **Gate sees the unwrapped effect (§3.2).** The ACTION_GATE claim/summary for
  `kernel.host_request` is built from the payload as if it were the equivalent discrete tool
  (`file.write` / `file.patch` / `test.execute`); the gate decision is still keyed by the outer
  tool-call id / argument digest.
- **No live approver (FROZEN #2).** AUTO-approve only where master already would
  (pre-leased, non-dangerous, no Jev `REQUIRE_APPROVAL`, no #16). Refused without a live approver:
  dangerous (`assessRequestRisk`), Jev `REQUIRE_APPROVAL`, missing lease / not CONTROLLED,
  READ_ONLY, `per-request` policy, a denylist hit, an armed uncertain kernel outcome.
  The dispatcher can only add `requireApproval` (via `context.kernelEffect.requireApproval`);
  it never removes one.
- **Denylist** key `(executionMode, effectKind, riskClass)` with
  `riskClass ∈ {workspace_write, secret_path, outside_workspace, test_command, dangerous_cmd}`.
  Host-owned file outside the workspace (excluded from workspace reads), never in
  `session_state`; carries a sha256 digest over its canonical entries. Digest mismatch ⇒ every
  key denied (fail closed). There is no remove API; `runtime/scripts/kernel-effect-denylist.mjs`
  can `add` / `list` / `verify`; clearing = deleting the file (explicit operator action).
  The runtime itself adds a key when an AUTO-approved effect ends with an unknown outcome.
- **Audit.** Every effect appends `REQUESTED` then `COMPLETED|FAILED|UNKNOWN|REFUSED` JSONL
  records (key, risk class, approval path `AUTO_HOST_POLICY|LIVE_APPROVAL|LIVE_BATCH_APPROVAL|REFUSED*`,
  args/result digests, lease id when the executor reports one). If the `REQUESTED` record cannot
  be written the effect is refused (`KERNEL_EFFECT_AUDIT_UNAVAILABLE`).
- **#16 and uncertain outcomes (FROZEN #6).** #16 is untouched: armed on verifier
  `UNCERTAIN|STALLED`, cleared only by a clean `PASS` (the dispatcher never clears it).
  Separately, an effect whose result is `UNKNOWN` / timed out / aborted, or a bridge
  `KERNEL_TIMEOUT` / `KERNEL_OUTCOME_UNCERTAIN`, is never replayed and arms
  "next effect needs an individual live approval" (refused if nobody can answer). A
  live-approved, observed effect discharges that additive flag only.
- **Leases and batches (FROZEN #3/#5).** One one-shot lease per effect. `fs.write_batch`
  (needs `DDA_KERNEL_WRITE_BATCH=1`): ≤10 items, ≤256 KB, one batch per model round; patch items
  are resolved to concrete writes up front (base digest checked); every item is risk/denylist/
  lease pre-admitted before anything runs. No live approver: all items must qualify for AUTO,
  else the whole batch is refused (nothing written). Live approver: one batch card
  (`approval.requested` with `kernelBatch.items`, `displayedDigest` = batch digest) covers exactly
  those items (path + content digest, 120 s TTL, voided by #16 or an uncertain outcome); each item
  still gets its own intent/approval record and lease. First failure stops: committed prefix is
  reported, the rest `SKIPPED`, **no rollback**.

## Not in this PR (honest scope)

- `shell.exec` / `net.fetch` (refused), code cells / OS sandbox (Phase-2b).
- Design §5 crash journal states (`GATED/LEASED/STARTED…`), `SessionState.pendingOutcomes`
  injection into the context and the read-only `LIKELY_APPLIED/NOT_APPLIED/DIVERGED` re-check.
  Host-process crashes still rely on the existing ExecutionStateStore UNKNOWN handling.
- Batch invalidation on a workspace snapshot-digest change between approval and execution
  (per-item `expectedDigest` stale checks still apply).
- `jev-metrics` `hostRequest.*` / `batch.*` counters (runtime events only for now).
- `dda health` display of effects availability, and an `--approval-mode deny` switch (does not
  exist on master; `per-request` without a live approver refuses everything).
- A batch card creates one extra intent/approval record that is approved but never leased.
