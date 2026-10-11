import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXIT_CODES,
  EXIT_CODE_NAMES,
  exitCodeForError,
  exitCodeForResult
} from '../src/exit-codes.mjs';

test('exit-code table matches the frozen linux-cli contract', () => {
  assert.deepEqual(EXIT_CODES, {
    SUCCESS: 0,
    RUNTIME_ERROR: 1,
    USAGE_ERROR: 2,
    CONFIG_ERROR: 3,
    WORKSPACE_ERROR: 4,
    APPROVAL_DENIED: 5,
    SAFETY_BLOCKED: 6,
    CANCELLED: 7,
    PROTOCOL_ERROR: 8,
    STORAGE_ERROR: 9,
    DEPENDENCY_ERROR: 10,
    SIGINT: 130
  });
  assert.equal(EXIT_CODE_NAMES[0], 'SUCCESS');
  assert.equal(EXIT_CODE_NAMES[6], 'SAFETY_BLOCKED');
});

test('ok results map to SUCCESS', () => {
  assert.equal(exitCodeForResult({ ok: true, runId: 'run-1' }), EXIT_CODES.SUCCESS);
});

test('results are fail-closed: non-ok and malformed never return SUCCESS', () => {
  assert.equal(exitCodeForResult({ ok: false }), EXIT_CODES.RUNTIME_ERROR);
  assert.equal(exitCodeForResult(null), EXIT_CODES.PROTOCOL_ERROR);
  assert.equal(exitCodeForResult('nonsense'), EXIT_CODES.PROTOCOL_ERROR);
  assert.equal(exitCodeForResult({}), EXIT_CODES.RUNTIME_ERROR);
});

test('known runtime error tokens map to their contract category', () => {
  const cases = [
    ['APPROVAL_REQUIRED', EXIT_CODES.APPROVAL_DENIED],
    ['APPROVAL_UNAVAILABLE', EXIT_CODES.APPROVAL_DENIED],
    ['WORKSPACE_NOT_FOUND', EXIT_CODES.WORKSPACE_ERROR],
    ['SCOPE_VIOLATION', EXIT_CODES.WORKSPACE_ERROR],
    ['THREAD_WORKSPACE_MISMATCH', EXIT_CODES.WORKSPACE_ERROR],
    ['TASK_PRECHECK_BLOCKED:reason', EXIT_CODES.SAFETY_BLOCKED],
    ['ROUTE_BLOCKED:reason', EXIT_CODES.SAFETY_BLOCKED],
    ['ROLE_BINDING_BLOCKED', EXIT_CODES.SAFETY_BLOCKED],
    ['TASK_CANCELLED', EXIT_CODES.CANCELLED],
    ['EXECUTION_MODE_INVALID', EXIT_CODES.CONFIG_ERROR],
    ['AGENT_MODE_INVALID', EXIT_CODES.CONFIG_ERROR],
    ['THREAD_ID_REQUIRED', EXIT_CODES.USAGE_ERROR],
    ['TOOL_INVALID_INPUT_JSON', EXIT_CODES.USAGE_ERROR],
    ['HARNESS_IMPORT_SOURCE_REQUIRED', EXIT_CODES.STORAGE_ERROR],
    ['PLUGIN_DEPENDENCIES_UNAVAILABLE', EXIT_CODES.DEPENDENCY_ERROR]
  ];
  for (const [token, expected] of cases) {
    assert.equal(exitCodeForError(token), expected, `token ${token}`);
  }
});

test('unknown tokens fall back to RUNTIME_ERROR', () => {
  assert.equal(exitCodeForError('SOMETHING_WE_HAVE_NEVER_SEEN'), EXIT_CODES.RUNTIME_ERROR);
  assert.equal(exitCodeForError(''), EXIT_CODES.RUNTIME_ERROR);
  assert.equal(exitCodeForError(undefined), EXIT_CODES.RUNTIME_ERROR);
});

test('exitCodeForResult reads error.code, error.message, string error and harness reason', () => {
  assert.equal(exitCodeForResult({ ok: false, error: { code: 'APPROVAL_REQUIRED' } }), EXIT_CODES.APPROVAL_DENIED);
  assert.equal(exitCodeForResult({ ok: false, error: { message: 'SCOPE_VIOLATION: outside root' } }), EXIT_CODES.WORKSPACE_ERROR);
  assert.equal(exitCodeForResult({ ok: false, error: 'ROUTE_BLOCKED:policy' }), EXIT_CODES.SAFETY_BLOCKED);
  assert.equal(exitCodeForResult({ ok: false, harness: { reason: 'TASK_CANCELLED' } }), EXIT_CODES.CANCELLED);
});
