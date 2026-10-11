import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { HarnessFacade } from '../src/harness-facade.mjs';
import { EXIT_CODES } from '../../harness-model/src/index.mjs';

// End-to-end: drive the real monolithic runtime through the facade. This proves
// the stable entry surface works against the actual runtime without importing
// its internals. `health` is read-only: no model request, no controlled
// executor, no state change (docs/LINUX_CLI_CONTRACT.md §3.1).
test('facade drives the real runtime health command', async () => {
  const facade = new HarnessFacade();
  if (!existsSync(facade.runtimeEntry)) {
    // Runtime not checked out alongside the packages; skip rather than fail.
    return;
  }
  const outcome = await facade.health({ timeoutMs: 60_000 });
  assert.ok(outcome.result, `expected a parsed result, stderr: ${outcome.stderr}`);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.exitCode, EXIT_CODES.SUCCESS);
  assert.ok(outcome.result.runtime, 'health result should include runtime info');
  assert.equal(outcome.result.runtime.platform, process.platform);
});
