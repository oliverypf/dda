import test from 'node:test';
import assert from 'node:assert/strict';
import { factFromToolSuccess, rememberTaskFact, renderTaskContext } from '../src/task-context.mjs';

test('later facts replace the same path and stay available for the next check', () => {
  const read = factFromToolSuccess('workspace.read', { path: 'desktop/src/main.ts', digest: 'sha256:aaa' }, { path: 'desktop/src/main.ts' });
  const again = factFromToolSuccess('workspace.read', { path: 'desktop/src/main.ts', digest: 'sha256:bbb' }, { path: 'desktop/src/main.ts' });
  const command = factFromToolSuccess('shell.execute', { ok: true, exitCode: 0 }, { command: 'node', args: ['scripts/build-full-local.mjs'], cwd: 'desktop' });
  let facts = rememberTaskFact([], read);
  facts = rememberTaskFact(facts, command);
  facts = rememberTaskFact(facts, again);
  assert.equal(facts.length, 2);
  assert.equal(facts.find((fact) => fact.path === 'desktop/src/main.ts').digest, 'sha256:bbb');
  const text = renderTaskContext(facts);
  assert.match(text, /HOST_TASK_CONTEXT/);
  assert.match(text, /desktop\/src\/main\.ts/);
  assert.match(text, /node scripts\/build-full-local\.mjs/);
  assert.match(text, /Reuse these paths/);
});
