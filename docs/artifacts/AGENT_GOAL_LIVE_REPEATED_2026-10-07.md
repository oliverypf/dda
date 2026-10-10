# Fixed task comparison: actual Codex CLI and hmCodex

Batch: 20261007T053637569Z-a09bbc8c
Codex: codex-cli 0.155.1
History: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\history.jsonl

Mode: live; model: mimo-v2.6-pro

| Condition | Success | Recovery | Tokens | Actual provider cost | Tool rounds | Wall ms |
|---|---:|---:|---:|---:|---:|---:|
| ordinary-codex | 5/6 | 1/2 | 108620 | UNKNOWN | 7 | 97250 |
| hmcodex-runtime | 6/6 | 2/2 | 27286 | UNKNOWN | 10 | 152228 |

- Both real clients execute real tools against independent identical initial workspaces. Ordinary Codex is the installed CLI, not a provider-only substitute.
- Both clients use the configured actual upstream model through the same protocol adapter. Missing usage or billing stays UNKNOWN.
- Actual provider billing is not reported. Price estimates require explicit per-million rates and assume uncached input. No humans are connected to this headless experiment.
- Plugins are disabled in the Codex control to keep external plugin/network work outside the fixed tasks. Both clients use read-only workspaces.
- The current fixed tasks cover inspection and recovery. Coding tasks, larger samples and actual billing/manual-time evidence remain required for product ROI claims.

Raw evidence: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\20261007T053637569Z-a09bbc8c
