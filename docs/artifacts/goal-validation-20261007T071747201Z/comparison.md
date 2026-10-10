# Fixed task comparison: actual Codex CLI and hmCodex

Batch: 20261007T072002210Z-4143a923
Codex: codex-cli 0.155.1
History: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\history.jsonl

Mode: live; model: mimo-v2.6-pro

| Condition | Success | Recovery | Tokens | Actual charge | Priced usage / basis | Human active min | Tool rounds | Wall ms |
|---|---:|---:|---:|---:|---|---:|---:|---:|
| ordinary-codex | 8/12 | 4/8 | UNKNOWN | UNKNOWN | UNKNOWN / SUBSCRIPTION_QUOTA | 0 | 71 | 1837024 |
| hmcodex-runtime | 9/12 | 5/8 | UNKNOWN | UNKNOWN | UNKNOWN / SUBSCRIPTION_QUOTA | 0 | 34 | 543350 |

- Both real clients execute real tools against independent identical initial workspaces. Ordinary Codex is the installed CLI, not a provider-only substitute.
- Both clients use the configured actual upstream model through the same protocol adapter. Missing usage or billing stays UNKNOWN.
- Published quota rates include separate cached-input prices. Quota consumption is not an invoice or per-task cash charge. Unknown billing stays unknown.
- No humans are connected to this headless run; zero intervention time does not prove human time savings.
- Plugins are disabled in the Codex control. Inspection is read-only; engineering tasks permit workspace edits with approved file/test capabilities. Both clients start from identical independent workspaces.
- Fixed engineering tasks use independent behavior assertions, syntax and test commands, and immutable test-file checks. Larger samples and actual billing/manual-time evidence remain required for product ROI claims.

Raw evidence: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\20261007T072002210Z-4143a923
