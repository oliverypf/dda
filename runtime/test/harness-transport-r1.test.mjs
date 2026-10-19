import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStreamRetryConfig } from '../src/plugins/task-runner.mjs';
import {
  isDeepseekStreamTransportError,
  tagDeepseekStreamTransportError
} from '../src/plugins/model-deepseek.mjs';

const withEnv = async (t, vars, fn) => {
  const previous = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  return fn();
};

const clearRetryEnv = {
  DDA_MODEL_STREAM_RETRIES: undefined,
  DDA_MODEL_STREAM_RETRY_DELAY_MS: undefined,
  DDA_MODEL_MAX_REQUESTS_PER_ROUND: undefined
};

test('T-tr-1 defaults: retries=4 delayMs=1500 maxRequestsPerRound=6; caps 8/12', async (t) => {
  await withEnv(t, clearRetryEnv, () => {
    const cfg = resolveStreamRetryConfig();
    assert.equal(cfg.streamRetries, 4);
    assert.equal(cfg.streamRetryDelayMs, 1500);
    assert.equal(cfg.maxRequestsPerRound, 6);
  });

  await withEnv(t, { ...clearRetryEnv, DDA_MODEL_STREAM_RETRIES: 8, DDA_MODEL_MAX_REQUESTS_PER_ROUND: 12 }, () => {
    const cfg = resolveStreamRetryConfig();
    assert.equal(cfg.streamRetries, 8);
    assert.equal(cfg.maxRequestsPerRound, 12);
  });

  await withEnv(t, { ...clearRetryEnv, DDA_MODEL_STREAM_RETRIES: 9 }, () => {
    assert.throws(() => resolveStreamRetryConfig(), /MODEL_RETRY_CONFIG_INVALID/);
  });

  await withEnv(t, { ...clearRetryEnv, DDA_MODEL_MAX_REQUESTS_PER_ROUND: 13 }, () => {
    assert.throws(() => resolveStreamRetryConfig(), /MODEL_RETRY_CONFIG_INVALID/);
  });
});

test('T-tr-3 deepseek terminated/fetch failed/ECONN/UND_ERR → transportPhase=STREAM; Abort untouched', () => {
  const terminated = new TypeError('terminated');
  const tagged = tagDeepseekStreamTransportError(terminated);
  assert.equal(tagged.transportPhase, 'STREAM');
  assert.equal(tagged.message, 'terminated');
  assert.ok(isDeepseekStreamTransportError(terminated));

  const fetchFailed = new TypeError('fetch failed');
  assert.equal(tagDeepseekStreamTransportError(fetchFailed).transportPhase, 'STREAM');

  const econn = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
  assert.equal(tagDeepseekStreamTransportError(econn).transportPhase, 'STREAM');

  const undici = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
  assert.equal(tagDeepseekStreamTransportError(undici).transportPhase, 'STREAM');

  const long = new Error('x'.repeat(120));
  long.code = 'ECONNRESET';
  const longTagged = tagDeepseekStreamTransportError(long);
  assert.equal(longTagged.transportPhase, 'STREAM');
  assert.ok(String(longTagged.message).length <= 80);

  const abort = new DOMException('The operation was aborted.', 'AbortError');
  const abortOut = tagDeepseekStreamTransportError(abort);
  assert.equal(abortOut, abort);
  assert.equal(abortOut.transportPhase, undefined);
  assert.equal(isDeepseekStreamTransportError(abort), false);

  const abortedSignal = tagDeepseekStreamTransportError(new TypeError('terminated'), { aborted: true });
  assert.equal(abortedSignal.transportPhase, undefined);

  // Must not label CONNECT/HTTP
  const tagged2 = tagDeepseekStreamTransportError(new TypeError('terminated'));
  assert.notEqual(tagged2.transportPhase, 'CONNECT');
  assert.notEqual(tagged2.transportPhase, 'HTTP');
});
