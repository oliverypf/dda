# Fixed task comparison: actual Codex CLI and hmCodex

Batch: 20261007T061813285Z-153564a1
Codex: codex-cli 0.155.1
History: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\history.jsonl

Mode: fixture; model: evidence-fixture

| Condition | Success | Recovery | Tokens | Actual provider cost | Tool rounds | Wall ms |
|---|---:|---:|---:|---:|---:|---:|
| ordinary-codex | 1/1 | 1/1 | 96 | 0 | 3 | 139579 |
| hmcodex-runtime | 0/1 | 0/1 | 144 | 0 | 4 | 14961 |

- Both real clients execute real tools against independent identical initial workspaces. Ordinary Codex is the installed CLI, not a provider-only substitute.
- The model and token usage are deterministic local fixtures; this validates the experiment, not production savings.
- Provider cost is zero only because no external inference is used; local compute is excluded.
- Plugins are disabled in the Codex control to keep external plugin/network work outside the fixed tasks. Both clients use read-only workspaces.
- The current fixed tasks cover inspection and recovery. Coding tasks, larger samples and actual billing/manual-time evidence remain required for product ROI claims.

Raw evidence: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\20261007T061813285Z-153564a1
