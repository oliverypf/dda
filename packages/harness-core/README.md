# @dda/harness-core

`HarnessFacade` — the **stable programmatic entry surface** that platform shells
(starting with `linux-cli`) use to drive the dda runtime without depending on the
monolith's internals.

This is the "core" half of the architecture split described in
[`docs/MULTI_PLATFORM_ARCHITECTURE.md`](../../docs/MULTI_PLATFORM_ARCHITECTURE.md)
and [`docs/adr/0024-harness-facade-and-package-split.md`](../../docs/adr/0024-harness-facade-and-package-split.md).

## Why a facade instead of importing the runtime

`runtime/src/index.mjs` runs its CLI dispatch at import time (top-level `await`),
so it cannot be imported as a library. The facade therefore drives the runtime as
a **supervised child process**, which matches the documented topology (the
runtime may be an in-process module *or* a supervised subprocess). As behaviour
is extracted out of the monolith into this package, individual methods can switch
from spawning to in-process calls **without changing the facade surface**, so the
shells never have to change.

## Surface

```js
import { HarnessFacade } from '@dda/harness-core';

const harness = new HarnessFacade();        // spawns runtime/src/index.mjs
const health = await harness.health();
const task = await harness.task({ prompt: 'inspect repo', workspace: '/proj' });

process.exitCode = task.exitCode;           // stable code from @dda/harness-model
for (const event of task.events) { /* render runtime_event JSONL */ }
```

Every call resolves (never rejects) with a frozen outcome:
`{ command, args, ok, result, events, exitCode, childExitCode, signal, stdout, stderr, timedOut }`.

## Safety invariants preserved

The facade **forwards caller intent only**; the runtime remains the authority for
safety, approval, PolicyLease, Rule Verifier and the Jev decision plane.
Specifically the facade:

- defaults tasks to `READ_ONLY`;
- never injects an approval decision or an auto-approve flag — fail-closed
  approval behaviour stays in the runtime;
- is fail-closed when mapping results to exit codes: a missing/garbled result is
  `PROTOCOL_ERROR` and a timeout is `RUNTIME_ERROR`, never `SUCCESS`;
- treats a CLI timeout as "action state unknown" (it kills the child but does not
  claim the action was cancelled).

## Tests

```bash
cd packages/harness-core && node --test   # Node 24
```

`harness-facade.unit.test.mjs` uses an injected fake `spawn`;
`harness-facade.e2e.test.mjs` drives the real runtime `health` command (skipped
if the runtime is not checked out next to the packages).
