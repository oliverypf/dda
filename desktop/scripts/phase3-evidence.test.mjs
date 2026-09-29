import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const script = resolve(here, 'phase3-evidence.mjs');

test('phase3 evidence check passes and writes artifact', () => {
  const result = spawnSync(process.execPath, [script], { cwd: resolve(here, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr ?? 'phase3 evidence failed');
  assert.match(result.stdout, /"total": 19/);
  assert.match(result.stdout, /WINDOWS_PHASE3_EVIDENCE\.json/);
});
