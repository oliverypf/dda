import test from 'node:test';
import assert from 'node:assert/strict';
import { redactRuntimeArgv } from '../src/runtime-log-redaction.mjs';

test('redacts prompt and title values from startup argv diagnostics', () => {
  assert.deepEqual(redactRuntimeArgv([
    'task', '--prompt', '用户的私密任务', '--workspace', 'C:\\workspace',
    'thread', '--title=另一个私密标题', '--input', '{"secret":true}'
  ]), [
    'task', '--prompt', '[REDACTED]', '--workspace', 'C:\\workspace',
    'thread', '--title=[REDACTED]', '--input', '[REDACTED]'
  ]);
});
