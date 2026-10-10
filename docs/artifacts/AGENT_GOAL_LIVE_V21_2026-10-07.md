# Fixed task comparison: actual Codex CLI and hmCodex

Batch: 20261007T054317201Z-48e773ed
Codex: codex-cli 0.155.1
History: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\history.jsonl

Mode: live; model: mimo-v2.6-pro

| Condition | Success | Recovery | Tokens | Actual provider cost | Tool rounds | Wall ms |
|---|---:|---:|---:|---:|---:|---:|
| ordinary-codex | 6/6 | 2/2 | 116941 | UNKNOWN | 8 | 108529 |
| hmcodex-runtime | 4/6 | 0/2 | 30472 | UNKNOWN | 12 | 150796 |

- Both real clients execute real tools against independent identical initial workspaces. Ordinary Codex is the installed CLI, not a provider-only substitute.
- Both clients use the configured actual upstream model through the same protocol adapter. Missing usage or billing stays UNKNOWN.
- Actual provider billing is not reported. Price estimates require explicit per-million rates and assume uncached input. No humans are connected to this headless experiment.
- Plugins are disabled in the Codex control to keep external plugin/network work outside the fixed tasks. Both clients use read-only workspaces.
- The current fixed tasks cover inspection and recovery. Coding tasks, larger samples and actual billing/manual-time evidence remain required for product ROI claims.

Raw evidence: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\20261007T054317201Z-48e773ed
