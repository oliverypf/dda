import test from 'node:test';
import assert from 'node:assert/strict';
import { isClassifiedLeaseFailure } from '../src/lease-failure.mjs';

test('a scope violation is already classified and must not be reported as uncertain', () => {
  assert.equal(isClassifiedLeaseFailure('SCOPE_VIOLATION'), true);
  assert.equal(isClassifiedLeaseFailure('EXECUTION_OUTCOME_UNCERTAIN'), false);
  assert.equal(isClassifiedLeaseFailure('EXECUTOR_RESULT_FAILED'), false);
  assert.equal(isClassifiedLeaseFailure(undefined), false);
});
