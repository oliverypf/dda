#!/usr/bin/env node
/**
 * CLOSED hook (Harness² day-loop): after tip/topology-live is marked CLOSED,
 * decide whether to invoke run-from-miss — never empty-rebench all-green tips.
 *
 * Usage:
 *   node on-closed.mjs --run 99
 *   node on-closed.mjs --run 60 --dry-run
 *   node on-closed.mjs --bench-log PATH [--run N]
 *   node on-closed.mjs --latest-closed
 *
 * Decisions:
 *   CLOSED/GATE MISS            → run-from-miss --run N
 *     (+ optional --dayloop-soft → bounded L1 fixture/sim; live needs model/jev)
 *   CLOSED/GATE PASS + anomaly  → run-from-miss --run N --path-anomaly --allow-experience-only
 *     (never force dayloop-soft)
 *   all-green, no path-anomaly  → no-op (0× run-from-miss / 0× dayloop)
 *
 * Never auto-FROZEN / never auto-merge PR. Logs CANDIDATE / EXPERIENCE paths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseBenchLog, resolveLatestClosed } from './ingest.mjs';
import { runDayloopSoft } from './dayloop-soft.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIVE = path.resolve(__dirname, '..');
const RUN_FROM_MISS = path.join(__dirname, 'run-from-miss.mjs');

/** Prefer --run60 when live run60 jsonl is void/missing (fixture smoke). */
function missArgvForRun(runId, drive = DRIVE) {
  const n = String(runId).replace(/^run/i, '');
  if (n === '60') {
    const live = path.join(drive, 'bench/t3/run60a.jsonl');
    let useRun60Flag = true;
    try {
      if (fs.existsSync(live) && fs.statSync(live).size >= 1024) useRun60Flag = false;
    } catch {
      useRun60Flag = true;
    }
    if (useRun60Flag) return ['--run60'];
  }
  return ['--run', n];
}

/**
 * Pure decision from a parsed bench log (+ optional run id).
 * @param {object} bench from parseBenchLog
 * @param {{ runId?: string|number }} [opts]
 * @returns {{ action: 'miss'|'path-anomaly'|'noop', reason: string, runId: string|null, argv: string[]|null }}
 */
export function decideClosedAction(bench, opts = {}) {
  const runId =
    opts.runId != null
      ? String(opts.runId).replace(/^run/i, '')
      : inferRunId(bench?.path);

  const red = bench?.redCells?.length || 0;
  const hasMiss = Boolean(bench?.gateMiss || bench?.closedMiss || red > 0);
  const hasAnomaly = Boolean(bench?.hasPathAnomaly || (bench?.pathAnomalyCells?.length || 0) > 0);
  const allGreen = Boolean(
    (bench?.gatePass || bench?.closedPass) && !bench?.gateMiss && !bench?.closedMiss && red === 0,
  );

  if (hasMiss) {
    return {
      action: 'miss',
      reason: bench?.closedMiss
        ? 'closed_miss'
        : bench?.gateMiss
          ? 'gate_miss'
          : 'red_cells',
      runId,
      argv: runId ? missArgvForRun(runId) : null,
    };
  }

  if (allGreen && hasAnomaly) {
    return {
      action: 'path-anomaly',
      reason: 'closed_pass_path_anomaly',
      runId,
      argv: runId
        ? ['--run', runId, '--path-anomaly', '--allow-experience-only']
        : null,
    };
  }

  if (allGreen && !hasAnomaly) {
    return {
      action: 'noop',
      reason: 'all_green_no_path_anomaly',
      runId,
      argv: null,
    };
  }

  return {
    action: 'noop',
    reason: 'not_closed_or_unclear',
    runId,
    argv: null,
  };
}

function inferRunId(benchLogPath) {
  if (!benchLogPath) return null;
  const m = path.basename(benchLogPath).match(/^bench-log-run(\d+)\.md$/i);
  return m ? m[1] : null;
}

/**
 * @param {object} opts
 * @param {string} [opts.benchLogPath]
 * @param {string|number} [opts.runId]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.decideOnly] — do not spawn run-from-miss
 * @param {string} [opts.outDir]
 * @param {string} [opts.drive]
 * @param {(argv: string[]) => object} [opts.invoker] — test seam for run-from-miss
 * @param {boolean} [opts.dayloopSoft] — MISS → bounded L1 dayloop; ignored for noop/path-anomaly
 * @param {'fixture'|'sim'|'live'} [opts.l1Mode='fixture']
 * @param {boolean} [opts.l1Live=false] live alias; only meaningful for MISS + dayloopSoft
 * @param {string} [opts.model]
 * @param {string} [opts.jev]
 * @param {string[]} [opts.l1Subjects] explicit subjects; more than two rejects without truncation
 * @param {unknown} [opts.transportError] injected bounded L1 transport failure
 * @param {string|number} [opts.liveStatus] injected bounded L1 transport status
 * @param {string} [opts.softWorktree] — soft worktree dir for dayloop-soft
 * @param {string} [opts.tipSha] — overrides bench-log tip; fallback 2258685 (post-#90 master)
 * @param {'soft-clean'|'false-win'|'hard-gate'} [opts.dayloopFixture='soft-clean']
 * @param {(opts: object) => object} [opts.dayloopRunner] — test seam for runDayloopSoft
 */
export function runClosedHook(opts = {}) {
  const drive = opts.drive || DRIVE;
  let benchLogPath = opts.benchLogPath || null;
  let runId = opts.runId != null ? String(opts.runId).replace(/^run/i, '') : null;

  if (!benchLogPath && runId) {
    benchLogPath = path.join(drive, `bench-log-run${runId}.md`);
  }
  if (!benchLogPath && opts.latestClosed) {
    const resolved = resolveLatestClosed({ drive });
    if (!resolved.ok) {
      return {
        ok: false,
        decision: { action: 'noop', reason: resolved.reason, runId: null, argv: null },
        invoked: false,
        logPath: null,
        candidatePaths: [],
        experiencePaths: [],
        stdout: '',
        stderr: resolved.reason,
      };
    }
    benchLogPath = resolved.benchLogPath;
    runId = resolved.n;
  }
  if (!benchLogPath || !fs.existsSync(benchLogPath)) {
    return {
      ok: false,
      decision: { action: 'noop', reason: 'missing_bench_log', runId, argv: null },
      invoked: false,
      logPath: null,
      candidatePaths: [],
      experiencePaths: [],
      stdout: '',
      stderr: `missing bench-log: ${benchLogPath}`,
    };
  }

  const bench = parseBenchLog(benchLogPath);
  const decision = decideClosedAction(bench, { runId: runId || inferRunId(benchLogPath) });
  const dayloopSoft = resolveDayloopSoftFlag(opts);

  const stamp = new Date().toISOString();
  /** @type {string[]} */
  let candidatePaths = [];
  /** @type {string[]} */
  let experiencePaths = [];
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  let invoked = false;

  if (decision.action === 'noop' || !decision.argv) {
    const logPath = writeHookLog({
      drive,
      runId: decision.runId,
      decision,
      stamp,
      invoked: false,
      candidatePaths,
      experiencePaths,
      note: dayloopSoft
        ? 'no-op: GATE（过门分）全绿且无 path-anomaly（路径异常）→ 0× run-from-miss / 0× dayloop-soft'
        : 'no-op: GATE（过门分）全绿且无 path-anomaly（路径异常）→ 0× run-from-miss',
      dayloopSoft,
    });
    return {
      ok: true,
      decision,
      invoked: false,
      dayloopInvoked: false,
      dayloopSoft,
      logPath,
      candidatePaths,
      experiencePaths,
      stdout: '',
      stderr: '',
      exitCode: 0,
    };
  }

  if (opts.decideOnly || opts.dryRun) {
    const wouldDayloop = dayloopSoft && decision.action === 'miss';
    const note = wouldDayloop
      ? `dry-run/decide-only: would invoke dayloop-soft (bounded L1) for MISS; argv fallback ${decision.argv.join(' ')}`
      : dayloopSoft && decision.action === 'path-anomaly'
        ? `dry-run/decide-only: path-anomaly EXPERIENCE-only — dayloop-soft ignored; would invoke run-from-miss ${decision.argv.join(' ')}`
        : `dry-run/decide-only: would invoke run-from-miss ${decision.argv.join(' ')}`;
    const logPath = writeHookLog({
      drive,
      runId: decision.runId,
      decision,
      stamp,
      invoked: false,
      dryRun: true,
      candidatePaths,
      experiencePaths,
      note,
      dayloopSoft,
      dayloopInvoked: false,
    });
    return {
      ok: true,
      decision,
      invoked: false,
      dayloopInvoked: false,
      dayloopSoft,
      wouldDayloopSoft: wouldDayloop,
      dryRun: true,
      logPath,
      candidatePaths,
      experiencePaths,
      stdout: '',
      stderr: '',
      exitCode: 0,
      wouldArgv: decision.argv,
    };
  }

  const outDir = opts.outDir || drive;
  const argv = [...decision.argv, '--out-dir', outDir];
  let dayloopInvoked = false;
  let dayloopSummary = null;

  // MISS + --dayloop-soft → bounded L1 (fixture by default). Never for path-anomaly/noop.
  if (decision.action === 'miss' && dayloopSoft) {
    dayloopInvoked = true;
    invoked = true;
    const softWorktreeDir =
      opts.softWorktree || path.join(outDir, `soft-worktree-run${decision.runId || 'x'}`);
    const dayloopOpts = {
      // Soft-side contrast fixture (soft-clean/false-win/hard-gate); baseline comes from the MISS run.
      fixture: opts.dayloopFixture || 'soft-clean',
      l1Mode: opts.l1Mode,
      l1Live: opts.l1Live,
      model: opts.model,
      jev: opts.jev,
      l1Subjects: opts.l1Subjects,
      transportError: opts.transportError,
      liveStatus: opts.liveStatus,
      tipSha: opts.tipSha || bench.tip || '2258685ce9793639ebc9698c8961dcedccf6e49b',
      outDir,
      softWorktreeDir,
      write: true,
      runId: decision.runId,
      drive,
      benchLogPath,
      fromMiss: true,
      allowFixtureFallback: opts.allowFixtureFallback !== false,
      minJsonlBytes: opts.minJsonlBytes,
      baselineJsonl: opts.baselineJsonl,
      baselineJsonlPaths: opts.baselineJsonlPaths,
    };
    try {
      if (typeof opts.dayloopRunner === 'function') {
        dayloopSummary = opts.dayloopRunner(dayloopOpts);
      } else {
        dayloopSummary = runDayloopSoft(dayloopOpts);
      }
      exitCode = dayloopSummary?.frozenWrites > 0 ? 3 : 0;
      stdout = JSON.stringify(dayloopSummary, null, 2);
      if (dayloopSummary?.candidatePath) candidatePaths.push(dayloopSummary.candidatePath);
      if (dayloopSummary?.fallbackExperiencePath) {
        experiencePaths.push(dayloopSummary.fallbackExperiencePath);
      }
      if (dayloopSummary?.softFallbackExperiencePath) {
        experiencePaths.push(dayloopSummary.softFallbackExperiencePath);
      }
      for (const r of dayloopSummary?.results || []) {
        if (r.candidatePath) candidatePaths.push(r.candidatePath);
        if (r.experiencePath) experiencePaths.push(r.experiencePath);
      }
    } catch (err) {
      exitCode = 1;
      stderr = String(err?.stack || err);
    }
    candidatePaths = [...new Set(candidatePaths.filter(Boolean))];
    experiencePaths = [...new Set(experiencePaths.filter(Boolean))];

    const logPath = writeHookLog({
      drive,
      runId: decision.runId,
      decision,
      stamp,
      invoked: true,
      exitCode,
      candidatePaths,
      experiencePaths,
      argv: ['dayloop-soft', `--fixture`, dayloopOpts.fixture, '--soft-worktree', softWorktreeDir],
      note: (() => {
        const bits = [];
        if (dayloopSummary?.baselineFallback) {
          bits.push(`VISIBLE baseline fixture-fallback (${dayloopSummary.baselineFallbackReason})`);
        } else {
          bits.push(`baselineSource=${dayloopSummary?.baselineSource || 'run'}`);
        }
        if (dayloopSummary?.softFallback) {
          bits.push(`VISIBLE softSource=fixture-fallback (${dayloopSummary.softFallbackReason})`);
        } else if (dayloopSummary?.softSource) {
          bits.push(`softSource=${dayloopSummary.softSource}`);
        }
        return `CLOSED MISS + --dayloop-soft → runDayloopSoft ${bits.join('; ')}`;
      })(),
      dayloopSoft: true,
      dayloopInvoked: true,
    });

    if (opts.appendBenchLog) {
      try {
        appendBenchLogPointer(benchLogPath, {
          decision,
          candidatePaths,
          experiencePaths,
          logPath,
        });
      } catch {
        // non-fatal
      }
    }

    return {
      ok: exitCode === 0,
      decision,
      invoked: true,
      dayloopInvoked: true,
      dayloopSoft: true,
      dayloopSummary,
      baselineSource: dayloopSummary?.baselineSource || null,
      baselineFallback: Boolean(dayloopSummary?.baselineFallback),
      baselineFallbackReason: dayloopSummary?.baselineFallbackReason || null,
      softSource: dayloopSummary?.softSource || null,
      softFallback: Boolean(dayloopSummary?.softFallback),
      softFallbackReason: dayloopSummary?.softFallbackReason || null,
      logPath,
      candidatePaths,
      experiencePaths,
      stdout,
      stderr,
      exitCode,
      argv: ['dayloop-soft', dayloopOpts.fixture, decision.runId ? `--run ${decision.runId}` : ''].filter(Boolean),
      softWorktreeDir,
    };
  }

  // Default: run-from-miss (path-anomaly always; miss without --dayloop-soft)
  invoked = true;

  let result;
  if (typeof opts.invoker === 'function') {
    result = opts.invoker(argv);
    stdout = result.stdout || '';
    stderr = result.stderr || '';
    exitCode = result.status ?? result.exitCode ?? 0;
  } else {
    const spawned = spawnSync(process.execPath, [RUN_FROM_MISS, ...argv], {
      encoding: 'utf8',
      maxBuffer: 20_000_000,
      cwd: __dirname,
    });
    stdout = spawned.stdout || '';
    stderr = spawned.stderr || '';
    exitCode = spawned.status ?? 1;
  }

  candidatePaths = extractPaths(stdout, /CANDIDATE:\s*(\S+)/g);
  // also freeze-candidate paths mentioned in JSON
  for (const m of stdout.matchAll(/"candidatePath":\s*"([^"]+)"/g)) {
    if (m[1] && m[1] !== 'null') candidatePaths.push(m[1]);
  }
  experiencePaths = extractPaths(stdout, /EXPERIENCE:\s*(.+)/g)
    .flatMap((line) => line.split(/,\s*/))
    .map((s) => s.trim())
    .filter(Boolean);
  for (const m of stdout.matchAll(/"experiencePath":\s*"([^"]+)"/g)) {
    if (m[1] && m[1] !== 'null') experiencePaths.push(m[1]);
  }
  candidatePaths = [...new Set(candidatePaths)];
  experiencePaths = [...new Set(experiencePaths)];

  const logPath = writeHookLog({
    drive,
    runId: decision.runId,
    decision,
    stamp,
    invoked: true,
    exitCode,
    candidatePaths,
    experiencePaths,
    argv,
    note:
      decision.action === 'miss'
        ? 'CLOSED MISS → run-from-miss（可出 CANDIDATE 或显式拒绝+EXPERIENCE）'
        : dayloopSoft
          ? 'CLOSED PASS + path-anomaly（路径异常）→ EXPERIENCE-only；--dayloop-soft ignored'
          : 'CLOSED PASS + path-anomaly（路径异常）→ EXPERIENCE-only；不升格 host latch',
    dayloopSoft,
    dayloopInvoked: false,
  });

  // Optional pointer onto bench-log (default off — keep historical logs stable)
  if (opts.appendBenchLog) {
    try {
      appendBenchLogPointer(benchLogPath, {
        decision,
        candidatePaths,
        experiencePaths,
        logPath,
      });
    } catch {
      // non-fatal
    }
  }

  return {
    ok: exitCode === 0,
    decision,
    invoked: true,
    dayloopInvoked: false,
    dayloopSoft,
    logPath,
    candidatePaths,
    experiencePaths,
    stdout,
    stderr,
    exitCode,
    argv,
  };
}

/** @param {object} opts */
export function resolveDayloopSoftFlag(opts = {}) {
  if (opts.dayloopSoft === true) return true;
  if (opts.dayloopSoft === false) return false;
  const env = opts.env || process.env;
  const v = env.OFFLOOP_DAYLOOP_SOFT || env.DDA_OFFLOOP_DAYLOOP_SOFT;
  if (v == null || v === '') return false;
  return /^(1|true|yes|on)$/i.test(String(v));
}

function extractPaths(text, re) {
  const out = [];
  for (const m of String(text || '').matchAll(re)) {
    if (m[1]) out.push(m[1].trim());
  }
  return out;
}

function writeHookLog({
  drive,
  runId,
  decision,
  stamp,
  invoked,
  dryRun,
  exitCode,
  candidatePaths,
  experiencePaths,
  argv,
  note,
  dayloopSoft,
  dayloopInvoked,
}) {
  const dir = path.join(drive, 'offloop-hook-logs');
  fs.mkdirSync(dir, { recursive: true });
  const name = `closed-hook-run${runId || 'unknown'}-${stamp.replace(/[:.]/g, '-')}.md`;
  const logPath = path.join(dir, name);
  const body = `# offloop CLOSED hook log

- **stamp**: ${stamp}
- **run**: ${runId || 'n/a'}
- **action**: \`${decision.action}\` (${decision.reason})
- **invoked run-from-miss / dayloop**: ${invoked ? 'yes' : 'no'}${dryRun ? ' (dry-run)' : ''}
- **dayloop-soft flag**: ${dayloopSoft ? 'yes' : 'no'}
- **dayloop invoked**: ${dayloopInvoked ? 'yes' : 'no'}
- **argv**: ${argv ? argv.join(' ') : '(none)'}
- **exitCode**: ${exitCode ?? 'n/a'}
- **note**: ${note || ''}

## 产物（从不自动 FROZEN / 从不自动合 PR）

### CANDIDATE（冻稿候选）
${candidatePaths?.length ? candidatePaths.map((p) => `- ${p}`).join('\n') : '- （无）'}

### EXPERIENCE（教训库）
${experiencePaths?.length ? experiencePaths.map((p) => `- ${p}`).join('\n') : '- （无）'}

## 纪律

- GATE（过门分）全绿且无 path-anomaly（路径异常）→ **0×** 调用
- path-anomaly EXPERIENCE **不**升格 host latch（例：t3-160 = agent_miss 先开火，非产品刀）
- runtime **0×** 读 EXPERIENCE 当免检 Memory
`;
  fs.writeFileSync(logPath, body, 'utf8');
  return logPath;
}

function appendBenchLogPointer(benchLogPath, { decision, candidatePaths, experiencePaths, logPath }) {
  const block = `

## offloop CLOSED hook

- action: \`${decision.action}\` (${decision.reason})
- hook-log: \`${logPath}\`
- CANDIDATE: ${candidatePaths.length ? candidatePaths.map((p) => `\`${p}\``).join(', ') : '（无）'}
- EXPERIENCE: ${experiencePaths.length ? experiencePaths.map((p) => `\`${p}\``).join(', ') : '（无）'}
- **不**自动 FROZEN / **不**自动合 PR
`;
  const cur = fs.readFileSync(benchLogPath, 'utf8');
  if (cur.includes('## offloop CLOSED hook')) {
    // replace last hook section roughly by appending a new dated note instead
    fs.appendFileSync(
      benchLogPath,
      `\n<!-- hook re-run ${new Date().toISOString()} action=${decision.action} log=${logPath} -->\n`,
      'utf8',
    );
    return;
  }
  fs.appendFileSync(benchLogPath, block, 'utf8');
}

function parseArgs(argv) {
  if (argv.includes('--l1-mode') && (argv.includes('--l1-sim') || argv.includes('--l1-live'))) {
    throw new Error('--l1-mode conflicts with --l1-sim/--l1-live; use one form only');
  }
  const out = {
    run: null,
    benchLog: null,
    latestClosed: false,
    dryRun: false,
    decideOnly: false,
    outDir: null,
    appendBenchLog: false,
    dayloopSoft: false,
    softWorktree: null,
    tipSha: null,
    dayloopFixture: null,
    l1Mode: 'fixture',
    l1Subjects: null,
    l1Live: false,
    model: null,
    jev: null,
    help: false,
  };
  let explicitL1Mode = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') out.run = argv[++i];
    else if (a === '--bench-log') out.benchLog = argv[++i];
    else if (a === '--latest-closed') out.latestClosed = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--decide-only') out.decideOnly = true;
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--append-bench-log') out.appendBenchLog = true;
    else if (a === '--dayloop-soft') out.dayloopSoft = true;
    else if (a === '--soft-worktree') out.softWorktree = argv[++i];
    else if (a === '--tip-sha') out.tipSha = argv[++i];
    else if (a === '--dayloop-fixture') out.dayloopFixture = argv[++i];
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
    } else if (a === '--help' || a === '-h') out.help = true;
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
  node on-closed.mjs --run N [--dry-run|--decide-only] [--dayloop-soft]
  node on-closed.mjs --bench-log PATH [--run N]
  node on-closed.mjs --latest-closed

CLOSED MISS → run-from-miss --run N
CLOSED MISS + --dayloop-soft → runDayloopSoft (bounded L1 fixture/sim by default)
  --l1-mode fixture|sim|live selects bounded L1 (default: fixture, without live quota).
  --l1-subjects s1,s2 selects subjects; subjects ≤ 2, excess rejects as bound_exceeded (no truncation).
  Live (--l1-mode live or --l1-live) requires nonblank --model M and --jev J.
  Aliases --l1-sim / --l1-live remain supported; combining either with --l1-mode rejects as a conflict.
CLOSED PASS + path-anomaly → run-from-miss --run N --path-anomaly --allow-experience-only
  (--dayloop-soft and L1 live flags ignored for path-anomaly / all-green)
all-green no anomaly → no-op (0×)
Env: OFFLOOP_DAYLOOP_SOFT=1 equivalent to --dayloop-soft`);
    process.exit(0);
  }

  const result = runClosedHook({
    runId: args.run,
    benchLogPath: args.benchLog,
    latestClosed: args.latestClosed,
    dryRun: args.dryRun,
    decideOnly: args.decideOnly,
    outDir: args.outDir,
    appendBenchLog: args.appendBenchLog,
    dayloopSoft: args.dayloopSoft,
    softWorktree: args.softWorktree,
    tipSha: args.tipSha,
    dayloopFixture: args.dayloopFixture,
    l1Mode: args.l1Mode,
    l1Subjects: args.l1Subjects,
    l1Live: args.l1Live,
    model: args.model,
    jev: args.jev,
  });

  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        action: result.decision.action,
        reason: result.decision.reason,
        runId: result.decision.runId,
        invoked: result.invoked,
        dayloopSoft: Boolean(result.dayloopSoft),
        dayloopInvoked: Boolean(result.dayloopInvoked),
        dayloopSummary: result.dayloopSummary
          ? { ...result.dayloopSummary, l1Subjects: args.l1Subjects ?? undefined }
          : undefined,
        wouldDayloopSoft: Boolean(result.wouldDayloopSoft),
        baselineSource: result.baselineSource || result.dayloopSummary?.baselineSource || null,
        baselineFallback: Boolean(result.baselineFallback ?? result.dayloopSummary?.baselineFallback),
        baselineFallbackReason:
          result.baselineFallbackReason || result.dayloopSummary?.baselineFallbackReason || null,
        wouldArgv: result.wouldArgv || result.argv || null,
        logPath: result.logPath,
        candidatePaths: result.candidatePaths,
        experiencePaths: result.experiencePaths,
        exitCode: result.exitCode ?? 0,
      },
      null,
      2,
    ),
  );

  if (!result.ok && result.decision.action !== 'noop') process.exit(result.exitCode || 1);
  process.exit(0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
