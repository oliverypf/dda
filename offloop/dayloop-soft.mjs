#!/usr/bin/env node
/**
 * One-command soft-layer day-loop e2e (bounded L1; fixture by default):
 *   Ingest → Propose → Probe L0 → Probe L1 (+ soft worktree) → Compose
 *
 * Usage:
 *   node dayloop-soft.mjs --fixture soft-clean --soft-worktree DIR --out-dir DIR
 *   node dayloop-soft.mjs --fixture false-win  --soft-worktree DIR --out-dir DIR
 *   node dayloop-soft.mjs --fixture hard-gate  --soft-worktree DIR --out-dir DIR
 *
 * Equivalent miss path:
 *   node run-from-miss.mjs --bench-log … --jsonl … --probe-l1 --probe-l1-soft … \
 *     --soft-worktree DIR --tip-sha 2258685ce9793639ebc9698c8961dcedccf6e49b --out-dir DIR --allow-experience-only
 *
 * Never writes FROZEN. Never edits oliverypf/dda runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestMiss, resolveRun, parseBenchLog } from './ingest.mjs';
import { proposeFromIngest, isSoftHypothesis, listExperience } from './propose.mjs';
import { probeL0, probeL1 } from './probe.mjs';
import { prepareSoftWorktree } from './soft-worktree.mjs';
import { composeCandidate } from './compose.mjs';
import { matchesMergedDirection } from './merged-directions.mjs';
import { hypothesisIsSteal, isExperienceOnlyHypothesis } from './path-signals.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'test/fixtures');
const DEFAULT_TIP = '2258685ce9793639ebc9698c8961dcedccf6e49b'; // post-#90 master

/**
 * @param {object} opts
 * @param {'soft-clean'|'false-win'|'hard-gate'} [opts.fixture='soft-clean']
 * @param {string} [opts.tipSha] — explicit tip overrides bench-log tip, then post-#90 master default
 * @param {string} [opts.outDir]
 * @param {string} [opts.softWorktreeDir]
 * @param {string} [opts.benchLogPath]
 * @param {string} [opts.baselineJsonl]
 * @param {string} [opts.softJsonl]
 * @param {string} [opts.experienceDir]
 * @param {boolean} [opts.write=true]
 * @param {boolean} [opts.dryRun=false]
 * @param {'fixture'|'sim'|'live'} [opts.l1Mode='fixture']
 * @param {boolean} [opts.l1Live=false] explicit live alias; requires model and jev
 * @param {string} [opts.model]
 * @param {string} [opts.jev]
 * @param {string[]} [opts.l1Subjects] explicit subjects are validated by probeL1
 * @param {unknown} [opts.transportError]
 * @param {string|number} [opts.liveStatus]
 * @param {object} [opts.transportRecord] optional transportClass/requestSha256/subjects/elapsedMs evidence
 * @param {string} [opts.transportClass] overrides the record class (otherwise transportError name/string)
 * @param {string} [opts.requestSha256] overrides the record request hash
 * @param {number} [opts.elapsedMs] overrides the record elapsed time
 * @param {object} [opts.hypothesis] force single hypothesis (skips propose filter to this)
 */


const DRIVE_DEFAULT = path.resolve(__dirname, '..');

/**
 * Resolve MISS baseline the same way run-from-miss does:
 * bench-log-runN.md + associated jsonl. Fixture soft-clean only as
 * **explicit visible fallback** when artifacts missing/void — never silent.
 *
 * @param {object} opts
 * @param {string|number} [opts.runId]
 * @param {string} [opts.drive]
 * @param {string} [opts.benchLogPath]
 * @param {string} [opts.baselineJsonl]
 * @param {string[]} [opts.baselineJsonlPaths]
 * @param {string} [opts.tipSha]
 * @param {boolean} [opts.allowFixtureFallback=true]
 * @param {number} [opts.minJsonlBytes=1] — treat smaller as void (use 1024 to match run60 live gate)
 * @returns {{
 *   ok: boolean,
 *   source: 'run'|'explicit'|'fixture-fallback',
 *   fallback: boolean,
 *   reason: string|null,
 *   runId: string|null,
 *   benchLogPath: string,
 *   baselineJsonlPaths: string[],
 *   tipSha: string,
 *   benchTip: string|null,
 * }}
 */
export function resolveMissBaseline(opts = {}) {
  const drive = opts.drive || DRIVE_DEFAULT;
  const fixtures = opts.fixturesDir || FIXTURES;
  const tipShaOpt = opts.tipSha ? String(opts.tipSha) : null;
  const minBytes = opts.minJsonlBytes != null ? Number(opts.minJsonlBytes) : 1;
  const allowFallback = opts.allowFixtureFallback !== false;
  const runId =
    opts.runId != null && String(opts.runId).trim() !== ''
      ? String(opts.runId).replace(/^run/i, '')
      : null;

  const fixtureBench = path.join(fixtures, 'e2e-soft-bench-log.md');
  const fixtureJsonl = path.join(fixtures, 'e2e-soft-baseline.jsonl');

  const usable = (p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).size >= minBytes;
    } catch {
      return false;
    }
  };

  // Explicit paths from caller (e2e / CLI) — not a silent miss fallback
  if (opts.baselineJsonlPaths?.length || opts.baselineJsonl) {
    const paths = (opts.baselineJsonlPaths?.length
      ? opts.baselineJsonlPaths
      : [opts.baselineJsonl]
    ).filter((p) => p && fs.existsSync(p));
    const benchLogPath =
      opts.benchLogPath && fs.existsSync(opts.benchLogPath)
        ? opts.benchLogPath
        : fixtureBench;
    let benchTip = null;
    try {
      // The built-in fixture's historical tip is not a caller-supplied baseline.
      benchTip = opts.benchLogPath && fs.existsSync(opts.benchLogPath)
        ? parseBenchLog(benchLogPath).tip || null
        : null;
    } catch {
      benchTip = null;
    }
    if (paths.length) {
      return {
        ok: true,
        source: 'explicit',
        fallback: false,
        reason: null,
        runId,
        benchLogPath,
        baselineJsonlPaths: paths,
        tipSha: tipShaOpt || benchTip || DEFAULT_TIP,
        benchTip,
      };
    }
  }

  // Prefer run artifacts when runId (or bench-log path) provided
  const benchLogPath =
    opts.benchLogPath ||
    (runId ? path.join(drive, `bench-log-run${runId}.md`) : null);

  if (runId || (benchLogPath && opts.fromMiss)) {
    if (!benchLogPath || !fs.existsSync(benchLogPath)) {
      if (!allowFallback) {
        return {
          ok: false,
          source: 'fixture-fallback',
          fallback: true,
          reason: `missing_bench_log:${benchLogPath || '(none)'}`,
          runId,
          benchLogPath: fixtureBench,
          baselineJsonlPaths: [fixtureJsonl],
          tipSha: tipShaOpt || DEFAULT_TIP,
          benchTip: null,
        };
      }
      return {
        ok: false,
        source: 'fixture-fallback',
        fallback: true,
        reason: `missing_bench_log:${benchLogPath || '(none)'}`,
        runId,
        benchLogPath: fixtureBench,
        baselineJsonlPaths: [fixtureJsonl],
        tipSha: tipShaOpt || DEFAULT_TIP,
        benchTip: null,
      };
    }

    let benchTip = null;
    try {
      benchTip = parseBenchLog(benchLogPath).tip || null;
    } catch {
      benchTip = null;
    }

    /** @type {string[]} */
    let paths = [];
    let resolveReason = null;

    if (runId) {
      const resolved = resolveRun(runId, { drive, mode: 'auto' });
      resolveReason = resolved.reason;
      if (resolved.paths?.length) {
        paths = resolved.paths.filter(usable);
      }
      // run60-style pair discovery when resolveRun finds nothing usable
      if (!paths.length) {
        const candidates = [
          [
            path.join(drive, 'bench/t3', `run${runId}a.jsonl`),
            path.join(drive, 'bench/t3', `run${runId}b.jsonl`),
          ],
          [
            path.join(drive, `bench/logs/run${runId}-void1/t3`, `run${runId}a.jsonl`),
            path.join(drive, `bench/logs/run${runId}-void1/t3`, `run${runId}b.jsonl`),
          ],
        ];
        for (const pair of candidates) {
          if (pair.every(usable)) {
            paths = pair;
            resolveReason = null;
            break;
          }
        }
      }
    }

    if (paths.length) {
      return {
        ok: true,
        source: 'run',
        fallback: false,
        reason: null,
        runId,
        benchLogPath,
        baselineJsonlPaths: paths,
        tipSha: tipShaOpt || benchTip || DEFAULT_TIP,
        benchTip,
      };
    }

    // Visible fallback — never silent fake-green
    const reason =
      resolveReason ||
      `missing_or_void_jsonl:run=${runId || '?'} bench=${benchLogPath}`;
    return {
      ok: false,
      source: 'fixture-fallback',
      fallback: true,
      reason,
      runId,
      // Keep real bench-log when present so EXPERIENCE/ingest still see the MISS context
      benchLogPath,
      baselineJsonlPaths: [fixtureJsonl],
      tipSha: tipShaOpt || benchTip || DEFAULT_TIP,
      benchTip,
      runBenchLogPath: benchLogPath,
    };
  }

  // Pure fixture e2e (no runId) — explicit soft-clean defaults, not miss silent path
  let benchTip = null;
  try {
    if (benchLogPath && fs.existsSync(benchLogPath)) {
      benchTip = parseBenchLog(benchLogPath).tip || null;
    }
  } catch {
    benchTip = null;
  }
  return {
    ok: true,
    source: 'explicit',
    fallback: false,
    reason: null,
    runId: null,
    benchLogPath: opts.benchLogPath && fs.existsSync(opts.benchLogPath) ? opts.benchLogPath : fixtureBench,
    baselineJsonlPaths: [
      opts.baselineJsonl && fs.existsSync(opts.baselineJsonl)
        ? opts.baselineJsonl
        : fixtureJsonl,
    ],
    tipSha: tipShaOpt || benchTip || DEFAULT_TIP,
    benchTip,
  };
}

function writeBaselineFallbackExperience({
  experienceDir,
  date,
  runId,
  reason,
  benchLogPath,
  baselineJsonlPaths,
  tipSha,
  write,
}) {
  const body = `# EXPERIENCE — dayloop baseline fixture-fallback

- **date**: ${date} (America/Adak)
- **slug**: dayloop-baseline-fixture-fallback
- **adopted_candidate**: no (baseline_fixture_fallback)
- **runId**: ${runId || 'n/a'}
- **reason**: ${reason || 'missing_artifacts'}
- **benchLogPath**: \`${benchLogPath}\`
- **baselineJsonlPaths**: ${baselineJsonlPaths.map((p) => `\`${p}\``).join(', ')}
- **tipShaBaseline**: \`${tipSha}\`
- **lesson**: MISS+\`--dayloop-soft\` could not load real run artifacts; fell back to soft-clean / poison-loop fixture. **Not** a silent fake-green — this EXPERIENCE records the gap. Re-run when bench-log-runN.md + jsonl exist.
- **runtime contract**: DDA runtime must **0×** read \`dda-drive/experience/\` as unchecked Memory.
- **promoted knife**: none
`;
  const expPath = path.join(
    experienceDir,
    `${date}-dayloop-baseline-fixture-fallback-rejected.md`,
  );
  if (write) {
    fs.mkdirSync(experienceDir, { recursive: true });
    fs.writeFileSync(expPath, body, 'utf8');
  }
  return { path: expPath, body };
}

/**
 * Resolve soft-side contrast jsonl for a MISS run (mirror resolveMissBaseline).
 * Prefer that run's soft/pair artifacts; if missing → visible fixture-fallback
 * (never silent fake-green as run-pair). Pure e2e / explicit soft stays explicit.
 *
 * Naming (aligned with run-from-miss / tip t3 pairs):
 *   bench/t3/run{N}a-soft.jsonl + run{N}b-soft.jsonl
 *   bench/t3/run{N}-soft.jsonl
 *   bench/t3/run{N}a.soft.jsonl (+ optional b)
 *   bench/logs/run{N}-void1/t3/run{N}{a,b}-soft.jsonl
 *
 * @param {object} opts
 * @param {string|number} [opts.runId]
 * @param {string} [opts.drive]
 * @param {string} [opts.softJsonl]
 * @param {string[]} [opts.softJsonlPaths]
 * @param {'soft-clean'|'false-win'|'hard-gate'} [opts.fixture='soft-clean']
 * @param {boolean} [opts.allowFixtureFallback=true]
 * @param {boolean} [opts.fromMiss]
 * @param {number} [opts.minJsonlBytes=1]
 * @param {string} [opts.fixturesDir]
 * @returns {{
 *   ok: boolean,
 *   softSource: 'run-pair'|'explicit'|'fixture-fallback',
 *   fallback: boolean,
 *   reason: string|null,
 *   runId: string|null,
 *   softJsonlPaths: string[],
 *   fixtureSoftJsonl: string,
 * }}
 */
export function resolveSoftContrast(opts = {}) {
  const drive = opts.drive || DRIVE_DEFAULT;
  const fixtures = opts.fixturesDir || FIXTURES;
  const minBytes = opts.minJsonlBytes != null ? Number(opts.minJsonlBytes) : 1;
  const allowFallback = opts.allowFixtureFallback !== false;
  const fixture = opts.fixture || 'soft-clean';
  const runId =
    opts.runId != null && String(opts.runId).trim() !== ''
      ? String(opts.runId).replace(/^run/i, '')
      : null;
  const fromMiss = opts.fromMiss === true || runId != null;

  const fixtureSoft =
    fixture === 'false-win'
      ? path.join(fixtures, 'l1-soft-false-win.jsonl')
      : path.join(fixtures, 'l1-soft-clean.jsonl');

  const usable = (p) => {
    try {
      return Boolean(p) && fs.existsSync(p) && fs.statSync(p).size >= minBytes;
    } catch {
      return false;
    }
  };

  // Explicit soft paths from caller (CLI / e2e) — not a silent miss fallback
  if (opts.softJsonlPaths?.length || opts.softJsonl) {
    const paths = (opts.softJsonlPaths?.length
      ? opts.softJsonlPaths
      : [opts.softJsonl]
    ).filter(usable);
    if (paths.length) {
      return {
        ok: true,
        softSource: 'explicit',
        fallback: false,
        reason: null,
        runId,
        softJsonlPaths: paths,
        fixtureSoftJsonl: fixtureSoft,
      };
    }
  }

  // hard-gate e2e: no soft jsonl needed (worktree reject path)
  if (fixture === 'hard-gate' && !fromMiss) {
    return {
      ok: true,
      softSource: 'explicit',
      fallback: false,
      reason: null,
      runId,
      softJsonlPaths: [],
      fixtureSoftJsonl: fixtureSoft,
    };
  }

  // Discover soft/pair jsonl for this run
  if (fromMiss && runId) {
    /** @type {string[][]} */
    const candidateSets = [
      [
        path.join(drive, 'bench/t3', `run${runId}a-soft.jsonl`),
        path.join(drive, 'bench/t3', `run${runId}b-soft.jsonl`),
      ],
      [path.join(drive, 'bench/t3', `run${runId}-soft.jsonl`)],
      [
        path.join(drive, 'bench/t3', `run${runId}a.soft.jsonl`),
        path.join(drive, 'bench/t3', `run${runId}b.soft.jsonl`),
      ],
      [path.join(drive, 'bench/t3', `run${runId}a.soft.jsonl`)],
      [
        path.join(drive, `bench/logs/run${runId}-void1/t3`, `run${runId}a-soft.jsonl`),
        path.join(drive, `bench/logs/run${runId}-void1/t3`, `run${runId}b-soft.jsonl`),
      ],
      [path.join(drive, `bench/logs/run${runId}-void1/t3`, `run${runId}-soft.jsonl`)],
      [
        path.join(drive, 'bench/soft/t3', `run${runId}a.jsonl`),
        path.join(drive, 'bench/soft/t3', `run${runId}b.jsonl`),
      ],
      [path.join(drive, 'bench/soft/t3', `run${runId}.jsonl`)],
    ];

    for (const set of candidateSets) {
      if (set.every(usable)) {
        return {
          ok: true,
          softSource: 'run-pair',
          fallback: false,
          reason: null,
          runId,
          softJsonlPaths: set,
          fixtureSoftJsonl: fixtureSoft,
        };
      }
      // Accept single usable member of a multi-file set (partial pair)
      const found = set.filter(usable);
      if (found.length >= 1 && set.length === 1) {
        return {
          ok: true,
          softSource: 'run-pair',
          fallback: false,
          reason: null,
          runId,
          softJsonlPaths: found,
          fixtureSoftJsonl: fixtureSoft,
        };
      }
    }
    // Also: if a-soft exists alone (b missing), still count as run-pair soft side
    for (const set of candidateSets) {
      const found = set.filter(usable);
      if (found.length >= 1) {
        return {
          ok: true,
          softSource: 'run-pair',
          fallback: false,
          reason: null,
          runId,
          softJsonlPaths: found,
          fixtureSoftJsonl: fixtureSoft,
        };
      }
    }

    const reason = `missing_soft_pair_jsonl:run=${runId}`;
    if (!allowFallback) {
      return {
        ok: false,
        softSource: 'fixture-fallback',
        fallback: true,
        reason,
        runId,
        softJsonlPaths: [fixtureSoft],
        fixtureSoftJsonl: fixtureSoft,
      };
    }
    return {
      ok: false,
      softSource: 'fixture-fallback',
      fallback: true,
      reason,
      runId,
      softJsonlPaths: [fixtureSoft],
      fixtureSoftJsonl: fixtureSoft,
    };
  }

  // Pure fixture e2e (no runId) — explicit soft-clean / false-win defaults
  return {
    ok: true,
    softSource: 'explicit',
    fallback: false,
    reason: null,
    runId: null,
    softJsonlPaths: fixture === 'hard-gate' ? [] : [fixtureSoft],
    fixtureSoftJsonl: fixtureSoft,
  };
}

function writeSoftContrastFallbackExperience({
  experienceDir,
  date,
  runId,
  reason,
  softJsonlPaths,
  tipSha,
  write,
}) {
  const body = `# EXPERIENCE — dayloop soft contrast fixture-fallback

- **date**: ${date} (America/Adak)
- **slug**: dayloop-soft-contrast-fixture-fallback
- **adopted_candidate**: no (fixture-fallback)
- **runId**: ${runId || 'n/a'}
- **softSource**: fixture-fallback
- **reason**: ${reason || 'missing_soft_pair_jsonl'}
- **softJsonlPaths**: ${(softJsonlPaths || []).map((p) => `\`${p}\``).join(', ') || '(none)'}
- **tipShaBaseline**: \`${tipSha}\`
- **lesson**: MISS+\`--dayloop-soft\` soft contrast side could not find run-pair soft jsonl (e.g. \`run{N}a-soft.jsonl\`); fell back to soft fixture. **Not** a silent fake-green as run-pair — this EXPERIENCE records the gap. Re-run when soft/pair artifacts exist.
- **runtime contract**: DDA runtime must **0×** read \`dda-drive/experience/\` as unchecked Memory.
- **promoted knife**: none
`;
  const expPath = path.join(
    experienceDir,
    `${date}-dayloop-soft-contrast-fixture-fallback-rejected.md`,
  );
  if (write) {
    fs.mkdirSync(experienceDir, { recursive: true });
    fs.writeFileSync(expPath, body, 'utf8');
  }
  return { path: expPath, body };
}


/** True FROZEN status on a candidate file (not checklist prose mentioning future FROZEN). */
export function countWrongFrozenStatus(candidatePath) {
  if (!candidatePath || !fs.existsSync(candidatePath)) return 0;
  const body = fs.readFileSync(candidatePath, 'utf8');
  // Title/status claiming FROZEN now — wrong for Compose output
  if (/r1：\*\*FROZEN\*\*/.test(body)) return 1;
  if (/状态：\*\*FROZEN\*\*/.test(body)) return 1;
  if (/^#\s+.*r1：\*\*FROZEN\*\*/m.test(body)) return 1;
  // Must remain CANDIDATE
  if (/\*\*CANDIDATE\*\*/.test(body) || /状态：CANDIDATE/.test(body)) return 0;
  return 0;
}

function resolveL1Mode(opts) {
  if (opts.l1Mode === 'live' || opts.l1Live === true) return 'live';
  return opts.l1Mode === 'sim' ? 'sim' : 'fixture';
}

/**
 * Build enabled, bounded L1 options while leaving rejection gates to probeL1.
 * Only inferred subjects are capped; explicit over-bound requests must reject.
 * @param {object} opts caller options (l1Mode/l1Live, l1Subjects, credentials, transport)
 * @param {object} context resolved ingest, soft worktree, write, l0, baseline and softLayer
 */
export function buildBoundedL1Opts(opts = {}, context = {}) {
  const l1Opts = {
    enabled: true,
    mode: resolveL1Mode(opts),
    subjects: opts.l1Subjects ?? (context.ingest?.cells || [])
      .slice(0, 2)
      .map((c) => c.cellId || c.cell)
      .filter(Boolean),
    softWorktreeDir: context.softWorktreeDir,
    prepareSoftWorktree: true,
    writeSoftWorktree: context.write,
    l0: context.l0,
    baseline: context.baseline,
    softLayer: context.softLayer,
  };
  for (const key of ['model', 'jev', 'transportError', 'liveStatus']) {
    if (opts[key] !== undefined) l1Opts[key] = opts[key];
  }
  return l1Opts;
}

export function runDayloopSoft(opts = {}) {
  const fixture = opts.fixture || 'soft-clean';
  const write = opts.write !== false && opts.dryRun !== true;
  const outDir = opts.outDir || path.join(__dirname, '..', 'out-dayloop-soft');
  const experienceDir = opts.experienceDir || path.join(outDir, 'experience');
  const softWorktreeDir =
    opts.softWorktreeDir || path.join(outDir, 'soft-worktree');
  const date = opts.date || todayAdak();

  const baseline = resolveMissBaseline({
    runId: opts.runId,
    drive: opts.drive,
    benchLogPath: opts.benchLogPath,
    baselineJsonl: opts.baselineJsonl,
    baselineJsonlPaths: opts.baselineJsonlPaths,
    tipSha: opts.tipSha,
    allowFixtureFallback: opts.allowFixtureFallback !== false,
    minJsonlBytes: opts.minJsonlBytes,
    fromMiss: opts.fromMiss === true || opts.runId != null,
    fixturesDir: opts.fixturesDir,
  });

  const tipSha = String(baseline.tipSha || DEFAULT_TIP);
  const benchLogPath = baseline.benchLogPath;
  const baselineJsonlPaths = baseline.baselineJsonlPaths;
  const baselineJsonl = baselineJsonlPaths[0];

  const softContrast = resolveSoftContrast({
    runId: opts.runId,
    drive: opts.drive,
    softJsonl: opts.softJsonl,
    softJsonlPaths: opts.softJsonlPaths,
    fixture,
    tipSha,
    allowFixtureFallback: opts.allowFixtureFallback !== false,
    minJsonlBytes: opts.minJsonlBytes,
    fromMiss: opts.fromMiss === true || opts.runId != null,
    fixturesDir: opts.fixturesDir,
  });
  const softJsonlPaths = softContrast.softJsonlPaths;
  const softJsonl = softJsonlPaths[0] || softContrast.fixtureSoftJsonl;

  if (!baselineJsonlPaths.length || !baselineJsonlPaths.every((p) => fs.existsSync(p))) {
    throw new Error(`baseline jsonl missing: ${baselineJsonlPaths.join(',')}`);
  }
  if (fixture !== 'hard-gate' && softJsonlPaths.length && !softJsonlPaths.every((p) => fs.existsSync(p))) {
    throw new Error(`soft jsonl missing: ${softJsonlPaths.join(',')}`);
  }
  if (fixture !== 'hard-gate' && !softJsonlPaths.length && !fs.existsSync(softJsonl)) {
    throw new Error(`soft jsonl missing: ${softJsonl}`);
  }

  /** @type {string|null} */
  let fallbackExperiencePath = null;
  /** @type {string|null} */
  let softFallbackExperiencePath = null;
  if (baseline.fallback) {
    const fb = writeBaselineFallbackExperience({
      experienceDir,
      date,
      runId: baseline.runId,
      reason: baseline.reason,
      benchLogPath,
      baselineJsonlPaths,
      tipSha,
      write,
    });
    fallbackExperiencePath = write ? fb.path : null;
  }
  if (softContrast.fallback) {
    const sfb = writeSoftContrastFallbackExperience({
      experienceDir,
      date,
      runId: softContrast.runId || baseline.runId,
      reason: softContrast.reason,
      softJsonlPaths,
      tipSha,
      write,
    });
    softFallbackExperiencePath = write ? sfb.path : null;
  }

  // --- Ingest ---
  let ingest = ingestMiss({
    benchLogPath,
    jsonlPaths: baselineJsonlPaths,
  });
  ingest = { ...ingest, tip: tipSha };

  // --- Propose ---
  let proposal = proposeFromIngest(ingest, { experienceDir });
  let hypotheses = proposal.accepted.slice();

  if (fixture === 'hard-gate') {
    hypotheses = [
      opts.hypothesis || {
        id: 'H-hard-gate',
        slug: 'patch-runtime-lease',
        title: 'Patch lease hard gate (e2e reject)',
        class: 'host_code_patch',
        probeKind: 'soft_or_latch_md',
        summary: 'Intentionally targets src/runtime/lease.ts — must reject.',
        softFiles: [{ path: 'src/runtime/lease.ts', content: '// hard-gate probe\n' }],
        evidence: (ingest.cells || []).slice(0, 1).map((c, i) => ({
          cellId: c.cellId,
          sequence: i + 1,
          text: 'hard-gate e2e',
        })),
        latchDraftMd: '',
        tags: ['e2e', 'hard-gate'],
        prior: [],
      },
    ];
    // Still record propose for observability
    proposal = {
      ...proposal,
      accepted: hypotheses,
      note: 'hard-gate fixture overrides propose with forbidden softFiles',
    };
  } else if (opts.hypothesis) {
    hypotheses = [opts.hypothesis];
  }

  // Prefer a soft direction that can still produce a new candidate.
  // Merged sticky hypotheses remain probeable for EXPERIENCE; Compose dedupes them.
  if (fixture !== 'hard-gate' && hypotheses.length > 1) {
    const preferred = hypotheses.find((h) =>
      isSoftHypothesis(h) && !isExperienceOnlyHypothesis(h) &&
      !matchesMergedDirection(h),
    );
    if (preferred) hypotheses = [preferred, ...hypotheses.filter((h) => h !== preferred)].slice(0, 3);
  }

  if (hypotheses.length === 0) {
    // Keep the fixture fallback soft-only and outside the shipped sticky direction.
    hypotheses = [
      {
        id: 'H1',
        slug: 'host-note-post-dpr-execute-bias',
        title: 'HOST note: prefer write/execute/verify after demote',
        class: 'soft_layer',
        probeKind: 'soft_or_latch_md',
        summary: 'Soft-layer guidance: prefer write/execute/verify after diagnose_probe_exhausted_recover.',
        evidence: [{ cellId: 't3/run-e2e-a', sequence: 1, text: 'poison-loop fixture' }],
        latchDraftMd: null,
        tags: ['soft', 'host-note', 'e2e'],
        prior: [],
      },
    ];
    proposal = { ...proposal, accepted: hypotheses, note: 'fallback HOST-note hyp for fixture e2e' };
  }

  const results = [];
  let frozenWrites = 0;

  for (const h of hypotheses) {
    // --- Probe L0 ---
    const probe = probeL0(h, {
      jsonlPaths: baselineJsonlPaths,
      exitOk: true,
      summaryOk: true,
      verificationPass: true,
      simulateStickySuppress: h.slug === 'post-dpr-sticky-execute',
    });

    // --- Probe L1 + soft worktree ---
    const hypSoftDir = path.join(softWorktreeDir, h.slug || 'hyp');
    const l1Opts = buildBoundedL1Opts(opts, {
      ingest,
      softWorktreeDir: hypSoftDir,
      write,
      l0: probe,
      baseline: {
        jsonlPaths: baselineJsonlPaths,
        tipSha,
        exitOk: true,
        summaryOk: true,
        verificationPass: false,
      },
      softLayer: {
        jsonlPaths: fixture === 'hard-gate' ? [] : softJsonlPaths.length ? softJsonlPaths : [softJsonl],
        tipSha,
        worktree: hypSoftDir,
        exitOk: true,
        summaryOk: true,
        verificationPass: true,
      },
    });

    // hard-gate: still call probeL1 which runs prepareSoftWorktree and rejects
    if (fixture === 'false-win') {
      l1Opts.softLayer.verificationPass = true; // green facade; poison remains in soft jsonl
    }

    const l1 = probeL1(h, l1Opts);

    let adoptProbe;
    if (l1.rejected || l1.reason === 'hard_gate_path' || l1.softWorktree?.rejected) {
      adoptProbe = {
        ...probe,
        adopt: false,
        falseWin: false,
        reason: l1.reason || 'hard_gate_path',
        rejected: true,
        notes: [...(probe.notes || []), ...(l1.notes || []), 'L1 hard-gate'],
        l1,
        softWorktree: l1.softWorktree,
        header: l1.header,
      };
    } else if (l1.falseWin || l1.adopt === false) {
      adoptProbe = {
        ...probe,
        adopt: false,
        falseWin: l1.falseWin || false,
        notes: [...(probe.notes || []), ...(l1.notes || []), 'L1 gate'],
        l1,
        softWorktree: l1.softWorktree,
        header: l1.header,
      };
    } else {
      const experienceOnly = isExperienceOnlyHypothesis(h);
      const candidateEligible = !experienceOnly && (
        hypothesisIsSteal(h) ||
        h.class === 'soft_layer' ||
        h.class === 'latch' ||
        h.class === 'latch_draft_md' ||
        probe.adopt === true
      );
      adoptProbe = {
        ...probe,
        adopt: candidateEligible,
        falseWin: false,
        baseline: l1.baseline,
        contrast: l1.contrast,
        notes: [
          ...(probe.notes || []).map((note) => `L0: ${note}`),
          ...(l1.notes || []),
          candidateEligible ? 'L1 pass → may CANDIDATE' :
            experienceOnly ? 'L1 pass (experience-only)' : 'L1 pass (soft deferred)',
        ],
        l1,
        softWorktree: l1.softWorktree,
        header: l1.header,
        tipShaBaseline: tipSha,
        softTreeFileListHash: l1.header?.softTreeFileListHash || null,
      };
    }

    // --- Compose ---
    const composed = composeCandidate({
      hypothesis: h,
      probeResult: adoptProbe,
      ingest,
      outDir,
      experienceDir,
      date,
      // Carry only transport evidence; caller metadata cannot authorize adoption.
      transportRecord: {
        transportClass: opts.transportClass ?? opts.transportRecord?.transportClass ??
          (typeof opts.transportError === 'object' ? opts.transportError?.name : opts.transportError),
        requestSha256: opts.requestSha256 ?? opts.transportRecord?.requestSha256,
        subjects: opts.transportRecord?.subjects ?? l1.summary?.subjects,
        elapsedMs: opts.elapsedMs ?? opts.transportRecord?.elapsedMs,
      },
      write,
    });

    if (composed.candidatePath && fs.existsSync(composed.candidatePath)) {
      frozenWrites += countWrongFrozenStatus(composed.candidatePath);
    }

    results.push({
      hypothesis: h.slug,
      adopt: adoptProbe.adopt,
      falseWin: adoptProbe.falseWin,
      l1: {
        skipped: l1.skipped,
        adopt: l1.adopt,
        falseWin: l1.falseWin,
        rejected: l1.rejected || false,
        reason: l1.reason || null,
        tipShaBaseline: l1.header?.tipShaBaseline || null,
        softTreeFileListHash: l1.header?.softTreeFileListHash || null,
        softWorktreeDir: l1.softWorktree?.dir || hypSoftDir,
        softWriteCount: l1.softWorktree?.writeCount ?? null,
      },
      wroteCandidate: composed.wroteCandidate,
      candidatePath: composed.candidatePath,
      experiencePath: composed.experiencePath,
      reason: composed.reason,
    });
  }

  // A transport stop is written by Compose after the initial Propose pass.
  // Re-run the read-only EXPERIENCE -> Propose wire after those writes so the
  // summary exposes the prior that the just-written lesson actually produced.
  // This never probes, adopts, or writes a CANDIDATE.
  let postWriteProposal = null;
  if (write && results.some((result) =>
    result.experiencePath && result.l1?.reason === 'transport')) {
    const written = results
      .filter((result) => result.experiencePath)
      .map((result) => ({
        hypothesis: result.hypothesis,
        path: result.experiencePath,
        file: path.basename(result.experiencePath),
      }));
    const writtenPaths = new Set(written.map((entry) => path.resolve(entry.path)));
    // Read the files just written and keep their exact records in the refresh
    // pool. If an older adopted record shares a slug, it must not replace the
    // new transport stop and make it look adopted in this consumption proof.
    const libraryEntries = listExperience(experienceDir);
    const writtenSlugs = new Set(libraryEntries
      .filter((entry) => entry.path && writtenPaths.has(path.resolve(entry.path)))
      .map((entry) => entry.slug));
    const refreshEntries = libraryEntries.filter((entry) =>
      !writtenSlugs.has(entry.slug) || (entry.path && writtenPaths.has(path.resolve(entry.path))));
    const refreshed = proposeFromIngest(ingest, { experienceEntries: refreshEntries });
    const retrieved = refreshed.experienceContext
      .filter((entry) => entry.path && writtenPaths.has(path.resolve(entry.path)))
      .map((entry) => ({
        slug: entry.slug,
        file: entry.file,
        path: entry.path,
        adopted: entry.adopted === true,
        reason: entry.rejectReason || entry.reason || null,
        lesson: entry.lesson,
        score: entry.score,
      }));
    const accepted = refreshed.accepted.map((hypothesis) => ({
      slug: hypothesis.slug,
      class: hypothesis.class,
      adopted: hypothesis.adopted === true,
      prior: (hypothesis.prior || []).map((prior) => ({
        slug: prior.slug,
        file: prior.file,
        adopted: prior.adopted === true,
        reason: prior.reason || null,
        lesson: prior.lesson,
        softReject: prior.softReject === true,
      })),
    }));
    const consumed = written.flatMap((entry) => accepted.flatMap((hypothesis) =>
      hypothesis.prior
        .filter((prior) => prior.file === entry.file)
        .map((prior) => ({
          hypothesis: hypothesis.slug,
          experience: entry,
          prior,
        }))
    ));
    postWriteProposal = {
      ran: true,
      experienceDir,
      written,
      retrieved,
      accepted,
      consumed,
      consumedCount: consumed.length,
      consumedOnlyWarnings: consumed.every(({ prior }) => prior.adopted !== true),
      wroteCandidate: refreshed.wroteCandidate === true,
      candidatePath: refreshed.candidatePath || null,
    };
    for (const result of results) {
      const matching = consumed.filter(({ experience }) =>
        experience.path === result.experiencePath,
      );
      result.postWritePrior = matching.map(({ hypothesis, prior }) => ({
        hypothesis,
        ...prior,
      }));
      result.postWritePriorConsumed = matching.length > 0;
    }
  }

  const candidate = results.find((r) => r.wroteCandidate);
  const summary = {
    ok: frozenWrites === 0,
    fixture,
    tipSha,
    phase: 'dayloop-soft',
    l1Mode: resolveL1Mode(opts),
    l1Bounded: true,
    l1LiveRequested: resolveL1Mode(opts) === 'live',
    ingestCells: ingest.cells?.length ?? 0,
    poisonLoop: ingest.totals?.poisonLoopCount ?? null,
    proposed: proposal.accepted?.map((h) => h.slug) || [],
    results,
    candidatePath: candidate?.candidatePath || null,
    wroteCandidate: Boolean(candidate),
    frozenWrites,
    softWorktreeDir,
    outDir,
    baselineSource: baseline.source,
    baselineFallback: Boolean(baseline.fallback),
    baselineFallbackReason: baseline.reason,
    baselineJsonlPaths,
    benchLogPath,
    benchTip: baseline.benchTip,
    runId: baseline.runId,
    fallbackExperiencePath,
    softSource: softContrast.softSource,
    softFallback: Boolean(softContrast.fallback),
    softFallbackReason: softContrast.reason,
    softJsonlPaths,
    softFallbackExperiencePath,
    postWriteProposal,
  };

  return summary;
}

function todayAdak() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseArgs(argv) {
  if (argv.includes('--l1-mode') && (argv.includes('--l1-sim') || argv.includes('--l1-live'))) {
    throw new Error('--l1-mode conflicts with --l1-sim/--l1-live; use one form only');
  }
  const out = {
    fixture: 'soft-clean',
    tipSha: null, // Resolve the bench-log tip before falling back to DEFAULT_TIP.
    softWorktree: null,
    outDir: null,
    benchLog: null,
    run: null,
    baseline: null,
    soft: null,
    l1Mode: 'fixture',
    l1Subjects: null,
    l1Live: false,
    model: null,
    jev: null,
    dryRun: false,
    help: false,
    json: true,
  };
  let explicitL1Mode = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fixture') out.fixture = argv[++i];
    else if (a === '--tip-sha') out.tipSha = argv[++i];
    else if (a === '--soft-worktree') out.softWorktree = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--bench-log') out.benchLog = argv[++i];
    else if (a === '--run') out.run = argv[++i];
    else if (a === '--baseline') out.baseline = argv[++i];
    else if (a === '--soft' || a === '--probe-l1-soft') out.soft = argv[++i];
    else if (a === '--l1-mode') {
      const mode = argv[++i];
      if (!['fixture', 'sim', 'live'].includes(mode)) {
        throw new Error('--l1-mode requires fixture|sim|live');
      }
      out.l1Mode = mode;
      explicitL1Mode = true;
    } else if (a === '--l1-subjects') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-') || !value.trim()) {
        throw new Error('--l1-subjects requires a comma-separated subject list');
      }
      out.l1Subjects = argv[++i].split(',').map((subject) => subject.trim());
    } else if (a === '--l1-live') {
      out.l1Live = true;
    } else if (a === '--l1-sim') {
      out.l1Mode = 'sim';
    } else if (a === '--model' || a === '--jev') {
      const value = argv[i + 1];
      out[a.slice(2)] = value !== undefined && !value.startsWith('-') ? argv[++i] : null;
    } else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  if (explicitL1Mode) out.l1Live = out.l1Mode === 'live';
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (args.help) {
    console.log(`Usage:
  node dayloop-soft.mjs --fixture soft-clean --soft-worktree DIR --out-dir DIR
  node dayloop-soft.mjs --fixture false-win  --soft-worktree DIR --out-dir DIR
  node dayloop-soft.mjs --fixture hard-gate  --soft-worktree DIR --out-dir DIR

One-command soft-layer day-loop e2e (Ingest→Propose→Probe L1+soft worktree→Compose).
--tip-sha SHA overrides the bench-log tip (fallback: ${DEFAULT_TIP}, post-#90 master).
--l1-mode fixture|sim|live selects bounded L1 (default: fixture, without live quota).
--l1-subjects s1,s2 selects subjects; subjects ≤ 2, excess rejects as bound_exceeded (no truncation).
Live (--l1-mode live or --l1-live) requires nonblank --model M and --jev J.
Aliases --l1-sim / --l1-live remain supported; combining either with --l1-mode rejects as a conflict.
Never writes FROZEN.`);
    process.exit(0);
  }

  const allowed = new Set(['soft-clean', 'false-win', 'hard-gate']);
  if (!allowed.has(args.fixture)) {
    console.error(`Unknown --fixture ${args.fixture}; want soft-clean|false-win|hard-gate`);
    process.exit(2);
  }

  const summary = runDayloopSoft({
    fixture: args.fixture,
    tipSha: args.tipSha,
    softWorktreeDir: args.softWorktree || undefined,
    outDir: args.outDir || undefined,
    benchLogPath: args.benchLog || undefined,
    runId: args.run || undefined,
    fromMiss: Boolean(args.run),
    baselineJsonl: args.baseline || undefined,
    softJsonl: args.soft || undefined,
    dryRun: args.dryRun,
    l1Mode: args.l1Mode,
    l1Subjects: args.l1Subjects,
    l1Live: args.l1Live,
    model: args.model,
    jev: args.jev,
  });

  console.log(JSON.stringify({ ...summary, l1Subjects: args.l1Subjects ?? undefined }, null, 2));

  if (summary.frozenWrites > 0) {
    console.error('BUG: FROZEN write detected (must be 0)');
    process.exit(3);
  }

  if (args.fixture === 'soft-clean') {
    if (summary.wroteCandidate) {
      const body = fs.readFileSync(summary.candidatePath, 'utf8');
      if (!body.includes(summary.tipSha) || !/softTreeFileListHash/.test(body)) {
        console.error('CANDIDATE missing tipShaBaseline / softTreeFileListHash');
        process.exit(1);
      }
      console.error(`CANDIDATE: ${summary.candidatePath}`);
    } else {
      // All default product directions are shipped; EXPERIENCE-only is a valid result.
      if (!summary.results.length || !summary.results.every((result) =>
        ['shipped_duplicate', 'experience_only'].includes(result.reason))) {
        console.error('soft-clean expected CANDIDATE or shipped/experience-only results');
        process.exit(1);
      }
      console.error(`No CANDIDATE (soft-clean). EXPERIENCE: ${summary.results
        .map((r) => r.experiencePath)
        .filter(Boolean)
        .join(', ')}`);
    }
    process.exit(0);
  }

  // false-win / hard-gate → EXPERIENCE-only, 0× CANDIDATE
  if (summary.wroteCandidate) {
    console.error(`${args.fixture} must not write CANDIDATE`);
    process.exit(1);
  }
  console.error(
    `No CANDIDATE (${args.fixture}). EXPERIENCE: ${summary.results
      .map((r) => r.experiencePath)
      .filter(Boolean)
      .join(', ')}`,
  );
  process.exit(0);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}
