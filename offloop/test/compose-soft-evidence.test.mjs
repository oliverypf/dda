import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeCandidate } from '../compose.mjs';
import { probeL1 } from '../probe.mjs';
import { prepareSoftWorktree } from '../soft-worktree.mjs';
import { matchesMergedDirection } from '../merged-directions.mjs';
import { STEAL_TIP_PIN } from '../path-signals.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, 'fixtures');

const hyp = {
  id: 'H1',
  slug: 'host-note-documentation-checklist',
  title: 'HOST note: documentation review checklist',
  class: 'soft_layer',
  probeKind: 'soft_or_latch_md',
  tags: ['soft', 'host-note'],
  summary: 'Use a documentation review checklist in soft HOST guidance.',
  evidence: [{ cellId: 't3/x', sequence: 1, text: 'poison' }],
  latchDraftMd: null,
};

/** T-cse-1: L1 adopt + soft hash → CANDIDATE body contains tip SHA and fileListHash */
test('T-cse-1: L1 adopt + soft hash → CANDIDATE nails tipShaBaseline + softTreeFileListHash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cse1-'));
  const outDir = path.join(root, 'out');
  const swDir = path.join(root, 'soft');

  const l1 = probeL1(hyp, {
    enabled: true,
    mode: 'fixture',
    softWorktreeDir: swDir,
    prepareSoftWorktree: true,
    baseline: {
      jsonlPaths: [path.join(fixtures, 'poison-loop-yes.jsonl')],
      tipSha: '4439768',
      verificationPass: false,
    },
    softLayer: {
      jsonlPaths: [path.join(fixtures, 'l1-soft-clean.jsonl')],
      tipSha: '4439768',
      verificationPass: true,
    },
  });

  assert.equal(l1.adopt, true);
  assert.equal(l1.header.tipShaBaseline, '4439768');
  assert.ok(l1.header.softTreeFileListHash);
  assert.match(l1.header.softTreeFileListHash, /^[a-f0-9]{64}$/i);

  const r = composeCandidate({
    hypothesis: hyp,
    probeResult: l1,
    ingest: {
      cells: [
        {
          cellId: 't3/run60a',
          poisonLoopCount: 1,
          dprCount: 2,
          stickyCount: 0,
          finalVerification: 'FAIL',
        },
      ],
      totals: { poisonLoopCount: 1, dprCount: 2 },
    },
    outDir,
    experienceDir: path.join(outDir, 'experience'),
    date: '2026-10-24',
    write: true,
  });

  assert.equal(r.wroteCandidate, true);
  assert.equal(r.reason, 'probe_adopt');
  assert.ok(r.candidatePath && fs.existsSync(r.candidatePath));
  const body = fs.readFileSync(r.candidatePath, 'utf8');
  assert.match(body, /\*\*CANDIDATE\*\*/);
  assert.doesNotMatch(body, /状态：\*\*FROZEN\*\*|r1：\*\*FROZEN\*\*/);
  assert.match(body, /tipShaBaseline/);
  assert.match(body, /4439768/);
  assert.match(body, /softTreeFileListHash/);
  assert.ok(body.includes(l1.header.softTreeFileListHash));
  const experience = fs.readFileSync(r.experiencePath, 'utf8');
  assert.ok(experience.includes(hyp.summary));
  assert.doesNotMatch(experience, /Sticky execute \(#83\) is the latch direction/);
  // soft-layer fileList paths present
  assert.match(body, /fileList|latch-md|HOST|skill|docs/i);
  assert.equal(
    fs.readdirSync(outDir).filter((f) => f.startsWith('freeze-candidate')).length,
    1,
  );
});

test('T-merged-host-note: allowlisted steal with inherited #82 evidence rejects its shipped direction', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cse-host-note-prior-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outDir = path.join(root, 'out');
  const pin = STEAL_TIP_PIN;
  const hypothesis = {
    ...hyp,
    slug: 'steal-post-amt-terminal-replan',
    title: 'Soft guidance after terminal replan',
    summary: 'Prefer a bounded productive action and verify after terminal replan.',
    tags: ['steal', 'soft', 'post-amt', 'path-anomaly'],
    evidence: [
      { cellId: 'steal-cell', sequence: 7, kind: 'post_amt', text: 'post_agent_miss_terminal_replan observed' },
      { cellId: 'library-cell', sequence: 2, text: 'Prior PR #82 host-note-post-dpr-execute-bias is shipped library guidance.' },
    ],
    prior: [{
      slug: 'host-note-post-dpr-execute-bias',
      title: 'HOST note post-dpr execute-bias',
      tags: ['host-note', '#82'],
      pullRequests: [82],
      lesson: 'PR #82 host-note post-dpr execute-bias is shipped.',
    }],
  };
  assert.equal(matchesMergedDirection(hypothesis), true);
  const probeResult = probeL1(hypothesis, {
    enabled: true,
    mode: 'fixture',
    prepareSoftWorktree: true,
    softWorktreeDir: path.join(root, 'soft'),
    baseline: {
      jsonlPaths: [path.join(fixtures, 'poison-loop-yes.jsonl')],
      tipSha: pin,
      verificationPass: false,
    },
    softLayer: {
      jsonlPaths: [path.join(fixtures, 'l1-soft-clean.jsonl')],
      tipSha: pin,
      verificationPass: true,
    },
  });
  assert.equal(probeResult.adopt, true);
  assert.equal(probeResult.header.tipShaBaseline, pin);
  assert.match(probeResult.header.softTreeFileListHash, /^[a-f0-9]{64}$/i);

  const result = composeCandidate({
    hypothesis,
    probeResult,
    outDir,
    experienceDir: path.join(outDir, 'experience'),
    date: '2026-10-25',
  });
  assert.equal(result.wroteCandidate, false);
  assert.equal(result.candidatePath, null);
  assert.equal(result.reason, 'shipped_duplicate');
  assert.deepEqual(fs.readdirSync(outDir).filter((file) => file.startsWith('freeze-candidate-')), []);
  const body = fs.readFileSync(result.experiencePath, 'utf8');
  assert.match(body, /^# EXPERIENCE/m);
  assert.ok(body.includes(pin));
  assert.ok(body.includes(probeResult.header.softTreeFileListHash));
  assert.match(body, /adopted_candidate\*\*: no \(shipped_duplicate\)/);
});

/** T-cse-2: L1 soft claims adopt but no hash → 0× CANDIDATE + EXPERIENCE missing evidence */
test('T-cse-2: L1 soft claim adopt without hash → 0× CANDIDATE + EXPERIENCE missing evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cse2-'));
  const probeResult = {
    level: 'L1',
    skipped: false,
    enabled: true,
    mode: 'fixture',
    adopt: true,
    falseWin: false,
    header: {
      tipShaBaseline: null,
      softTreeFileListHash: null,
      softWorktree: 'soft-layer/docs-only',
      mode: 'fixture',
    },
    softWorktree: {
      ok: true,
      rejected: false,
      fileListHash: null,
      fileList: [],
    },
    baseline: { poison: { count: 1 }, win: { win: false } },
    contrast: { poison: { count: 0 }, win: { win: true, reason: 'green_and_poison_loop_zero' } },
    notes: ['L1 soft claim without evidence'],
  };

  const r = composeCandidate({
    hypothesis: hyp,
    probeResult,
    ingest: { cells: [], totals: { poisonLoopCount: 1 } },
    outDir: dir,
    experienceDir: path.join(dir, 'experience'),
    date: '2026-10-24',
    write: true,
  });

  assert.equal(r.wroteCandidate, false);
  assert.equal(r.candidatePath, null);
  assert.equal(r.reason, 'missing_soft_evidence');
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('freeze-candidate')).length, 0);
  assert.ok(r.experiencePath && fs.existsSync(r.experiencePath));
  const exp = fs.readFileSync(r.experiencePath, 'utf8');
  assert.match(exp, /missing_soft_evidence/);
  assert.match(exp, /adopted_candidate.*no/);
});

/** T-cse-2b: tip present but hash missing still rejects */
test('T-cse-2b: L1 soft adopt with tip but no fileListHash → 0× CANDIDATE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cse2b-'));
  const r = composeCandidate({
    hypothesis: hyp,
    probeResult: {
      level: 'L1',
      skipped: false,
      enabled: true,
      adopt: true,
      falseWin: false,
      header: {
        tipShaBaseline: '4439768',
        softTreeFileListHash: null,
      },
      baseline: { poison: { count: 1 } },
      contrast: { poison: { count: 0 }, win: { reason: 'green_and_poison_loop_zero' } },
      notes: [],
    },
    outDir: dir,
    experienceDir: path.join(dir, 'experience'),
    date: '2026-10-24',
    write: true,
  });
  assert.equal(r.wroteCandidate, false);
  assert.equal(r.reason, 'missing_soft_evidence');
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('freeze-candidate')).length, 0);
});

/** hard_gate_path → 0× CANDIDATE */
test('T-cse-hg: soft tree hard_gate_path → 0× CANDIDATE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cse-hg-'));
  const badHyp = {
    ...hyp,
    slug: 'patch-runtime-lease',
    softFiles: [{ path: 'src/runtime/lease.ts', content: 'x' }],
  };
  const sw = prepareSoftWorktree(badHyp, {
    dir: path.join(dir, 'tree'),
    write: true,
  });
  assert.equal(sw.rejected, true);
  assert.equal(sw.reason, 'hard_gate_path');

  const r = composeCandidate({
    hypothesis: badHyp,
    probeResult: {
      level: 'L1',
      skipped: false,
      enabled: true,
      adopt: false,
      falseWin: false,
      reason: 'hard_gate_path',
      rejected: true,
      softWorktree: sw,
      notes: ['reject: hard-gate path'],
      baseline: { poison: { count: 1 } },
    },
    outDir: dir,
    experienceDir: path.join(dir, 'experience'),
    date: '2026-10-24',
    write: true,
  });
  assert.equal(r.wroteCandidate, false);
  assert.equal(r.reason, 'hard_gate_path');
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('freeze-candidate')).length, 0);
});

/** false-win non-adopt unchanged */
test('T-cse-fw: false-win still non-adopt → 0× CANDIDATE (unchanged)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-cse-fw-'));
  const r = composeCandidate({
    hypothesis: hyp,
    probeResult: {
      level: 'L1',
      skipped: false,
      enabled: true,
      adopt: false,
      falseWin: true,
      header: {
        tipShaBaseline: '4439768',
        softTreeFileListHash: 'a'.repeat(64),
      },
      baseline: { poison: { count: 1 } },
      contrast: { poison: { count: 2 }, win: { falseWin: true } },
      notes: ['reject: false win'],
    },
    outDir: dir,
    experienceDir: path.join(dir, 'experience'),
    date: '2026-10-24',
    write: true,
  });
  assert.equal(r.wroteCandidate, false);
  assert.equal(r.reason, 'false_win');
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('freeze-candidate')).length, 0);
});
