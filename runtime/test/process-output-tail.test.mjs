import test from 'node:test';
import assert from 'node:assert/strict';
import { processFailureOutputTail } from '../src/process-output-tail.mjs';

test('stderr warnings plus stdout failure list: both streams preserved', () => {
  const stdout = `test result: ok\nfailures:\n    tests::a_slow_case\n    tests::the_real_failure\ntest result: FAILED. 0 passed`;
  const stderr = `warning: unused variable\nwarning: linker stdout Non-UTF-8\nwarning: more noise`;
  const tail = processFailureOutputTail({ stdout, stderr });
  assert.ok(tail.includes('[stdout]'), 'stdout section labeled');
  assert.ok(tail.includes('[stderr]'), 'stderr section labeled');
  assert.ok(tail.includes('the_real_failure'), 'stdout failure names survive');
  assert.ok(tail.length <= 800, `bounded, got ${tail.length}`);
  // stdout tail is the last thing the reviewer reads.
  assert.ok(tail.trimEnd().endsWith('FAILED. 0 passed'));
});

test('each oversized stream still fits the total cap', () => {
  const stdout = 'x'.repeat(5000);
  const stderr = 'y'.repeat(5000);
  const tail = processFailureOutputTail({ stdout, stderr });
  assert.ok(tail.length <= 800, `total <=800, got ${tail.length}`);
  assert.ok(tail.includes('x') && tail.includes('y'), 'neither stream loses all space');
});

test('single stream keeps the plain tail', () => {
  const stdout = 'a'.repeat(2000);
  assert.equal(processFailureOutputTail({ stdout }), stdout.slice(-800));
  const stderr = 'b'.repeat(2000);
  assert.equal(processFailureOutputTail({ stderr }), stderr.slice(-800));
});

test('missing/empty output yields empty string', () => {
  assert.equal(processFailureOutputTail({}), '');
  assert.equal(processFailureOutputTail({ stdout: '', stderr: '' }), '');
  assert.equal(processFailureOutputTail(undefined), '');
  assert.equal(processFailureOutputTail({ stdout: 1, stderr: null }), '');
});

test('boundary limits stay bounded including labels', () => {
  for (const limit of [0, 1, 18, 19, 20]) {
    const tail = processFailureOutputTail({ stdout: 'x'.repeat(5000), stderr: 'y'.repeat(5000) }, limit);
    assert.ok(tail.length <= Math.max(0, limit), `limit ${limit} gave ${tail.length}`);
    if (limit < 1) assert.equal(tail, '');
  }
  assert.equal(processFailureOutputTail({ stdout: 'x', stderr: 'y' }, -1), '');
  assert.equal(processFailureOutputTail({ stdout: 'x', stderr: 'y' }, NaN), '');
  const huge = processFailureOutputTail({ stdout: 's'.repeat(1_000_000), stderr: 'e'.repeat(1_000_000) });
  assert.ok(huge.length <= 800);
});

test('short stderr leaves more budget for stdout', () => {
  const stdout = 's'.repeat(2000);
  const stderr = 'warn';
  const tail = processFailureOutputTail({ stdout, stderr });
  assert.ok(tail.includes('warn'));
  assert.ok(tail.length <= 800);
  // stderr used only 4 chars of its ~half budget; stdout claims the rest.
  const stdoutSection = tail.split('[stdout]')[1].trim();
  assert.ok(stdoutSection.length > 380, `stdout gets leftover budget, got ${stdoutSection.length}`);
});
