# Fixed task comparison: actual Codex CLI and hmCodex

Batch: 20261007T053743971Z-18f33b47
Codex: codex-cli 0.155.1
History: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\history.jsonl

Mode: fixture; model: evidence-fixture

| Condition | Success | Recovery | Tokens | Actual provider cost | Tool rounds | Wall ms |
|---|---:|---:|---:|---:|---:|---:|
| ordinary-codex | 3/3 | 1/1 | 168 | 0 | 4 | 10978 |
| hmcodex-runtime | 3/3 | 1/1 | 216 | 0 | 5 | 15061 |

- Both real clients execute real tools against independent identical initial workspaces. Ordinary Codex is the installed CLI, not a provider-only substitute.
- The model and token usage are deterministic local fixtures; this validates the experiment, not production savings.
- Provider cost is zero only because no external inference is used; local compute is excluded.
- Plugins are disabled in the Codex control to keep external plugin/network work outside the fixed tasks. Both clients use read-only workspaces.
- The current fixed tasks cover inspection and recovery. Coding tasks, larger samples and actual billing/manual-time evidence remain required for product ROI claims.

Raw evidence: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\20261007T053743971Z-18f33b47
