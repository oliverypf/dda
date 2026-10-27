import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBenchLog } from '../ingest.mjs';
import { decideClosedAction, runClosedHook } from '../on-closed.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIVE = path.resolve(__dirname, '../..');

test('T-h2h-1: CLOSED/GATE MISS → miss action with run-from-miss argv', () => {
  const bench = parseBenchLog(path.join(DRIVE, 'bench-log-run60.md'));
  assert.equal(bench.gateMiss, true);
  assert.ok(bench.redCells.length >= 1);
  const d = decideClosedAction(bench, { runId: 60 });
  assert.equal(d.action, 'miss');
  // live run60 jsonl void → --run60 fixture path; otherwise --run 60
  assert.ok(
    (d.argv[0] === '--run60' && d.argv.length === 1) ||
      (d.argv[0] === '--run' && d.argv[1] === '60'),
    `unexpected argv ${JSON.stringify(d.argv)}`,
  );
});

test('T-h2h-1: runClosedHook MISS dry-run would invoke (not noop)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h2h-miss-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const r = runClosedHook({
    runId: 60,
    benchLogPath: path.join(DRIVE, 'bench-log-run60.md'),
    drive: root,
    dryRun: true,
    outDir: path.join(root, 'out'),
  });
  assert.equal(r.decision.action, 'miss');
  assert.equal(r.invoked, false);
  assert.ok(r.wouldArgv?.includes('--run') || r.wouldArgv?.includes('--run60'));
  assert.ok(r.logPath && fs.existsSync(r.logPath));
});

test('T-h2h-2: CLOSED PASS + path-anomaly → path-anomaly argv', () => {
  const bench = parseBenchLog(path.join(DRIVE, 'bench-log-run99.md'));
  assert.equal(bench.gatePass || bench.closedPass, true);
  assert.equal(bench.hasPathAnomaly, true);
  const d = decideClosedAction(bench, { runId: 99 });
  assert.equal(d.action, 'path-anomaly');
  assert.deepEqual(d.argv, ['--run', '99', '--path-anomaly', '--allow-experience-only']);
});

test('T-h2h-2: all-green no path-anomaly → noop (0× run-from-miss)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'h2h-noop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bench = parseBenchLog(path.join(DRIVE, 'bench-log-run68.md'));
  assert.ok(bench.gatePass || bench.cells.every((c) => c.result === 'PASS'));
  assert.equal(bench.redCells.length, 0);
  // run68 notes lack agent_miss/DGR/tip-path/post_amt — treat as no anomaly
  assert.equal(bench.hasPathAnomaly, false, 'run68 should be no-anomaly for noop');
  const d = decideClosedAction(bench, { runId: 68 });
  assert.equal(d.action, 'noop');
  assert.equal(d.argv, null);

  let invokerCalls = 0;
  const r = runClosedHook({
    runId: 68,
    benchLogPath: path.join(DRIVE, 'bench-log-run68.md'),
    drive: root,
    invoker: () => {
      invokerCalls += 1;
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(r.decision.action, 'noop');
  assert.equal(r.invoked, false);
  assert.equal(invokerCalls, 0, 'noop must not call run-from-miss');
  assert.ok(r.logPath && fs.existsSync(r.logPath));
  const body = fs.readFileSync(r.logPath, 'utf8');
  assert.match(body, /0×/);
});
