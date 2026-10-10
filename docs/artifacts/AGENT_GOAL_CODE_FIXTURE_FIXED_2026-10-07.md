# Fixed task comparison: actual Codex CLI and hmCodex

Batch: 20261007T062347348Z-fbc2fdc5
Codex: codex-cli 0.155.1
History: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\history.jsonl

Mode: fixture; model: evidence-fixture

| Condition | Success | Recovery | Tokens | Actual charge | Priced usage / basis | Human active min | Tool rounds | Wall ms |
|---|---:|---:|---:|---:|---|---:|---:|---:|
| ordinary-codex | 1/1 | 1/1 | 96 | 0 | 0 / LOCAL_FIXTURE | 0 | 3 | 99814 |
| hmcodex-runtime | 1/1 | 1/1 | 144 | 0 | 0 / LOCAL_FIXTURE | 0 | 4 | 24769 |

- Both real clients execute real tools against independent identical initial workspaces. Ordinary Codex is the installed CLI, not a provider-only substitute.
- The model and token usage are deterministic local fixtures; this validates the experiment, not production savings.
- Provider cost is zero only because no external inference is used; local compute is excluded.
- No humans are connected to this headless run; zero intervention time does not prove human time savings.
- Plugins are disabled in the Codex control. Inspection is read-only; engineering tasks permit workspace edits with approved file/test capabilities. Both clients start from identical independent workspaces.
- Fixed engineering tasks use independent behavior assertions, syntax and test commands, and immutable test-file checks. Larger samples and actual billing/manual-time evidence remain required for product ROI claims.

Raw evidence: C:\Users\User\hmCodex-local\docs\artifacts\agent-goal-runs\20261007T062347348Z-fbc2fdc5
