#!/usr/bin/env node
/**
 * Run the product-root bounded MVP smoke and write an inspectable report.
 *
 * This is a thin wrapper around bin/offloop.mjs. It always uses the fixture
 * MISS path and the fixed non-empty tip; it never enables live work.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRODUCT_ROOT, TIP_PIN } from '../bin/offloop.mjs';

export const SMOKE_SCHEMA = 'offloop-mvp-smoke-r1';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(PRODUCT_ROOT, 'bin', 'offloop.mjs');

function valueAfter(argv, index) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) return { value: '', next: index };
  return { value, next: index + 1 };
}

/** @param {string[]} argv */
export function parseArgs(argv = process.argv.slice(2)) {
  const parsed = {
    help: false,
    outDir: process.env.OFFLOOP_MVP_SMOKE_OUT || path.join(PRODUCT_ROOT, 'out', 'mvp-smoke'),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
    } else if (arg === '--out-dir') {
      const taken = valueAfter(argv, index);
      parsed.outDir = taken.value || parsed.outDir;
      index = taken.next;
    } else if (arg === '--live' || arg === '--l1-live' || arg === '--live-request') {
      throw new Error('mvp:smoke is fixture-only; live flags require the explicit live workflow');
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return parsed;
}

function helpText() {
  return `offloop MVP smoke (fixture-only, bounded MISS path)

Usage:
  npm run mvp:smoke
  npm run mvp:smoke -- --out-dir /tmp/offloop-mvp-smoke

The wrapper delegates to bin/offloop.mjs with --fixture and the fixed tip
${TIP_PIN}. Live tests are never enabled by this command.
`;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function integerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** @param {string[]} argv */
export function run(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    return 2;
  }
  if (args.help) {
    console.log(helpText());
    return 0;
  }

  const outDir = path.resolve(args.outDir);
  const experienceDir = path.join(outDir, 'experience');
  const reportPath = path.join(outDir, 'mvp-smoke-report.json');
  const cliSummaryPath = path.join(outDir, 'offloop-cli-summary.json');
  fs.mkdirSync(outDir, { recursive: true });

  const child = spawnSync(
    process.execPath,
    [CLI, 'miss', '--fixture', '--tip-sha', TIP_PIN, '--out-dir', outDir, '--experience-dir', experienceDir],
    {
      cwd: path.resolve(PRODUCT_ROOT, '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        MAIN_OPENROUTER_CALLS: '0',
      },
    },
  );

  fs.writeFileSync(path.join(outDir, 'mvp-smoke-stdout.log'), child.stdout || '', 'utf8');
  fs.writeFileSync(path.join(outDir, 'mvp-smoke-stderr.log'), child.stderr || '', 'utf8');

  const cliSummary = readJson(cliSummaryPath);
  const tipSha = cliSummary?.tipSha ?? null;
  const pinEqual = cliSummary?.pinEqual === true;
  const candidateWrites = integerOrNull(cliSummary?.candidateWrites);
  const liveRequests = integerOrNull(cliSummary?.liveRequests);
  const mainOpenRouterCalls = integerOrNull(cliSummary?.mainOpenRouterCalls);
  const delegatedPass = child.error == null && child.signal == null && child.status === 0 &&
    cliSummary?.status === 'PASS';
  const countersZero = candidateWrites === 0 && liveRequests === 0 && mainOpenRouterCalls === 0;
  const status = delegatedPass && tipSha === TIP_PIN && pinEqual && countersZero ? 'PASS' : 'FAIL';

  const report = {
    schema: SMOKE_SCHEMA,
    status,
    passKind: 'fixture-smoke',
    mode: 'fixture',
    liveOptIn: false,
    environment: {
      status: 'SKIP',
      kind: 'live',
      reason: 'Live environment is intentionally skipped; fixture smoke PASS is recorded separately.',
    },
    tipSha,
    tipPin: TIP_PIN,
    pinEqual,
    candidateWrites,
    liveRequests,
    mainOpenRouterCalls,
    replayExecutions: 0,
    cliExitCode: child.error ? null : child.status,
    cliSummaryPath,
    outDir,
    experienceDir,
    delegatedError: child.error?.message || null,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
  return status === 'PASS' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SCRIPT_DIR, 'mvp-smoke.mjs')) {
  process.exitCode = run();
}
