import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClosedHook, resolveDayloopSoftFlag } from '../on-closed.mjs';
import { runDayloopSoft } from '../dayloop-soft.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIVE = path.resolve(__dirname, '../..');
const PIN = 'a9c0b357bb0340325a02b3b50378851e22ddb4d9';

/** T-ocs-1: CLOSED MISS + --dayloop-soft → dayloop invoked; shipped EXPERIENCE keeps tip+hash */
test('T-ocs-1: CLOSED MISS + dayloop-soft → dayloop invoked; shipped EXPERIENCE has tip+hash', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ocs1-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outDir = path.join(root, 'out');
  const softDir = path.join(root, 'swt');
  let dayloopCalls = 0;
  let missInvokerCalls = 0;

  const r = runClosedHook({
    runId: 60,
    benchLogPath: path.join(DRIVE, 'bench-log-run60.md'),
    drive: root,
    outDir,
    dayloopSoft: true,
    softWorktree: softDir,
    tipSha: PIN,
    dayloopFixture: 'soft-clean',
    // Real dayloop (fixture/sim) — also count calls
    dayloopRunner: (opts) => {
      dayloopCalls += 1;
      return runDayloopSoft(opts);
    },
    // If this fires, we wrongly fell through to run-from-miss
    invoker: () => {
      missInvokerCalls += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  assert.equal(r.decision.action, 'miss');
  assert.equal(r.dayloopSoft, true);
  assert.equal(r.dayloopInvoked, true);
  assert.equal(dayloopCalls, 1, 'dayloop must be invoked once');
  assert.equal(missInvokerCalls, 0, 'run-from-miss must not run when dayloop-soft handles MISS');
  assert.equal(r.invoked, true);
  assert.deepEqual(r.candidatePaths, [], 'shipped soft-green directions stay EXPERIENCE-only');
  assert.equal(r.dayloopSummary.wroteCandidate, false);
  assert.equal(r.dayloopSummary.frozenWrites, 0);
  const steal = r.dayloopSummary.results.find((result) => result.hypothesis === 'steal-post-amt-terminal-replan');
  assert.equal(steal.reason, 'shipped_duplicate');
  assert.equal(steal.l1.adopt, true);
  assert.ok(r.experiencePaths.includes(steal.experiencePath));
  assert.ok(fs.existsSync(steal.experiencePath));
  const body = fs.readFileSync(steal.experiencePath, 'utf8');
  assert.match(body, /^# EXPERIENCE/m);
  assert.match(body, /adopted_candidate.*no \(shipped_duplicate\)/);
  assert.doesNotMatch(body, /状态：\*\*FROZEN\*\*|r1：\*\*FROZEN\*\*/);
  assert.match(body, /tipShaBaseline/);
  assert.ok(body.includes(PIN));
  assert.match(body, /softTreeFileListHash/);
  assert.ok(/[a-f0-9]{64}/i.test(body));
  assert.ok(r.logPath && fs.existsSync(r.logPath));
  const log = fs.readFileSync(r.logPath, 'utf8');
  assert.match(log, /dayloop invoked.*yes/i);
});

/** T-ocs-1b: dry-run MISS + dayloop-soft wouldDayloopSoft without invoking */
test('T-ocs-1b: dry-run MISS + dayloop-soft → wouldDayloopSoft, 0× invoke', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ocs1b-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let dayloopCalls = 0;
  const r = runClosedHook({
    runId: 60,
    benchLogPath: path.join(DRIVE, 'bench-log-run60.md'),
    drive: root,
    dryRun: true,
    dayloopSoft: true,
    dayloopRunner: () => {
      dayloopCalls += 1;
      return { wroteCandidate: false, frozenWrites: 0, results: [] };
    },
  });
  assert.equal(r.decision.action, 'miss');
  assert.equal(r.wouldDayloopSoft, true);
  assert.equal(r.dayloopInvoked, false);
  assert.equal(r.invoked, false);
  assert.equal(dayloopCalls, 0);
});

/** T-ocs-2: all-green no anomaly → noop, 0× dayloop even with --dayloop-soft */
test('T-ocs-2: all-green + dayloop-soft → noop, 0× dayloop', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ocs2-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let dayloopCalls = 0;
  let missCalls = 0;
  const r = runClosedHook({
    runId: 68,
    benchLogPath: path.join(DRIVE, 'bench-log-run68.md'),
    drive: root,
    dayloopSoft: true,
    dayloopRunner: () => {
      dayloopCalls += 1;
      return { wroteCandidate: false, frozenWrites: 0, results: [] };
    },
    invoker: () => {
      missCalls += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(r.decision.action, 'noop');
  assert.equal(r.invoked, false);
  assert.equal(r.dayloopInvoked, false);
  assert.equal(dayloopCalls, 0, 'noop must not call dayloop');
  assert.equal(missCalls, 0, 'noop must not call run-from-miss');
  const log = fs.readFileSync(r.logPath, 'utf8');
  assert.match(log, /0×/);
  assert.match(log, /dayloop invoked.*no/i);
});

/** T-ocs-2b: path-anomaly ignores --dayloop-soft (still EXPERIENCE-only via run-from-miss) */
test('T-ocs-2b: path-anomaly + dayloop-soft → dayloop NOT invoked', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-ocs2b-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let dayloopCalls = 0;
  let missCalls = 0;
  const r = runClosedHook({
    runId: 99,
    benchLogPath: path.join(DRIVE, 'bench-log-run99.md'),
    drive: root,
    dryRun: true,
    dayloopSoft: true,
    dayloopRunner: () => {
      dayloopCalls += 1;
      return { wroteCandidate: false, frozenWrites: 0, results: [] };
    },
    invoker: () => {
      missCalls += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(r.decision.action, 'path-anomaly');
  assert.equal(r.wouldDayloopSoft, false);
  assert.equal(r.dayloopInvoked, false);
  assert.equal(dayloopCalls, 0);
  assert.ok(r.wouldArgv?.includes('--path-anomaly'));
});

test('T-ocs-env: OFFLOOP_DAYLOOP_SOFT=1 resolves flag', () => {
  assert.equal(resolveDayloopSoftFlag({ env: { OFFLOOP_DAYLOOP_SOFT: '1' } }), true);
  assert.equal(resolveDayloopSoftFlag({ env: { OFFLOOP_DAYLOOP_SOFT: '0' } }), false);
  assert.equal(resolveDayloopSoftFlag({ dayloopSoft: true, env: {} }), true);
  assert.equal(resolveDayloopSoftFlag({}), false);
});
