# Fixed task single-client diagnostic

Batch: 20261007T084556239Z-be027c27
Codex: codex-cli 0.155.1
History: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\history.jsonl

Mode: live; model: mimo-v2.6-pro; decision: LIVE_JEV_HMCODEX_ONLY

| Condition | Success | Recovery | Tokens | Actual charge | Priced usage / basis | Human active min | Tool rounds | Wall ms |
|---|---:|---:|---:|---:|---|---:|---:|---:|
| hmcodex-runtime | 0/2 | 0/2 | 18053 | UNKNOWN | 0.005161594 / SUBSCRIPTION_QUOTA | 0 | 6 | 245583 |

- This is a single-client diagnostic, not a paired comparison. Other batches cannot supply its control condition.
- Selected clients use the configured actual upstream model through the shared protocol adapter. Missing usage or billing stays UNKNOWN.
- hmCodex uses the real Jev service; raw decision usage is recorded separately. Priced usage covers the language model only; Jev cash charges remain unknown.
- Published quota rates include separate cached-input prices. Quota consumption is not an invoice or per-task cash charge. Unknown billing stays unknown.
- No humans are connected to this headless run; zero intervention time does not prove human time savings.
- Plugins are disabled in the Codex control. Inspection is read-only; engineering tasks permit workspace edits with approved file/test capabilities. Both clients start from identical independent workspaces.
- Fixed engineering tasks use independent behavior assertions, syntax and test commands, and immutable test-file checks. Larger samples and actual billing/manual-time evidence remain required for product ROI claims.

Raw evidence: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\20261007T084556239Z-be027c27
