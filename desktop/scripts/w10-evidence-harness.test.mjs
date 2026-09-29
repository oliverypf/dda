import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { accumulateLongRun, runW10Evidence } from './w10-evidence-harness.mjs';
import { createHarnessEventStore } from '../../runtime/src/harness-event-store.mjs';

const stateFile = async (name, value) => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-w10-evidence-'));
  const path = join(root, name);
  await writeFile(path, JSON.stringify(value), 'utf8');
  return path;
};

test('w10 evidence stays NOT_READY without a real install, window and signed reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-w10-gate-'));
  const statePath = join(root, 'longrun.json');
  const report = await runW10Evidence({ statePath, skipDrills: true, expectedRunCount: 5, failureCount: 0 });
  assert.equal(report.releaseDecision, 'NOT_READY');
  assert.equal(report.artifact, 'WINDOWS_PHASE2_W10_EVIDENCE');
  assert.equal(typeof report.execution.installedPackage, 'boolean');
  assert.equal(report.longRun.status, 'PENDING_OBSERVATION');
  assert.equal(report.longRun.observedMinutes, 0);
  assert.equal(report.retention.status, 'UNKNOWN');
  assert.ok(report.blockingReasons.includes('LONG_RUN_WINDOW_INCOMPLETE'));
  assert.ok(report.blockingReasons.includes('RETENTION_UNKNOWN'));
  assert.ok(report.blockingReasons.includes('RELEASE_DECISION_REPORT_MISSING'));
  assert.ok(report.blockingReasons.includes('REAL_WORKSPACE_OBSERVATION_MISSING'));
  // Sections that were not executed must never be reported as executed.
  assert.equal(report.lifecycle.evidenceClass, 'NOT_RUN');
  assert.equal(report.killSwitch.evidenceClass, 'NOT_RUN');
});

test('long run only credits observed wall clock inside the gap tolerance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-w10-longrun-'));
  const statePath = join(root, 'longrun.json');
  const base = 1_700_000_000_000;
  await accumulateLongRun(statePath, { nowMs: base });
  await accumulateLongRun(statePath, { nowMs: base + 60_000 });
  const single = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(single.sessions.length, 1);
  assert.equal(single.observedMinutes, 1);
  await accumulateLongRun(statePath, { nowMs: base + 60 * 60_000 });
  const split = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(split.sessions.length, 2);
  assert.equal(split.observedMinutes, 1);
  const pending = await accumulateLongRun(statePath, { nowMs: base + 61 * 60_000 });
  assert.equal(pending.status, 'PENDING_OBSERVATION');
  assert.equal(pending.requiredMinutes, 1440);
  const credited = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(credited.sessions.length, 2);
  assert.equal(credited.observedMinutes, 2);
});

test('signed release evidence must declare ok:true', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-w10-evidence-gate-'));
  const statePath = join(root, 'longrun.json');
  const notOk = await stateFile('not-ok.json', { ok: false });
  const okReport = await stateFile('ok.json', { ok: true });
  const rejected = await runW10Evidence({ statePath, skipDrills: true, releaseReportPath: notOk, expectedRunCount: 1 });
  assert.equal(rejected.releaseEvidence.decisionReport.ok, false);
  assert.ok(rejected.blockingReasons.includes('W10_REPORT_NOT_OK'));
  const accepted = await runW10Evidence({ statePath, skipDrills: true, releaseReportPath: okReport, expectedRunCount: 1 });
  assert.equal(accepted.releaseEvidence.decisionReport.ok, true);
  assert.ok(!accepted.blockingReasons.includes('W10_REPORT_NOT_OK'));
  assert.match(accepted.releaseEvidence.decisionReport.digest, /^sha256:[0-9a-f]{64}$/u);
});

test('retention needs a recorded observation start before it can be partial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-w10-retention-'));
  const statePath = join(root, 'longrun.json');
  const unknown = await runW10Evidence({ statePath, skipDrills: true, expectedRunCount: 1 });
  assert.equal(unknown.retention.status, 'UNKNOWN');
  const partial = await runW10Evidence({
    statePath,
    skipDrills: true,
    expectedRunCount: 1,
    observationStartedAtMs: Date.now() - 60_000,
    observationSource: 'test-record'
  });
  assert.equal(partial.retention.status, 'PARTIAL');
  assert.equal(partial.retention.reason, 'THIRTY_DAY_WINDOW_INCOMPLETE');
  assert.equal(partial.retention.observationSource, 'test-record');
});
import { createHash } from 'node:crypto';
import { readInstallLifecycle } from './w10-evidence-harness.mjs';

const digestOf = (text) => createHash('sha256').update(text).digest('hex');

const writeLifecycleFixture = async ({ root, steps }) => {
  const lifecyclePath = join(root, 'lifecycle.json');
  await writeFile(lifecyclePath, JSON.stringify({
    schemaVersion: '1.0',
    artifact: 'WINDOWS_PHASE2_INSTALL_LIFECYCLE',
    installer: 'NSIS_PER_MACHINE',
    evidenceClass: 'REAL_EXECUTION',
    elevated: true,
    finishedAtMs: 1_700_000_000_000,
    expectedRuntimeSha256: 'a'.repeat(64),
    steps
  }), 'utf8');
  return lifecyclePath;
};

const writeStep = async (root, name, { exitCode = 0, assertions, evidenceClass = 'REAL_EXECUTION' } = {}) => {
  const logPath = join(root, `${name}.log`);
  const logText = `${name} log\n`;
  await writeFile(logPath, logText, 'utf8');
  const stepPath = join(root, `${name}.json`);
  const record = {
    schemaVersion: '1.0',
    artifact: 'WINDOWS_PHASE2_INSTALL_LIFECYCLE_STEP',
    step: name,
    evidenceClass,
    elevated: true,
    exitCode,
    command: `${name} drill`,
    log: { path: logPath, bytes: Buffer.byteLength(logText), sha256: digestOf(logText) },
    logs: [{ path: logPath, bytes: Buffer.byteLength(logText), sha256: digestOf(logText) }],
    assertions: assertions ?? [{ name: 'exitCodeZero', ok: exitCode === 0 }],
    ok: (assertions ?? [{ ok: exitCode === 0 }]).every((assertion) => assertion.ok === true)
  };
  await writeFile(stepPath, JSON.stringify(record), 'utf8');
  return { ...record, stepFile: stepPath, stepFileSha256: digestOf(JSON.stringify(record)) };
};

const REQUIRED = ['install', 'upgrade', 'migration', 'rollback', 'uninstall'];

test('install lifecycle evidence must be present, elevated and complete', async () => {
  const absent = await readInstallLifecycle(undefined);
  assert.equal(absent.status, 'MISSING');
  assert.equal(absent.code, 'INSTALL_LIFECYCLE_EVIDENCE_MISSING');
  assert.deepEqual(absent.missingSteps, REQUIRED);
  const notFound = await readInstallLifecycle(join(tmpdir(), 'hmcodex-lifecycle-does-not-exist.json'));
  assert.equal(notFound.code, 'INSTALL_LIFECYCLE_EVIDENCE_MISSING');
  assert.equal(notFound.reason, 'PATH_NOT_FOUND');
});

test('install lifecycle evidence accepts only fully verified elevated steps', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-w10-lifecycle-'));
  const steps = [];
  for (const name of REQUIRED) steps.push(await writeStep(root, name));
  const lifecyclePath = await writeLifecycleFixture({ root, steps });
  const verified = await readInstallLifecycle(lifecyclePath);
  assert.equal(verified.status, 'VERIFIED');
  assert.equal(verified.code, null);
  assert.deepEqual(verified.missingSteps, []);
  assert.deepEqual(verified.failedSteps, []);
  for (const name of REQUIRED) {
    assert.equal(verified.steps[name].status, 'VERIFIED');
    assert.equal(verified.steps[name].stepFileDigestVerified, true);
  }
  const statePath = join(root, 'longrun.json');
  const report = await runW10Evidence({ statePath, skipDrills: true, installLifecyclePath: lifecyclePath, expectedRunCount: 1 });
  assert.equal(report.install.lifecycle.status, 'VERIFIED');
  assert.equal(report.install.missing.includes('installLog'), false);
  assert.equal(report.blockingReasons.includes('INSTALL_LIFECYCLE_EVIDENCE_MISSING'), false);
  assert.equal(report.blockingReasons.includes('INSTALL_LIFECYCLE_STEP_ASSERTION_FAILED'), false);
});

test('install lifecycle evidence rejects fabricated, partial and tampered records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-w10-lifecycle-bad-'));
  const partial = [await writeStep(root, 'upgrade'), await writeStep(root, 'rollback')];
  const partialPath = await writeLifecycleFixture({ root, steps: partial });
  const incomplete = await readInstallLifecycle(partialPath);
  assert.equal(incomplete.status, 'INCOMPLETE');
  assert.equal(incomplete.code, 'INSTALL_LIFECYCLE_EVIDENCE_INCOMPLETE');
  assert.deepEqual(incomplete.missingSteps, ['install', 'migration', 'uninstall']);

  const tamperedRoot = await mkdtemp(join(tmpdir(), 'hmcodex-w10-lifecycle-tamper-'));
  const steps = [];
  for (const name of REQUIRED) {
    steps.push(name === 'rollback'
      ? await writeStep(tamperedRoot, name, { assertions: [{ name: 'fullLocalRestoredByteIdentical', ok: false }] })
      : await writeStep(tamperedRoot, name));
  }
  const tamperedPath = await writeLifecycleFixture({ root: tamperedRoot, steps });
  const failed = await readInstallLifecycle(tamperedPath);
  assert.equal(failed.status, 'INCOMPLETE');
  assert.equal(failed.code, 'INSTALL_LIFECYCLE_STEP_ASSERTION_FAILED');
  assert.deepEqual(failed.failedSteps, ['rollback']);
  assert.equal(failed.steps.rollback.status, 'REJECTED');
  const statePath = join(tamperedRoot, 'longrun.json');
  const report = await runW10Evidence({ statePath, skipDrills: true, installLifecyclePath: tamperedPath, expectedRunCount: 1 });
  assert.ok(report.blockingReasons.includes('INSTALL_LIFECYCLE_STEP_ASSERTION_FAILED'));
  assert.ok(report.install.missing.includes('rollbackLog'));
  assert.equal(report.install.missing.includes('installLog'), false);

  const unElevatedRoot = await mkdtemp(join(tmpdir(), 'hmcodex-w10-lifecycle-unelevated-'));
  const unElevatedSteps = [];
  for (const name of REQUIRED) unElevatedSteps.push(await writeStep(unElevatedRoot, name));
  const unElevatedPath = join(unElevatedRoot, 'lifecycle.json');
  await writeFile(unElevatedPath, JSON.stringify({
    artifact: 'WINDOWS_PHASE2_INSTALL_LIFECYCLE',
    evidenceClass: 'REAL_EXECUTION',
    elevated: false,
    steps: unElevatedSteps
  }), 'utf8');
  const unElevated = await readInstallLifecycle(unElevatedPath);
  assert.equal(unElevated.code, 'INSTALL_LIFECYCLE_EVIDENCE_INVALID');
  assert.equal(unElevated.reason, 'NOT_ELEVATED');
});

test('the evidence record names the physical store file it read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hmcodex-w10-store-identity-'));
  const statePath = join(root, 'longrun.json');
  const storePath = join(root, 'store.db');
  await createHarnessEventStore({ storagePath: storePath }).load();
  const report = await runW10Evidence({ statePath, storePath, skipDrills: true });
  assert.equal(report.execution.evidenceStore, storePath);
  assert.equal(report.execution.storeIdentity.requestedPath, storePath);
  assert.equal(report.execution.storeIdentity.exists, true);
  assert.ok(report.execution.storeIdentity.sizeBytes > 0);
  const withoutStore = await runW10Evidence({ statePath: join(root, 'empty-longrun.json'), skipDrills: true });
  assert.deepEqual(withoutStore.execution.storeIdentity, { requestedPath: null, exists: false });
});
