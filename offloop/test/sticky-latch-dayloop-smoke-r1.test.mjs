import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIN, dedicatedSticky, fixtures, listFiles, runFixture } from '../out-sticky-latch-dayloop-smoke-r1/fixture-runner.mjs';

const offloop = fileURLToPath(new URL('../', import.meta.url));
const out = path.join(offloop, 'out-sticky-latch-dayloop-smoke-r1');
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
assert.deepEqual(fixtures.map(({ id }) => id), ['A', 'B'], 'two subjects total, reused for every replay');

function smoke(t, fixture, expectedPaths) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `T-slds-${fixture.id}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = runFixture(root, fixture);
  const { hook, result, files, manifest } = run;
  assert.equal(hook.decision.action, 'miss');
  assert.equal(hook.invoked, true);
  assert.equal(hook.dayloopSoft, true);
  assert.equal(hook.dayloopInvoked, true);
  assert.equal(run.dayloopCalls, 1);
  assert.equal(run.fallbackCalls, 0);
  assert.equal(hook.exitCode, 0);
  assert.deepEqual(hook.candidatePaths, []);
  const summary = hook.dayloopSummary;
  assert.equal(summary.phase, 'dayloop-soft');
  assert.equal(summary.fixture, 'soft-clean');
  assert.equal(summary.l1Mode, 'fixture');
  assert.equal(summary.l1LiveRequested, false, 'non tip: fixture smoke only');
  assert.equal(summary.l1Bounded, true);
  assert.equal(summary.baselineSource, 'explicit');
  assert.equal(summary.softSource, 'explicit');
  assert.equal(summary.baselineFallback, false);
  assert.equal(summary.softFallback, false);
  assert.equal(summary.tipSha, PIN);
  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.candidatePath, null);
  assert.equal(summary.frozenWrites, 0);
  assert.equal(result.hypothesis, fixture.hypothesis.slug);
  assert.equal(result.l1.rejected, false);
  assert.equal(result.l1.adopt, true);
  assert.equal(result.l1.falseWin, false);
  assert.ok(result.l1.softWriteCount >= 1, 'must inspect written soft product, not an empty miss');
  assert.equal(result.l1.softWriteCount, files.length);
  assert.equal(result.l1.tipShaBaseline, PIN);
  assert.equal(result.wroteCandidate, false);
  assert.equal(result.candidatePath, null);
  assert.equal(result.reason, 'shipped_duplicate');
  assert.deepEqual(files.map(({ relPath }) => relPath), expectedPaths);
  assert.deepEqual(run.filePaths, ['.soft-worktree-manifest.json', ...expectedPaths].sort());

  // Hash actual files independently of the soft-worktree hashing helper.
  const fileList = files.map(({ relPath, content }) => ({ relPath, sha256: sha256(content), bytes: Buffer.byteLength(content) }));
  const hash = sha256(fileList.map(({ relPath, sha256: digest }) => `${relPath}\0${digest}\n`).join(''));
  assert.deepEqual(manifest.fileList, fileList);
  assert.equal(manifest.fileListHash, hash);
  assert.equal(result.l1.softTreeFileListHash, hash);
  assert.equal(manifest.softLayerOnly, true);
  assert.equal(manifest.hardGates, 'untouched');
  assert.equal(manifest.slug, fixture.hypothesis.slug);
  assert.ok(hook.experiencePaths.includes(result.experiencePath));
  const experience = fs.readFileSync(result.experiencePath, 'utf8');
  assert.match(experience, /^# EXPERIENCE/m);
  assert.match(experience, /adopted_candidate.*no \(shipped_duplicate\)/);
  assert.ok(experience.includes(PIN));
  assert.ok(experience.includes(hash));
  assert.equal(listFiles(root).some((rel) => path.basename(rel).startsWith('freeze-candidate')), false);
  assert.match(fs.readFileSync(hook.logPath, 'utf8'), /dayloop invoked.*yes/i);
  return run;
}

test('T-slds-1: sticky soft_layer HIT through on-closed -> fixture dayloop writes dedicated latch without CANDIDATE', (t) => {
  assert.deepEqual(fixtures[0].hypothesis, {
    slug: 'post-dpr-sticky-execute', class: 'soft_layer', tags: ['sticky', 'post-dpr', 'execute'],
  });
  const { files } = smoke(t, fixtures[0], ['latch-md/latch-draft.md', 'skill/SKILL.md']);
  const latch = files.find(({ relPath }) => relPath === 'latch-md/latch-draft.md').content;
  assert.match(latch, /After DPR[^\n]*PLAN_THEN_EXECUTE/);
  assert.match(latch, /probe-budget-only or JEV_EVIDENCE_REQUIRED-only FAIL must not re-upgrade to DIAGNOSE/);
  assert.match(latch, /post_dpr_sticky_execute/);
  assert.match(latch, /soft HOST\/latch guidance/i);
  assert.match(latch, dedicatedSticky);
  assert.match(latch, /_Soft-layer only\. Never edits runtime hard gates\._$/);
  assert.equal((latch.match(/does not reimplement (?:the )?runtime latch table/gi) || []).length, 1);
});

test('T-slds-2: host-note-only non-HIT writes no dedicated sticky inject; product/PIN baselines and FROZEN|SCAN CLOSED lock hold', (t) => {
  assert.equal(fixtures[1].hypothesis.slug, 'host-note-post-dpr-execute-bias');
  const { files } = smoke(t, fixtures[1], ['HOST/host-note.md', 'skill/SKILL.md']);
  for (const file of files) assert.doesNotMatch(file.content, dedicatedSticky);
  const host = files.find(({ relPath }) => relPath === 'HOST/host-note.md').content;
  assert.match(host, /post_dpr_sticky_execute/, 'shared HOST words alone are not dedicated sticky injection');
  const body = host.slice(host.indexOf('HOST_DIAGNOSE_PROBE_EXHAUSTED_RECOVER:'));
  assert.equal(sha256(body), '07fa8f80bab3ee0ed92199ce86a082323a9dae4b33b2d700eb48000025c113ea');

  const before = Object.fromEntries(fs.readFileSync(path.join(out, 'before-hashes.txt'), 'utf8').trim().split('\n').map((line) => line.split(' ')));
  for (const [name, expected] of Object.entries(before).filter(([name]) => name.endsWith('.mjs'))) {
    assert.equal(sha256(fs.readFileSync(path.join(offloop, name))), expected, `${name}: product 0×`);
  }
  const pinSource = fs.readFileSync(path.join(offloop, 'path-signals.mjs'), 'utf8');
  assert.equal(pinSource.match(/export const STEAL_TIP_PIN = '([^']+)'/)?.[1], PIN);
  assert.equal(before.STEAL_TIP_PIN, PIN);
  assert.equal(before.tipHEAD, PIN);
  const freeze = fs.readFileSync(path.join(offloop, '../freeze-offloop-sticky-latch-dayloop-smoke-r1.md'), 'utf8');
  const title = freeze.split('\n')[0];
  const status = freeze.split('\n').find((line) => /^- \*\*状态[：:]/.test(line)) || '';
  // Codex must not self-CLOSE; independent SCAN may flip to CLOSED — PASS（NO_PRODUCT_DELTA）.
  const frozenHonesty = /\*\*FROZEN \/ 开干\*\*/.test(freeze) && !/CLOSED/.test(title);
  const scanClosed = /CLOSED — PASS/.test(title)
    && /\*\*状态：CLOSED — PASS/.test(status)
    && /独立 SCAN/.test(freeze);
  assert.ok(frozenHonesty || scanClosed, 'freeze must stay FROZEN (Codex) or SCAN CLOSED');
  const lock = freeze.split('## 0. 锁定\n')[1]?.split('\n## 1. 不做')[0];
  assert.equal(sha256(lock), '81ffea6adf35bc54d5d1386f7084dd4b47450fcfa096dadc25b2be84f8212891', '§0 lock body must remain byte-identical');
});
