import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runDayloopSoft } from '../dayloop-soft.mjs';
import { parseExperienceBody } from '../experience.mjs';
import { STEAL_TIP_PIN } from '../path-signals.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const knife = 'transport-experience-propose-prior-consume-r1';
const out = path.join(root, 'offloop', `out-${knife}`);
const pin = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const requestSha = '82a7a2dab9de482955b86fef7dae9fba2cc9e3e6a10d13681266296c21ca08af';
const sessionDir = '/tmp/codex-transport-experience-propose-prior-consume-r1';
const sha256 = value => createHash('sha256').update(value).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

function parseHashes(file) {
  return Object.fromEntries(fs.readFileSync(file, 'utf8').trim().split('\n').map(line => {
    const [hash, name] = line.trim().split(/\s+/);
    return [name, hash];
  }));
}

function transportOptions(runRoot) {
  return {
    fixture: 'soft-clean',
    outDir: runRoot,
    experienceDir: path.join(runRoot, 'experience'),
    softWorktreeDir: path.join(runRoot, 'soft-worktree'),
    date: '2026-10-27',
    tipSha: pin,
    l1Mode: 'live',
    l1Live: true,
    model: 'deepseek-v4.1-flash',
    jev: 'zen',
    liveStatus: 'TRANSPORT',
    transportError: 'TimeoutError',
    transportRecord: {
      transportClass: 'TimeoutError',
      requestSha256: requestSha,
      subjects: ['t4/a', 't4/b'],
      elapsedMs: 50059,
    },
    write: true,
  };
}

test('T-teppc-1: product write is followed by retrieveExperience → Propose prior consumption', () => {
  fs.mkdirSync(out, { recursive: true });
  const runRoot = fs.mkdtempSync(path.join(out, 'api-proof-'));
  const summary = runDayloopSoft(transportOptions(runRoot));
  const post = summary.postWriteProposal;

  assert.equal(summary.tipSha, pin);
  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.candidatePath, null);
  assert.equal(post?.ran, true);
  assert.ok(post.written.length >= 1, 'the injected transport stop must write EXPERIENCE');
  assert.ok(post.retrieved.length >= 1, 'the post-write retrieve must see a written lesson');
  assert.ok(post.consumedCount >= 1, 'the written lesson must be attached as a Propose prior');
  assert.equal(post.consumedOnlyWarnings, true);
  assert.equal(post.wroteCandidate, false);
  assert.equal(post.candidatePath, null);

  const hit = post.retrieved.find(entry =>
    entry.lesson.includes('TRANSPORT / TimeoutError') && entry.lesson.includes(requestSha));
  assert.ok(hit, 'post-write retrieval must preserve TimeoutError and request SHA');
  assert.equal(hit.adopted, false);
  assert.equal(hit.reason, 'experience_only');
  const consumed = post.consumed.find(entry =>
    entry.prior.lesson.includes('TRANSPORT / TimeoutError') && entry.prior.lesson.includes(requestSha));
  assert.ok(consumed, 'post-write Propose prior must carry the transport lesson');
  assert.equal(consumed.prior.adopted, false);
  assert.equal(consumed.prior.reason, 'experience_only');

  for (const result of summary.results) {
    assert.equal(result.adopt, false);
    assert.equal(result.wroteCandidate, false);
    assert.equal(result.postWritePriorConsumed, true);
    assert.ok(result.postWritePrior.every(prior => prior.adopted !== true));
  }

  const writtenFiles = post.written.map(entry => entry.path);
  assert.ok(writtenFiles.every(file => fs.existsSync(file)));
  const entry = parseExperienceBody(fs.readFileSync(hit.path, 'utf8'), {
    file: hit.file,
    full: hit.path,
  });
  assert.equal(entry.adopted, false);
  assert.equal(entry.rejectReason, 'experience_only');
  assert.match(entry.lesson, /TRANSPORT \/ TimeoutError/);
  assert.match(entry.lesson, new RegExp(requestSha));
  assert.deepEqual(walk(runRoot).filter(file => /freeze-candidate-.*\.md$/.test(path.basename(file))), []);
});
test('T-teppc-2: prior warnings stay non-adopted; PIN and the five-file baseline are stable', () => {
  const session = readJson(path.join(sessionDir, 'session-start.json'));
  const before = parseHashes(path.join(sessionDir, 'before-hashes.txt'));
  const files = [
    'offloop/experience.mjs',
    'offloop/compose.mjs',
    'offloop/dayloop-soft.mjs',
    'offloop/soft-worktree.mjs',
    'offloop/propose.mjs',
  ];
  assert.equal(STEAL_TIP_PIN, pin);
  assert.equal(session.tipPin, pin);
  assert.equal(session.tipHead, pin);
  assert.equal(fs.readFileSync(path.join(root, 'offloop/out-dayloop-transport-experience-live-persist-r1/tip-head.txt'), 'utf8').trim(), pin);

  const current = Object.fromEntries(files.map(file => [file,
    sha256(fs.readFileSync(path.join(root, file)))]));
  assert.equal(current['offloop/experience.mjs'], before['offloop/experience.mjs']);
  assert.equal(current['offloop/compose.mjs'], before['offloop/compose.mjs']);
  assert.equal(current['offloop/soft-worktree.mjs'], before['offloop/soft-worktree.mjs']);
  assert.equal(current['offloop/propose.mjs'], before['offloop/propose.mjs']);
  assert.notEqual(current['offloop/dayloop-soft.mjs'], before['offloop/dayloop-soft.mjs']);

  const record = readJson(path.join(root, 'offloop/out-tip-soft-adopt-second-family-live-r1/transport-record.json'));
  assert.equal(record.result, 'TRANSPORT');
  assert.equal(record.transportClass, 'TimeoutError');
  assert.equal(record.requestSha256, requestSha);
  assert.deepEqual(record.subjects, ['t4/a', 't4/b']);
  assert.equal(record.elapsedMs, 50059);

  const knife5 = readJson(path.join(root, 'offloop/out-dayloop-transport-experience-live-persist-r1/live-write-proof.json'));
  assert.equal(knife5.liveWritePathProven, true);
  assert.equal(knife5.adopted, false);
  assert.equal(knife5.reason, 'experience_only');
  assert.equal(knife5.candidateWrites, 0);

  const filesInOut = walk(out);
  assert.deepEqual(filesInOut.filter(file => /freeze-candidate-.*\.md$/.test(path.basename(file))), []);
  assert.equal(session.selfClosed, false);
  const freeze = fs.readFileSync(path.join(root, `freeze-offloop-${knife}.md`), 'utf8');
  const lock = freeze.slice(freeze.indexOf('## 0. 锁定\n'), freeze.indexOf('## 1. 不做'));
  assert.equal(sha256(lock), session.freezeLockSha256);
  // Codex hands off FROZEN; independent SCAN may flip to CLOSED — PASS（CONSUME / PRODUCT_DELTA）.
  const title = freeze.split('\n')[0];
  const status = freeze.split('\n').find(line => line.startsWith('- **状态：')) ?? '';
  const titleBadge = title.match(/\*\*([^*]+)\*\*\s*$/)?.[1] ?? '';
  const statusBadge = status.match(/^\-\s+\*\*状态[：:]\s*([^*\n]+)\*\*/)?.[1] ?? '';
  const frozenHandoff = /^FROZEN \/ (?:开干|SCAN READY)(?:[（(]|$)/.test(titleBadge)
    && /^FROZEN \/ (?:开干|SCAN READY)/.test(statusBadge)
    && !/\bCLOSED\b/.test(`${titleBadge}\n${statusBadge}`);
  const scanClosed = /^CLOSED — PASS(?:\s*[（(](?:CONSUME\s*\/\s*)?PRODUCT_DELTA[）)]|\s*·\s*PRODUCT_DELTA)\s*$/.test(titleBadge)
    && /^CLOSED — PASS\b/.test(statusBadge)
    && (/独立 SCAN/.test(freeze) || /[（(]SCAN\s*·/.test(status));
  assert.ok(frozenHandoff || scanClosed, 'FROZEN handoff or independent SCAN CLOSED — PASS · PRODUCT_DELTA');
});
