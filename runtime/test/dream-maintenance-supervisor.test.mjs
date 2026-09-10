import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDreamMaintenanceSupervisor,
  parseDreamActiveRuns,
  parseDreamMaintenanceFailureLimit,
  parseDreamMaintenanceInterval
} from '../src/dream-maintenance-supervisor.mjs';

test('dream activity counts are parsed conservatively', () => {
  assert.equal(parseDreamActiveRuns('0'), 0);
  assert.equal(parseDreamActiveRuns(' 1024\n'), 1024);
  assert.equal(parseDreamActiveRuns(''), undefined);
  assert.equal(parseDreamActiveRuns('1025'), undefined);
  assert.equal(parseDreamActiveRuns('busy'), undefined);
});

test('dream maintenance configuration is bounded', () => {
  assert.equal(parseDreamMaintenanceInterval(undefined), 15 * 60 * 1000);
  assert.equal(parseDreamMaintenanceInterval(30 * 1000), 30 * 1000);
  assert.equal(parseDreamMaintenanceFailureLimit(undefined), 3);
  assert.throws(() => parseDreamMaintenanceInterval(29_999), /DREAM_MAINTENANCE_INTERVAL_INVALID/u);
  assert.throws(() => parseDreamMaintenanceInterval(24 * 60 * 60 * 1000 + 1), /DREAM_MAINTENANCE_INTERVAL_INVALID/u);
  assert.throws(() => parseDreamMaintenanceFailureLimit(0), /DREAM_MAINTENANCE_FAILURE_LIMIT_INVALID/u);
});

test('dream maintenance runs bounded cycles and stops from an abort signal', async () => {
  const controller = new AbortController();
  const events = [];
  let calls = 0;
  const supervisor = createDreamMaintenanceSupervisor({
    intervalMs: 30_000,
    delayImpl: async () => {
      if (calls >= 2) controller.abort();
    },
    runOnce: async ({ cycle }) => {
      calls += 1;
      return { cycle };
    },
    emit: (event) => events.push(event)
  });

  const result = await supervisor.start({ signal: controller.signal });
  assert.equal(result.state, 'STOPPED');
  assert.equal(result.cycleCount, 2);
  assert.equal(supervisor.running, false);
  assert.deepEqual(events.filter((event) => event.state === 'RUNNING').map((event) => event.cycle), [1, 2]);
  assert.equal(events.filter((event) => event.state === 'COMPLETED').length, 2);
  assert.equal(events.at(-1)?.state, 'STOPPED');
});

test('dream maintenance fails closed after repeated cycle failures', async () => {
  const supervisor = createDreamMaintenanceSupervisor({
    intervalMs: 30_000,
    failureLimit: 1,
    delayImpl: async () => {},
    runOnce: async () => { throw new Error('DREAM_FIXTURE_FAILURE'); }
  });

  await assert.rejects(
    () => supervisor.start(),
    /DREAM_MAINTENANCE_FAILURE_LIMIT/u
  );
  assert.equal(supervisor.running, false);
  assert.equal(supervisor.cycleCount, 1);
  assert.equal(supervisor.consecutiveFailures, 1);
});
