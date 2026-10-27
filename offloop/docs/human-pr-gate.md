# Human PR gate for Harness² off-loop evidence

**CANDIDATE（候选）** is a PR change proposal. It is never an automatic
write-back, merge, promotion, `CANDIDATE → FROZEN` transition, or
`adopted=true` policy update. The off-loop tools may write a reviewable
candidate file under the configured output directory, but a human owns the
decision to merge it.

**EXPERIENCE（经验）** is reusable evidence only. Its record stays
`adopted=false` and `reason=experience_only`; it is not runtime Memory or an
online policy update.

## Reviewer checklist

Before merging a CANDIDATE PR, the reviewer records the result for each item:

- [ ] `tipSha` is non-empty, equals the fixed pin, and `pinEqual=true`.
- [ ] The DGR（decision-grade record，决策级记录） and source evidence are
      present and traceable to the bounded MISS/path-anomaly run.
- [ ] The runtime hard gate（硬闸） and all relevant write-surface boundaries
      remain fail-closed; no runtime or Agent Harness package file changed.
- [ ] Invariants（不变量） hold: no online self-modification, no hidden live
      request, no Main OpenRouter call, and no empty-tip shortcut.
- [ ] Core tests pass; any live result is from the explicit opt-in job and is
      labelled separately from fixture smoke.
- [ ] The diff contains only the proposed off-loop/docs change and has passed
      `git diff --check`.

The reviewer, not the script, decides whether the PR merges. A rejected or
insufficient proposal remains evidence; it is not silently rewritten into a
green product state.
