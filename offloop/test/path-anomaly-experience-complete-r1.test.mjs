import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { composeCandidate } from '../compose.mjs';
import { parseExperienceBody } from '../experience.mjs';
import { notesPathAnomaly, summarizePathAnomalyFields } from '../path-signals.mjs';

const PIN = 'a9c0b357bb0340325a02b3b50378851e22ddb4d9';
const DGR_CHECK = 'deterministic-green-jev-behavior-reject-promote';
const TIP_CHECK = 'deterministic-green-jev-uncertain-tip-path';

function temporaryRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'offloop-pae-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function candidateFiles(root) {
  return fs.readdirSync(root).filter((name) => /^freeze-candidate-.*\.md$/.test(name));
}

function experienceHypothesis(overrides = {}) {
  return {
    id: 'H-pae',
    slug: 'experience-path-anomaly-observation',
    title: 'Observed path anomaly',
    class: 'experience',
    tags: ['experience', 'path-anomaly'],
    summary: 'Retain first-hand path evidence as an observational lesson.',
    ...overrides,
  };
}

function pinnedProbe(overrides = {}) {
  return {
    level: 'L1', enabled: true, skipped: false,
    adopt: false, falseWin: false, notes: ['path-anomaly experience-only'],
    tipShaBaseline: PIN,
    softTreeFileListHash: 'a'.repeat(64),
    softTreeFileList: ['docs/path-observation.md'],
    ...overrides,
  };
}

function composeAt(root, ingest, hypothesis = experienceHypothesis(), probeResult = pinnedProbe()) {
  return composeCandidate({
    hypothesis, probeResult, ingest, outDir: root,
    experienceDir: path.join(root, 'experience'), date: '2026-10-25',
  });
}

function field(body, key) {
  const prefix = `- **${key}**: `;
  const line = body.split('\n').find((line) => line.startsWith(prefix));
  assert.ok(line, `EXPERIENCE must include ${key}`);
  return line.slice(prefix.length);
}

function assertExperienceOnly(result, root) {
  assert.equal(result.wroteCandidate, false);
  assert.equal(result.candidatePath, null);
  assert.equal(result.reason, 'experience_only');
  assert.deepEqual(candidateFiles(root), []);
  assert.ok(result.experiencePath && fs.existsSync(result.experiencePath));
  const body = fs.readFileSync(result.experiencePath, 'utf8');
  assert.equal(body, result.experienceBody);
  assert.equal(field(body, 'adopted_candidate'), 'no (experience_only)');
  assert.match(body, /runtime must \*\*0×\*\* read/);
  return body;
}

test('T-pae-1: DGR EXPERIENCE records run, first-hand counts and check-id with 0 CANDIDATE', (t) => {
  const root = temporaryRoot(t);
  const body = assertExperienceOnly(composeAt(root, {
    runId: 'run163',
    pathSignals: { agentMissCount: 1, dgrPromoteCount: 1, tipPathCount: 0, postAmtCount: 0 },
    evidenceQuotes: [{ kind: 'dgr_promote', text: `verification check ${DGR_CHECK}` }],
  }), root);
  assert.equal(field(body, 'runId'), 'run163');
  assert.equal(field(body, 'path_counts'), 'DGR=1 tip-path=0 post_amt=0 agent_miss=1');
  assert.equal(field(body, 'path_tags'), 'DGR');
  assert.equal(field(body, 'check_ids'), DGR_CHECK);
  assert.ok(field(body, 'soft_evidence').includes(`tipShaBaseline=\`${PIN}\``));
  const parsed = parseExperienceBody(body);
  assert.ok(parsed.tags.includes('dgr'));
  assert.ok(parsed.tags.includes('agent-miss'));
  assert.equal(parsed.tags.includes('tip-path'), false);
  assert.equal(parsed.tags.includes('post-amt'), false);
});

test('T-pae-2: mid-only agent_miss and negated notes cannot invent promotion counts or tags', (t) => {
  const root = temporaryRoot(t);
  const notes = 'mid UNCERTAIN → agent_miss alone ≠ tip-path/DGR; ≠ DGR; ≠ tip-path; ≠ post_amt; 无 DGR';
  const flags = notesPathAnomaly(notes);
  assert.equal(flags.agentMiss, true);
  assert.equal(flags.any, true);
  for (const kind of ['dgr', 'tipPath', 'postAmt']) assert.equal(flags[kind], false);
  const body = assertExperienceOnly(composeAt(root, {
    runId: 'run-mid',
    pathSignals: { agentMissCount: 1, dgrPromoteCount: 0, tipPathCount: 0, postAmtCount: 0 },
    cells: [{ cellId: 't1/run-mid', notes }],
  }, experienceHypothesis({ summary: notes }), pinnedProbe({ adopt: true })), root);
  assert.equal(field(body, 'path_counts'), 'DGR=0 tip-path=0 post_amt=0 agent_miss=1');
  assert.equal(field(body, 'path_tags'), '(none)');
  assert.equal(field(body, 'check_ids'), '(none)');
  const parsed = parseExperienceBody(body);
  assert.ok(parsed.tags.includes('agent-miss'));
  for (const tag of ['dgr', 'tip-path', 'post-amt']) assert.equal(parsed.tags.includes(tag), false, tag);
});

test('T-pae-3: cell counters and runtime run IDs survive aggregate absence; typed check IDs dedupe', (t) => {
  const root = temporaryRoot(t);
  const quote = { kind: 'tip_path', text: `verification check ${TIP_CHECK}` };
  const body = assertExperienceOnly(composeAt(root, {
    evidenceQuotes: [quote, { kind: 'agent_miss', text: 'verification check unrelated-check' }],
    cells: [
      { cellId: 't1/run-a', runId: 'runtime-a', pathSignals: { tipPathCount: 1, evidenceQuotes: [quote] } },
      {
        cellId: 't2/run-b', runId: 'runtime-b', pathSignals: { tipPathCount: 2 },
        evidenceQuotes: [quote, { kind: 'tip_path', text: `verification check execute.${TIP_CHECK}` }],
      },
      { cellId: 't3/run-a', runId: 'runtime-a', pathSignals: {} },
    ],
  }), root);
  assert.equal(field(body, 'runId'), 'runtime-a, runtime-b');
  assert.equal(field(body, 'path_counts'), 'DGR=0 tip-path=3 post_amt=0 agent_miss=0');
  assert.equal(field(body, 'path_tags'), 'tip-path');
  assert.equal(field(body, 'check_ids'), `${TIP_CHECK}, execute.${TIP_CHECK}`);
});

test('T-pae-4: aggregate zero is authoritative per counter and raw signals retain canonical tags', () => {
  const summary = summarizePathAnomalyFields({
    runId: 'run-aggregate',
    pathSignals: { dgrPromoteCount: 0, postAmtCount: 0, agentMissCount: 3 },
    totals: { dgrPromoteCount: 99, postAmtCount: 99 },
    cells: [{
      notes: 'DGR tip-path post_amt agent_miss',
      pathSignals: { dgrPromoteCount: 8, tipPathCount: 2, postAmtCount: 7, agentMissCount: 4 },
    }],
  });
  assert.equal(summary.runId, 'run-aggregate');
  assert.deepEqual(summary.counts, {
    dgr: 0, tipPath: 2, postAmt: 0, agentMiss: 3, postMissUncertain: 0, progressFailLease: 0,
  });
  assert.deepEqual(summary.path_tags, ['tip-path']);
  assert.deepEqual(summary.checkIds, []);
  const raw = summarizePathAnomalyFields({
    dgrPromoteCount: 2, tipPathCount: 1, postAmtCount: 3,
    evidenceQuotes: [{ kind: 'dgr_promote', text: `verification check ${DGR_CHECK}` }],
  }, { runId: 'raw-run' });
  assert.equal(raw.runId, 'raw-run');
  assert.deepEqual(raw.path_tags, ['DGR', 'tip-path']);
  assert.equal(raw.counts.postAmt, 3);
  assert.deepEqual(raw.checkIds, [DGR_CHECK]);
  assert.equal(summarizePathAnomalyFields({
    runId: ' \t ', cells: [{ runId: ' runtime-known ' }],
  }).runId, 'runtime-known');
});

test('T-pae-5: allowlisted shipped steal retains enriched EXPERIENCE with zero CANDIDATE', (t) => {
  const root = temporaryRoot(t);
  const result = composeAt(root, {
    runId: 'run-steal',
    pathSignals: { dgrPromoteCount: 1, tipPathCount: 1, postAmtCount: 1, agentMissCount: 0 },
  }, {
    id: 'H-steal', slug: 'steal-post-amt-terminal-replan',
    title: 'Soft guidance after terminal replan',
    class: 'soft_layer', tags: ['steal', 'soft', 'post-amt', 'path-anomaly'],
    summary: 'Prefer a bounded productive action and verify after the terminal replan.',
    evidence: [{ kind: 'post_amt', text: 'post_agent_miss_terminal_replan observed' }],
  }, pinnedProbe({ adopt: true, notes: [] }));
  assert.equal(result.wroteCandidate, false);
  assert.equal(result.candidatePath, null);
  assert.equal(result.reason, 'shipped_duplicate');
  assert.deepEqual(candidateFiles(root), []);
  const body = fs.readFileSync(result.experiencePath, 'utf8');
  assert.ok(body.includes(PIN));
  assert.ok(body.includes('a'.repeat(64)));
  assert.equal(field(body, 'adopted_candidate'), 'no (shipped_duplicate)');
  assert.equal(field(body, 'runId'), 'run-steal');
  assert.equal(field(body, 'path_counts'), 'DGR=1 tip-path=1 post_amt=1 agent_miss=0');
  assert.equal(field(body, 'path_tags'), 'DGR, tip-path');
});

test('T-pae-6: CLOSED PASS CLI preserves bench run identity and first-hand evidence with 0 CANDIDATE', (t) => {
  const root = temporaryRoot(t);
  const benchLog = path.join(root, 'bench-log-run777.md');
  const jsonl = path.join(root, 'run777a.jsonl');
  const outDir = path.join(root, 'out');
  fs.writeFileSync(benchLog, `# run777 — CLOSED PASS\n\n- tip: \`${PIN}\`\n\n| cell | result | notes |\n| --- | --- | --- |\n| t1/run777a | PASS | DGR observed; ≠ tip-path; ≠ post_amt |\n`);
  const runtimeEvent = (sequence, kind, payload) => ({
    type: 'runtime_event', schemaVersion: '1.0', runId: 'runtime-cell-777',
    sequence, kind, payload, emittedAtMs: sequence,
  });
  fs.writeFileSync(jsonl, [
    runtimeEvent(1, 'harness.agent_miss_replan', { status: 'UNCERTAIN', failureCodes: [] }),
    runtimeEvent(2, 'verification.completed', {
      status: 'PASS', failureCodes: [], checks: [{ id: DGR_CHECK, status: 'PASS' }],
    }),
    runtimeEvent(3, 'run.completed', { ok: true }),
    { ok: true, harness: { verification: { status: 'PASS', checks: [{ id: DGR_CHECK, status: 'PASS' }] } } },
  ].map((event) => JSON.stringify(event)).join('\n') + '\n');
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('../run-from-miss.mjs', import.meta.url)),
    '--bench-log', benchLog, '--jsonl', jsonl,
    '--path-anomaly', '--allow-experience-only', '--out-dir', outDir,
    '--experience-dir', path.join(outDir, 'experience'),
  ], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 0, `${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  assert.deepEqual(candidateFiles(outDir), []);
  const files = fs.readdirSync(path.join(outDir, 'experience')).filter((name) => name.endsWith('.md'));
  assert.ok(files.length > 0, 'CLI must write EXPERIENCE');
  for (const file of files) {
    const body = fs.readFileSync(path.join(outDir, 'experience', file), 'utf8');
    assert.equal(field(body, 'runId'), 'run777');
    assert.equal(field(body, 'path_counts'), 'DGR=1 tip-path=0 post_amt=0 agent_miss=1');
    assert.equal(field(body, 'path_tags'), 'DGR');
    assert.equal(field(body, 'check_ids'), DGR_CHECK);
    assert.equal(field(body, 'adopted_candidate'), 'no (experience_only)');
  }
});

test('T-pae-7: legacy EXPERIENCE without structured counts preserves existing retrieval tags', () => {
  const entry = parseExperienceBody(`# EXPERIENCE — Historical path observations

- **slug**: historical-path-observations
- **adopted_candidate**: no (experience_only)
- **lesson**: DGR, tip-path, post_amt and agent_miss observed.
`);
  for (const tag of ['dgr', 'tip-path', 'post-amt', 'agent-miss']) assert.ok(entry.tags.includes(tag), tag);
  assert.equal(entry.reason, 'experience_only');
});
