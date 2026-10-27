import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeCandidate } from '../compose.mjs';
import { runDayloopSoft } from '../dayloop-soft.mjs';
import { isAllowedSoftRelPath } from '../soft-worktree.mjs';
import { STEAL_TIP_PIN } from '../path-signals.mjs';

const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offloop-tcand-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function candidateFiles(outDir) {
  return fs.readdirSync(outDir).filter((name) => /^freeze-candidate-.*\.md$/.test(name));
}

test('T-tcand-1: post-#90 default and explicit steal pin retain shipped EXPERIENCE without CANDIDATE', (t) => {
  const root = temporaryRoot(t);
  const defaultOutDir = path.join(root, 'default-out');
  const defaultSummary = runDayloopSoft({
    fixture: 'soft-clean',
    outDir: defaultOutDir,
    softWorktreeDir: path.join(root, 'default-swt'),
  });
  assert.equal(defaultSummary.ok, true);
  assert.equal(defaultSummary.tipSha, PIN);
  assert.equal(defaultSummary.wroteCandidate, false);
  assert.equal(defaultSummary.candidatePath, null);
  assert.equal(defaultSummary.frozenWrites, 0);
  assert.deepEqual(candidateFiles(defaultOutDir), []);
  const rejected = defaultSummary.results.find((result) => result.hypothesis === 'steal-post-amt-terminal-replan');
  assert.equal(rejected.reason, 'shipped_duplicate');
  assert.equal(rejected.l1.tipShaBaseline, PIN);
  assert.match(rejected.l1.softTreeFileListHash, /^[a-f0-9]{64}$/i);
  assert.match(fs.readFileSync(rejected.experiencePath, 'utf8'), /adopted_candidate.*no \(shipped_duplicate\)/);

  const outDir = path.join(root, 'out');
  const summary = runDayloopSoft({
    fixture: 'soft-clean',
    tipSha: STEAL_TIP_PIN,
    outDir,
    softWorktreeDir: path.join(root, 'swt'),
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.tipSha, STEAL_TIP_PIN);
  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.frozenWrites, 0);
  assert.equal(summary.candidatePath, null);
  assert.deepEqual(candidateFiles(outDir), []);

  const steal = summary.results.find((result) => result.hypothesis === 'steal-post-amt-terminal-replan');
  const body = fs.readFileSync(steal.experiencePath, 'utf8');
  assert.match(body, /^# EXPERIENCE/m);
  assert.match(body, /adopted_candidate.*no \(shipped_duplicate\)/);
  assert.doesNotMatch(body, /状态：\*\*FROZEN\*\*|r1：\*\*FROZEN\*\*/);
  const tips = [...body.matchAll(/tipShaBaseline=`([^`]+)`/g)];
  assert.ok(tips.length > 0, 'experience must contain tipShaBaseline evidence');
  assert.ok(tips.every((match) => match[1] === STEAL_TIP_PIN), 'all experience tip evidence must use the full steal pin');

  assert.equal(summary.results.length, 3);
  assert.equal(steal.wroteCandidate, false);
  assert.equal(steal.reason, 'shipped_duplicate');
  assert.equal(steal.l1.adopt, true);
  const lesson = summary.results.find((result) => result.hypothesis === 'experience-poison-loop-lesson');
  assert.equal(lesson.wroteCandidate, false);
  assert.equal(lesson.reason, 'experience_only');
  assert.match(fs.readFileSync(lesson.experiencePath, 'utf8'), /adopted_candidate.*no \(experience_only\)/);
  const sticky = summary.results.find((result) => result.hypothesis === 'post-dpr-sticky-execute');
  assert.equal(sticky.wroteCandidate, false);
  assert.equal(sticky.reason, 'shipped_duplicate');
  assert.equal(steal.l1.tipShaBaseline, STEAL_TIP_PIN);
  const hash = steal.l1.softTreeFileListHash;
  assert.match(hash, /^[a-f0-9]{64}$/i);
  const hashes = [...body.matchAll(/softTreeFileListHash=`([^`]+)`/g)];
  assert.ok(hashes.length > 0, 'experience must contain softTreeFileListHash evidence');
  assert.ok(hashes.every((match) => match[1] === hash));

  const manifest = JSON.parse(fs.readFileSync(
    path.join(steal.l1.softWorktreeDir, '.soft-worktree-manifest.json'), 'utf8',
  ));
  assert.equal(manifest.fileListHash, hash);
  const paths = manifest.fileList.map((file) => file.relPath);
  assert.ok(paths.length > 0, 'soft fileList must contain actual files');
  for (const relPath of paths) {
    assert.equal(isAllowedSoftRelPath(relPath), true, `allowed soft path: ${relPath}`);
    assert.equal(fs.statSync(path.join(steal.l1.softWorktreeDir, relPath)).isFile(), true);
  }
});

for (const [fixture, reason] of [['false-win', 'false_win'], ['hard-gate', 'hard_gate_path']]) {
  test(`T-tcand-2: ${fixture} with post-#90 default PIN writes EXPERIENCE and 0 CANDIDATE`, (t) => {
    const root = temporaryRoot(t);
    const outDir = path.join(root, 'out');
    const summary = runDayloopSoft({
      fixture,
      outDir,
      softWorktreeDir: path.join(root, 'swt'),
    });

    assert.equal(summary.tipSha, PIN);
    assert.equal(summary.wroteCandidate, false);
    assert.equal(summary.candidatePath, null);
    assert.equal(summary.frozenWrites, 0);
    assert.deepEqual(candidateFiles(outDir), []);
    assert.ok(summary.results.length > 0, 'gate must produce a rejection record');
    for (const result of summary.results) {
      assert.equal(result.wroteCandidate, false);
      assert.equal(result.reason, reason);
      assert.ok(result.experiencePath && fs.existsSync(result.experiencePath));
      const body = fs.readFileSync(result.experiencePath, 'utf8');
      assert.match(body, /^# EXPERIENCE/m);
      assert.ok(body.includes(`**adopted_candidate**: no (${reason})`));
      if (fixture === 'hard-gate') assert.equal(result.l1.softWriteCount, 0);
    }
  });
}

test('T-tcand-3: path-anomaly Compose remains EXPERIENCE-only with pinned evidence', (t) => {
  const root = temporaryRoot(t);
  const outDir = path.join(root, 'out');
  const result = composeCandidate({
    hypothesis: {
      id: 'H-path-anomaly',
      slug: 'experience-agent-miss-progress-fail-not-dgr',
      title: 'Path anomaly remains a lesson',
      class: 'experience',
      tags: ['experience', 'path-anomaly'],
      summary: 'Record the agent-miss path; do not promote the lesson into a candidate.',
    },
    probeResult: {
      adopt: false,
      falseWin: false,
      notes: ['path-anomaly experience-only'],
      tipShaBaseline: STEAL_TIP_PIN,
      softTreeFileListHash: 'a'.repeat(64),
      softTreeFileList: ['docs/path-anomaly.md'],
    },
    outDir,
    experienceDir: path.join(outDir, 'experience'),
  });
  assert.equal(result.wroteCandidate, false);
  assert.equal(result.candidatePath, null);
  assert.equal(result.reason, 'experience_only');
  assert.deepEqual(candidateFiles(outDir), []);
  assert.ok(result.experiencePath && fs.existsSync(result.experiencePath));
  const body = fs.readFileSync(result.experiencePath, 'utf8');
  assert.match(body, /^# EXPERIENCE/m);
  assert.match(body, /\*\*adopted_candidate\*\*: no \(experience_only\)/);
  assert.ok(body.includes(`tipShaBaseline=\`${STEAL_TIP_PIN}\``));
});
