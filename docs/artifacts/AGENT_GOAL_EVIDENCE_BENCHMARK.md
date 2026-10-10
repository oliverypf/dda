# Fixed task comparison: actual Codex CLI and hmCodex

Batch: 20261007T052220904Z-67c017c1
Codex: codex-cli 0.155.1
History: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\history.jsonl

| Condition | Success | Recovery | Tokens (fixture) | Provider cost (fixture) | Tool rounds | Wall ms |
|---|---:|---:|---:|---:|---:|---:|
| ordinary-codex | 6/6 | 2/2 | 336 | 0 | 8 | 22165 |
| hmcodex-runtime | 6/6 | 2/2 | 432 | 0 | 10 | 30109 |

- Both real clients execute real tools against independent identical initial workspaces. Ordinary Codex is the installed CLI, not a provider-only substitute.
- The model and token usage are deterministic local fixtures. This validates grading and metrics persistence, not production quality, savings or latency improvement.
- Provider cost is zero only because no external inference is used. Local compute is excluded. No humans are connected to this headless experiment.
- Plugins are disabled in the Codex control to keep external plugin/network work outside the fixed tasks. Both clients use read-only workspaces.
- Production coding tasks and real-model comparisons remain required for product advantage evidence.

Raw evidence: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\20261007T052220904Z-67c017c1
