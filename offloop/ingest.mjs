/**
 * Ingest bench-log markdown + cell jsonl into a timeline summary.
 * Supports run60-style tables and run99+ subject-column tables.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { countPoisonLoops } from './poison-loop.mjs';
import { countPathSignals, notesPathAnomaly } from './path-signals.mjs';

const PRODUCT_ROOT = path.dirname(fileURLToPath(import.meta.url));

function configuredPath(explicit, envName, fallback) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit;
  const fromEnv = process.env[envName];
  return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv : fallback;
}

function resolveDriveRoot(explicit) {
  return configuredPath(explicit, 'DDA_DRIVE_ROOT', PRODUCT_ROOT);
}

function resolveBenchRoot(explicit) {
  return configuredPath(explicit, 'DDA_BENCH_ROOT', path.join(PRODUCT_ROOT, 'bench'));
}

const INTERESTING_KINDS = new Set([
  'topology.upgraded',
  'topology.selected',
  'topology.budget_blocked',
  'harness.diagnose_probe_exhausted_recover',
  'harness.post_dpr_sticky_execute',
  'harness.agent_miss_replan',
  'harness.post_agent_miss_terminal_replan',
  'harness.post_miss_uncertain_replan',
  'harness.post_miss_uncertain_exhausted_replan',
  'harness.post_miss_evidence_delta_replan',
  'verification.completed',
  'run.failed',
  'run.completed',
]);

/**
 * @param {string} jsonlPath
 * @returns {object[]}
 */
export function readJsonlEvents(jsonlPath) {
  const text = fs.readFileSync(jsonlPath, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed
    }
  }
  return out;
}

/**
 * Parse one matrix row. Supports:
 *   | t3/run60a | MISS | notes |
 *   | t1/run99a | t1-136 | **PASS** | notes |
 * @param {string} line
 */
export function parseCellRow(line) {
  if (!line || line[0] !== '|') return null;
  const parts = line.split('|').map((s) => s.trim());
  if (parts.length < 3) return null;
  const cols = parts.slice(1, -1);
  if (cols.length < 2) return null;
  const cell = cols[0];
  if (!/^t[1-4c]\/run\S+$/i.test(cell)) return null;

  let resultIdx = -1;
  for (let i = 1; i < cols.length; i++) {
    const cleaned = cols[i].replace(/\*/g, '').trim();
    if (/^(PASS|MISS|FAIL|SKIP|TRANSPORT)(_|$|\s)/i.test(cleaned) || /^(PASS|MISS|FAIL|SKIP|TRANSPORT)$/i.test(cleaned)) {
      resultIdx = i;
      break;
    }
  }
  if (resultIdx < 0) return null;
  const result = cols[resultIdx].replace(/\*/g, '').trim();
  const subject = resultIdx > 1 ? cols[1].replace(/\*/g, '').trim() : null;
  const notes = cols.slice(resultIdx + 1).join(' | ').trim();
  return { cell, subject, result, notes };
}

/**
 * @param {string} benchLogPath
 */
export function parseBenchLog(benchLogPath) {
  const text = fs.readFileSync(benchLogPath, 'utf8');
  const cells = [];
  for (const line of text.split('\n')) {
    const row = parseCellRow(line);
    if (row) cells.push(row);
  }
  const tipMatch = text.match(/`([0-9a-f]{7,40})`/);
  const greensMatch =
    text.match(/\*\*Greens\*\*[^:]*:\s*\*\*(\d+)\s*\/\s*(\d+)\*\*/i) ||
    text.match(/Greens\s*\(GATE[^)]*\)\s*:\s*\*\*(\d+)\s*\/\s*(\d+)\*\*/i) ||
    text.match(/T1–T4\s*\*\*(\d+)\/(\d+)\*\*/i);
  const gatePass = /GATE:\s*\*?\*?PASS\b/i.test(text) || /GATE\s+PASS\b/i.test(text);
  const gateMiss = /GATE MISS/i.test(text) || /GATE:\s*\*?\*?MISS\b/i.test(text);
  const closedPass = /CLOSED\s+PASS/i.test(text);
  const closedMiss = /CLOSED\s+MISS/i.test(text);
  // Whole-doc tip-path / agent_miss / 「0× 被 post_amt 抢」prose is monitoring.
  // Hook path-anomaly（路径异常）is driven by matrix *cell notes* only.
  const pathAnomalyCells = cells.filter((c) => notesPathAnomaly(c.notes).any);
  const docAnomaly = false;
  return {
    path: benchLogPath,
    tip: tipMatch?.[1] || null,
    greens: greensMatch ? Number(greensMatch[1]) : null,
    greensDenom: greensMatch ? Number(greensMatch[2]) : null,
    gatePass,
    gateMiss,
    closedPass,
    closedMiss,
    docAnomaly,
    cells,
    redCells: cells.filter((c) => c.result === 'MISS' && !c.cell.startsWith('tc/')),
    pathAnomalyCells,
    hasPathAnomaly: pathAnomalyCells.length > 0,
  };
}

/**
 * Resolve bench-log-runN.md + jsonl paths under bench/.
 * @param {string|number} runId e.g. 99 | '99' | 'run99'
 * @param {{ drive?: string, benchRoot?: string, mode?: 'red'|'path-anomaly'|'all'|'auto' }} opts
 */
export function resolveRun(runId, opts = {}) {
  const drive = resolveDriveRoot(opts.drive);
  const benchRoot = resolveBenchRoot(opts.benchRoot);
  const n = String(runId).replace(/^run/i, '');
  const benchLogPath = path.join(drive, `bench-log-run${n}.md`);
  if (!fs.existsSync(benchLogPath)) {
    return { ok: false, reason: `missing ${benchLogPath}`, n, benchLogPath, paths: [], bench: null };
  }
  const bench = parseBenchLog(benchLogPath);
  let mode = opts.mode || 'auto';
  if (mode === 'auto') {
    if (bench.redCells.length > 0 || bench.gateMiss) mode = 'red';
    else if (bench.pathAnomalyCells.length > 0) mode = 'path-anomaly';
    else mode = 'all';
  }

  /** @type {string[]} */
  let paths = [];
  if (mode === 'red') {
    for (const cell of bench.redCells) {
      const p = cellPath(benchRoot, cell.cell);
      if (p) paths.push(p);
    }
  } else if (mode === 'path-anomaly') {
    for (const cell of bench.pathAnomalyCells) {
      const p = cellPath(benchRoot, cell.cell);
      if (p) paths.push(p);
    }
    // also pick jsonl cells that signal path anomaly even if notes missed
    if (paths.length === 0) {
      paths = discoverRunJsonl(benchRoot, n).filter((p) => {
        const events = readJsonlEvents(p);
        return countPathSignals(events).isPathAnomaly;
      });
    }
  } else {
    paths = discoverRunJsonl(benchRoot, n);
  }

  return {
    ok: paths.length > 0,
    reason: paths.length ? null : `no jsonl for mode=${mode} run=${n}`,
    n,
    mode,
    benchLogPath,
    bench,
    paths,
  };
}

/**
 * Latest CLOSED-looking bench-log by mtime among run*.md that parse.
 */
export function resolveLatestClosed(opts = {}) {
  const drive = resolveDriveRoot(opts.drive);
  const files = fs
    .readdirSync(drive)
    .filter((f) => /^bench-log-run\d+\.md$/.test(f))
    .map((f) => ({ f, mtime: fs.statSync(path.join(drive, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f } of files) {
    const m = f.match(/^bench-log-run(\d+)\.md$/);
    if (!m) continue;
    const resolved = resolveRun(m[1], { ...opts, mode: opts.mode || 'auto' });
    if (resolved.ok) return resolved;
  }
  return { ok: false, reason: 'no resolvable closed run', paths: [], bench: null };
}

function cellPath(benchRoot, cellId) {
  const [tier, run] = String(cellId).split('/');
  if (!tier || !run) return null;
  const p = path.join(benchRoot, tier, `${run}.jsonl`);
  return fs.existsSync(p) ? p : null;
}

function discoverRunJsonl(benchRoot, n) {
  const out = [];
  for (const tier of ['t1', 't2', 't3', 't4', 'tc']) {
    for (const suffix of ['a', 'b']) {
      const p = path.join(benchRoot, tier, `run${n}${suffix}.jsonl`);
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} [opts.benchLogPath]
 * @param {string[]} opts.jsonlPaths
 * @param {string} [opts.benchRoot]
 * @param {boolean} [opts.includePathSignals=true]
 */
export function ingestMiss({
  benchLogPath,
  jsonlPaths,
  benchRoot: requestedBenchRoot,
  includePathSignals = true,
}) {
  const benchRoot = resolveBenchRoot(requestedBenchRoot);
  const bench = benchLogPath ? parseBenchLog(benchLogPath) : null;
  const cells = [];

  for (const jsonlPath of jsonlPaths) {
    const events = readJsonlEvents(jsonlPath);
    const poison = countPoisonLoops(events);
    const pathSig = includePathSignals ? countPathSignals(events) : null;
    const interesting = [];
    let runId = null;
    let finalOk = null;
    let finalVerification = null;

    for (const ev of events) {
      if (ev.type === 'runtime_event') {
        runId = runId || ev.runId;
        if (INTERESTING_KINDS.has(ev.kind)) {
          interesting.push({
            sequence: ev.sequence,
            kind: ev.kind,
            emittedAtMs: ev.emittedAtMs,
            payload: summarizePayload(ev.kind, ev.payload || {}),
          });
        }
      } else if (typeof ev.ok === 'boolean') {
        finalOk = ev.ok;
        finalVerification = ev.harness?.verification?.status || null;
      }
    }

    const base = path.basename(jsonlPath, '.jsonl');
    const parent = path.basename(path.dirname(jsonlPath));
    const cellId = /^t[1-4c]$/.test(parent) ? `${parent}/${base}` : base;
    const benchRow = bench?.cells?.find((c) => c.cell === cellId);

    const evidenceQuotes = [
      ...buildEvidenceQuotes(interesting, poison),
      ...(pathSig?.evidenceQuotes || []),
    ].slice(0, 20);

    cells.push({
      cellId,
      jsonlPath,
      runId,
      finalOk,
      finalVerification,
      poisonLoopCount: poison.count,
      poisonInstances: poison.instances,
      dprCount: poison.dprCount,
      stickyCount: poison.stickyCount,
      pathSignals: pathSig,
      notes: benchRow?.notes || '',
      notesAnomaly: notesPathAnomaly(benchRow?.notes || ''),
      timeline: interesting,
      evidenceQuotes,
    });
  }

  const pathSignals = {
    agentMissCount: cells.reduce((s, c) => s + (c.pathSignals?.agentMissCount || 0), 0),
    postAmtCount: cells.reduce((s, c) => s + (c.pathSignals?.postAmtCount || 0), 0),
    dgrPromoteCount: cells.reduce((s, c) => s + (c.pathSignals?.dgrPromoteCount || 0), 0),
    tipPathCount: cells.reduce((s, c) => s + (c.pathSignals?.tipPathCount || 0), 0),
    progressFailLeaseCount: cells.reduce(
      (s, c) => s + (c.pathSignals?.progressFailLeaseCount || 0),
      0,
    ),
  };

  return {
    ingestedAt: new Date().toISOString(),
    benchRoot,
    bench,
    cells,
    pathSignals,
    totals: {
      cells: cells.length,
      poisonLoopCount: cells.reduce((s, c) => s + c.poisonLoopCount, 0),
      dprCount: cells.reduce((s, c) => s + c.dprCount, 0),
      stickyCount: cells.reduce((s, c) => s + c.stickyCount, 0),
      ...pathSignals,
    },
  };
}

function summarizePayload(kind, payload) {
  switch (kind) {
    case 'topology.upgraded':
      return {
        from: payload.from,
        to: payload.to,
        failureCodes: payload.failureCodes || [],
        attempt: payload.attempt,
      };
    case 'topology.selected':
      return { topology: payload.topology, reasonCodes: payload.reasonCodes || [] };
    case 'topology.budget_blocked':
      return {
        name: payload.name,
        reasonCode: payload.reasonCode,
        topology: payload.topology,
      };
    case 'harness.diagnose_probe_exhausted_recover':
      return {
        recoverOrdinal: payload.recoverOrdinal,
        from: payload.fromTopology,
        to: payload.toTopology,
        probes: payload.probes,
        maxProbes: payload.maxProbes,
      };
    case 'harness.post_dpr_sticky_execute':
      return payload;
    case 'harness.agent_miss_replan':
    case 'harness.post_agent_miss_terminal_replan':
      return {
        status: payload.status,
        failureCodes: payload.failureCodes || [],
        writesApplied: payload.writesApplied,
      };
    case 'verification.completed':
      return {
        status: payload.status,
        failureCodes: payload.failureCodes || [],
        progressMessage: (payload.checks || []).find((c) => c.id === 'actions.progress')?.message,
      };
    case 'run.failed':
      return { code: payload.code, failureCodes: payload.failureCodes || [] };
    default:
      return payload;
  }
}

function buildEvidenceQuotes(interesting, poison) {
  const quotes = [];
  for (const inst of poison.instances) {
    quotes.push({
      kind: 'poison_loop',
      sequence: inst.sequence,
      text: `topology.upgraded ${inst.from}→${inst.to} codes=${JSON.stringify(inst.failureCodes)} progress=${inst.progressMessage || ''}`,
    });
  }
  for (const ev of interesting) {
    if (ev.kind === 'harness.diagnose_probe_exhausted_recover') {
      quotes.push({
        kind: 'dpr',
        sequence: ev.sequence,
        text: `diagnose_probe_exhausted_recover ordinal=${ev.payload.recoverOrdinal} ${ev.payload.from}→${ev.payload.to}`,
      });
    }
    if (ev.kind === 'topology.budget_blocked' && ev.payload.reasonCode === 'TOPOLOGY_BUDGET_PROBES') {
      quotes.push({
        kind: 'budget_blocked',
        sequence: ev.sequence,
        text: `budget_blocked ${ev.payload.name} TOPOLOGY_BUDGET_PROBES under ${ev.payload.topology}`,
      });
    }
  }
  return quotes.slice(0, 12);
}

/**
 * Resolve default red-cell jsonl paths from a bench log + bench root.
 */
export function resolveRedCellJsonl(benchLogPath, benchRoot) {
  const bench = parseBenchLog(benchLogPath);
  benchRoot = resolveBenchRoot(benchRoot);
  const paths = [];
  for (const cell of bench.redCells) {
    const p = cellPath(benchRoot, cell.cell);
    if (p) paths.push(p);
  }
  return { bench, paths };
}
