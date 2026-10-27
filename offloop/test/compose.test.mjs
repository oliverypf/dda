import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { composeCandidate } from '../compose.mjs';
import { matchesMergedDirection } from '../merged-directions.mjs';

const hyp = {
  id: 'H1',
  slug: 'host-note-documentation-checklist',
  title: 'HOST note: documentation review checklist',
  summary: 'Use a documentation review checklist in soft HOST guidance.',
  class: 'soft_layer',
  tags: ['soft', 'host-note'],
  evidence: [{ cellId: 't3/x', sequence: 1, text: 'poison' }],
  latchDraftMd: null,
};

test('T-ol-3: no evidence / not adopt → no CANDIDATE file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-compose-'));
  const r = composeCandidate({
    hypothesis: hyp,
    probeResult: { adopt: false, falseWin: false, baseline: { poison: { count: 1 } }, notes: [] },
    ingest: { cells: [], totals: { poisonLoopCount: 1 } },
    outDir: dir,
    experienceDir: path.join(dir, 'experience'),
    date: '2026-10-22',
    write: true,
  });
  assert.equal(r.wroteCandidate, false);
  assert.equal(r.candidatePath, null);
  assert.ok(r.experiencePath && fs.existsSync(r.experiencePath));
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('freeze-candidate')).length, 0);
});

test('T-ol-3: adopt → freeze-candidate + Probe section + CANDIDATE status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-compose-'));
  const r = composeCandidate({
    hypothesis: hyp,
    probeResult: {
      adopt: true,
      falseWin: false,
      baseline: { poison: { count: 1 } },
      contrast: { poison: { count: 0 }, win: { reason: 'green_and_poison_loop_zero' } },
      notes: ['ok'],
    },
    ingest: {
      cells: [{ cellId: 't3/run60a', poisonLoopCount: 1, dprCount: 2, stickyCount: 0, finalVerification: 'FAIL' }],
      totals: { poisonLoopCount: 1, dprCount: 2, stickyCount: 0 },
    },
    outDir: dir,
    experienceDir: path.join(dir, 'experience'),
    date: '2026-10-22',
    write: true,
  });
  assert.equal(r.wroteCandidate, true);
  assert.ok(fs.existsSync(r.candidatePath));
  const body = fs.readFileSync(r.candidatePath, 'utf8');
  assert.match(body, /\*\*CANDIDATE\*\*/);
  assert.match(body, /状态：CANDIDATE/);
  assert.doesNotMatch(body, /状态：\*\*FROZEN\*\*|r1：\*\*FROZEN\*\*/);
  assert.match(body, /## 2\. Probe 记录/);
  assert.match(body, /## 3\. 升格清单/);
  assert.match(body, /勿开干/);
  assert.ok(fs.existsSync(r.experiencePath));
});

test('T-ol-3: shipped sticky adopt → EXPERIENCE only, never a CANDIDATE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-compose-duplicate-'));
  const r = composeCandidate({
    hypothesis: { ...hyp, slug: 'post-dpr-sticky-execute', title: 'Sticky PTE after dpr' },
    probeResult: { adopt: true, falseWin: false, notes: ['clean fixture'] },
    outDir: dir,
    experienceDir: path.join(dir, 'experience'),
    date: '2026-10-26',
  });
  assert.equal(r.wroteCandidate, false);
  assert.equal(r.candidatePath, null);
  assert.equal(r.reason, 'shipped_duplicate');
  assert.ok(fs.existsSync(r.experiencePath));
  assert.match(fs.readFileSync(r.experiencePath, 'utf8'), /adopted_candidate\*\*: no \(shipped_duplicate\)/);
  assert.equal(fs.readdirSync(dir).filter((file) => file.startsWith('freeze-candidate-')).length, 0);
});

test('T-merged-host-note: shipped host-note adopt → EXPERIENCE only, zero CANDIDATE files', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-compose-host-note-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hypothesis = {
    ...hyp,
    slug: 'host-note-post-dpr-execute-bias',
    title: 'HOST note: prefer write/execute/verify after demote',
    summary: 'Prefer write/execute/verify actions in soft HOST guidance after demote.',
  };
  assert.equal(matchesMergedDirection(hypothesis), true);
  const result = composeCandidate({
    hypothesis,
    probeResult: { adopt: true, falseWin: false, notes: ['clean fixture'] },
    outDir: dir,
    experienceDir: path.join(dir, 'experience'),
    date: '2026-10-25',
  });

  assert.equal(result.wroteCandidate, false);
  assert.equal(result.candidatePath, null);
  assert.equal(result.reason, 'shipped_duplicate');
  assert.ok(result.experiencePath && fs.existsSync(result.experiencePath));
  const experience = fs.readFileSync(result.experiencePath, 'utf8');
  assert.match(experience, /^# EXPERIENCE/m);
  assert.match(experience, /adopted_candidate\*\*: no \(shipped_duplicate\)/);
  assert.match(experience, /\*\*slug\*\*: host-note-post-dpr-execute-bias/);
  assert.equal(fs.readdirSync(dir).filter((file) => file.startsWith('freeze-candidate-')).length, 0);
});

test('merged sticky direction matches aliases and own PR refs without inheriting prior collisions', () => {
  const duplicates = [
    { slug: 'sticky-execute' },
    { slug: 'renamed-sticky-latch-r2' },
    { slug: 'renamed', title: 'Sticky PTE after dpr' },
    { slug: 'renamed', tags: ['sticky', '#83'] },
    { slug: 'renamed', title: 'PR #84 evidence-only latch' },
    { slug: 'renamed', prRefs: ['https://github.com/oliverypf/dda/pull/83'] },
    { slug: 'renamed', pullRequest: { number: 84 } },
  ];
  for (const duplicate of duplicates) {
    assert.equal(matchesMergedDirection(duplicate), true, JSON.stringify(duplicate));
  }
  assert.equal(matchesMergedDirection({
    ...hyp,
    evidence: [{ text: 'Prior PR #83 sticky execute observed' }],
    prior: [{ slug: 'post-dpr-sticky-execute', tags: ['sticky', '#83'] }],
  }), false);
  assert.equal(matchesMergedDirection({ slug: 'soft-host-note', title: 'PR #830 host note' }), false);
});
