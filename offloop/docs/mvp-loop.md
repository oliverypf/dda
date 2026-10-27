# Harness² MVP loop, bounded smoke, and CI

This document defines the product-root **MVP（最小可行产品）** loop. A
**smoke（冒烟）** run is a bounded reproducible path check; it is not a full
live bench and it never spends Main OpenRouter quota.

## Copyable core loop

Run from the product repository root (`/workspace/dda`) or from its `offloop/`
package. The first command keeps the plan's repo-root contract visible; the
`mvp:smoke` wrapper supplies the fixed tip explicitly.

```sh
cd /path/to/dda
export DDA_TIP_REPO="$(git rev-parse --show-toplevel)"
npm --prefix offloop test
npm --prefix offloop run mvp:smoke
git diff --check
git status --short
```

The equivalent package-local form is:

```sh
cd /path/to/dda/offloop
export DDA_TIP_REPO="$(git rev-parse --show-toplevel)"
npm test
npm run mvp:smoke
git diff --check
git status --short
```

`mvp:smoke` delegates to `bin/offloop.mjs` with `--fixture` and the fixed,
non-empty tip `2258685ce9793639ebc9698c8961dcedccf6e49b`. It then runs the
existing `run-from-miss` pipeline; it does not create a second runtime. Output
goes to ignored `offloop/out/mvp-smoke/` by default, or to `--out-dir` / the
`OFFLOOP_MVP_SMOKE_OUT` environment variable.

The bounded route is:

```text
MISS（未命中） or path-anomaly（路径异常）
  → run-from-miss
  → Probe L0 fixture path
  → EXPERIENCE（经验） or reviewable CANDIDATE（候选） evidence
```

`EXPERIENCE` remains `adopted=false` with `reason=experience_only`. A
`CANDIDATE` is only a proposal for a human **PR gate（人工 PR 闸）**; neither
route changes runtime policy. The fixture smoke is expected to write zero
CANDIDATE files and zero live requests.

## Smoke report and skip semantics

The wrapper writes `mvp-smoke-report.json` with this minimum schema:

```json
{
  "status": "PASS",
  "passKind": "fixture-smoke",
  "mode": "fixture",
  "liveOptIn": false,
  "environment": {"status": "SKIP", "kind": "live"},
  "tipSha": "2258685ce9793639ebc9698c8961dcedccf6e49b",
  "pinEqual": true,
  "candidateWrites": 0,
  "liveRequests": 0,
  "mainOpenRouterCalls": 0,
  "replayExecutions": 0
}
```

`status: PASS` describes the bounded fixture path. `environment.status: SKIP`
records that the live environment was not requested; it is not a hidden live
PASS. An empty tip, `pinEqual: false`, a non-zero live/Main OpenRouter counter,
or an implicit live request makes the wrapper fail. There is no empty-tip
dual-green path.

For a real bounded input, use the same product CLI and pass explicit files;
the tip check still runs before MISS work:

```sh
node offloop/bin/offloop.mjs miss \
  --tip-sha 2258685ce9793639ebc9698c8961dcedccf6e49b \
  --bench-log /path/to/bench-log-run60.md \
  --jsonl /path/to/run60a.jsonl
```

Live flags are rejected by this product-root entry. Live tests are deferred to
the opt-in job below.

## Human PR gate

The review rules are detailed in [human-pr-gate.md](./human-pr-gate.md):

- `CANDIDATE` means PR proposal only; there is no automatic write-back,
  auto-merge, or automatic `CANDIDATE → FROZEN` / `adopted=true` promotion.
- `EXPERIENCE` is reusable evidence only and remains `experience_only` with
  `adopted=false`.
- A reviewer checks the fixed tip and `pinEqual`, DGR（decision-grade record，
  决策级记录）, hard gate（硬闸）, invariants（不变量）, tests, and the diff,
  then decides whether a PR may merge.

## CI（持续集成） core job

The default PR job is core-only and has no live credentials:

```sh
set -eu
export MAIN_OPENROUTER_CALLS=0
npm --prefix offloop test
test -z "$(git ls-files 'offloop/out-*')"
git diff --check
npm --prefix offloop run mvp:smoke
node -e 'const r=require("./offloop/out/mvp-smoke/mvp-smoke-report.json"); for (const k of ["candidateWrites","liveRequests","replayExecutions","mainOpenRouterCalls"]) if (r[k] !== 0) process.exit(1)'
```

The core `npm test` script is an allowlisted collection of non-live files and
explicitly excludes `*live*.test.mjs`. CI never writes `/workspace/dda-drive`,
changes the tip, touches the runtime write surface, or merges a PR.

## CI live opt-in job

The live job is available only through `workflow_dispatch`, an explicitly
labelled `live` PR, or an equivalent explicit switch. It must set both
`DDA_TIP_REPO` (a checkout resolving to the fixed non-empty pin) and
`DDA_LIVE_BENCH_ROOT`; neither variable is inferred from a core PASS. It runs
exactly the twelve deferred tests below and records their environment result
separately from core smoke PASS:

```sh
set -eu
test "${LIVE_OPT_IN:-}" = 1
export DDA_TIP_REPO=/path/to/fixed-tip-checkout
export DDA_LIVE_BENCH_ROOT=/path/to/explicit/live-bench
node --test \
  offloop/test/dayloop-live-bounded-expand-r1.test.mjs \
  offloop/test/dayloop-opt-in-real-live-smoke-r1.test.mjs \
  offloop/test/dayloop-tip-soft-adopt-live-r1.test.mjs \
  offloop/test/dayloop-tip-soft-contrast-live-r1.test.mjs \
  offloop/test/dayloop-transport-experience-live-persist-r1.test.mjs \
  offloop/test/experience-transport-prior-live-wire-r1.test.mjs \
  offloop/test/probe-l1-live-bounded-r1.test.mjs \
  offloop/test/tip-soft-adopt-fifth-family-live-r1.test.mjs \
  offloop/test/tip-soft-adopt-fourth-family-live-r1.test.mjs \
  offloop/test/tip-soft-adopt-second-family-live-r1.test.mjs \
  offloop/test/tip-soft-adopt-t4-retry-live-r1.test.mjs \
  offloop/test/tip-soft-adopt-third-family-live-r1.test.mjs
```

The package alias `npm --prefix offloop run test:live` is also opt-in only; it
is never part of the default core script. The live job does not write drive
evidence, change the tip, touch `runtime/`, auto-merge, or auto-promote a
CANDIDATE. A missing live environment is an explicit `ENVIRONMENT SKIP`, not a
core PASS and not permission to bypass a hard gate.
