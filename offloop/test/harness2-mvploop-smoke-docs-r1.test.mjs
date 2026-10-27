import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TIP_PIN } from '../bin/offloop.mjs';

const OFFLOOP = fileURLToPath(new URL('../', import.meta.url));
const PRODUCT_ROOT = path.resolve(OFFLOOP, '..');
const SMOKE = path.join(OFFLOOP, 'scripts', 'mvp-smoke.mjs');
const README = path.join(OFFLOOP, 'README.md');
const MVP_DOC = path.join(OFFLOOP, 'docs', 'mvp-loop.md');
const GATE_DOC = path.join(OFFLOOP, 'docs', 'human-pr-gate.md');
const PACKAGE = path.join(OFFLOOP, 'package.json');

const DEFERRED_LIVE_TESTS = [
  'dayloop-live-bounded-expand-r1.test.mjs',
  'dayloop-opt-in-real-live-smoke-r1.test.mjs',
  'dayloop-tip-soft-adopt-live-r1.test.mjs',
  'dayloop-tip-soft-contrast-live-r1.test.mjs',
  'dayloop-transport-experience-live-persist-r1.test.mjs',
  'experience-transport-prior-live-wire-r1.test.mjs',
  'probe-l1-live-bounded-r1.test.mjs',
  'tip-soft-adopt-fifth-family-live-r1.test.mjs',
  'tip-soft-adopt-fourth-family-live-r1.test.mjs',
  'tip-soft-adopt-second-family-live-r1.test.mjs',
  'tip-soft-adopt-t4-retry-live-r1.test.mjs',
  'tip-soft-adopt-third-family-live-r1.test.mjs',
];

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness2-mvploop-smoke-docs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function readDocs() {
  return {
    readme: fs.readFileSync(README, 'utf8'),
    mvp: fs.readFileSync(MVP_DOC, 'utf8'),
    gate: fs.readFileSync(GATE_DOC, 'utf8'),
  };
}

function runSmoke(outDir) {
  const child = spawnSync(process.execPath, [SMOKE, '--out-dir', outDir], {
    cwd: PRODUCT_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      DDA_TIP_REPO: PRODUCT_ROOT,
      MAIN_OPENROUTER_CALLS: '0',
    },
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.signal || 'smoke must exit normally');
  return child;
}

test('T-H2-K5-MVP-MISS: fixture smoke invokes bounded MISS and keeps EXPERIENCE/CANDIDATE evidence auditable', (t) => {
  const root = tempRoot(t);
  const outDir = path.join(root, 'out');
  const child = runSmoke(outDir);
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);

  const report = JSON.parse(fs.readFileSync(path.join(outDir, 'mvp-smoke-report.json'), 'utf8'));
  assert.equal(report.status, 'PASS');
  assert.equal(report.passKind, 'fixture-smoke');
  assert.equal(report.mode, 'fixture');
  assert.equal(report.liveOptIn, false);
  assert.deepEqual(report.environment, {
    status: 'SKIP',
    kind: 'live',
    reason: 'Live environment is intentionally skipped; fixture smoke PASS is recorded separately.',
  });
  assert.equal(report.tipSha, TIP_PIN);
  assert.equal(report.pinEqual, true);
  assert.equal(report.candidateWrites, 0);
  assert.equal(report.liveRequests, 0);
  assert.equal(report.mainOpenRouterCalls, 0);
  assert.equal(report.replayExecutions, 0);

  const experienceFiles = fs.readdirSync(path.join(outDir, 'experience'))
    .filter((name) => name.endsWith('.md'));
  assert.ok(experienceFiles.length > 0, 'fixture MISS must retain EXPERIENCE evidence');
  const evidence = fs.readFileSync(path.join(outDir, 'experience', experienceFiles[0]), 'utf8');
  assert.match(evidence, /^# EXPERIENCE/m);
  assert.match(evidence, /adopted_candidate/);
  assert.match(fs.readFileSync(MVP_DOC, 'utf8'), /run-from-miss/);
});

test('T-H2-K5-HUMAN-PR-GATE: docs keep CANDIDATE behind a human PR-only decision', () => {
  const { readme, mvp, gate } = readDocs();
  const text = `${readme}\n${mvp}\n${gate}`;
  assert.match(text, /CANDIDATE[\s\S]{0,180}PR/);
  assert.match(text, /no automatic write-back/i);
  assert.match(text, /auto-merge/i);
  assert.match(text, /CANDIDATE\s*(?:→|->)\s*FROZEN/i);
  assert.match(text, /adopted=false/);
  assert.match(text, /experience_only/);
  for (const item of ['tip', 'pin', 'DGR', 'hard gate', 'invariants', 'tests', 'diff']) {
    assert.match(text, new RegExp(item, 'i'), `review checklist must mention ${item}`);
  }
  assert.match(gate, /human[\s\S]{0,120}merge/i);
});

test('T-H2-K5-CI-LIVE-OPTIN: core entry is separate from the explicit live job and names all deferred tests', () => {
  const { mvp } = readDocs();
  const packageJson = JSON.parse(fs.readFileSync(PACKAGE, 'utf8'));
  assert.match(mvp, /npm --prefix offloop test/);
  assert.match(mvp, /git ls-files ['"]offloop\/out-\*['"]/);
  assert.match(mvp, /MAIN_OPENROUTER_CALLS=0/);
  assert.match(mvp, /workflow_dispatch/);
  assert.match(mvp, /LIVE_OPT_IN/);
  assert.match(mvp, /DDA_TIP_REPO/);
  assert.match(mvp, /DDA_LIVE_BENCH_ROOT/);
  assert.match(mvp, /node --test/);
  for (const file of DEFERRED_LIVE_TESTS) assert.match(mvp, new RegExp(file.replaceAll('.', '\\.'), 'g'));

  const coreEntry = mvp.indexOf('npm --prefix offloop test');
  const liveEntry = mvp.indexOf('node --test \\\n  offloop/test/');
  assert.ok(coreEntry >= 0 && liveEntry > coreEntry, 'core and live entries must be distinct');
  assert.match(packageJson.scripts.test, /! -name ['"]\*live\*['"]/);
  assert.match(packageJson.scripts['test:live'], /test\/\*live\*\.test\.mjs/);
});

test('T-H2-K5-NO-EMPTY: smoke schema has pin/counter fields and empty or implicit live cannot be PASS', (t) => {
  const { readme, mvp } = readDocs();
  const script = fs.readFileSync(SMOKE, 'utf8');
  for (const field of ['tipSha', 'pinEqual', 'candidateWrites', 'liveRequests', 'mainOpenRouterCalls']) {
    assert.match(script, new RegExp(field));
    assert.match(mvp, new RegExp(field));
  }
  assert.match(`${readme}\n${mvp}`, /empty tip/i);
  assert.match(`${readme}\n${mvp}`, /implicit live/i);

  const root = tempRoot(t);
  const emptyOut = path.join(root, 'empty-out');
  const child = spawnSync(
    process.execPath,
    [path.join(OFFLOOP, 'bin', 'offloop.mjs'), 'miss', '--fixture', '--tip-sha', '', '--out-dir', emptyOut],
    { cwd: PRODUCT_ROOT, encoding: 'utf8', env: { ...process.env, MAIN_OPENROUTER_CALLS: '0' } },
  );
  assert.notEqual(child.status, 0, 'empty tip must fail closed');
  assert.doesNotMatch(child.stdout, /"status":\s*"PASS"/);
  assert.match(child.stdout, /"pinEqual":\s*false/);
});
