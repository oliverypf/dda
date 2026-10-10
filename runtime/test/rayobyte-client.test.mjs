import test from 'node:test';
import assert from 'node:assert/strict';
import { appendTargeting } from '../src/rayobyte-client.mjs';

test('targeting options are appended to the password', () => {
  const password = 'secret';
  assert.equal(appendTargeting(password, { country: 'US' }), `${password}-country-US`);
  assert.equal(appendTargeting(password, { session: 'abc12345' }), `${password}-session-abc12345`);
  assert.equal(
    appendTargeting(password, { country: 'us', session: 'abc12345' }),
    `${password}-country-US-session-abc12345`
  );
  assert.equal(appendTargeting(password, {}), password);
});

test('targeting values that would split an option are rejected', () => {
  assert.throws(() => appendTargeting('secret', { country: 'USA' }), /2-letter/);
  assert.throws(() => appendTargeting('secret', { session: 'worker-7' }), /1-16/);
});
