# Jev speed MVP (implemented, default OFF)

Goal: lower wall-clock time and model cost in `--agent-mode multi` without
adding human approvals. All flags are default OFF and fail closed to today's
behavior. `DDA_JEV_BATCH_VERIFY` is intentionally **not** implemented yet (its
#16 anti-false-trigger contract is not frozen).

Like every `DDA_JEV_*` variable, setting one of these flags counts as
configuring the decision plane; Jev still only runs with its credential.

## 1. Measurement (always on, additive output only)

`result.decisionLayer.metrics`:

- `jev.byKind.<KIND>`: `decisions`, `requests`, `requestErrors`, `fallbacks`,
  `shortCircuits` (+ `shortCircuitReasons`), `latency.{totalMs,maxMs,p50Ms,p95Ms}`.
  Kinds: `ACTION_GATE`, `VERIFY_BEHAVIOR`, `DECISION_LAYER`, and candidate
  decisions by action kind (`CLASSIFY_TASK`, `SELECT_ROUTE`, `SELECT_TOPOLOGY`,
  `SELECT_PLAN_TIER`, `REVIEW_PLAN`, ...).
- `stages.<name>.{count,totalMs,maxMs}`: `planTier`, `planner`, `council`,
  `execution`, `verification`, `verifyBehavior`, `decisionLayer`, `recovery`.
- `planTier` when `DDA_JEV_PLAN_TIER_ENABLED` is set.

No decision, event, or approval changes when flags are off.

## 2. `DDA_JEV_READONLY_FAST_PATH=1`

Deterministic `ALLOW` (`source: rule`, `reasonCode: READONLY_FAST_PATH`) with
no Jev request and no Jev-only evidence collection, only when **all** hold:

- tool is exactly one of `workspace.list|read|focus`,
  `kernel.workspace_list|read|focus`, registered and flagged read-only;
- `path` absent/empty (workspace root) or relative without `..`, drive, UNC,
  `~`, absolute prefix; no `cwd`; the proposal claim has no
  `OUTSIDE_OR_OPAQUE` path/cwd class;
- the hard READ_ONLY BLOCK did not already apply (it is evaluated first).

Still gated by Jev: `kernel.session_*`, `kernel.host_request`, every side-effect
tool, non-allowlisted read-only tools, absolute/opaque paths. #15
`REQUIRE_APPROVAL` is untouched because it only applies to genuine Jev opinions
on gated calls. Trace: `SELECT_TOOL_ACTION` decision with reason
`READONLY_FAST_PATH`, selection criterion `readonly-fast-path-rule`, and a
`jev.action_gate_skipped` runtime event.

## 3. `DDA_JEV_PLAN_TIER_ENABLED=1` (multi only)

New decision `SELECT_PLAN_TIER` **before** the planner turn:

| tier | planner | council |
|---|---|---|
| `DIRECT` | runs | skipped |
| `PLAN` | runs | skipped |
| `PLAN_COUNCIL` | runs | existing heuristic (steps > 2 or modify/test) |

DIRECT does not skip the planner (not specified yet), so DIRECT and PLAN have
the same effect today. A tier can only remove council turns, never add them.
Host filter: CONTROLLED + modify/test never offers `DIRECT`.

Inert (today's behavior, reason in `metrics.planTier.reasonCode`) when: flag
off, single mode, Jev disabled, resumed plan (`PLAN_TIER_RESUMED_PLAN`), or
`DDA_JEV_TOPOLOGY_ENABLED` is also on (`PLAN_TIER_TOPOLOGY_EXCLUSIVE`; the
post-planner topology decision wins). Jev timeout/error/unknown choice keeps
the existing heuristic.

## Preserved

#15 mid-task approval, #16 verifier re-approval, Phase 1.5 CONTROLLED, READ_ONLY
hard block, resident kernel semantics, `DDA_*` env names.

## Incidental fix

`SELECT_TOPOLOGY` options referenced an evidence id that was never attached to
the decision, so a real Jev topology answer failed the run with
`DECISION_EVIDENCE_NOT_FOUND`. Options now carry no evidence refs (same as the
other candidate decisions).
