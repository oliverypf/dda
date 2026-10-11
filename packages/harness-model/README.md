# @dda/harness-model

Platform-agnostic surface shared by every dda client (linux-cli, desktop,
HarmonyOS). It has **no runtime dependencies and no platform code** — only value
objects, vocabulary and the stable CLI contract.

This package is the "model" half of the architecture split described in
[`docs/MULTI_PLATFORM_ARCHITECTURE.md`](../../docs/MULTI_PLATFORM_ARCHITECTURE.md).
It lets the shells agree on semantics while heavy behaviour is extracted
incrementally out of the monolithic `runtime/src/index.mjs`. See
[`docs/MONOLITH_EXTRACTION_STATUS.md`](../../docs/MONOLITH_EXTRACTION_STATUS.md)
for an honest account of what still lives in the monolith.

## Contents

| Module | Purpose |
| --- | --- |
| `versions.mjs` | Harness protocol / storage-schema / app / producer / policy versions. Canonical source; the runtime re-exports these. |
| `exit-codes.mjs` | Frozen CLI exit-code table (`docs/LINUX_CLI_CONTRACT.md` §5) plus a fail-closed `exitCodeForResult` mapper. |
| `event-kinds.mjs` | Known `runtime_event` kinds, human labels, terminal run states and a minimal envelope validator. Unknown kinds are preserved, never dropped. |

## Usage

```js
import { exitCodeForResult, EXIT_CODES } from '@dda/harness-model';

const result = JSON.parse(lastJsonlLine);
process.exitCode = exitCodeForResult(result); // SUCCESS only for { ok: true }
```

Until a repo-level workspace is wired, consumers import by relative path
(`../../packages/harness-model/src/index.mjs`).

## Tests

```bash
cd packages/harness-model && node --test   # Node 24
```
