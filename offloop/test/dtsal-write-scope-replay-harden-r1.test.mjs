import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { STEAL_TIP_PIN } from '../path-signals.mjs';

const OFFLOOP = fileURLToPath(new URL('../', import.meta.url));
const ROOT = path.dirname(OFFLOOP.replace(/\/$/, ''));
const KNIFE = 'dtsal-write-scope-replay-harden-r1';
const OUT = path.join(OFFLOOP, `out-${KNIFE}`);
const LIVE = path.join(OFFLOOP, 'out-dayloop-tip-soft-adopt-live-r1');
const HARNESS = path.join(LIVE, 'tip-soft-adopt-live.mjs');
const NODE = '/home/box/.local/node24/bin/node';
const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const LOCK = '8809beb7a2bb471b8731c62ec8106a32abc10f10ea200c5d2d3b0aa5107b9cc3';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = file => digest(fs.readFileSync(file));
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonl = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const save = (name, value) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(value, null, 2) + '\n');

function assertAuthority() {
  const session = json(path.join(OUT, 'session-start.json'));
  for (const [name, expected] of Object.entries(session.authorityMustNotFlip)) {
    assert.equal(sha(path.join(LIVE, name)), expected, `${name}: immutable session authority/source MATCH`);
  }
  const evidence = json(path.join(LIVE, 'adopt-evidence.json'));
  assert.equal(evidence.adopt, true, 'wave8 adopt=true SCAN is not reopened');
  assert.equal(evidence.result, 'success', 'write scope cannot flip TRANSPORT');
  assert.equal(evidence.tipSha, PIN);
  assert.equal(evidence.realBurnCount, 1);
  return evidence;
}

function runGuarded(label, scope, args) {
  const dir = path.join(OUT, label);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['scope-denials.jsonl', 'offline-processes.jsonl']) fs.writeFileSync(path.join(dir, name), '');
  const stdoutPath = path.join(OUT, `${label}.tap`);
  const stderrPath = path.join(dir, 'stderr.txt');
  const fds = [fs.openSync(stdoutPath, 'w'), fs.openSync(stderrPath, 'w')];
  const env = { ...process.env, NODE_OPTIONS: '', TMPDIR: path.join(dir, 'tmp'),
    DDA_DWSR_SCOPE: scope, DDA_DWSR_RUN_DIR: dir, DDA_OFFLOOP_REAL_LIVE: '',
    OFFLOOP_DAYLOOP_SOFT: '', DDA_OFFLOOP_DAYLOOP_SOFT: '', GIT_OPTIONAL_LOCKS: '0' };
  delete env.NODE_TEST_CONTEXT;
  for (const name of Object.keys(env)) if (/KEY|TOKEN|SECRET|PASSWORD|SESSION/i.test(name)) delete env[name];
  let child;
  try {
    child = spawnSync(NODE, ['--require', path.join(OUT, 'offline-guard.cjs'), ...args], {
      cwd: OFFLOOP, env, stdio: ['ignore', ...fds], timeout: 60_000,
    });
  } finally { for (const fd of fds) fs.closeSync(fd); }
  assert.equal(child.error, undefined, `${label}: child executes`);
  assert.equal(child.signal, null, `${label}: no timeout/signal`);
  const processes = jsonl(path.join(dir, 'offline-processes.jsonl'));
  assert.ok(processes.some(row => row.pid === child.pid), `${label}: root offline guard installed`);
  for (const row of processes) {
    assert.equal(row.scope, scope);
    assert.deepEqual(row.counts, { fetch: 0, socket: 0, liveSubprocess: 0 }, `${label}: zero network/burn attempts`);
  }
  return { status: child.status, stdout: fs.readFileSync(stdoutPath, 'utf8'),
    stderr: fs.readFileSync(stderrPath, 'utf8'), processes,
    denials: jsonl(path.join(dir, 'scope-denials.jsonl')) };
}

const testArgs = pattern => ['--test', '--test-reporter=tap', '--test-isolation=none',
  `--test-name-pattern=${pattern}`, 'test/dayloop-tip-soft-adopt-live-r1.test.mjs'];
function assertPassed(run, ids) {
  assert.equal(run.status, 0, `guarded TAP must pass: ${run.stderr}`);
  for (const id of ids) assert.match(run.stdout, new RegExp(`^ok \\d+ - ${id}:`, 'm'));
  assert.match(run.stdout, /^# fail 0$/m);
  assert.match(run.stdout, new RegExp(`^# pass ${ids.length}$`, 'm'));
  assert.deepEqual(run.denials, [], 'green run has no write-scope denials');
}

function assertGuardedAttempts(run, replayExit) {
  assert.deepEqual(run.processes.filter(row => row.argv[1] === HARNESS)
    .map(row => ({ replay: row.argv.includes('--replay'), exitCode: row.exitCode })), [
    { replay: false, exitCode: 2 }, { replay: false, exitCode: 2 }, { replay: true, exitCode: replayExit },
  ], 'offline preload reaches each actual default/marker/replay child');
}

// Attribute only this observed replay failure. An exit 2 or preload name alone is insufficient.
function classifyForeign(run, deniedFile) {
  if (run.status !== 1 || !/^not ok \d+ - T-dtsal-1:/m.test(run.stdout)
      || !/^# fail 1$/m.test(run.stdout) || !/2 !== 0/.test(run.stdout)) return null;
  const denial = run.denials.find(row => row.code === 'ERR_TEST_WRITE_SCOPE'
    && row.policy === 'foreign' && row.operation === 'copyFileSync' && row.file === deniedFile
    && row.argv[1] === HARNESS && row.argv.includes('--replay')
    && run.processes.some(child => child.pid === row.pid && child.exitCode === 2
      && child.argv[1] === HARNESS && child.argv.includes('--replay')));
  return denial ? 'ENVIRONMENT / WRITE_SCOPE' : null;
}

test('T-dwsr-1: knife allow-list replay is green; foreign deny is ENVIRONMENT / WRITE_SCOPE with unchanged adopt authority', t => {
  const evidence = assertAuthority();
  const allowed = runGuarded('allow-list', 'local', testArgs('^T-dtsal-1:'));
  assertPassed(allowed, ['T-dtsal-1']);
  assertGuardedAttempts(allowed, 0);
  assert.ok(allowed.processes.some(row => row.argv[1] === path.join(evidence.root, 'offloop/on-closed.mjs')
    && row.exitCode === 0 && row.scope === 'local'), 'local scope reaches the copied CLI through cleanEnv');
  const replay = json(path.join(LIVE, 'replay-evidence.json'));
  assert.equal(replay.adopt, true);
  assert.equal(replay.result, 'success');
  assert.equal(replay.tipSha, PIN);
  assert.deepEqual(replay.cliNetworkCalls, { fetch: 0, socket: 0, curl: 0, otherSubprocess: 0 });
  for (const [name, expected] of Object.entries(json(path.join(OUT, 'session-start.json')).lockedProductHashes)) {
    assert.equal(sha(path.join(evidence.root, 'offloop', name)), expected);
  }
  assertAuthority();

  const foreign = runGuarded('foreign-scope-repro', 'foreign', testArgs('^T-dtsal-1:'));
  assertGuardedAttempts(foreign, 2);
  const deniedFile = path.join(evidence.root, 'offloop/dayloop-soft.mjs');
  assert.equal(foreign.denials.length, 1, 'one current-run denial, no stale diagnostics');
  assert.equal(classifyForeign(foreign, deniedFile), 'ENVIRONMENT / WRITE_SCOPE');
  // Negative controls: never convert generic failures, stale/wrong-path denials, or PIN errors into environment success.
  for (const changed of [
    { denials: [] }, { processes: [] }, { status: 2 },
    { stdout: foreign.stdout.replace('2 !== 0', 'tip_pin_mismatch') },
    { denials: foreign.denials.map(row => ({ ...row, code: 'ERR_ASSERTION' })) },
    { denials: foreign.denials.map(row => ({ ...row, file: path.join(OFFLOOP, 'dayloop-soft.mjs') })) },
    { denials: foreign.denials.map(row => ({ ...row, pid: -1 })) },
  ]) assert.equal(classifyForeign({ ...foreign, ...changed }, deniedFile), null);
  assertAuthority();
  fs.writeFileSync(path.join(OUT, 'scope-denials.jsonl'), foreign.denials.map(row => JSON.stringify(row)).join('\n') + '\n');

  const plain = runGuarded('without-write-scope', 'none', testArgs('^T-dtsal-1:'));
  assertPassed(plain, ['T-dtsal-1']);
  assertGuardedAttempts(plain, 0);
  assertAuthority();
  save('attribution-demo.json', {
    knife: KNIFE, classification: 'ENVIRONMENT / WRITE_SCOPE', fixture: 'foreign-style; original foreign knife untouched',
    allowedScope: { status: allowed.status, pass: 1 },
    foreignScope: { status: foreign.status, expectedTapFail: 1, replayExit: 2, denial: foreign.denials[0] },
    withoutWriteScope: { status: plain.status, pass: 1 },
    authorityUnchanged: true, adopt: true, result: 'success', tipPin: PIN,
    genericFailuresStillFail: true, realBurnNetworkCalls: 0,
  });
  t.diagnostic('ENVIRONMENT / WRITE_SCOPE: foreign fixture denies replay copyFileSync, child exit=2; expected raw TAP 0/1 retained. Local allow-list and no write-scope T-dtsal-1 PASS; default/marker/replay network=0; adopt=true, success, PIN and authority MATCH.');
});

test('T-dwsr-2: PIN, all product/authority hashes and §0 stay fixed; freeze/bench FROZEN handoff or independent SCAN CLOSED; guarded T-dtsal-2/3 remain green', t => {
  const session = json(path.join(OUT, 'session-start.json'));
  assert.equal(session.knife, KNIFE);
  assert.equal(session.tipPin, PIN);
  assert.equal(STEAL_TIP_PIN, PIN);
  assert.equal(session.freezeLockSha256, LOCK);
  assert.equal(session.productWrites, 0);
  assert.equal(session.runtimeWrites, 0);
  assert.equal(session.selfClosed, false);
  assert.equal(fs.readFileSync(path.join(OUT, 'tip-head.txt'), 'utf8').trim(), PIN);
  const head = spawnSync('git', ['-C', '/workspace/dda-tip-r25', 'rev-parse', 'HEAD'], {
    cwd: OFFLOOP, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, encoding: 'utf8', timeout: 5000,
  });
  assert.equal(head.error, undefined);
  assert.equal(head.status, 0, 'tip HEAD is read, never replaced by an empty dual-green');
  assert.equal(head.stdout.trim(), PIN);
  const before = fs.readFileSync(path.join(OUT, 'before-hashes.txt'), 'utf8');
  const rows = before.trim().split('\n').map(line => {
    const match = line.match(/^([a-f0-9]{64})  ([^/]+\.mjs)$/);
    assert.ok(match, 'valid product hash row');
    return { name: match[2], sha256: match[1] };
  });
  const products = fs.readdirSync(OFFLOOP).filter(name => name.endsWith('.mjs')).sort();
  assert.ok(products.length > 0);
  assert.deepEqual(rows.map(row => row.name).sort(), products, 'every top-level product is covered');
  const assertProducts = () => {
    for (const row of rows) assert.equal(sha(path.join(OFFLOOP, row.name)), row.sha256, `${row.name}: NO_PRODUCT_DELTA`);
  };
  assertProducts();
  assert.equal(fs.readFileSync(path.join(OUT, 'after-hashes.txt'), 'utf8'), before);
  assertAuthority();
  const freeze = fs.readFileSync(path.join(ROOT, `freeze-offloop-${KNIFE}.md`), 'utf8');
  // Codex hands off FROZEN; independent SCAN may flip to CLOSED — PASS（NO_PRODUCT_DELTA）.
  const title = freeze.split('\n')[0];
  const status = freeze.split('\n').find(line => line.startsWith('- **状态：'));
  assert.equal(typeof status, 'string', 'one freeze 状态');
  const titleBadge = title.match(/\*\*([^*]+)\*\*\s*$/)?.[1] ?? '';
  const statusBadge = status.match(/^\-\s+\*\*状态[：:]\s*([^*\n]+)\*\*/)?.[1] ?? '';
  const frozenHandoff = /^FROZEN \/ (?:开干|SCAN READY)(?:[（(]|$)/.test(titleBadge)
    && /^FROZEN \/ (?:开干|SCAN READY)(?:[（(]|$)/.test(statusBadge)
    && !/\bCLOSED\b/.test(`${titleBadge}\n${statusBadge}`);
  const scanClosed = /^CLOSED — PASS(?:\s*[（(]NO_PRODUCT_DELTA[）)]|\s*·\s*NO_PRODUCT_DELTA)\s*$/.test(titleBadge)
    && /^CLOSED — PASS\b/.test(statusBadge)
    && (/独立 SCAN/.test(freeze) || /[（(]SCAN\s*·/.test(status));
  assert.ok(frozenHandoff || scanClosed, 'FROZEN handoff or independent SCAN CLOSED — PASS · NO_PRODUCT_DELTA');
  const lock = freeze.match(/^## 0\. 锁定\n[\s\S]*?(?=^## 1\.)/m)?.[0];
  assert.equal(typeof lock, 'string');
  assert.equal(digest(lock), LOCK, 'entire §0 including product-value gloss stays byte-identical');
  const bench = fs.readFileSync(path.join(ROOT, `bench-log-offloop-${KNIFE}.md`), 'utf8');
  const benchStatuses = [...bench.matchAll(/^- Status: \*\*([^*\n]+)\*\*/gm)];
  assert.equal(benchStatuses.length, 1, 'one bench Status');
  const benchFrozen = benchStatuses[0][1] === 'FROZEN / SCAN READY';
  const benchClosed = /^CLOSED — PASS(?:\s*[（(]NO_PRODUCT_DELTA[）)]|\s*·\s*NO_PRODUCT_DELTA)\s*$/.test(benchStatuses[0][1])
    && /独立 SCAN/.test(bench);
  assert.ok(benchFrozen || benchClosed, 'bench FROZEN handoff or independent SCAN CLOSED');
  assert.match(bench, /`selfClosed=false`/);
  assert.doesNotMatch(bench, /selfClosed\s*=\s*true/);
  const snapshot = json(path.join(OUT, 'before-source-integrity.json'));
  for (const row of snapshot.filter(row => !row.file.endsWith(`${KNIFE}.md`))) {
    assert.equal(sha(path.join(ROOT, row.file)), row.sha256, `${row.file}: existing sources/foreign knife unchanged`);
  }
  const scopeProbe = runGuarded('scope-boundaries', 'local', ['-e', `
const assert = require('node:assert/strict');
const { assertWritable } = require(${JSON.stringify(path.join(OUT, 'validation-write-scope.cjs'))});
for (const file of ${JSON.stringify([
    path.join(OFFLOOP, 'dayloop-soft.mjs'), '/workspace/dda-tip-r25/runtime',
    path.join(OFFLOOP, 'out-lifecycle-wave10-sibling-accept-r1/not-written'),
    path.join(LIVE, 'adopt-evidence.json'), path.join(LIVE, 'adopt-record.json'),
    path.join(LIVE, 'adopt-manifest.json'), path.join(LIVE, 'transport-record.json'),
    path.join(LIVE, 'real-burn-started.json'), HARNESS,
  ])}) assert.throws(() => assertWritable(file, 'read-only-policy-probe'), { code: 'ERR_TEST_WRITE_SCOPE' });
assertWritable(${JSON.stringify(path.join(OUT, 'allowed-evidence.json'))}, 'read-only-policy-probe');
assertWritable(${JSON.stringify(path.join(json(path.join(LIVE, 'adopt-manifest.json')).root, 'offloop/dayloop-soft.mjs'))}, 'read-only-policy-probe');
console.log('9 forbidden targets denied; knife evidence and dtsal temporary drive allowed; probe performed no target writes');
`]);
  assert.equal(scopeProbe.status, 0);
  assert.equal(scopeProbe.denials.length, 9);
  const controls = runGuarded('dtsal-controls', 'local', testArgs('^T-dtsal-[23]:'));
  assertPassed(controls, ['T-dtsal-2', 'T-dtsal-3']);
  assert.match(controls.stdout, /14 prior acceptance controls passed/);
  assertProducts();
  assertAuthority();
  save('invariants.json', { knife: KNIFE, tipPin: PIN, tipHead: head.stdout.trim(), productHashes: rows,
    productWrites: 0, runtimeWrites: 0, authorityUnchanged: true, freezeLockSha256: digest(lock),
    freezeTitle: title, freezeStatusLine: status, selfClosed: false, negativeControlsPassed: 2, priorControlsPassed: 14,
    policyBoundaryDenials: scopeProbe.denials.length });
  t.diagnostic('15/15 product hashes MATCH; authority/harness/original tests and wave8 freeze unchanged; tip HEAD=STEAL_TIP_PIN; §0 MATCH; freeze FROZEN|SCAN CLOSED; T-dtsal-2/3 PASS plus 14 prior offline controls.');
});
