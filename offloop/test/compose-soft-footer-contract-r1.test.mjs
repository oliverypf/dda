import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { composeCandidate } from '../compose.mjs';
import { hypothesisIsSteal, STEAL_TIP_PIN } from '../path-signals.mjs';

const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const HASH = '0123456789abcdef'.repeat(4);
const FILES = ['HOST/host-note.md', 'skill/SKILL.md', 'latch-md/latch-draft.md', 'docs/soft-hypothesis.md'];
const FILE_LIST = [FILES[0], { relPath: FILES[1] }, { path: FILES[2] }, FILES[3]];
const HYPOTHESIS = {
  id: 'H-csf',
  slug: 'compose-soft-footer-documentation-checklist',
  title: 'Soft documentation review checklist',
  class: 'soft_layer',
  tags: ['soft'],
  summary: 'Record a documentation review checklist in soft guidance.',
  evidence: [],
};
const STEAL_HYPOTHESIS = {
  ...HYPOTHESIS,
  slug: 'compose-soft-footer-post-amt-checklist',
  tags: ['soft', 'post-amt'],
  evidence: [{ kind: 'post_amt', cellId: 'csf/run', sequence: 1, text: 'Terminal replan observed.' }],
};

function softProbe(tip = PIN, hash = HASH) {
  return {
    level: 'L1', skipped: false, enabled: true, adopt: true, falseWin: false,
    header: { tipShaBaseline: tip, softTreeFileListHash: hash },
    softWorktree: { ok: true, rejected: false, fileList: FILE_LIST },
    baseline: { poison: { count: 1 } },
    contrast: { poison: { count: 0 }, win: { reason: 'green_and_poison_loop_zero' } },
    notes: [],
  };
}

function writeCompose(t, probeResult, hypothesis = HYPOTHESIS) {
  const root = fs.mkdtempSync('/tmp/ol-csf-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outDir = path.join(root, 'out');
  const result = composeCandidate({
    hypothesis, probeResult, outDir, experienceDir: path.join(outDir, 'experience'),
    date: '2026-10-25', write: true,
  });
  return { result, outDir };
}

function assertRejected({ result, outDir }, reason) {
  assert.equal(result.wroteCandidate, false);
  assert.equal(result.reason, reason);
  assert.equal(result.candidatePath, null);
  assert.equal(result.candidateBody, undefined);
  assert.deepEqual(fs.readdirSync(outDir).filter((file) => file.startsWith('freeze-candidate-')), []);
  const experience = fs.readFileSync(result.experiencePath, 'utf8');
  assert.equal(experience, result.experienceBody);
  assert.match(experience, /^# EXPERIENCE /m);
  assert.ok(experience.includes(`- **adopted_candidate**: no (${reason})`));
  return experience;
}

test('T-csf-1: complete L1 soft evidence nails table + footer + fileList on disk', (t) => {
  assert.equal(STEAL_TIP_PIN, PIN);
  assert.equal(hypothesisIsSteal(STEAL_HYPOTHESIS), true);
  const cases = [
    { tip: PIN },
    { tip: '4439768' },
    { tip: PIN, nested: true },
    { tip: '4439768', nested: true },
    { tip: STEAL_TIP_PIN, nested: true, hypothesis: STEAL_HYPOTHESIS },
  ];
  for (const { tip, nested, hypothesis } of cases) {
    const l1 = softProbe(tip);
    const probeResult = nested ? { adopt: true, falseWin: false, l1 } : l1;
    const { result, outDir } = writeCompose(t, probeResult, hypothesis);
    assert.equal(result.wroteCandidate, true, result.reason);
    assert.equal(result.reason, 'probe_adopt');
    const body = fs.readFileSync(result.candidatePath, 'utf8');
    assert.equal(body, result.candidateBody);
    assert.match(body, /r1：\*\*CANDIDATE\*\*/);
    const section = body.match(/^### 0\.1 L1 soft-layer contrast\n([\s\S]*?)(?=^## 1\.)/m)?.[1];
    assert.ok(section, 'CANDIDATE must include the soft-evidence section');
    const table = section.split('\n').filter((line) => line.startsWith('|'));
    const shortTip = String(tip).slice(0, 7);
    for (const [field, value] of [['tipShaBaseline', tip], ['tipShort', shortTip], ['softTreeFileListHash', HASH]]) {
      assert.ok(table.includes(`| ${field} | \`${value}\` |`), `table must carry ${field}`);
    }
    assert.match(HASH, /^[a-f0-9]{64}$/i);
    const footer = body.split('\n').filter((line) => line.startsWith('- **soft_evidence**:'));
    assert.deepEqual(footer, [
      `- **soft_evidence**: tipShaBaseline=\`${tip}\` tipShort=\`${shortTip}\` softTreeFileListHash=\`${HASH}\``,
    ]);
    assert.ok(body.indexOf(footer[0]) > body.indexOf('## 2. Probe 记录'));
    assert.ok(body.indexOf(footer[0]) < body.indexOf('## 3. 升格清单'));
    const fileList = section.split('Soft-layer `fileList` (HOST / skill / latch-md / docs):\n')[1];
    assert.ok(fileList, 'soft fileList must have its own section');
    assert.deepEqual(fileList.trim().split('\n'), FILES.map((file) => `- \`${file}\``));
    assert.deepEqual(result.softEvidence.fileList, FILE_LIST);
    assert.deepEqual(fs.readdirSync(outDir).filter((file) => file.startsWith('freeze-candidate-')), [path.basename(result.candidatePath)]);
    const experience = fs.readFileSync(result.experiencePath, 'utf8');
    assert.equal(experience, result.experienceBody);
    assert.match(experience, /adopted_candidate\*\*: yes \(probe_adopt\)/);
    const experienceFooter = experience.split('\n').find((line) => line.startsWith('- **soft_evidence**:'));
    assert.ok(experienceFooter?.includes(`tipShaBaseline=\`${tip}\``));
    assert.ok(experienceFooter.includes(`softTreeFileListHash=\`${HASH}\``));
    assert.doesNotMatch(experience, /^- \*\*missing_soft_evidence\*\*:/m);
  }
});

test('T-csf-2: missing or invalid tip/hash rejects write without a complete soft_evidence footer', (t) => {
  const cases = [
    { tip: null, hash: HASH, tipOk: false, hashOk: true },
    { tip: PIN, hash: null, tipOk: true, hashOk: false },
    { tip: '   ', hash: HASH, tipOk: false, hashOk: true },
    { tip: PIN, hash: 'a'.repeat(63), tipOk: true, hashOk: false },
    { tip: PIN, hash: 'z'.repeat(64), tipOk: true, hashOk: false },
    { tip: '4439768', hash: HASH, tipOk: false, hashOk: true, hypothesis: STEAL_HYPOTHESIS },
  ];
  for (const { tip, hash, tipOk, hashOk, hypothesis } of cases) {
    const composed = writeCompose(t, softProbe(tip, hash), hypothesis);
    const experience = assertRejected(composed, 'missing_soft_evidence');
    assert.equal(composed.result.missingSoftEvidence.tipOk, tipOk);
    assert.equal(composed.result.missingSoftEvidence.hashOk, hashOk);
    assert.match(experience, /^- \*\*missing_soft_evidence\*\*:.*CANDIDATE write rejected$/m);
    assert.doesNotMatch(experience, /^- \*\*soft_evidence\*\*:/m);
  }
});

test('T-csf-3: complete soft evidence cannot override hard_gate_path or falseWin', (t) => {
  for (const nested of [false, true]) {
    for (const reason of ['hard_gate_path', 'false_win']) {
      const l1 = softProbe();
      if (reason === 'hard_gate_path') {
        l1.softWorktree = { ...l1.softWorktree, rejected: true, reason };
      } else {
        l1.falseWin = true;
      }
      const probeResult = nested ? { adopt: true, falseWin: false, l1 } : l1;
      assertRejected(writeCompose(t, probeResult), reason);
    }
  }
});
