# Fixed task comparison: actual Codex CLI and hmCodex

Batch: 20261007T180217856Z-3be656c2
Codex: codex-cli 0.155.1
History: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\history.jsonl

Mode: live; model: mimo-v2.6-flash; decision: LIVE_JEV_HMCODEX_ONLY

| Condition | Success | Recovery | Tokens | Actual charge | Priced usage / basis | Human active min | Tool rounds | Wall ms |
|---|---:|---:|---:|---:|---|---:|---:|---:|
| ordinary-codex | 9/12 | 5/8 | UNKNOWN | UNKNOWN | UNKNOWN / SUBSCRIPTION_QUOTA | 0 | 60 | 1774238 |
| hmcodex-runtime | 10/12 | 6/8 | UNKNOWN | UNKNOWN | UNKNOWN / SUBSCRIPTION_QUOTA | 0 | 61 | 1109480 |

- Both real clients execute real tools against independent identical initial workspaces. Ordinary Codex is the installed CLI, not a provider-only substitute.
- Selected clients use the configured actual upstream model through the shared protocol adapter. Missing usage or billing stays UNKNOWN.
- hmCodex uses the real Jev service in its enabled condition; raw decision usage and latency are recorded separately. Priced usage covers the language model only; Jev cash charges remain unknown.
- Published quota rates include separate cached-input prices. Quota consumption is not an invoice or per-task cash charge. Unknown billing stays unknown.
- No humans are connected to this headless run; zero intervention time does not prove human time savings.
- Plugins are disabled in the Codex control. Inspection is read-only; engineering tasks permit workspace edits with approved file/test capabilities. Both clients start from identical independent workspaces.
- Fixed engineering tasks use independent behavior assertions, syntax and test commands, and immutable test-file checks. Larger samples and actual billing/manual-time evidence remain required for product ROI claims.

Raw evidence: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\20261007T180217856Z-3be656c2
