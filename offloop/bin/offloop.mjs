#!/usr/bin/env node
/**
 * Product-root entry for bounded off-loop evidence.
 *
 * This wrapper owns the product-root contract and delegates MISS processing to
 * the existing run-from-miss.mjs pipeline. It never enables live work.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const TIP_PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';

const BIN_DIR = path.dirname(fileURLToPath(import.meta.url));
export const PRODUCT_ROOT = path.resolve(BIN_DIR, '..');
export const REPO_ROOT = resolveRepoRoot(PRODUCT_ROOT);
const RUN_FROM_MISS = path.join(PRODUCT_ROOT, 'run-from-miss.mjs');
const FIXTURE_JSONL = path.join(PRODUCT_ROOT, 'test', 'fixtures', 'poison-loop-yes.jsonl');

/** @param {string} start */
export function resolveRepoRoot(start = PRODUCT_ROOT) {
  try {
    const top = execFileSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (top) return path.resolve(top);
  } catch {
    // The product package remains usable from an unpacked directory; its
    // parent is the best import-meta-derived repo-root fallback.
  }
  return path.resolve(start, '..');
}

/**
 * Output directory precedence: CLI option > environment > product root.
 * @param {{outDir?: string, experienceDir?: string, env?: NodeJS.ProcessEnv, productRoot?: string}} [opts]
 */
export function resolveOutputPaths(opts = {}) {
  const env = opts.env || process.env;
  const productRoot = opts.productRoot || PRODUCT_ROOT;
  const choose = (explicit, envName, fallback) => {
    if (typeof explicit === 'string' && explicit.trim()) return path.resolve(explicit);
    if (typeof env[envName] === 'string' && env[envName].trim()) {
      return path.resolve(env[envName]);
    }
    return path.resolve(fallback);
  };
  return {
    outDir: choose(opts.outDir, 'OFFLOOP_OUT_DIR', path.join(productRoot, 'out')),
    experienceDir: choose(
      opts.experienceDir,
      'OFFLOOP_EXPERIENCE_DIR',
      path.join(productRoot, 'experience'),
    ),
  };
}

function valueAfter(argv, index) {
  const value = argv[index + 1];
  if (value == null || (value.startsWith('--') && value !== '--')) {
    return { value: '', next: index };
  }
  return { value, next: index + 1 };
}

/** @param {string[]} argv */
export function parseCliArgs(argv) {
  const parsed = {
    command: 'miss',
    help: false,
    fixture: false,
    tipSha: { set: false, value: '' },
    tipPath: { set: false, value: '' },
    outDir: { set: false, value: '' },
    experienceDir: { set: false, value: '' },
    passthrough: [],
    hasInput: false,
    hasBenchLog: false,
    run60: false,
    liveRequested: false,
  };

  let index = 0;
  const first = argv[0];
  if (first === 'help' || first === '--help' || first === '-h') {
    parsed.help = true;
    return parsed;
  }
  if (first === 'miss' || first === 'run-from-miss' || first === 'run60') index += 1;
  if (first === 'run60') {
    parsed.run60 = true;
    parsed.hasInput = true;
    parsed.passthrough.push('--run60');
  }

  for (; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === 'help' || arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--fixture') {
      parsed.fixture = true;
      continue;
    }
    if (arg === '--tip-sha') {
      const taken = valueAfter(argv, index);
      parsed.tipSha = { set: true, value: taken.value };
      index = taken.next;
      continue;
    }
    if (arg === '--tip-path') {
      const taken = valueAfter(argv, index);
      parsed.tipPath = { set: true, value: taken.value };
      index = taken.next;
      continue;
    }
    if (arg === '--out-dir') {
      const taken = valueAfter(argv, index);
      parsed.outDir = { set: true, value: taken.value };
      index = taken.next;
      continue;
    }
    if (arg === '--experience-dir') {
      const taken = valueAfter(argv, index);
      parsed.experienceDir = { set: true, value: taken.value };
      index = taken.next;
      continue;
    }
    if (arg === '--run60') parsed.run60 = true;
    if (arg === '--bench-log') parsed.hasBenchLog = true;
    if (arg === '--run60' || arg === '--run' || arg === '--latest-closed' || arg === '--bench-log' || arg === '--jsonl') {
      parsed.hasInput = true;
    }
    if (arg === '--live' || arg === '--l1-live' || arg === '--live-request') {
      parsed.liveRequested = true;
    }
    parsed.passthrough.push(arg);
  }
  return parsed;
}

function gitHead(repo) {
  try {
    const sha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

/**
 * Resolve and verify the fixed non-empty tip before any MISS work starts.
 * @param {{tipSha?: {set:boolean,value:string}, tipPath?: {set:boolean,value:string}, env?: NodeJS.ProcessEnv, repoRoot?: string}} opts
 */
export function resolveTip(opts = {}) {
  const env = opts.env || process.env;
  const repoRoot = opts.repoRoot || REPO_ROOT;
  let tipSha = null;
  let tipSource = 'repoRoot:git';
  let error = null;

  if (opts.tipSha?.set) {
    tipSource = 'explicit:--tip-sha';
    tipSha = String(opts.tipSha.value ?? '').trim() || null;
  } else if (opts.tipPath?.set) {
    tipSource = 'explicit:--tip-path';
    const tipPath = String(opts.tipPath.value ?? '').trim();
    tipSha = tipPath ? gitHead(path.resolve(tipPath)) : null;
    if (!tipSha && tipPath) error = `tip-path has no readable git HEAD: ${tipPath}`;
  } else if (Object.prototype.hasOwnProperty.call(env, 'DDA_TIP_REPO')) {
    tipSource = 'environment:DDA_TIP_REPO';
    const tipRepo = String(env.DDA_TIP_REPO ?? '').trim();
    tipSha = tipRepo ? gitHead(path.resolve(tipRepo)) : null;
    if (!tipSha && tipRepo) error = `DDA_TIP_REPO has no readable git HEAD: ${tipRepo}`;
  } else {
    tipSha = gitHead(repoRoot);
    if (!tipSha) error = `repoRoot has no readable git HEAD: ${repoRoot}`;
  }

  const pinEqual = Boolean(tipSha) && tipSha === TIP_PIN;
  if (!tipSha) error ||= 'tipSha is missing or empty';
  else if (!pinEqual) error ||= `tipSha does not equal fixed pin ${TIP_PIN}`;
  return {
    tipSha,
    tipSource,
    tipPin: TIP_PIN,
    pinEqual,
    ok: Boolean(tipSha) && pinEqual,
    error,
  };
}

function helpText(paths = resolveOutputPaths()) {
  return `offloop product-root CLI (bounded off-loop evidence)

Usage:
  node offloop/bin/offloop.mjs help
  node offloop/bin/offloop.mjs miss --fixture --tip-sha ${TIP_PIN}
  node offloop/bin/offloop.mjs miss --run60 --tip-path /path/to/fixed-tip

Contract:
  core（核心） is the default path: it delegates to run-from-miss with no live requests.
  live（在线） is never enabled implicitly; this entry rejects live flags.
  tip-path（tip 路径） resolution is --tip-sha, then --tip-path,
  DDA_TIP_REPO, then repoRoot git HEAD; the non-empty SHA must equal the fixed pin.
  MISS（未命中） results are auditable EXPERIENCE（经验） or CANDIDATE（候选） files;
  CANDIDATE remains behind a human PR gate and is never auto-merged.
  output directories: --out-dir > OFFLOOP_OUT_DIR > productRoot/out
  experience directory: --experience-dir > OFFLOOP_EXPERIENCE_DIR > productRoot/experience
  resolved productRoot: ${PRODUCT_ROOT}
  default outDir: ${paths.outDir}
  default experienceDir: ${paths.experienceDir}
  tipSha, tipSource, and pinEqual are emitted before bounded MISS work.
`;
}

function makeFixture() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dda-offloop-cli-fixture-'));
  const benchLog = path.join(fixtureRoot, 'bench-log-run60.md');
  fs.writeFileSync(
    benchLog,
    `# Product-root CLI bounded MISS fixture\n\n- **Tip**: \`${TIP_PIN}\`\n- **GATE**: **MISS**\n\n| Cell | Subject | Result | Notes |\n| --- | --- | --- | --- |\n| t3/run60a | t3-cli-fixture | **MISS** | bounded fixture poison-loop |\n`,
    'utf8',
  );
  return { fixtureRoot, benchLog, jsonl: FIXTURE_JSONL };
}

function appendOption(args, name, value) {
  args.push(name, value);
}

function writeCliSummary(outDir, data) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'offloop-cli-summary.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function candidateCount(outDir) {
  try {
    return fs.readdirSync(outDir).filter((name) => /^freeze-candidate-.*\.md$/.test(name)).length;
  } catch {
    return 0;
  }
}

/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  const paths = resolveOutputPaths({
    outDir: parsed.outDir.set ? parsed.outDir.value : undefined,
    experienceDir: parsed.experienceDir.set ? parsed.experienceDir.value : undefined,
  });

  if (parsed.help) {
    console.log(helpText(paths));
    return 0;
  }
  if (parsed.liveRequested) {
    console.error('FAIL: live flags are not accepted by the bounded product-root entry; use an explicit live workflow.');
    return 2;
  }
  if (parsed.fixture && parsed.hasInput) {
    console.error('FAIL: --fixture cannot be combined with --run60, --run, --latest-closed, --bench-log, or --jsonl.');
    return 2;
  }

  const tip = resolveTip({
    tipSha: parsed.tipSha,
    tipPath: parsed.tipPath,
  });
  console.log(JSON.stringify({
    phase: 'tip-check',
    status: tip.ok ? 'PASS' : 'FAIL',
    tipSha: tip.tipSha,
    tipSource: tip.tipSource,
    tipPin: tip.tipPin,
    pinEqual: tip.pinEqual,
  }));
  if (!tip.ok) {
    console.error(`FAIL: fixed tip check: ${tip.error}`);
    return 2;
  }

  let fixture = null;
  let passthrough = [...parsed.passthrough];
  const run60Fallback = parsed.run60 && !parsed.hasBenchLog &&
    !fs.existsSync(path.join(REPO_ROOT, 'bench-log-run60.md'));
  if (parsed.fixture || run60Fallback) {
    fixture = makeFixture();
    if (run60Fallback) passthrough = passthrough.filter((arg) => arg !== '--run60');
    appendOption(passthrough, '--bench-log', fixture.benchLog);
    appendOption(passthrough, '--jsonl', fixture.jsonl);
    passthrough.push('--allow-experience-only');
  }

  const beforeCandidates = candidateCount(paths.outDir);
  appendOption(passthrough, '--out-dir', paths.outDir);
  appendOption(passthrough, '--experience-dir', paths.experienceDir);
  appendOption(passthrough, '--tip-sha', tip.tipSha);

  let child;
  try {
    child = spawnSync(process.execPath, [RUN_FROM_MISS, ...passthrough], {
      cwd: REPO_ROOT,
      env: { ...process.env },
      stdio: 'inherit',
    });
  } finally {
    if (fixture) fs.rmSync(fixture.fixtureRoot, { recursive: true, force: true });
  }

  const exitCode = child?.error ? 1 : (child?.status ?? (child?.signal ? 1 : 0));
  const afterCandidates = candidateCount(paths.outDir);
  writeCliSummary(paths.outDir, {
    phase: 'offloop-cli',
    command: 'miss',
    status: exitCode === 0 ? 'PASS' : 'FAIL',
    tipSha: tip.tipSha,
    tipSource: tip.tipSource,
    tipPin: tip.tipPin,
    pinEqual: tip.pinEqual,
    productRoot: PRODUCT_ROOT,
    repoRoot: REPO_ROOT,
    outDir: paths.outDir,
    experienceDir: paths.experienceDir,
    fixture: Boolean(fixture),
    fixtureReason: parsed.fixture ? 'explicit' : run60Fallback ? 'run60-missing-bench-log' : null,
    candidateWrites: Math.max(0, afterCandidates - beforeCandidates),
    liveRequests: 0,
    mainOpenRouterCalls: 0,
    delegatedExitCode: exitCode,
  });
  if (child?.error) console.error(`FAIL: unable to delegate run-from-miss: ${child.error.message}`);
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
