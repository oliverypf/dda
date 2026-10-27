import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { runDayloopSoft } from '../dayloop-soft.mjs';
import { composeCandidate } from '../compose.mjs';
import { parseExperienceBody, retrieveExperience } from '../experience.mjs';
import { attachPrior, filterHypotheses, proposeFromIngest } from '../propose.mjs';
import { matchesMergedDirection } from '../merged-directions.mjs';
import { isArchivedOrShipped, isPendingCandidate } from '../candidate-archive.mjs';
import { STEAL_TIP_PIN } from '../path-signals.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'offloop/out-dayloop-transport-experience-live-persist-r1');
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const historicalPath = 'offloop/out-tip-soft-adopt-second-family-live-r1/transport-record.json';
const historical = JSON.parse(fs.readFileSync(path.join(root, historicalPath), 'utf8'));
const requestSha = '82a7a2dab9de482955b86fef7dae9fba2cc9e3e6a10d13681266296c21ca08af';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const relative = file => path.relative(root, file).split(path.sep).join('/');
const readExperience = file => parseExperienceBody(fs.readFileSync(file, 'utf8'), {
  file: path.basename(file), full: file,
});
const hypothesis = {
  id: 'H-dtelp', slug: 'experience-residual-cell-lesson', title: 'EXPERIENCE: residual observation',
  class: 'experience', probeKind: 'soft_or_latch_md',
  summary: 'Retain the hypothesis residual observation only.',
  evidence: [{ cellId: 't4/a', text: 'injected transport write-path control' }],
  tags: ['experience'], prior: [],
};
// Only these fields are input from the historical burn. Never invoke its adapter.
const metadata = {
  transportClass: historical.transportClass, requestSha256: historical.requestSha256,
  subjects: historical.subjects, elapsedMs: historical.elapsedMs,
};
const options = dir => ({
  fixture: 'soft-clean', tipSha: pin, date: '2026-10-26', outDir: dir,
  softWorktreeDir: path.join(dir, 'soft-worktree'), experienceDir: path.join(dir, 'experience'),
  l1Mode: 'live', l1Live: true, model: 'injected-no-network', jev: 'injected-no-network',
  l1Subjects: [...historical.subjects], liveStatus: 'TRANSPORT', transportError: 'TimeoutError',
  hypothesis: structuredClone(hypothesis), write: true,
});
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(file) : [file];
});

function guardIO(t) {
  const counts = { fetch: 0, socket: 0, tls: 0, subprocess: 0, candidateWriteAttempts: 0 };
  const blocked = key => () => { counts[key]++; assert.fail(`forbidden ${key} in injected API proof`); };
  t.mock.method(globalThis, 'fetch', blocked('fetch'));
  t.mock.method(net.Socket.prototype, 'connect', blocked('socket'));
  t.mock.method(tls, 'connect', blocked('tls'));
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
    t.mock.method(cp, name, blocked('subprocess'));
  }
  const writes = [];
  const originalWrite = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (file, body, ...args) {
    const full = path.resolve(file);
    assert.ok(full.startsWith(out + path.sep), `write escaped this knife: ${full}`);
    if (/^freeze-candidate-/.test(path.basename(full))) {
      counts.candidateWriteAttempts++;
      assert.fail('TRANSPORT must never attempt a CANDIDATE write');
    }
    const result = Reflect.apply(originalWrite, this, [file, body, ...args]);
    writes.push({ path: full, sha256: sha(body) });
    return result;
  });
  syncBuiltinESMExports();
  t.after(() => {
    assert.ok(Object.values(counts).every(value => value === 0), JSON.stringify(counts));
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { counts, writes };
}

function assertStopped(summary) {
  assert.equal(summary.ok, true);
  assert.equal(summary.tipSha, pin);
  assert.equal(summary.l1Mode, 'live');
  assert.equal(summary.l1LiveRequested, true);
  assert.equal(summary.results.length, 1);
  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.candidatePath, null);
  assert.equal(summary.frozenWrites, 0);
  const row = summary.results[0];
  assert.equal(row.adopt, false);
  assert.equal(row.wroteCandidate, false);
  assert.equal(row.candidatePath, null);
  assert.equal(row.reason, 'experience_only');
  assert.equal(row.l1.skipped, false);
  assert.equal(row.l1.adopt, false);
  assert.equal(row.l1.reason, 'transport');
  assert.equal(row.l1.softTreeFileListHash, null);
  assert.equal(fs.existsSync(summary.softWorktreeDir), false, 'stop before soft contrast / empty dual-green');
  return row;
}

function assertNoPromotion(proposal) {
  assert.ok(proposal.accepted.length > 0);
  assert.ok(proposal.accepted.length <= 3);
  for (const h of proposal.accepted) {
    assert.equal(h.class, 'experience');
    assert.notEqual(h.adopt, true);
    assert.notEqual(h.adopted, true);
    assert.notEqual(h.wroteCandidate, true);
    assert.equal(h.candidatePath ?? null, null);
    assert.ok(h.prior.length <= 3);
  }
}

function assertPrior(entry, experienceDir) {
  const ingest = { totals: {}, cells: historical.subjects.map(cellId => ({
    cellId, evidenceQuotes: [{ kind: 'observation', source: entry.path, text: entry.lesson }],
  })) };
  const proposals = [];
  for (const opts of [{ experienceDir }, { experienceEntries: [entry] }]) {
    const proposal = proposeFromIngest(ingest, opts);
    assertNoPromotion(proposal);
    assert.ok(proposal.experienceContext.some(e => e.slug === entry.slug && e.adopted === false));
    const attached = proposal.accepted.flatMap(h => h.prior).filter(p => p.slug === entry.slug);
    assert.ok(attached.length > 0, 'deposited lesson must reach Propose prior');
    for (const prior of attached) {
      assert.equal(prior.adopted, false);
      assert.equal(prior.reason, 'experience_only');
      assert.match(prior.lesson, /TRANSPORT \/ TimeoutError.*honest stop/);
      assert.ok(prior.lesson.includes(requestSha));
    }
    proposals.push(proposal);
  }
  return proposals;
}

test('T-dtelp-1: injected live TRANSPORT writes TimeoutError EXPERIENCE with request SHA; retrieve → warn-only Propose prior', t => {
  const io = guardIO(t);
  assert.equal(historical.result, 'TRANSPORT');
  assert.equal(historical.requestSha256, requestSha);
  assert.equal(historical.transportClass, 'TimeoutError');
  const dir = fs.mkdtempSync(path.join(out, 'api-proof-'));
  const call = { ...options(dir), transportRecord: structuredClone(metadata) };
  const inputBefore = JSON.stringify(call);
  const summary = runDayloopSoft(call);
  assert.equal(JSON.stringify(call), inputBefore, 'caller metadata stays unchanged');
  const row = assertStopped(summary);
  const entry = readExperience(row.experiencePath);
  assert.equal(entry.adopted, false);
  assert.equal(entry.rejectReason, 'experience_only');
  assert.match(entry.lesson, /TRANSPORT \/ TimeoutError: honest stop; no usable L1 contrast/);
  assert.match(entry.lesson, /Warn\/prior only; not adopt=true or CANDIDATE authorization/);
  assert.notEqual(entry.lesson, hypothesis.summary);
  assert.ok(entry.lesson.includes(requestSha));
  assert.match(entry.body, /\*\*requestSha256\*\*: 82a7a2da/);
  assert.match(entry.body, /\*\*subjects\*\*: t4\/a, t4\/b/);
  assert.match(entry.body, /\*\*elapsedMs\*\*: 50059/);
  assert.match(path.basename(row.experiencePath), /^2026-10-26-/);
  const hits = retrieveExperience(path.dirname(row.experiencePath), { query: 'TRANSPORT TimeoutError' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, row.experiencePath);
  assert.equal(hits[0].adopted, false);
  const proposals = assertPrior(entry, path.dirname(row.experiencePath));
  assert.deepEqual(walk(dir), [row.experiencePath], 'the only persisted artifact is the product-written EXPERIENCE');
  const productWrites = io.writes.filter(write => write.path === row.experiencePath);
  assert.equal(productWrites.length, 1, 'observe a new product write, not a pre-existing fixture');
  assert.equal(productWrites[0].sha256, sha(fs.readFileSync(row.experiencePath)));
  const liveWritePathProven = productWrites.length === 1 && hits.length > 0 &&
    proposals.every(p => p.accepted.some(h => h.prior.some(prior => prior.slug === entry.slug))) &&
    entry.adopted === false && summary.wroteCandidate === false;
  assert.equal(liveWritePathProven, true);
  const proof = {
    knife: 'dayloop-transport-experience-live-persist-r1', liveWritePathProven,
    proofKind: 'injected live-status product API write; local fixture inputs; no live burn or replay',
    productApi: 'runDayloopSoft → probeL1 transport stop → composeCandidate',
    historicalSource: historicalPath, historicalRequestUsedAsInputOnly: true,
    newLiveBurn: false, liveRequests: 0, replayExecutions: 0, mainOpenRouterCalls: 0,
    runtimeTipExecutions: 0, candidateWrites: 0, networkAndSubprocess: { ...io.counts },
    input: { liveStatus: call.liveStatus, transportError: call.transportError, transportRecord: metadata },
    summary, productWriteCount: productWrites.length,
    experiencePath: relative(row.experiencePath), experienceSha256: productWrites[0].sha256,
    lessonExcerpt: entry.lesson, requestShaCitation: requestSha, adopted: entry.adopted,
    reason: entry.rejectReason, retrieval: hits.map(({ slug, adopted, reason, score }) => ({ slug, adopted, reason, score })),
    proposePriors: proposals[0].accepted.map(({ slug, class: kind, prior }) => ({ slug, class: kind, prior })),
    selfClosed: false, freezeStatus: 'FROZEN / 开干',
  };
  fs.writeFileSync(path.join(out, 'live-write-proof.json'), JSON.stringify(proof, null, 2) + '\n');
});

test('T-dtelp-2: aepp/ttep/etpl, diversity and archive refuse promotion; PIN, authority, product deltas and FROZEN lock hold', t => {
  const aepp = readExperience(path.join(root, 'offloop/out-dayloop-tip-soft-adopt-live-r1/temporary-miss-drive-t2H55F/out/experience/2026-10-25-experience-dgr-promote-observed-rejected.md'));
  const ttep = readExperience(path.join(root, 'offloop/out-transport-timeout-experience-prior-r1/experience/2026-10-26-experience-transport-timeout-honest-stop-rejected.md'));
  const etpl = json(path.join(root, 'offloop/out-experience-transport-prior-live-wire-r1/no-product-delta.json'));
  assert.equal(etpl.liveWritePathProven, false, 'historical STOP stays historical STOP');
  assert.equal(etpl.stop, true);
  const crowded = Array.from({ length: 6 }, (_, i) => parseExperienceBody(
    `# EXPERIENCE — sticky control\n- **slug**: post-dpr-sticky-execute-${i}\n- **adopted_candidate**: no (experience_only)\n- **lesson**: poison-loop sticky post-dpr soft latch dayloop soft-reject recurrence.\n`));
  for (const source of [aepp, ttep]) {
    assert.equal(source.adopted, false);
    assert.equal(source.reason, 'experience_only');
    const p = proposeFromIngest({ totals: { poisonLoopCount: 1 }, cells: [] }, { experienceEntries: [...crowded, source] });
    assert.equal(p.experienceContext.length, 5);
    assert.ok(p.experienceContext.every(e => /sticky/.test(e.slug)));
    const h = p.accepted.find(h => !matchesMergedDirection(h));
    assert.ok(h, 'library diversity survives a full sticky retrieval cap');
    assert.equal(h.class, 'experience');
    const prior = h.prior.find(item => item.slug === source.slug);
    assert.equal(prior?.adopted, false);
    assert.equal(prior?.reason, 'experience_only');
  }
  const hard = parseExperienceBody('# EXPERIENCE — hard gate\n- **slug**: soft-hard-gate\n- **adopted_candidate**: no (hard_gate_path)\n- **lesson**: Soft rejection is warning evidence only.\n');
  assert.equal(attachPrior({ class: 'soft_layer' }, [{ ...hard, adopted: true }]).prior[0].adopted, false);
  const rejected = filterHypotheses(['host_code_patch', 'host_latch_adopt', 'host_code_patch_adopt'].map(kind => ({
    id: kind, slug: kind, title: 'Invalid promotion', class: kind, prior: [hard],
    evidence: [{ kind: 'experience', text: hard.lesson }],
  })));
  assert.deepEqual(rejected.accepted, []);
  assert.equal(rejected.rejected.length, 3);
  for (const marker of ['ARCHIVED', 'SHIPPED', '挂着']) {
    for (const [title, banner] of [[marker, 'CANDIDATE'], ['CANDIDATE', marker]]) {
      const body = `# Draft：**${title}**\n- **状态：${banner}（勿开干）。**\n`;
      assert.equal(isArchivedOrShipped(body), true);
      assert.equal(isPendingCandidate(body), false);
    }
  }
  assert.equal(isPendingCandidate('# Draft：**CANDIDATE**\n'), true);
  assert.equal(STEAL_TIP_PIN, pin);
  assert.equal(fs.readFileSync(path.join(out, 'tip-head.txt'), 'utf8').trim(), pin);
  assert.equal(cp.execFileSync('git', ['-C', '/workspace/dda-tip-r25', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), pin);
  const session = json(path.join(out, 'session-start.json'));
  assert.equal(session.tipPin, pin);
  const freeze = fs.readFileSync(path.join(root, 'freeze-offloop-dayloop-transport-experience-live-persist-r1.md'), 'utf8');
  // Codex hands off FROZEN; independent SCAN may flip to CLOSED — PASS（PRODUCT_DELTA）.
  const title = freeze.split('\n')[0];
  const status = freeze.split('\n').find(line => line.startsWith('- **状态：'));
  assert.equal(typeof status, 'string', 'one freeze 状态');
  const titleBadge = title.match(/\*\*([^*]+)\*\*\s*$/)?.[1] ?? '';
  const statusBadge = status.match(/^\-\s+\*\*状态[：:]\s*([^*\n]+)\*\*/)?.[1] ?? '';
  const frozenHandoff = /^FROZEN \/ (?:开干|SCAN READY)(?:[（(]|$)/.test(titleBadge)
    && /^FROZEN \/ (?:开干|SCAN READY)(?:[（(]|$)/.test(statusBadge)
    && !/\bCLOSED\b/.test(`${titleBadge}\n${statusBadge}`)
    && sha(freeze) === session.freezeSha256AtStart;
  const scanClosed = /^CLOSED — PASS(?:\s*[（(]PRODUCT_DELTA[）)]|\s*·\s*PRODUCT_DELTA)\s*$/.test(titleBadge)
    && /^CLOSED — PASS\b/.test(statusBadge)
    && (/独立 SCAN/.test(freeze) || /[（(]SCAN\s*·/.test(status));
  assert.ok(frozenHandoff || scanClosed, 'FROZEN handoff or independent SCAN CLOSED — PASS · PRODUCT_DELTA');
  const lock = freeze.slice(freeze.indexOf('## 0. 锁定\n'), freeze.indexOf('## 1. 不做')).trimEnd() + '\n';
  assert.equal(sha(lock), session.freezeLockSha256);
  assert.equal(session.freezeLockSha256, '11c13651c69fb14237ed28c54ba718e07af0d3dd7e7b3ad1d3149583c8c87f15');
  const bench = fs.readFileSync(path.join(root, 'bench-log-offloop-dayloop-transport-experience-live-persist-r1.md'), 'utf8');
  const benchStatuses = [...bench.matchAll(/^- Status: \*\*([^*\n]+)\*\*/gm)];
  assert.equal(benchStatuses.length, 1, 'one bench Status');
  const benchFrozen = benchStatuses[0][1] === 'FROZEN / SCAN READY';
  const benchClosed = /^CLOSED — PASS(?:\s*[（(]PRODUCT_DELTA[）)]|\s*·\s*PRODUCT_DELTA)\s*$/.test(benchStatuses[0][1])
    && /独立 SCAN/.test(bench);
  assert.ok(benchFrozen || benchClosed, 'bench FROZEN handoff or independent SCAN CLOSED');
  assert.match(bench, /selfClosed=false/);
  assert.doesNotMatch(bench, /selfClosed\s*=\s*true/);
  for (const [file, hash] of Object.entries(json(path.join(out, 'authority-before.json')))) {
    assert.equal(sha(fs.readFileSync(path.join(root, file))), hash, `protected authority changed: ${file}`);
  }
  const parseHashes = name => Object.fromEntries(fs.readFileSync(path.join(out, name), 'utf8').trim().split('\n').map(line => {
    const [hash, file] = line.trim().split(/\s+/); return [file, hash];
  }));
  const before = parseHashes('before-hashes.txt'), after = parseHashes('after-hashes.txt');
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  const deltas = [];
  for (const [file, hash] of Object.entries(after)) {
    assert.equal(sha(fs.readFileSync(path.join(root, file))), hash);
    if (hash !== before[file]) {
      deltas.push(file);
      t.diagnostic(`${file} after=${hash} ← before=${before[file]}`);
    }
  }
  assert.deepEqual(deltas.sort(), ['offloop/compose.mjs', 'offloop/dayloop-soft.mjs']);
  const productSurface = json(path.join(out, 'product-surface-before.json'));
  assert.deepEqual(Object.keys(productSurface).sort(), fs.readdirSync(path.join(root, 'offloop')).filter(f => f.endsWith('.mjs')).map(f => `offloop/${f}`).sort());
  for (const [file, hash] of Object.entries(productSurface)) {
    if (!deltas.includes(file)) assert.equal(sha(fs.readFileSync(path.join(root, file))), hash, file);
  }
  assert.equal(json(path.join(out, 'live-write-proof.json')).liveWritePathProven, true);
  assert.deepEqual(walk(out).filter(file => /^freeze-candidate-.*\.md$/.test(path.basename(file))), []);
});

test('T-dtelp-3: original caller, Error objects and top-level metadata work; status-only and dry-run do not invent evidence', t => {
  guardIO(t);
  const base = fs.mkdtempSync(path.join(out, 'variants-'));
  const timeout = new Error('message must not be copied as transport evidence');
  timeout.name = 'TimeoutError';
  const cases = [
    { name: 'original-caller', extra: {}, citation: false, cls: 'TimeoutError' },
    { name: 'top-level', extra: { transportError: timeout, requestSha256: requestSha, elapsedMs: 50059 }, citation: true, cls: 'TimeoutError' },
    { name: 'status-only', extra: { transportError: undefined }, citation: false, cls: 'unspecified' },
    { name: 'error-only', extra: { liveStatus: undefined, transportError: timeout }, citation: false, cls: 'TimeoutError' },
  ];
  for (const c of cases) {
    const summary = runDayloopSoft({ ...options(path.join(base, c.name)), ...c.extra });
    const row = assertStopped(summary);
    const entry = readExperience(row.experiencePath);
    assert.ok(entry.lesson.includes(`TRANSPORT / ${c.cls}: honest stop`));
    assert.equal(entry.body.includes(requestSha), c.citation);
    assert.doesNotMatch(entry.body, /message must not be copied/);
    if (!c.citation) assert.match(entry.body, /\*\*requestSha256\*\*: n\/a \(not supplied\)/);
  }
  // The tip-soft adapter leaves Propose in charge of hypothesis selection.
  const automatic = runDayloopSoft({ ...options(path.join(base, 'automatic-propose')), hypothesis: undefined });
  assert.ok(automatic.results.length > 0);
  assert.equal(automatic.wroteCandidate, false);
  for (const row of automatic.results) {
    assert.equal(row.adopt, false);
    assert.equal(row.l1.adopt, false);
    assert.equal(row.l1.reason, 'transport');
    assert.equal(row.reason, 'experience_only');
    assert.equal(row.candidatePath, null);
    assert.match(readExperience(row.experiencePath).lesson, /TRANSPORT \/ TimeoutError: honest stop/);
  }
  assert.equal(fs.existsSync(automatic.softWorktreeDir), false);
  for (const noWrite of [{ write: false }, { dryRun: true }]) {
    const dir = path.join(base, noWrite.dryRun ? 'dry-run' : 'write-false');
    const summary = runDayloopSoft({ ...options(dir), ...noWrite, transportRecord: metadata });
    const row = assertStopped(summary);
    assert.equal(row.experiencePath, null);
    assert.equal(fs.existsSync(dir), false);
  }
});

test('T-dtelp-4: Compose rejects contradictory adoption on TRANSPORT; metadata alone grants no transport or adoption authority', t => {
  guardIO(t);
  const soft = { ...hypothesis, slug: 'host-note-transport-control', class: 'soft_layer' };
  const stopped = { level: 'L1', skipped: false, enabled: true, reason: 'transport', transport: 'TRANSPORT', adopt: true };
  for (const probeResult of [stopped, { adopt: true, l1: stopped }]) {
    const result = composeCandidate({ hypothesis: soft, probeResult, write: false,
      transportRecord: { ...metadata, adopt: true, result: 'success', credential: 'must-not-persist' } });
    assert.equal(result.wroteCandidate, false);
    assert.equal(result.candidatePath, null);
    assert.equal(result.reason, 'experience_only');
    const entry = parseExperienceBody(result.experienceBody);
    assert.equal(entry.adopted, false);
    assert.ok(entry.lesson.includes(requestSha));
    assert.doesNotMatch(entry.body, /must-not-persist/);
  }
  const ordinary = composeCandidate({ hypothesis: soft, probeResult: { adopt: false }, transportRecord: metadata, write: false });
  assert.equal(ordinary.wroteCandidate, false);
  assert.equal(parseExperienceBody(ordinary.experienceBody).lesson, soft.summary);
  assert.doesNotMatch(ordinary.experienceBody, /\*\*transport_result\*\*|82a7a2da/);
  for (const [probeResult, reason] of [
    [{ adopt: true, falseWin: true, l1: stopped }, 'false_win'],
    [{ adopt: true, reason: 'hard_gate_path', l1: stopped }, 'hard_gate_path'],
  ]) {
    const result = composeCandidate({ hypothesis: soft, probeResult, transportRecord: metadata, write: false });
    assert.equal(result.reason, reason, 'existing rejection priorities stay intact');
    assert.equal(result.wroteCandidate, false);
    assert.equal(parseExperienceBody(result.experienceBody).adopted, false);
  }
});
