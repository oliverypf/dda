# Bench log — offloop true CANDIDATE r1

- Date: 2026-10-25.
- Implementation and validation: complete; root CANDIDATE + this bench-log verified under `/workspace/dda-drive/` (Codex sandbox saw EROFS; box shell smoke succeeded).
- PIN / `tipShaBaseline`: `a9c0b357bb0340325a02b3b50378851e22ddb4d9` (post-#89 master).
- Regression: specified baseline **49/49 → 57/57**, including 8 new tests; 0 failures, 0 skipped.
- No runtime, lease, topology, or tip product code changes; no live benches or PR merges.

## Commands run

Working directory: `/workspace/dda-drive/offloop`.

```bash
node --test test/*.test.mjs
```

Final result: exit 0, all 16 test files pass. This sandbox's Node v20.19.2 runner reports file wrappers; the following direct import confirms **57/57 individual cases**:

```bash
node --input-type=module > /tmp/offloop-tcand-suite.tap <<'NODE'
import fs from 'node:fs';
for (const file of fs.readdirSync('test').filter((name) => name.endsWith('.test.mjs')).sort()) {
  await import(new URL(`./test/${file}`, `file://${process.cwd()}/`));
}
NODE
tail -n 12 /tmp/offloop-tcand-suite.tap
```

Focused tests also run directly: `node test/true-candidate-r1.test.mjs` (4 cases), `node test/tip-baseline.test.mjs` (4 cases), and the three portability-adjusted files (11 cases). All pass in the final suite.

The initial unmodified suite failed in 3 files: 6 hook cases attempted read-only parent log writes; 1 isolation case hit subprocess `EPERM`. Hook tests now use temporary drives while reading the same bench logs; the isolation assertion scans the same runtime tree directly. Existing assertions and explicit `tipSha: '4439768'` inputs are preserved.

### Required root smoke

```bash
node dayloop-soft.mjs --fixture soft-clean --soft-worktree /tmp/offloop-tcand-swt --out-dir /workspace/dda-drive --tip-sha a9c0b357bb0340325a02b3b50378851e22ddb4d9
```

**PASS (box shell):** wrote `/workspace/dda-drive/freeze-candidate-post-dpr-sticky-execute-r1.md` with tipShaBaseline=`a9c0b357bb0340325a02b3b50378851e22ddb4d9`, softTreeFileListHash=`fd8711a518305bc89d7e1b85132afe2c325c0c5c8bead2ce0c2210b92b9136c8` (64 hex), soft fileList=`latch-md/latch-draft.md`. Codex sandbox alone hit EROFS; executor installed/re-ran outside sandbox.


### Writable staged smoke and required default smoke

```bash
node dayloop-soft.mjs --fixture soft-clean --soft-worktree /tmp/offloop-tcand-swt --out-dir /workspace/dda-drive/offloop/out-true-candidate-r1 --tip-sha a9c0b357bb0340325a02b3b50378851e22ddb4d9 > /tmp/offloop-tcand-explicit.json
node dayloop-soft.mjs --fixture soft-clean --soft-worktree /tmp/offloop-tcand-def --out-dir /tmp/offloop-tcand-def-out > /tmp/offloop-tcand-default.json
```

Both exit 0 and report `wroteCandidate: true`, `frozenWrites: 0`. Both use fixture evidence; these smokes make no claim of live bench evidence.

## Candidate evidence

| Mode | Candidate path |
| --- | --- |
| Explicit full PIN, **dda-drive root** | `/workspace/dda-drive/freeze-candidate-post-dpr-sticky-execute-r1.md` |
| Explicit full PIN, staged | `/workspace/dda-drive/offloop/out-true-candidate-r1/freeze-candidate-post-dpr-sticky-execute-r1.md` |
| Default, no `--tip-sha` | `/tmp/offloop-tcand-def-out/freeze-candidate-post-dpr-sticky-execute-r1.md` |

Both candidates were read back and checked against their JSON summaries and soft-worktree manifests:

- Status: **CANDIDATE** / `状态：CANDIDATE`.
- `tipShaBaseline`: `a9c0b357bb0340325a02b3b50378851e22ddb4d9` in every evidence table.
- `softTreeFileListHash`: `fd8711a518305bc89d7e1b85132afe2c325c0c5c8bead2ce0c2210b92b9136c8` (64 hex, matches manifest).
- Soft `fileList`: `latch-md/latch-draft.md`; file exists in each corresponding soft worktree.

## Acceptance and gates

| ID | Result |
| --- | --- |
| T-tcand-1 | PASS: no explicit tip produces an on-disk true CANDIDATE with the full PIN, manifest hash, and allowed fileList. Root destination verified: `/workspace/dda-drive/freeze-candidate-post-dpr-sticky-execute-r1.md`. |
| T-tcand-2 | PASS: both false-win and hard-gate fixtures write EXPERIENCE and 0 CANDIDATE; hard-gate writes 0 soft files. |
| T-tcand-3 | PASS: path-anomaly Compose remains EXPERIENCE-only with pinned evidence; existing CLOSED hook anomaly cases also pass. |
| T-tcand-4 | PASS for regression: 49 existing + 4 true-candidate/gate + 4 tip-precedence = 57/57. Root artifact + bench-log placement verified. |

Existing missing-soft-evidence rejection and all-green noop cases pass. No Compose/probe gate implementation changed. New precedence coverage proves explicit tip > supplied bench-log tip > new default, including historical explicit/seeded `4439768`; automatically chosen historical fixture metadata is not a seed. `probe-l1.mjs` also had an old CLI default, now updated so production `.mjs` files contain no `4439768` default.

## Diff vs soft-contrast-pair

soft-contrast-pair proved run-pair vs fixture-fallback visibility. This knife upgrades DEFAULT_TIP to post-#89 master and proves Compose writes true CANDIDATE with tip+hash+fileList (not EXPERIENCE-only). Baseline/soft fallback visibility and all rejection/noop gates remain intact.

## Changed files

- `dayloop-soft.mjs`, `on-closed.mjs`, `run-from-miss.mjs`, `probe-l1.mjs`: pin/default precedence and help text.
- `README.md`: full PIN and true-candidate contract.
- New `test/true-candidate-r1.test.mjs`, `test/tip-baseline.test.mjs`: 8 cases.
- `test/closed-hook.test.mjs`, `test/on-closed-soft.test.mjs`, `test/experience-isolation.test.mjs`: sandbox-compatible test I/O, same assertions.
- This staged bench log and `out-true-candidate-r1/` smoke CANDIDATE/EXPERIENCE outputs.
