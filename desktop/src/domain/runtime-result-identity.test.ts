import { expect, it } from 'vitest';
import { resolveRuntimeResultIdentity } from './runtime-result-identity';

it('uses final runtime identity when streaming events were not received', () => {
  expect(resolveRuntimeResultIdentity(undefined, 'run', new Set())).toEqual({ runId: 'run', deleted: false });
  expect(resolveRuntimeResultIdentity('run', undefined, new Set())).toEqual({ runId: 'run', deleted: false });
});

it('rejects conflicting identities and identifies deleted final responses', () => {
  expect(() => resolveRuntimeResultIdentity('first', 'second', new Set())).toThrow('RUNTIME_RUN_ID_MISMATCH');
  expect(resolveRuntimeResultIdentity(undefined, 'gone', new Set(['gone'])).deleted).toBe(true);
  expect(resolveRuntimeResultIdentity('gone', undefined, new Set(['gone'])).deleted).toBe(true);
  expect(resolveRuntimeResultIdentity(undefined, undefined, new Set(['gone'])).deleted).toBe(false);
});
