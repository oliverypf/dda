# Curated EXPERIENCE（经验）

This directory is a small, reviewable off-loop evidence layout. **EXPERIENCE
（经验） is not runtime Memory（运行时记忆）**: every entry is
`experience_only`, keeps `adopted=false`, and is never read as unchecked runtime
policy. Runtime reads remain 0×.

The machine-checkable contract is [`schema.json`](./schema.json), and
[`index.json`](./index.json) is the curated inventory. The two JSON samples are
minimal records regenerated from the knife5 **MVP smoke（最小冒烟）** fixture
fields. Their `source` and `provenance.fixture` values point back to the
product smoke script and its fixture test; no CLI output directory is copied.

**DGR（decision-grade record，决策级记录）** is the bounded review record
reference. These samples have no standalone DGR artifact, so `dgr`/`dgrRef` are
`null` with an explicit `dgrReason`.

Every indexable row records the fixed, non-empty tip pin
`2258685ce9793639ebc9698c8961dcedccf6e49b` in both `tipSha` and `tipPin`, with
`pinEqual=true`. A missing or empty tip is non-green and can never be `PASS`.
The index rules do not allow `experience_only` to hide a missing pin.

Generated/runtime writes remain ignored under `offloop/experience/` and
`offloop/out/` (including `out-*`). Only this README, the schema, the index, and
the files under `samples/` are carved out for tracking. Full history, live
JSONL, secrets, complete bench data, and runtime policy/Memory blobs do not
belong here.
