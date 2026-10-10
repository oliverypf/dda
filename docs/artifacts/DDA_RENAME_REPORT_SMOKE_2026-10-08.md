# Fixed task single-client diagnostic

Batch: 20261008T010725944Z-4454450d
Codex: codex-cli 0.155.1
History: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\history.jsonl

Mode: fixture; model: evidence-fixture; decision: OFF

| Condition | Success | Recovery | Tokens | Actual charge | Priced usage / basis | Human active min | Tool rounds | Wall ms |
|---|---:|---:|---:|---:|---|---:|---:|---:|
| dda | 1/1 | 0/0 | 48 | 0 | 0 / LOCAL_FIXTURE | 0 | 1 | 8555 |

- This is a single-client diagnostic, not a paired comparison. Other batches cannot supply its control condition.
- The model and token usage are deterministic local fixtures; this validates the experiment, not production savings.
- Jev is explicitly disabled for this same-model client comparison.
- Provider cost is zero only because no external inference is used; local compute is excluded.
- No humans are connected to this headless run; zero intervention time does not prove human time savings.
- Plugins are disabled in the Codex control. Inspection is read-only; engineering tasks permit workspace edits with approved file/test capabilities. Both clients start from identical independent workspaces.
- Fixed engineering tasks use independent behavior assertions, syntax and test commands, and immutable test-file checks. Larger samples and actual billing/manual-time evidence remain required for product ROI claims.

Raw evidence: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\20261008T010725944Z-4454450d
