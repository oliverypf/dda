#!/usr/bin/env node
/**
 * Post-SCAN one-shot (Harness² day-loop): after tip/topology-live is marked CLOSED,
 * resolve the runId and invoke on-closed.mjs — print JSON including `action`.
 *
 * Usage:
 *   node post-scan-on-closed.mjs                  # latest CLOSED-looking run
 *   node post-scan-on-closed.mjs --run 100
 *   node post-scan-on-closed.mjs --run 99 --decide-only
 *   node post-scan-on-closed.mjs --latest-closed
 *
 * Contract (unchanged): MISS→CANDIDATE possible; path-anomaly→EXPERIENCE-only;
 * all-green→noop. Never auto-FROZEN / never auto-merge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveLatestClosed } from './ingest.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIVE = path.resolve(__dirname, '..');
const ON_CLOSED = path.join(__dirname, 'on-closed.mjs');

function parseArgs(argv) {
  const out = {
    runId: null,
    latestClosed: false,
    decideOnly: false,
    dryRun: false,
    outDir: null,
    drive: DRIVE,
    dayloopSoft: false,
    softWorktree: null,
    tipSha: null,
    dayloopFixture: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run') out.runId = argv[++i];
    else if (a === '--latest-closed') out.latestClosed = true;
    else if (a === '--decide-only') out.decideOnly = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--drive') out.drive = argv[++i];
    else if (a === '--dayloop-soft') out.dayloopSoft = true;
    else if (a === '--soft-worktree') out.softWorktree = argv[++i];
    else if (a === '--tip-sha') out.tipSha = argv[++i];
    else if (a === '--dayloop-fixture') out.dayloopFixture = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function resolveRunId(opts) {
  if (opts.runId != null) {
    const n = String(opts.runId).replace(/^run/i, '');
    const benchLogPath = path.join(opts.drive, `bench-log-run${n}.md`);
    if (!fs.existsSync(benchLogPath)) {
      return { ok: false, reason: `missing ${benchLogPath}`, n: null };
    }
    return { ok: true, n, benchLogPath };
  }
  const resolved = resolveLatestClosed({ drive: opts.drive });
  if (!resolved.ok) {
    return { ok: false, reason: resolved.reason || 'no resolvable closed run', n: null };
  }
  return { ok: true, n: String(resolved.n), benchLogPath: resolved.benchLogPath };
}

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(`Usage:
  node post-scan-on-closed.mjs [--run N | --latest-closed] [--decide-only] [--dry-run] [--out-dir DIR] [--dayloop-soft]

Resolves latest CLOSED runId (or --run N), then:
  node on-closed.mjs --run N [--dayloop-soft]
Prints JSON including action (miss | path-anomaly | noop).
MISS + --dayloop-soft runs soft day-loop; all-green/path-anomaly never force dayloop.`);
    process.exit(0);
  }

  const resolved = resolveRunId(opts);
  if (!resolved.ok) {
    const payload = {
      ok: false,
      action: 'noop',
      reason: resolved.reason,
      runId: null,
      invoked: false,
      onClosedArgv: null,
      logPath: null,
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exit(1);
  }

  const argv = ['--run', resolved.n];
  if (opts.decideOnly) argv.push('--decide-only');
  if (opts.dryRun) argv.push('--dry-run');
  if (opts.outDir) argv.push('--out-dir', opts.outDir);
  if (opts.dayloopSoft) argv.push('--dayloop-soft');
  if (opts.softWorktree) argv.push('--soft-worktree', opts.softWorktree);
  if (opts.tipSha) argv.push('--tip-sha', opts.tipSha);
  if (opts.dayloopFixture) argv.push('--dayloop-fixture', opts.dayloopFixture);

  const spawned = spawnSync(process.execPath, [ON_CLOSED, ...argv], {
    encoding: 'utf8',
    maxBuffer: 20_000_000,
    cwd: __dirname,
  });

  const stdout = spawned.stdout || '';
  const stderr = spawned.stderr || '';
  const exitCode = spawned.status ?? 1;

  /** on-closed.mjs prints one final JSON object that includes `action`. */
  let hook = null;
  const trimmed = stdout.trim();
  try {
    hook = JSON.parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf('{');
    if (start >= 0) {
      try {
        hook = JSON.parse(trimmed.slice(start));
      } catch {
        hook = null;
      }
    }
  }

  const payload = {
    ok: exitCode === 0 && Boolean(hook),
    action: hook?.action || 'error',
    reason: hook?.reason || null,
    runId: resolved.n,
    benchLogPath: resolved.benchLogPath,
    invoked: Boolean(hook?.invoked),
    dayloopSoft: Boolean(hook?.dayloopSoft || opts.dayloopSoft),
    dayloopInvoked: Boolean(hook?.dayloopInvoked),
    onClosedArgv: [process.execPath, ON_CLOSED, ...argv],
    logPath: hook?.logPath || null,
    candidatePaths: hook?.candidatePaths || [],
    experiencePaths: hook?.experiencePaths || [],
    exitCode,
    stderr: stderr.trim() || undefined,
  };

  console.log(JSON.stringify(payload, null, 2));
  process.exit(exitCode === 0 ? 0 : 1);
}

main();
