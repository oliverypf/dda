import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ingestMiss, readJsonlEvents } from '../ingest.mjs';
import { composeCandidate } from '../compose.mjs';
import { proposeFromIngest } from '../propose.mjs';
import {
  countPathSignals,
  STEAL_TIP_PIN,
  summarizePathAnomalyFields,
} from '../path-signals.mjs';
import { formatPathStructuredFields, parseExperienceBody, retrieveExperience } from '../experience.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = path.join(ROOT, 'offloop/out-harness2-agent-miss-route-ledger-r1');
const FIXTURES = path.join(OUT, 'fixtures');
const MATRIX_PATH = path.join(OUT, 'route-ledger-matrix.json');
const RECONCILE_PATH = path.join(OUT, 'route-ledger-reconcile.json');
const AFTER_HASHES_PATH = path.join(OUT, 'after-hashes.txt');
const NO_PRODUCT_DELTA_PATH = path.join(OUT, 'no-product-delta.json');
const SUMMARY_PATH = path.join(OUT, 'summary.json');
const BEFORE_HASHES_PATH = path.join(OUT, 'before-hashes.txt');
const FREEZE_PATH = path.join(ROOT, 'freeze-offloop-harness2-agent-miss-route-ledger-r1.md');
const TIP = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const FREEZE_LOCK = '85eb95cd361fc55932fb2f63689a7cbafe7d40e8fe99646fbc3c70bf082bda76';
const KNIFE6 = 'probe-compose-experience-prior-contract-r1';

const CHECK_DGR = 'deterministic-green-jev-behavior-reject-promote';
const CHECK_TIP = 'deterministic-green-jev-uncertain-tip-path';

const MATRIX_ROWS = [
  {
    id: 'mid-agent-miss-alone',
    cell: 't1/run-h2r-mid',
    notes: 'mid agent_miss alone; no DGR and no tip-path promote',
    expected: { agentMiss: 1, dgr: 0, tipPath: 0, postAmt: 0, postMissUncertain: 0 },
    events: [
      {
        type: 'runtime_event',
        kind: 'harness.agent_miss_replan',
        sequence: 1,
        runId: 'h2r-mid',
        payload: { status: 'mid', failureCodes: ['AF', 'BR'] },
      },
    ],
  },
  {
    id: 'real-dgr-promote',
    cell: 't2/run-h2r-dgr',
    notes: 'mid agent_miss followed by a real DGR behavior-reject promote check',
    expected: { agentMiss: 1, dgr: 1, tipPath: 0, postAmt: 0, postMissUncertain: 0 },
    events: [
      {
        type: 'runtime_event',
        kind: 'harness.agent_miss_replan',
        sequence: 1,
        runId: 'h2r-dgr',
        payload: { status: 'mid', failureCodes: ['AF', 'BR'] },
      },
      {
        type: 'runtime_event',
        kind: 'verification.completed',
        sequence: 2,
        runId: 'h2r-dgr',
        payload: {
          status: 'PASS',
          checks: [{ id: CHECK_DGR, status: 'PASS', message: 'DGR promote observed' }],
        },
      },
    ],
  },
  {
    id: 'real-tip-path-promote',
    cell: 't3/run-h2r-tip',
    notes: 'real uncertain tip-path promote check; no DGR check',
    expected: { agentMiss: 0, dgr: 0, tipPath: 1, postAmt: 0, postMissUncertain: 0 },
    events: [
      {
        type: 'runtime_event',
        kind: 'verification.completed',
        sequence: 1,
        runId: 'h2r-tip',
        payload: {
          status: 'PASS',
          checks: [{ id: CHECK_TIP, status: 'PASS', message: 'uncertain tip-path promote observed' }],
        },
      },
    ],
  },
  {
    id: 'post-miss-replan-no-post-amt',
    cell: 't4/run-h2r-post-miss',
    notes: 'post_miss_uncertain_replan and post_miss_evidence_delta_replan are not post_amt',
    expected: { agentMiss: 1, dgr: 0, tipPath: 0, postAmt: 0, postMissUncertain: 3 },
    events: [
      {
        type: 'runtime_event',
        kind: 'harness.agent_miss_replan',
        sequence: 1,
        runId: 'h2r-post-miss',
        payload: { status: 'mid', failureCodes: ['AF'] },
      },
      {
        type: 'runtime_event',
        kind: 'harness.post_miss_uncertain_replan',
        sequence: 2,
        runId: 'h2r-post-miss',
        payload: {},
      },
      {
        type: 'runtime_event',
        kind: 'harness.post_miss_uncertain_exhausted_replan',
        sequence: 3,
        runId: 'h2r-post-miss',
        payload: {},
      },
      {
        type: 'runtime_event',
        kind: 'harness.post_miss_evidence_delta_replan',
        sequence: 4,
        runId: 'h2r-post-miss',
        payload: {},
      },
    ],
  },
  {
    id: 'prose-keywords-only',
    cell: 'tc/run-h2r-prose',
    notes: 'notes mention DGR tip-path agent_miss, but no structured evidence is present',
    expected: { agentMiss: 0, dgr: 0, tipPath: 0, postAmt: 0, postMissUncertain: 0 },
    events: [
      {
        type: 'note',
        sequence: 1,
        notes: 'DGR tip-path agent_miss post_amt are only prose keywords',
      },
      {
        type: 'comment',
        sequence: 2,
        text: 'agent_miss was discussed; deterministic-green-jev behavior-reject is not evidence',
      },
    ],
  },
];

const COUNTER_KEYS = ['dgr', 'tipPath', 'postAmt', 'agentMiss'];

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function freezeSection0Sha() {
  const body = fs.readFileSync(FREEZE_PATH, 'utf8');
  const start = body.indexOf('## 0. 锁定');
  const end = body.indexOf('\n## 1. 不做', start);
  assert.ok(start >= 0 && end > start, 'freeze §0 must be present');
  return sha256Text(body.slice(start, end + 1));
}

function ensureFixtureFiles() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const benchLines = [
    '# route-ledger synthetic bench notes',
    '',
    ...MATRIX_ROWS.map((row) => `| ${row.cell} | PASS | ${row.notes} |`),
    '',
  ];
  const benchLogPath = path.join(FIXTURES, 'bench-log-route-ledger.md');
  fs.writeFileSync(benchLogPath, benchLines.join('\n'), 'utf8');

  const paths = new Map();
  for (const row of MATRIX_ROWS) {
    const [tier, filename] = row.cell.split('/');
    const dir = path.join(FIXTURES, tier);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${filename}.jsonl`);
    fs.writeFileSync(file, `${row.events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
    paths.set(row.id, file);
  }
  return { benchLogPath, paths };
}

function priorEntry() {
  const fields = formatPathStructuredFields({
    runId: 'route-ledger-prior',
    pathCounts: { dgr: 0, tipPath: 0, postAmt: 0, agentMiss: 1 },
    checkIds: [],
  });
  const body = [
    '# EXPERIENCE — route ledger prior',
    '',
    '- **date**: 2026-10-26 (America/Adak)',
    '- **slug**: experience-route-ledger-prior',
    '- **adopted_candidate**: no (experience_only)',
    '- **source runs**: route-ledger-prior',
    '- **lesson**: Structured agent_miss observation remains EXPERIENCE-only; prose does not promote DGR or tip-path.',
    fields,
    '- **poison loop**: count=0',
    '- **prior**: none',
    '',
  ].join('\n');
  return parseExperienceBody(body, { file: '2026-10-26-experience-route-ledger-prior.md' });
}

function expectedCounts(row) {
  return {
    dgr: row.expected.dgr,
    tipPath: row.expected.tipPath,
    postAmt: row.expected.postAmt,
    agentMiss: row.expected.agentMiss,
  };
}

function pathFieldsAgree(fields, counts) {
  return JSON.stringify(fields.pathCounts) === JSON.stringify(counts) &&
    JSON.stringify(fields.pathTags) === JSON.stringify(
      [counts.dgr > 0 ? 'DGR' : null, counts.tipPath > 0 ? 'tip-path' : null].filter(Boolean),
    ) &&
    (counts.dgr === 0 || fields.checkIds.some((id) => id === CHECK_DGR || id === `execute.${CHECK_DGR}`)) &&
    (counts.tipPath === 0 || fields.checkIds.some((id) => id === CHECK_TIP || id === `execute.${CHECK_TIP}`));
}

function buildMatrix() {
  const { benchLogPath, paths } = ensureFixtureFiles();
  const prior = priorEntry();
  const rows = [];

  for (const row of MATRIX_ROWS) {
    const jsonlPath = paths.get(row.id);
    const events = readJsonlEvents(jsonlPath);
    const directSignals = countPathSignals(events);
    const ingest = ingestMiss({ benchLogPath, jsonlPaths: [jsonlPath] });
    const summary = summarizePathAnomalyFields(ingest);
    const counts = expectedCounts(row);
    const ingestCounts = {
      dgr: ingest.pathSignals.dgrPromoteCount,
      tipPath: ingest.pathSignals.tipPathCount,
      postAmt: ingest.pathSignals.postAmtCount,
      agentMiss: ingest.pathSignals.agentMissCount,
    };
    const cellSignals = ingest.cells[0]?.pathSignals || {};

    const proposal = proposeFromIngest(ingest, {
      experienceEntries: [prior],
      skipExperience: false,
    });
    const experienceHypothesis = proposal.accepted.find((hypothesis) => hypothesis.class === 'experience');
    assert.ok(experienceHypothesis, `${row.id}: proposal must retain an EXPERIENCE hypothesis`);

    const workDir = path.join(OUT, 'matrix-work', row.id);
    fs.rmSync(workDir, { recursive: true, force: true });
    const composedExperience = composeCandidate({
      hypothesis: experienceHypothesis,
      probeResult: { adopt: true, notes: ['route-ledger matrix'] },
      ingest,
      outDir: workDir,
      experienceDir: path.join(workDir, 'experience'),
      date: '2026-10-26',
      write: true,
    });
    assert.equal(composedExperience.wroteCandidate, false, `${row.id}: EXPERIENCE cannot write CANDIDATE`);
    assert.equal(composedExperience.reason, 'experience_only', `${row.id}: route must be experience_only`);
    assert.ok(composedExperience.experiencePath, `${row.id}: EXPERIENCE evidence should be written`);
    const storedExperience = parseExperienceBody(
      fs.readFileSync(composedExperience.experiencePath, 'utf8'),
      { file: path.basename(composedExperience.experiencePath), full: composedExperience.experiencePath },
    );
    const retrieved = retrieveExperience(null, {
      entries: [storedExperience],
      pathSignals: ingest.pathSignals,
      runId: summary.runId,
      limit: 5,
    });

    const routeResults = proposal.accepted.map((hypothesis) => {
      const result = composeCandidate({
        hypothesis,
        probeResult: { adopt: false, notes: ['route-ledger matrix default stop'] },
        ingest,
        outDir: path.join(workDir, 'route-probes'),
        experienceDir: path.join(workDir, 'route-probes/experience'),
        date: '2026-10-26',
        write: false,
      });
      return {
        slug: hypothesis.slug,
        class: hypothesis.class,
        prior: (hypothesis.prior || []).map((entry) => ({
          slug: entry.slug,
          adopted: entry.adopted,
          reason: entry.reason,
        })),
        wroteCandidate: result.wroteCandidate,
        reason: result.reason,
      };
    });

    const checks = {
      ingestCountsMatch: JSON.stringify(ingestCounts) === JSON.stringify(counts),
      directSignalsMatch: directSignals.agentMissCount === row.expected.agentMiss &&
        directSignals.dgrPromoteCount === row.expected.dgr &&
        directSignals.tipPathCount === row.expected.tipPath &&
        directSignals.postAmtCount === row.expected.postAmt &&
        directSignals.postMissUncertainCount === row.expected.postMissUncertain,
      experienceCountsMatch: pathFieldsAgree(storedExperience, counts),
      experienceRetrievable: retrieved.some((entry) => entry.slug === storedExperience.slug),
      experienceOnlyAdoptedFalse: storedExperience.adopted === false &&
        experienceHypothesis.class === 'experience' &&
        (experienceHypothesis.prior || []).every((entry) => entry.adopted === false),
      composeExperienceOnly: composedExperience.reason === 'experience_only',
      noCandidateRoute: routeResults.every((route) => route.wroteCandidate === false),
      midAgentMissDoesNotPromote: row.id !== 'mid-agent-miss-alone' ||
        (counts.agentMiss > 0 && counts.dgr === 0 && counts.tipPath === 0 &&
          summary.path_tags.length === 0 && summary.checkIds.length === 0),
      dgrPromoteIsTyped: row.id !== 'real-dgr-promote' ||
        (summary.path_tags.includes('DGR') && summary.checkIds.includes(CHECK_DGR)),
      tipPathPromoteIsTyped: row.id !== 'real-tip-path-promote' ||
        (summary.path_tags.includes('tip-path') && summary.checkIds.includes(CHECK_TIP)),
      postMissNeverPostAmt: row.id !== 'post-miss-replan-no-post-amt' ||
        (cellSignals.postMissUncertainCount === 3 && counts.postAmt === 0 &&
          summary.path_tags.length === 0 && summary.checkIds.length === 0),
      proseDoesNotInvent: row.id !== 'prose-keywords-only' ||
        (Object.values(counts).every((value) => value === 0) &&
          summary.path_tags.length === 0 && summary.checkIds.length === 0 &&
          (storedExperience.pathTags || []).length === 0 &&
          (storedExperience.checkIds || []).length === 0),
    };

    rows.push({
      id: row.id,
      cell: row.cell,
      notes: row.notes,
      fixture: path.relative(ROOT, jsonlPath),
      expected: row.expected,
      ingest: {
        pathSignals: ingest.pathSignals,
        cellPathSignals: cellSignals,
        totals: ingest.totals,
      },
      pathSignals: directSignals,
      experience: {
        path_counts: storedExperience.pathCounts,
        path_tags: storedExperience.pathTags || [],
        check_ids: storedExperience.checkIds || [],
        adopted: storedExperience.adopted,
        reason: composedExperience.reason,
        retrieved: retrieved.map((entry) => entry.slug),
      },
      propose: {
        accepted: proposal.accepted.map((hypothesis) => ({
          slug: hypothesis.slug,
          class: hypothesis.class,
          prior: (hypothesis.prior || []).map((entry) => ({
            slug: entry.slug,
            adopted: entry.adopted,
            reason: entry.reason,
          })),
        })),
        experienceHypothesis: experienceHypothesis.slug,
      },
      compose: {
        experienceOnly: {
          wroteCandidate: composedExperience.wroteCandidate,
          reason: composedExperience.reason,
          experiencePath: path.relative(ROOT, composedExperience.experiencePath),
        },
        routes: routeResults,
        candidateWrites: routeResults.filter((route) => route.wroteCandidate).length,
      },
      checks,
      pass: Object.values(checks).every(Boolean),
    });
  }

  const allGreen = rows.every((row) => row.pass);
  const mismatches = rows
    .filter((row) => !row.pass)
    .flatMap((row) => Object.entries(row.checks)
      .filter(([, pass]) => !pass)
      .map(([check]) => ({ row: row.id, check })));
  const matrix = {
    knife: 'harness2-agent-miss-route-ledger-r1',
    wave: 'wave14',
    knifeNumber: 5,
    pack: 'B',
    fixtureMode: 'synthetic-jsonl-under-out',
    rows,
    allGreen,
  };
  const reconcile = {
    knife: matrix.knife,
    wave: matrix.wave,
    knifeNumber: matrix.knifeNumber,
    pack: matrix.pack,
    allGreen,
    verdict: allGreen ? 'STOP' : 'PRODUCT_DELTA',
    mismatches,
    productDeltaFiles: [],
    candidateWrites: 0,
    note: allGreen
      ? 'Fresh cross-layer matrix is green; STOP / NO_PRODUCT_DELTA.'
      : 'Residual mismatch requires review before any product write.',
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(MATRIX_PATH, `${JSON.stringify(matrix, null, 2)}\n`, 'utf8');
  fs.writeFileSync(RECONCILE_PATH, `${JSON.stringify(reconcile, null, 2)}\n`, 'utf8');
  return { matrix, reconcile };
}

function loadOrBuild() {
  if (!fs.existsSync(MATRIX_PATH) || !fs.existsSync(RECONCILE_PATH)) return buildMatrix();
  return {
    matrix: JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8')),
    reconcile: JSON.parse(fs.readFileSync(RECONCILE_PATH, 'utf8')),
  };
}

function protectedAfterHashes() {
  const lines = fs.readFileSync(BEFORE_HASHES_PATH, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  return lines.map((line) => {
    const [, file] = line.trim().split(/\s+/);
    return `${sha256File(path.join(ROOT, file))}  ${file}`;
  });
}

function writeStopArtifacts(reconcile, matrix) {
  const beforeLines = fs.readFileSync(BEFORE_HASHES_PATH, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const afterLines = protectedAfterHashes();
  fs.writeFileSync(AFTER_HASHES_PATH, `${afterLines.join('\n')}\n`, 'utf8');
  assert.deepEqual(afterLines, beforeLines, 'STOP product hashes must remain byte-identical');

  const noDelta = {
    verdict: 'STOP',
    allGreen: true,
    productWrites: 0,
    productDeltaFiles: [],
    reason: 'Fresh matrix allGreen=true; no product mismatch was proven.',
    matrix: 'route-ledger-matrix.json',
    reconcile: 'route-ledger-reconcile.json',
  };
  fs.writeFileSync(NO_PRODUCT_DELTA_PATH, `${JSON.stringify(noDelta, null, 2)}\n`, 'utf8');

  const summary = {
    knife: 'harness2-agent-miss-route-ledger-r1',
    wave: 'wave14',
    knifeNumber: 5,
    pack: 'B',
    status: 'FROZEN / SCAN READY',
    productDelta: 0,
    runtimeDelta: 0,
    tipPin: TIP,
    STEAL_TIP_PIN: TIP,
    tipHead: execFileSync('git', ['-C', '/workspace/dda-tip-r25', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    productWrites: 0,
    runtimeWrites: 0,
    mainOpenRouterCalls: 0,
    liveBurns: 0,
    liveBurn: false,
    model: 'deepseek-v4.1-flash',
    jev: 'Zen',
    candidateWrites: 0,
    candidateCount: 0,
    emptyTipDoubleGreen: false,
    tipDualGreen: false,
    autoCandidatePromote: false,
    tests: {
      command: "cd /workspace/dda-drive/offloop && /home/box/.local/node24/bin/node --test --test-reporter=tap --test-isolation=none '--test-name-pattern=^T-w14-h2r-' test/harness2-agent-miss-route-ledger-r1.test.mjs",
      ids: ['T-w14-h2r-1', 'T-w14-h2r-2'],
      'T-w14-h2r-1': 'PASS',
      'T-w14-h2r-2': 'PASS',
      passed: 2,
      total: 2,
      tap: 'focused.tap',
      file: 'offloop/test/harness2-agent-miss-route-ledger-r1.test.mjs',
      focusedTap: 'focused.tap',
    },
    freezeStatus: 'FROZEN / SCAN READY',
    freezeFileStatus: 'FROZEN / 开干',
    freeze: 'FROZEN / SCAN READY',
    freezeRemainsFROZEN: true,
    selfClosed: false,
    freezeLockSha256: FREEZE_LOCK,
    freezeSection0LockSha256: freezeSection0Sha(),
    verdict: 'STOP',
    allGreen: true,
    noProductDelta: true,
    productDeltaLabel: 'NO_PRODUCT_DELTA',
    product_delta: 0,
    knife6MustNotStart: true,
    doNotStartKnives: [KNIFE6],
    productHashesUnchanged: true,
    productDeltaFiles: [],
    stop: true,
    afterHashes: 'after-hashes.txt',
    beforeHashes: 'before-hashes.txt',
    matrix: 'route-ledger-matrix.json',
    reconcile: 'route-ledger-reconcile.json',
    productBaseline: {
      'offloop/experience.mjs': '64e7c25770e78cec02cb7d5714ef9ea13ed450ca9ca941865138eea824c58aeb',
      'offloop/compose.mjs': 'e284a70868d3954cfe6ce2461683b9e3edbd3d5305c5754cd2eedcafe7aa4e4b',
      'offloop/dayloop-soft.mjs': '39dbf330b3143335163e6209c0a5d8d32538cfb72ededc40ab979b689e48fef3',
      'offloop/soft-worktree.mjs': '45d3119e9a2f4ceae239f16ff61b863d67c20880786b561979ae9c9cb2c21316',
      'offloop/propose.mjs': '08390e92bc5de89c5b29286b24c942e93ec5256f6fc20e643f9bf09b0ea5c411',
    },
    rows: matrix.rows.map((row) => ({ id: row.id, pass: row.pass })),
    independentScanPerformedByThisKnife: false,
  };
  fs.writeFileSync(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

if (
  process.execArgv.includes('--test-isolation=none') ||
  (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
) {
  test('T-w14-h2r-1: fresh matrix cross-layer reconcile', () => {
    const { matrix, reconcile } = buildMatrix();
    const loadedMatrix = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8'));
    const loadedReconcile = JSON.parse(fs.readFileSync(RECONCILE_PATH, 'utf8'));
    assert.deepEqual(loadedMatrix, matrix);
    assert.deepEqual(loadedReconcile, reconcile);
    assert.equal(matrix.rows.length, 5);
    assert.equal(reconcile.allGreen, true);
    assert.equal(reconcile.verdict, 'STOP');
    assert.deepEqual(reconcile.mismatches, []);
    assert.deepEqual(reconcile.productDeltaFiles, []);

    const mid = matrix.rows.find((row) => row.id === 'mid-agent-miss-alone');
    assert.equal(mid.ingest.pathSignals.agentMissCount, 1);
    assert.equal(mid.ingest.pathSignals.dgrPromoteCount, 0);
    assert.equal(mid.ingest.pathSignals.tipPathCount, 0);
    assert.deepEqual(mid.experience.path_tags, []);
    assert.deepEqual(mid.experience.check_ids, []);

    const dgr = matrix.rows.find((row) => row.id === 'real-dgr-promote');
    assert.ok(dgr.experience.path_tags.includes('DGR'));
    assert.ok(dgr.experience.check_ids.includes(CHECK_DGR));

    const tip = matrix.rows.find((row) => row.id === 'real-tip-path-promote');
    assert.ok(tip.experience.path_tags.includes('tip-path'));
    assert.ok(tip.experience.check_ids.includes(CHECK_TIP));

    const postMiss = matrix.rows.find((row) => row.id === 'post-miss-replan-no-post-amt');
    assert.equal(postMiss.ingest.cellPathSignals.postMissUncertainCount, 3);
    assert.equal(postMiss.ingest.pathSignals.postAmtCount, 0);
    assert.equal(postMiss.experience.path_counts.postAmt, 0);
    assert.deepEqual(postMiss.experience.path_tags, []);

    const prose = matrix.rows.find((row) => row.id === 'prose-keywords-only');
    assert.deepEqual(prose.pathSignals, {
      agentMissCount: 0,
      postAmtCount: 0,
      postMissUncertainCount: 0,
      dprCount: 0,
      stickyCount: 0,
      dgrPromoteCount: 0,
      tipPathCount: 0,
      progressFailLeaseCount: 0,
      evidenceQuotes: [],
      isPathAnomaly: false,
    });
    assert.deepEqual(prose.experience.path_tags, []);
    assert.deepEqual(prose.experience.check_ids, []);

    for (const row of matrix.rows) {
      assert.equal(row.pass, true, `${row.id}: ${JSON.stringify(row.checks)}`);
      assert.equal(row.experience.adopted, false, `${row.id}: EXPERIENCE must stay adopted=false`);
      assert.equal(row.compose.candidateWrites, 0, `${row.id}: no CANDIDATE writes`);
      assert.ok(row.propose.accepted.every((hypothesis) => Array.isArray(hypothesis.prior)));
    }
  });

  test('T-w14-h2r-2: PIN freeze honesty and STOP product hash gate', () => {
    const { matrix, reconcile } = loadOrBuild();
    assert.equal(reconcile.allGreen, true);
    assert.equal(reconcile.verdict, 'STOP');
    assert.equal(STEAL_TIP_PIN, TIP);
    assert.equal(fs.readFileSync(path.join(OUT, 'tip-head.txt'), 'utf8').trim(), TIP);
    assert.equal(
      execFileSync('git', ['-C', '/workspace/dda-tip-r25', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      TIP,
    );
    assert.equal(freezeSection0Sha(), FREEZE_LOCK);
    const freeze = fs.readFileSync(FREEZE_PATH, 'utf8');
    assert.match(freeze, /^# .*FROZEN \/ 开干/m);
    assert.match(freeze, /\*\*状态：FROZEN \/ 开干/);
    assert.doesNotMatch(freeze.split('\n')[0], /CLOSED/);
    const session = JSON.parse(fs.readFileSync(path.join(OUT, 'session-start.json'), 'utf8'));
    assert.equal(session.selfClosed, false);
    assert.equal(session.productWrites, 0);
    assert.equal(session.runtimeWrites, 0);
    assert.equal(session.freezeLockSha256, FREEZE_LOCK);
    assert.equal(sha256File(FREEZE_PATH), session.freezeFullSha256);

    const before = fs.readFileSync(BEFORE_HASHES_PATH, 'utf8').trim().split(/\r?\n/).filter(Boolean);
    const after = protectedAfterHashes();
    assert.deepEqual(after, before);
    fs.writeFileSync(AFTER_HASHES_PATH, `${after.join('\n')}\n`, 'utf8');
    assert.equal(
      sha256File(path.join(ROOT, 'offloop/dayloop-soft.mjs')),
      '39dbf330b3143335163e6209c0a5d8d32538cfb72ededc40ab979b689e48fef3',
    );
    writeStopArtifacts(reconcile, matrix);

    const noDelta = JSON.parse(fs.readFileSync(NO_PRODUCT_DELTA_PATH, 'utf8'));
    const summary = JSON.parse(fs.readFileSync(SUMMARY_PATH, 'utf8'));
    assert.equal(noDelta.verdict, 'STOP');
    assert.deepEqual(noDelta.productDeltaFiles, []);
    assert.equal(summary.freezeStatus, 'FROZEN / SCAN READY');
    assert.equal(summary.freezeFileStatus, 'FROZEN / 开干');
    assert.equal(summary.selfClosed, false);
    assert.equal(summary.freezeLockSha256, FREEZE_LOCK);
    assert.equal(summary.wave, 'wave14');
    assert.equal(summary.knifeNumber, 5);
    assert.equal(summary.pack, 'B');
    assert.equal(summary.productWrites, 0);
    assert.equal(summary.runtimeWrites, 0);
    assert.equal(summary.mainOpenRouterCalls, 0);
    assert.equal(summary.liveBurns, 0);
    assert.equal(summary.candidateWrites, 0);
    assert.equal(summary.productHashesUnchanged, true);
    assert.equal(summary.knife6MustNotStart, true);
    assert.deepEqual(summary.doNotStartKnives, [KNIFE6]);
    assert.equal(summary.verdict, 'STOP');
    assert.equal(summary.allGreen, true);
    assert.deepEqual(summary.productDeltaFiles, []);
  });
}
