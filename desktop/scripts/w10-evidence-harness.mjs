import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHarnessEventStore } from '../../runtime/src/harness-event-store.mjs';
import { assessStorageCapacity } from '../../runtime/src/storage-capacity.mjs';
import { evaluateThirtyDayRetention } from '../../runtime/src/retention-acceptance.mjs';
import { PluginVersionLifecycle } from '../../runtime/src/plugin-version-lifecycle.mjs';
import { createEvolutionControlStore } from '../../runtime/src/evolution-control.mjs';
import { createModelEgressLedger } from '../../runtime/src/model-egress-ledger.mjs';
import { createReadModelRebuilder } from '../../runtime/src/read-model-rebuilder.mjs';
import { describeStorePath } from './windows-store-identity.mjs';
import { readStoreSnapshot } from './harness-store-snapshot.mjs';

/**
 * W10 evidence harness.
 *
 * Every section reports how its facts were produced:
 *   REAL_EXECUTION         the check ran on this host and its measured result is in the record
 *   PENDING_INSTALLED_HOST a packaged build must produce this before it counts as release evidence
 *   NOT_RUN                the check was not attempted
 *
 * The lifecycle, concurrency, recovery, capacity, backup/restore, privacy
 * deletion, kill switch and cost drills execute real runtime code against real
 * stores. They are not release evidence on their own: `install`, `longRun` and
 * `retention` need a packaged install (with the elevated
 * install/upgrade/migration/rollback/uninstall drill recorded as its lifecycle
 * evidence), an actual 24h window and an actual
 * 30-day window, and the release decision needs operator-signed reports.
 * `releaseDecision` stays NOT_READY until every gate is satisfied.
 */

const REAL = 'REAL_EXECUTION';
const PENDING_INSTALLED_HOST = 'PENDING_INSTALLED_HOST';
const NOT_RUN = 'NOT_RUN';
const LONG_RUN_REQUIRED_MINUTES = 1440;
const LONG_RUN_GAP_TOLERANCE_MS = 120_000;
const RECOVERY_BUDGET_MS = 30_000;
const CONCURRENCY_WORKERS = 4;
const CONCURRENCY_EVENTS_PER_WORKER = 25;
const LIFECYCLE_REQUIRED_STEPS = ['install', 'upgrade', 'migration', 'rollback', 'uninstall'];

const sha256File = async (path) => `sha256:${createHash('sha256').update(await readFile(path)).digest('hex')}`;

const readJsonIfPresent = async (path) => {
  if (!path) return undefined;
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; }
};

/** Operator-supplied evidence must be a real file that declares ok: true. */
const readSignedReport = async (path, missingCode) => {
  if (!path) return { ok: false, code: missingCode };
  const parsed = await readJsonIfPresent(path);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'W10_REPORT_INVALID' };
  if (parsed.ok !== true) return { ok: false, code: 'W10_REPORT_NOT_OK' };
  return { ok: true, code: 'W10_REPORT_OK', path, digest: await sha256File(path).catch(() => undefined) };
};

const runNode = (args, { timeoutMs = 120_000 } = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => { child.kill(); }, timeoutMs);
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.once('error', (error) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(error?.message ?? error) }); });
  child.once('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});

/** Detect the packaged install. Absence is reported, never inferred away. */
export const detectInstalledHost = async () => {
  const programFiles = process.env['ProgramFiles'];
  const localAppData = process.env['LOCALAPPDATA'];
  const evidence = [];
  let installed = false;
  const candidates = [
    ['INSTALLED_BINARY', programFiles ? join(programFiles, 'dda', 'dda-desktop.exe') : undefined],
    ['INSTALLED_RUNTIME', programFiles ? join(programFiles, 'dda', 'runtime', 'src', 'index.mjs') : undefined],
    ['UNINSTALLER', programFiles ? join(programFiles, 'dda', 'uninstall.exe') : undefined]
  ];
  for (const [kind, path] of candidates) {
    if (!path || !existsSync(path)) continue;
    if (kind !== 'UNINSTALLER') installed = true;
    const metadata = await stat(path).catch(() => undefined);
    evidence.push({
      kind,
      path,
      bytes: metadata?.size,
      modifiedAtMs: metadata?.mtimeMs,
      digest: await sha256File(path).catch(() => undefined)
    });
  }
  return { installed, programFiles: programFiles ?? null, localAppData: localAppData ?? null, evidence };
};

/** Real plugin version lifecycle drill: install, upgrade, degraded activation, rollback, reload. */
const runLifecycleDrill = async () => {
  const lifecycle = new PluginVersionLifecycle();
  lifecycle.install({ pluginId: 'w10-evidence', version: '1.0.0', packageDigest: `sha256:${'a'.repeat(64)}` });
  lifecycle.install({ pluginId: 'w10-evidence', version: '2.0.0', packageDigest: `sha256:${'b'.repeat(64)}` });
  lifecycle.install({ pluginId: 'w10-degraded', version: '1.0.0', packageDigest: `sha256:${'c'.repeat(64)}` });
  const first = await lifecycle.activate('w10-evidence', '1.0.0');
  const upgrade = await lifecycle.activate('w10-evidence', '2.0.0');
  const degraded = await lifecycle.activate('w10-degraded', '1.0.0', { selfTest: async () => ({ ok: false }) });
  const rollback = await lifecycle.rollback('w10-evidence');
  const snapshot = lifecycle.snapshot();
  const reloaded = new PluginVersionLifecycle();
  reloaded.restore(snapshot);
  return {
    evidenceClass: REAL,
    status: first.activated && upgrade.activated && degraded.activated === false && rollback.version === '1.0.0' && reloaded.active('w10-evidence')?.version === '1.0.0' ? 'PASS' : 'FAIL',
    activatedFirst: first.activated === true,
    upgradeActivated: upgrade.activated === true,
    failedActivationDegraded: degraded.activated === false,
    rollbackVersion: rollback.version,
    reloadActiveVersion: reloaded.active('w10-evidence')?.version,
    versions: snapshot.versions.map((item) => ({ pluginId: item.pluginId, version: item.version, state: item.state }))
  };
};

/** Real multi-process concurrency drill against one durable store. */
const runConcurrencyDrill = async (workDir) => {
  const storePath = join(workDir, 'concurrency.db');
  const runtimeUrl = new URL('../../runtime/src/harness-event-store.mjs', import.meta.url).href;
  const worker = [
    `import { createHarnessEventStore } from ${JSON.stringify(runtimeUrl)};`,
    'const store = createHarnessEventStore({ storagePath: process.argv[1] });',
    'await store.load();',
    'for (let index = 0; index < Number(process.argv[2]); index += 1) {',
    "  await store.append({ runId: process.argv[3], aggregateType: 'W10Concurrency', aggregateId: process.argv[3], kind: 'W10ConcurrentWrite', payload: { index }, sensitivity: 'INTERNAL' });",
    '}'
  ].join('\n');
  const startedAtMs = Date.now();
  const results = await Promise.all(Array.from({ length: CONCURRENCY_WORKERS }, (_, workerId) => runNode(
    ['--input-type=module', '-e', worker, storePath, String(CONCURRENCY_EVENTS_PER_WORKER), `w10-concurrency-${workerId}`]
  )));
  const failures = results.filter((result) => result.code !== 0).map((result) => result.stderr.trim().slice(0, 200));
  let durableEvents = 0;
  try {
    const store = createHarnessEventStore({ storagePath: storePath });
    await store.load();
    durableEvents = store.summary().eventCount;
  } catch (error) {
    failures.push(String(error?.message ?? error).slice(0, 200));
  }
  const expectedEvents = CONCURRENCY_WORKERS * CONCURRENCY_EVENTS_PER_WORKER;
  return {
    evidenceClass: REAL,
    status: failures.length === 0 && durableEvents === expectedEvents ? 'PASS' : 'FAIL',
    workers: CONCURRENCY_WORKERS,
    expectedEvents,
    durableEvents,
    elapsedMs: Date.now() - startedAtMs,
    failures
  };
};

/** Real recovery drill: cold load plus read-model rebuild from a durable store. */
const runRecoveryDrill = async (storePath, workDir) => {
  if (!storePath || !existsSync(storePath)) return { evidenceClass: REAL, status: NOT_RUN, reason: 'STORE_UNAVAILABLE' };
  try {
    const startedAtMs = Date.now();
    const store = createHarnessEventStore({ storagePath: storePath });
    await store.load();
    const loadElapsedMs = Date.now() - startedAtMs;
    const eventCount = store.summary().eventCount;
    const rebuildStartedAtMs = Date.now();
    const rebuilder = createReadModelRebuilder({ eventStore: store });
    const projection = await rebuilder.rebuild({ storagePath: join(workDir, 'recovery-read-model.json') });
    const rebuildElapsedMs = Date.now() - rebuildStartedAtMs;
    const elapsedMs = Date.now() - startedAtMs;
    return {
      evidenceClass: REAL,
      status: elapsedMs <= RECOVERY_BUDGET_MS ? 'PASS' : 'FAIL',
      storePath,
      eventCount,
      projectionVersion: projection?.projectionVersion,
      loadElapsedMs,
      rebuildElapsedMs,
      elapsedMs,
      budgetMs: RECOVERY_BUDGET_MS
    };
  } catch (error) {
    return { evidenceClass: REAL, status: 'FAIL', storePath, error: String(error?.message ?? error).slice(0, 200) };
  }
};

/** Real backup/restore drill: copy the durable store, reopen the copy, compare content. */
const runBackupRestoreDrill = async (storePath, workDir) => {
  if (!storePath || !existsSync(storePath)) return { evidenceClass: REAL, status: NOT_RUN, reason: 'STORE_UNAVAILABLE' };
  const backupPath = join(workDir, `restore-${Date.now()}.db`);
  try {
    const originalBytes = await readFile(storePath);
    await writeFile(backupPath, originalBytes);
    const [original, restored] = [createHarnessEventStore({ storagePath: storePath }), createHarnessEventStore({ storagePath: backupPath })];
    await Promise.all([original.load(), restored.load()]);
    const [originalPage, restoredPage] = await Promise.all([
      original.listPage({ limit: 1 }),
      restored.listPage({ limit: 1 })
    ]);
    const originalSummary = original.summary();
    const restoredSummary = restored.summary();
    const matched = originalSummary.eventCount > 0
      && originalSummary.eventCount === restoredSummary.eventCount
      && originalSummary.tombstoneCount === restoredSummary.tombstoneCount
      && originalPage.events[0]?.eventId === restoredPage.events[0]?.eventId
      && originalPage.events[0]?.recordDigest === restoredPage.events[0]?.recordDigest;
    return {
      evidenceClass: REAL,
      status: matched ? 'PASS' : 'FAIL',
      sourceBytes: originalBytes.byteLength,
      originalEvents: originalSummary.eventCount,
      restoredEvents: restoredSummary.eventCount,
      originalTombstones: originalSummary.tombstoneCount,
      restoredTombstones: restoredSummary.tombstoneCount
    };
  } catch (error) {
    return { evidenceClass: REAL, status: 'FAIL', error: String(error?.message ?? error).slice(0, 200) };
  } finally {
    await rm(backupPath, { force: true }).catch(() => {});
  }
};

/** Real privacy deletion drill: purge a run and prove no residue survives. */
const runPrivacyDeletionDrill = async (workDir) => {
  try {
    const storePath = join(workDir, 'privacy-deletion.db');
    const store = createHarnessEventStore({ storagePath: storePath });
    await store.load();
    await store.append({
      runId: 'w10-deletion-run',
      aggregateType: 'TaskRun',
      aggregateId: 'w10-deletion-run',
      kind: 'TaskRunCreated',
      payload: { prompt: 'w10-privacy-probe' },
      sensitivity: 'INTERNAL'
    });
    const purged = await store.purgeRun('w10-deletion-run', { reason: 'W10_DRILL' });
    const deletedRunIds = await store.listDeletedRunIds();
    const remaining = await store.list({ runId: 'w10-deletion-run' });
    const onDisk = await readFile(storePath, 'utf8').catch(() => '');
    const rawResidueDetected = onDisk.includes('w10-privacy-probe');
    return {
      evidenceClass: REAL,
      status: deletedRunIds.includes('w10-deletion-run') && remaining.length === 0 && !rawResidueDetected ? 'PASS' : 'FAIL',
      deletedRunIds,
      remainingEvents: remaining.length,
      rawResidueDetected,
      tombstoneDigest: purged?.tombstoneDigest ?? purged?.digest
    };
  } catch (error) {
    return { evidenceClass: REAL, status: 'FAIL', error: String(error?.message ?? error).slice(0, 200) };
  }
};

/** Real kill switch drill: kill blocks evolution, enable restores it, state persists. */
const runKillSwitchDrill = async (workDir) => {
  try {
    const storePath = join(workDir, 'kill-switch.db');
    const store = createHarnessEventStore({ storagePath: storePath });
    await store.load();
    const control = createEvolutionControlStore({ eventStore: store });
    await control.load();
    await control.kill({ reason: 'W10_KILL_SWITCH_DRILL', actor: 'W10_HARNESS' });
    let blocked = false;
    try {
      await control.assertEnabled('W10_DRILL');
    } catch (error) {
      blocked = String(error?.message ?? '').startsWith('EVOLUTION_CONTROL_KILLED');
    }
    await control.enable({ reason: 'W10_KILL_SWITCH_DRILL_RECOVERY', actor: 'W10_HARNESS' });
    const reloaded = createEvolutionControlStore({ eventStore: createHarnessEventStore({ storagePath: storePath }) });
    await reloaded.load();
    return {
      evidenceClass: REAL,
      status: blocked && reloaded.state().enabled === true ? 'PASS' : 'FAIL',
      blockedWhenKilled: blocked,
      restoredEnabled: reloaded.state().enabled
    };
  } catch (error) {
    return { evidenceClass: REAL, status: 'FAIL', error: String(error?.message ?? error).slice(0, 200) };
  }
};

/** Real capacity drill against the configured evidence paths. */
const runCapacityDrill = async (paths) => {
  const existing = paths.filter((path) => typeof path === 'string' && path && existsSync(path));
  if (!existing.length) return { evidenceClass: REAL, status: NOT_RUN, reason: 'NO_PATHS' };
  try {
    const assessment = await assessStorageCapacity({ paths: existing });
    return {
      evidenceClass: REAL,
      status: assessment.level === 'HARD_LIMIT' ? 'FAIL' : 'PASS',
      level: assessment.level,
      totalBytes: assessment.totalBytes,
      maxBytes: assessment.maxBytes,
      ratio: Number(assessment.ratio.toFixed(6)),
      fileCount: assessment.fileCount,
      paths: existing
    };
  } catch (error) {
    return { evidenceClass: REAL, status: 'FAIL', error: String(error?.message ?? error).slice(0, 200) };
  }
};

/** Real cost/egress report read from the durable evidence store. */
const runCostReport = async (storePath) => {
  if (!storePath || !existsSync(storePath)) return { evidenceClass: REAL, status: NOT_RUN, reason: 'STORE_UNAVAILABLE' };
  try {
    const ledger = createModelEgressLedger({ eventStore: createHarnessEventStore({ storagePath: storePath }) });
    await ledger.load();
    const summary = ledger.summarize();
    return {
      evidenceClass: REAL,
      status: 'REPORTED',
      recordCount: summary.recordCount,
      calls: summary.totals.calls,
      failures: summary.totals.failures,
      expectedCost: summary.totals.expectedCost,
      expectedCostKnown: summary.totals.expectedCostKnown,
      actualCost: summary.totals.actualCost,
      actualCostKnown: summary.totals.actualCostKnown
    };
  } catch (error) {
    return { evidenceClass: REAL, status: 'FAIL', error: String(error?.message ?? error).slice(0, 200) };
  }
};

/** Real long-run accumulation. Only wall-clock time between runs is credited. */
export const accumulateLongRun = async (statePath, { nowMs = Date.now(), sample = {} } = {}) => {
  if (!statePath) return { status: NOT_RUN, reason: 'STATE_PATH_REQUIRED', requiredMinutes: LONG_RUN_REQUIRED_MINUTES, observedMinutes: 0, sessions: 0, samples: 0 };
  const previous = await readJsonIfPresent(statePath);
  const sessions = Array.isArray(previous?.sessions) ? previous.sessions.slice(-200) : [];
  const samples = Number.isSafeInteger(previous?.samples) ? previous.samples + 1 : 1;
  const last = sessions[sessions.length - 1];
  if (last && nowMs - last.lastAtMs <= LONG_RUN_GAP_TOLERANCE_MS && nowMs >= last.lastAtMs) {
    sessions[sessions.length - 1] = { startedAtMs: last.startedAtMs, lastAtMs: nowMs };
  } else {
    sessions.push({ startedAtMs: nowMs, lastAtMs: nowMs });
  }
  const observedMs = sessions.reduce((total, session) => total + Math.max(0, session.lastAtMs - session.startedAtMs), 0);
  const observedMinutes = Math.floor(observedMs / 60_000);
  const record = { schemaVersion: '1.0', artifact: 'WINDOWS_PHASE2_W10_LONGRUN_STATE', updatedAtMs: nowMs, sessions, samples, observedMinutes, lastSample: sample };
  await mkdir(join(statePath, '..'), { recursive: true });
  await writeFile(statePath, JSON.stringify(record, null, 2));
  return { status: observedMinutes >= LONG_RUN_REQUIRED_MINUTES ? 'OBSERVED' : 'PENDING_OBSERVATION', requiredMinutes: LONG_RUN_REQUIRED_MINUTES, observedMinutes, sessions: sessions.length, samples, gapToleranceMs: LONG_RUN_GAP_TOLERANCE_MS };
};

/**
 * Read the real install/upgrade/migration/rollback/uninstall lifecycle drill
 * evidence. The drill runs elevated on Windows, writes one record per step and
 * a roll-up that carries the per-step files and their digests. Nothing is
 * inferred here: an absent, incomplete or failing artifact stays a blocking
 * reason and the affected step names are reported as missing.
 */
export const readInstallLifecycle = async (lifecyclePath) => {
  const base = {
    evidenceClass: NOT_RUN,
    status: 'MISSING',
    path: lifecyclePath ?? null,
    installer: null,
    elevated: null,
    requiredSteps: [...LIFECYCLE_REQUIRED_STEPS],
    missingSteps: [...LIFECYCLE_REQUIRED_STEPS],
    failedSteps: [],
    steps: {}
  };
  if (!lifecyclePath) return { ...base, code: 'INSTALL_LIFECYCLE_EVIDENCE_MISSING', reason: 'NOT_PROVIDED' };
  if (!existsSync(lifecyclePath)) return { ...base, code: 'INSTALL_LIFECYCLE_EVIDENCE_MISSING', reason: 'PATH_NOT_FOUND' };
  let result;
  try {
    result = JSON.parse(await readFile(lifecyclePath, 'utf8'));
  } catch {
    return { ...base, code: 'INSTALL_LIFECYCLE_EVIDENCE_INVALID', reason: 'UNREADABLE_JSON' };
  }
  if (result?.evidenceClass !== REAL || result?.elevated !== true) {
    return {
      ...base,
      code: 'INSTALL_LIFECYCLE_EVIDENCE_INVALID',
      reason: result?.evidenceClass !== REAL ? 'NOT_REAL_EXECUTION' : 'NOT_ELEVATED',
      installer: result?.installer ?? null,
      elevated: result?.elevated ?? null
    };
  }
  const records = Array.isArray(result.steps) ? result.steps : [];
  const steps = {};
  const missingSteps = [];
  const failedSteps = [];
  for (const name of LIFECYCLE_REQUIRED_STEPS) {
    const step = records.find((candidate) => candidate?.step === name);
    if (!step) { missingSteps.push(name); continue; }
    const logDigest = typeof step.log?.sha256 === 'string' && step.log.sha256 ? step.log.sha256 : null;
    const assertions = Array.isArray(step.assertions)
      ? step.assertions.map((assertion) => ({ name: assertion?.name ?? 'unnamed', ok: assertion?.ok === true }))
      : [];
    let stepFileDigestVerified = null;
    if (typeof step.stepFile === 'string' && step.stepFile && typeof step.stepFileSha256 === 'string' && step.stepFileSha256) {
      stepFileDigestVerified = await sha256File(step.stepFile)
        .then((digest) => digest === `sha256:${step.stepFileSha256}`)
        .catch(() => false);
    }
    const verified = step.evidenceClass === REAL && step.exitCode === 0 && Boolean(logDigest)
      && assertions.length > 0 && assertions.every((assertion) => assertion.ok);
    if (!verified) failedSteps.push(name);
    steps[name] = {
      status: verified ? 'VERIFIED' : 'REJECTED',
      evidenceClass: step.evidenceClass ?? null,
      elevated: step.elevated ?? null,
      exitCode: step.exitCode ?? null,
      command: step.command ?? null,
      log: step.log?.path ? { path: step.log.path, bytes: step.log.bytes ?? null, sha256: logDigest } : null,
      stepFile: step.stepFile ?? null,
      stepFileDigestVerified,
      assertions
    };
  }
  const code = missingSteps.length > 0
    ? 'INSTALL_LIFECYCLE_EVIDENCE_INCOMPLETE'
    : (failedSteps.length > 0 ? 'INSTALL_LIFECYCLE_STEP_ASSERTION_FAILED' : null);
  return {
    evidenceClass: REAL,
    status: code === null ? 'VERIFIED' : 'INCOMPLETE',
    code,
    path: lifecyclePath,
    installer: result.installer ?? null,
    elevated: true,
    finishedAtMs: Number.isFinite(result.finishedAtMs) ? result.finishedAtMs : null,
    expectedRuntimeSha256: result.expectedRuntimeSha256 ?? null,
    requiredSteps: [...LIFECYCLE_REQUIRED_STEPS],
    missingSteps,
    failedSteps,
    steps
  };
};

export async function runW10Evidence({
  outputPath,
  statePath,
  storePath,
  releaseReportPath,
  workspaceObservationPath,
  installLifecyclePath,
  observationStartedAtMs,
  observationSource,
  workerProgress,
  expectedRunCount,
  failureCount = 0,
  skipDrills = false
} = {}) {
  if ((expectedRunCount !== undefined && (!Number.isSafeInteger(expectedRunCount) || expectedRunCount < 0))
    || !Number.isFinite(failureCount) || failureCount < 0) throw new Error('W10_EVIDENCE_INPUT_INVALID');
  const startedAt = new Date().toISOString();
  const installedHost = await detectInstalledHost();
  const installLifecycle = await readInstallLifecycle(installLifecyclePath);
  const workDir = await mkdtemp(join(tmpdir(), 'hmcodex-w10-'));
  const drills = {};
  if (!skipDrills) {
    drills.lifecycle = await runLifecycleDrill();
    drills.concurrency = await runConcurrencyDrill(workDir);
    drills.recovery = await runRecoveryDrill(storePath, workDir);
    drills.backupRestore = await runBackupRestoreDrill(storePath, workDir);
    drills.privacyDeletion = await runPrivacyDeletionDrill(workDir);
    drills.killSwitch = await runKillSwitchDrill(workDir);
    drills.capacity = await runCapacityDrill([storePath, outputPath]);
    drills.cost = await runCostReport(storePath);
  }
  await rm(workDir, { recursive: true, force: true });

  // The sample names the physical file the counts came from. A drill count from
  // a packaged process must not be reported as the user profile store.
  const storeSnapshot = await readStoreSnapshot(storePath);
  const longRun = await accumulateLongRun(statePath, { sample: storeSnapshot });
  const installStatus = installedHost.installed ? 'OBSERVED' : NOT_RUN;
  const retention = {
    ...evaluateThirtyDayRetention({ observationStartedAtMs, workerProgress, expectedRunCount, failureCount }),
    ...(observationSource ? { observationSource } : {})
  };
  const releaseReport = await readSignedReport(releaseReportPath, 'RELEASE_DECISION_REPORT_MISSING');
  const workspaceObservation = await readSignedReport(workspaceObservationPath, 'REAL_WORKSPACE_OBSERVATION_MISSING');

  // A step whose log is absent, rejected or failing is still missing acceptable evidence.
  const lifecycleMissing = LIFECYCLE_REQUIRED_STEPS
    .filter((step) => installLifecycle.steps[step]?.status !== 'VERIFIED')
    .map((step) => `${step}Log`);
  const installMissing = installStatus === 'OBSERVED' ? lifecycleMissing : ['installedHost', ...lifecycleMissing];
  const blockingReasons = [];
  if (installStatus !== 'OBSERVED') blockingReasons.push('INSTALLED_PACKAGE_NOT_OBSERVED');
  if (installLifecycle.status !== 'VERIFIED') blockingReasons.push(installLifecycle.code ?? 'INSTALL_LIFECYCLE_EVIDENCE_MISSING');
  if (longRun.status !== 'OBSERVED') blockingReasons.push('LONG_RUN_WINDOW_INCOMPLETE');
  if (retention.status !== 'PASS') blockingReasons.push(`RETENTION_${retention.status}`);
  for (const [key, code] of [['lifecycle', 'PLUGIN_LIFECYCLE_DRILL_UNVERIFIED'], ['concurrency', 'CONCURRENCY_DRILL_UNVERIFIED'], ['recovery', 'RECOVERY_DRILL_UNVERIFIED'], ['backupRestore', 'BACKUP_RESTORE_DRILL_UNVERIFIED'], ['privacyDeletion', 'PRIVACY_DELETION_DRILL_UNVERIFIED'], ['killSwitch', 'KILL_SWITCH_DRILL_UNVERIFIED']]) {
    if (drills[key]?.status !== 'PASS') blockingReasons.push(code);
  }
  if (!releaseReport.ok) blockingReasons.push(releaseReport.code);
  if (!workspaceObservation.ok) blockingReasons.push(workspaceObservation.code);

  const report = {
    schemaVersion: '1.1',
    artifact: 'WINDOWS_PHASE2_W10_EVIDENCE',
    startedAt,
    execution: {
      hostPlatform: process.platform,
      node: process.version,
      installedPackage: installedHost.installed,
      packageEvidence: installedHost.evidence,
      evidenceStore: storePath ?? null,
      // Which physical file the store path resolved to. A packaged process can
      // read a package-local copy of %LOCALAPPDATA%; the record names both so
      // a drill result is never attributed to the wrong file.
      storeIdentity: describeStorePath(storePath),
      drillsExecuted: !skipDrills
    },
    install: {
      status: installStatus,
      evidenceClass: installedHost.installed ? REAL : PENDING_INSTALLED_HOST,
      observed: installedHost.evidence,
      lifecycle: installLifecycle,
      missing: installMissing
    },
    lifecycle: drills.lifecycle ?? { evidenceClass: NOT_RUN },
    longRun,
    concurrency: drills.concurrency ?? { evidenceClass: NOT_RUN },
    recoverySlo: drills.recovery ?? { evidenceClass: NOT_RUN },
    backupRestore: drills.backupRestore ?? { evidenceClass: NOT_RUN },
    privacyDeletion: drills.privacyDeletion ?? { evidenceClass: NOT_RUN },
    killSwitch: drills.killSwitch ?? { evidenceClass: NOT_RUN },
    storageCapacity: drills.capacity ?? { evidenceClass: NOT_RUN },
    cost: drills.cost ?? { evidenceClass: NOT_RUN },
    retention,
    releaseEvidence: { decisionReport: releaseReport, workspaceObservation },
    releaseDecision: blockingReasons.length === 0 ? 'READY' : 'NOT_READY',
    blockingReasons
  };
  if (outputPath) { await mkdir(join(outputPath, '..'), { recursive: true }); await writeFile(outputPath, JSON.stringify(report, null, 2)); }
  return report;
}

const argumentOf = (prefix) => process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
const numberArgumentOf = (prefix) => {
  const raw = argumentOf(prefix);
  return raw === undefined ? undefined : Number(raw);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const output = argumentOf('--output=');
  const defaultStore = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'hmCodex', 'hmcodex.db') : undefined;
  const statePath = argumentOf('--state=') ?? (output ? `${output}.longrun.json` : undefined);
  const progressPath = argumentOf('--retention-progress=') ?? (defaultStore ? `${defaultStore}.retention-progress.json` : undefined);
  const workerProgress = await readJsonIfPresent(progressPath);
  // The observation start must come from recorded evidence: either the
  // operator's observation record or the retention progress store itself.
  const observationRecord = await readJsonIfPresent(argumentOf('--retention-observation='));
  const observationSource = observationRecord?.ok === true
    ? argumentOf('--retention-observation=')
    : (Number.isFinite(workerProgress?.startedAtMs) ? progressPath : undefined);
  const report = await runW10Evidence({
    outputPath: output,
    statePath,
    storePath: argumentOf('--store=') ?? (defaultStore && existsSync(defaultStore) ? defaultStore : undefined),
    releaseReportPath: argumentOf('--release-report='),
    workspaceObservationPath: argumentOf('--workspace-observation='),
    installLifecyclePath: argumentOf('--install-lifecycle='),
    observationStartedAtMs: numberArgumentOf('--observation-started-at-ms=')
      ?? (observationRecord?.ok === true ? observationRecord.observationStartedAtMs : undefined)
      ?? (Number.isFinite(workerProgress?.startedAtMs) ? workerProgress.startedAtMs : undefined),
    workerProgress,
    observationSource,
    expectedRunCount: numberArgumentOf('--expected-run-count='),
    failureCount: numberArgumentOf('--failure-count=') ?? 0,
    skipDrills: process.argv.includes('--skip-drills')
  });
  console.log(JSON.stringify(report, null, 2));
  if (process.argv.includes('--strict') && report.releaseDecision !== 'READY') process.exitCode = 1;
}
