# Fixed task Jev off/on comparison: same hmCodex source and model

Batch: 20261007T185054362Z-99afaa1f
Codex: codex-cli 0.155.1
History: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\history.jsonl

Mode: live; model: mimo-v2.6-flash; decision: LIVE_JEV_ON_OFF_ABLATION

| Condition | Success | Recovery | Tokens | Actual charge | Priced usage / basis | Human active min | Tool rounds | Wall ms |
|---|---:|---:|---:|---:|---|---:|---:|---:|
| hmcodex-jev-off | 12/12 | 8/8 | UNKNOWN | UNKNOWN | UNKNOWN / SUBSCRIPTION_QUOTA | 0 | 30 | 482977 |
| hmcodex-jev-on | 8/12 | 5/8 | UNKNOWN | UNKNOWN | UNKNOWN / SUBSCRIPTION_QUOTA | 0 | 57 | 930219 |

- The same hmCodex source and upstream model run paired Jev off/on tasks with identical initial files and alternating order. This is not a Codex client comparison.
- Selected clients use the configured actual upstream model through the shared protocol adapter. Missing usage or billing stays UNKNOWN.
- hmCodex uses the real Jev service in its enabled condition; raw decision usage and latency are recorded separately. Priced usage covers the language model only; Jev cash charges remain unknown.
- Published quota rates include separate cached-input prices. Quota consumption is not an invoice or per-task cash charge. Unknown billing stays unknown.
- No humans are connected to this headless run; zero intervention time does not prove human time savings.
- Plugins are disabled in the Codex control. Inspection is read-only; engineering tasks permit workspace edits with approved file/test capabilities. Both clients start from identical independent workspaces.
- Fixed engineering tasks use independent behavior assertions, syntax and test commands, and immutable test-file checks. Larger samples and actual billing/manual-time evidence remain required for product ROI claims.

Matched pairs: 12; activated on runs: 12/12.

| Jev calls | Successful calls | Decision proxy wall ms | Decision input tokens | Decision API-price estimate USD | Actual Jev charge |
|---:|---:|---|---|---|---|
| 100 | 66 | 224122.4967230004 | UNKNOWN | UNKNOWN | UNKNOWN |

- All failed and timed-out runs are included in their assigned condition.
- Decision API-price estimates and language-model subscription quota are separate quantities, not combined invoices.
- Small samples and provider/network timing variation limit causal attribution. Human savings and cash charges remain unverified.

Raw evidence: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\20261007T185054362Z-99afaa1f
