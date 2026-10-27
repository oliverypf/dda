import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDayloopSoft } from '../dayloop-soft.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIN = 'a9c0b357bb0340325a02b3b50378851e22ddb4d9';

/** T-e2e-1: fixture soft-clean → shipped EXPERIENCE retains tip SHA + 64-hex hash */
test('T-e2e-1: fixture soft-clean path → shipped EXPERIENCE has tipShaBaseline + softTreeFileListHash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-e2e1-'));
  const outDir = path.join(root, 'out');
  const softDir = path.join(root, 'swt');

  const summary = runDayloopSoft({
    fixture: 'soft-clean',
    tipSha: PIN,
    outDir,
    softWorktreeDir: softDir,
    write: true,
  });

  assert.equal(summary.ok, true);
  assert.equal(summary.frozenWrites, 0);
  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.candidatePath, null);

  const steal = summary.results.find((r) => r.hypothesis === 'steal-post-amt-terminal-replan');
  const body = fs.readFileSync(steal.experiencePath, 'utf8');
  assert.match(body, /^# EXPERIENCE/m);
  assert.match(body, /adopted_candidate.*no \(shipped_duplicate\)/);
  assert.doesNotMatch(body, /状态：\*\*FROZEN\*\*|r1：\*\*FROZEN\*\*/);
  assert.match(body, /tipShaBaseline/);
  assert.ok(body.includes(PIN));
  assert.match(body, /softTreeFileListHash/);
  assert.equal(steal.l1.adopt, true, 'soft-clean contrast still passes L1');
  assert.equal(steal.l1.falseWin, false);

  const hash = steal.l1.softTreeFileListHash;
  assert.ok(hash && /^[a-f0-9]{64}$/i.test(hash), `hash=${hash}`);
  assert.ok(body.includes(hash));

  // Propose retains two shipped directions plus its non-merged lesson fallback.
  assert.equal(summary.results.length, 3);
  assert.equal(steal.wroteCandidate, false);
  assert.equal(steal.reason, 'shipped_duplicate');
  assert.ok((steal.l1.softWriteCount ?? 0) >= 1);
  const lesson = summary.results.find((r) => r.hypothesis === 'experience-poison-loop-lesson');
  assert.equal(lesson.wroteCandidate, false);
  assert.equal(lesson.reason, 'experience_only');
  assert.match(fs.readFileSync(lesson.experiencePath, 'utf8'), /adopted_candidate.*no \(experience_only\)/);
  assert.ok((lesson.l1.softWriteCount ?? 0) >= 1);
  const sticky = summary.results.find((r) => r.hypothesis === 'post-dpr-sticky-execute');
  assert.ok(sticky, 'sticky hyp present');
  assert.ok((sticky.l1.softWriteCount ?? 0) >= 1);
  assert.equal(sticky.wroteCandidate, false);
  assert.equal(sticky.reason, 'shipped_duplicate');
  assert.ok(fs.existsSync(sticky.experiencePath));
  assert.match(fs.readFileSync(sticky.experiencePath, 'utf8'), /adopted_candidate.*no \(shipped_duplicate\)/);
  assert.equal(
    fs.readdirSync(outDir).filter((f) => f.startsWith('freeze-candidate')).length,
    0,
  );
});

/** T-e2e-2a: fixture false-win → 0× CANDIDATE */
test('T-e2e-2: fixture false-win → 0× CANDIDATE (EXPERIENCE-only)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-e2e2-fw-'));
  const summary = runDayloopSoft({
    fixture: 'false-win',
    tipSha: '4439768',
    outDir: path.join(root, 'out'),
    softWorktreeDir: path.join(root, 'swt'),
    write: true,
  });

  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.frozenWrites, 0);
  assert.equal(
    fs.readdirSync(path.join(root, 'out')).filter((f) => f.startsWith('freeze-candidate'))
      .length,
    0,
  );
  assert.ok(summary.results.some((r) => r.falseWin || r.reason === 'false_win' || r.adopt === false));
  assert.ok(summary.results.some((r) => r.experiencePath && fs.existsSync(r.experiencePath)));
});

/** T-e2e-2b: fixture hard-gate → 0× CANDIDATE + 0× soft tree writes */
test('T-e2e-2b: fixture hard-gate → 0× CANDIDATE and 0× soft writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-e2e2-hg-'));
  const softDir = path.join(root, 'swt');
  const summary = runDayloopSoft({
    fixture: 'hard-gate',
    tipSha: '4439768',
    outDir: path.join(root, 'out'),
    softWorktreeDir: softDir,
    write: true,
  });

  assert.equal(summary.wroteCandidate, false);
  assert.equal(summary.frozenWrites, 0);
  assert.equal(
    fs.readdirSync(path.join(root, 'out')).filter((f) => f.startsWith('freeze-candidate'))
      .length,
    0,
  );
  const hg = summary.results[0];
  assert.ok(hg);
  assert.equal(hg.wroteCandidate, false);
  assert.ok(
    hg.reason === 'hard_gate_path' ||
      hg.l1?.reason === 'hard_gate_path' ||
      hg.l1?.rejected === true,
  );
  assert.equal(hg.l1.softWriteCount === 0 || hg.l1.softWriteCount == null, true);
  // directory for hard-gate reject should not contain lease.ts write
  const lease = path.join(softDir, 'patch-runtime-lease', 'src/runtime/lease.ts');
  assert.equal(fs.existsSync(lease), false);
});
