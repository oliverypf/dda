import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBenchLog, parseCellRow, resolveRun, ingestMiss } from '../ingest.mjs';
import { proposeFromIngest, attachPrior } from '../propose.mjs';
import { retrieveExperience, parseExperienceBody } from '../experience.mjs';
import { countPathSignals } from '../path-signals.mjs';
import { readJsonlEvents } from '../ingest.mjs';
import { composeCandidate } from '../compose.mjs';
import { probeL0 } from '../probe.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIVE = path.resolve(__dirname, '../..');

test('T-h2w-1: parseBenchLog run60 + run99 tables; resolveRun path-anomaly', () => {
  const r60 = parseBenchLog(path.join(DRIVE, 'bench-log-run60.md'));
  assert.ok(r60.cells.length >= 8, `run60 cells=${r60.cells.length}`);
  assert.ok(r60.redCells.length >= 1);

  const r99 = parseBenchLog(path.join(DRIVE, 'bench-log-run99.md'));
  assert.ok(r99.cells.length >= 8, `run99 cells=${r99.cells.length}`);
  assert.equal(r99.gatePass, true);
  assert.ok(r99.pathAnomalyCells.length >= 1, 'run99 notes should flag path-anomaly');

  const row = parseCellRow('| t3/run99a | t3-160 | **PASS** | agent_miss_replan |');
  assert.equal(row.cell, 't3/run99a');
  assert.equal(row.result, 'PASS');
  assert.equal(row.subject, 't3-160');

  const resolved = resolveRun(99, { drive: DRIVE, mode: 'path-anomaly' });
  assert.equal(resolved.ok, true, resolved.reason);
  assert.ok(resolved.paths.length >= 1);
  assert.ok(resolved.paths.some((p) => p.includes('run99')));
});

test('T-h2w-2: Propose with non-empty EXPERIENCE attaches prior; empty lib still OK', () => {
  const ingest = {
    totals: { poisonLoopCount: 1, dprCount: 1, stickyCount: 0, agentMissCount: 0 },
    pathSignals: { agentMissCount: 0, dgrPromoteCount: 0, tipPathCount: 0, postAmtCount: 0, progressFailLeaseCount: 0 },
    cells: [
      {
        cellId: 't3/run60a',
        poisonLoopCount: 1,
        dprCount: 1,
        evidenceQuotes: [
          { kind: 'poison_loop', sequence: 10, text: 'upgrade probe-only' },
          { kind: 'dpr', sequence: 5, text: 'dpr ordinal=1' },
        ],
      },
    ],
  };

  const empty = proposeFromIngest(ingest, { experienceEntries: [], skipExperience: false });
  // retrieve with empty entries → experienceContext may be empty filter
  const emptyLib = proposeFromIngest(ingest, { experienceEntries: [] });
  assert.ok(emptyLib.accepted.length >= 1);
  assert.ok(emptyLib.accepted.every((h) => Array.isArray(h.prior)));

  const entries = [
    parseExperienceBody(
      `# EXPERIENCE — Sticky PTE\n\n- **slug**: post-dpr-sticky-execute\n- **adopted_candidate**: yes (probe_adopt)\n- **lesson**: Sticky execute after poison loop. Green without poisonLoop==0 is false win.\n`,
      { file: '2026-10-22-post-dpr-sticky-execute.md' },
    ),
  ];
  // score them via retrieve
  const hits = retrieveExperience(null, {
    query: 'poison-loop sticky post-dpr',
    entries,
    limit: 3,
  });
  assert.ok(hits.length >= 1);

  const withLib = proposeFromIngest(ingest, { experienceEntries: entries });
  assert.ok(withLib.accepted.length >= 1);
  const sticky = withLib.accepted.find((h) => h.slug === 'post-dpr-sticky-execute');
  assert.ok(sticky, 'expected sticky hypothesis');
  assert.ok(Array.isArray(sticky.prior), 'prior must be array');
  assert.ok(sticky.prior.length >= 1, 'non-empty experience → prior refs');
  assert.equal(sticky.prior[0].slug, 'post-dpr-sticky-execute');

  const attached = attachPrior({ id: 'X', slug: 'x' }, hits);
  assert.ok(attached.prior.length >= 1);
});

test('T-h2w-3: false-win → 0× CANDIDATE', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h2w-fw-'));
  const hyp = {
    id: 'H1',
    slug: 'post-dpr-sticky-execute',
    title: 'Sticky',
    summary: 'x',
    evidence: [{ text: 'e', sequence: 1 }],
    prior: [],
  };
  const fixture = path.join(__dirname, 'fixtures/false-win-poison.jsonl');
  const probe = probeL0(hyp, {
    jsonlPaths: [fixture],
    exitOk: true,
    summaryOk: true,
    verificationPass: true,
    simulateStickySuppress: false,
  });
  assert.equal(probe.falseWin, true);
  assert.equal(probe.adopt, false);
  const r = composeCandidate({
    hypothesis: hyp,
    probeResult: probe,
    ingest: { cells: [{ cellId: 't3/x' }], totals: { poisonLoopCount: 1 } },
    outDir: dir,
    experienceDir: path.join(dir, 'experience'),
    date: '2026-10-24',
    write: true,
  });
  assert.equal(r.wroteCandidate, false);
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('freeze-candidate')).length, 0);
  assert.ok(r.experiencePath && fs.existsSync(r.experiencePath));
});

test('T-h2w-1 path-anomaly: run99 t3 ingest signals agent_miss + progress fail', () => {
  const jsonl = path.join(DRIVE, 'bench/t3/run99a.jsonl');
  assert.ok(fs.existsSync(jsonl));
  const events = readJsonlEvents(jsonl);
  const sig = countPathSignals(events);
  assert.ok(sig.agentMissCount >= 1, 'agent_miss');
  assert.ok(sig.progressFailLeaseCount >= 1, 'progress fail lease');
  assert.equal(sig.isPathAnomaly, true);

  const ingest = ingestMiss({
    benchLogPath: path.join(DRIVE, 'bench-log-run99.md'),
    jsonlPaths: [jsonl],
  });
  const proposal = proposeFromIngest(ingest, {
    experienceDir: path.join(DRIVE, 'experience'),
  });
  assert.ok(proposal.accepted.length >= 1);
  assert.ok(
    proposal.accepted.some((h) => h.slug.includes('agent-miss') || h.tags?.includes('path-anomaly')),
    `expected path-anomaly hyp, got ${proposal.accepted.map((h) => h.slug)}`,
  );
  // prior present when experience dir non-empty
  if (fs.readdirSync(path.join(DRIVE, 'experience')).some((f) => f.endsWith('.md'))) {
    assert.ok(proposal.accepted.every((h) => Array.isArray(h.prior)));
  }
});
