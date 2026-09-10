import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PluginVersionLifecycle } from '../../runtime/src/plugin-version-lifecycle.mjs';
import { evaluateThirtyDayRetention } from '../../runtime/src/retention-acceptance.mjs';

/**
 * Produce a reviewable W10 evidence record. The lifecycle checks are real
 * runtime checks; install/long-run fields remain explicitly pending until the
 * harness is run against a packaged Windows installation with --installed.
 */
export async function runW10Evidence({ outputPath, installed = false, longRunMinutes = 0, observationStartedAtMs, workerProgress, expectedRunCount = 0, failureCount = 0 } = {}) {
  if (typeof installed !== 'boolean' || !Number.isFinite(longRunMinutes) || longRunMinutes < 0 || !Number.isFinite(expectedRunCount) || expectedRunCount < 0 || !Number.isFinite(failureCount) || failureCount < 0) throw new Error('W10_EVIDENCE_INPUT_INVALID');
  const startedAt = new Date().toISOString();
  const lifecycle = new PluginVersionLifecycle();
  lifecycle.install({ pluginId: 'w10-evidence', version: '1.0.0', packageDigest: 'sha256:evidence-old' });
  lifecycle.install({ pluginId: 'w10-evidence', version: '2.0.0', packageDigest: 'sha256:evidence-new' });
  await lifecycle.activate('w10-evidence', '1.0.0');
  const upgrade = await lifecycle.activate('w10-evidence', '2.0.0');
  const rollback = await lifecycle.rollback('w10-evidence');
  const report = {
    schemaVersion: '1.0', artifact: 'WINDOWS_PHASE2_W10_EVIDENCE', startedAt,
    execution: { hostPlatform: process.platform, node: process.version, installedPackage: installed, longRunMinutes },
    lifecycle: { upgradeActivated: upgrade.activated, rollbackVersion: rollback.version },
    install: { status: installed ? 'PENDING_REAL_ASSERTIONS' : 'NOT_RUN', evidenceClass: installed ? 'INSTALLED_HOST_REQUIRED' : 'SIMULATION_ONLY', missing: installed ? ['packageIdentity', 'installLog', 'upgradeLog', 'uninstallLog'] : ['installedHost'] },
    longRun: { status: longRunMinutes >= 1440 ? 'PENDING_REAL_ASSERTIONS' : (longRunMinutes > 0 ? 'PENDING_OBSERVATION' : 'NOT_RUN'), requiredMinutes: 1440, observedMinutes: longRunMinutes, missing: longRunMinutes >= 1440 ? ['concurrency', 'eventGrowth', 'recoverySlo', 'uiJank', 'costReport'] : ['longRunWindow'] },
    backupRestore: { status: 'PENDING_INSTALLED_HOST' },
    privacyDeletion: { status: 'PENDING_INSTALLED_HOST' },
    killSwitch: { status: 'PENDING_INSTALLED_HOST' },
    retention: evaluateThirtyDayRetention({ observationStartedAtMs, workerProgress, expectedRunCount: expectedRunCount || undefined, failureCount }),
    releaseDecision: 'NOT_READY'
  };
  if (outputPath) { await mkdir(join(outputPath, '..'), { recursive: true }); await writeFile(outputPath, JSON.stringify(report, null, 2)); }
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const output = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9);
  const installed = process.argv.includes('--installed');
  const minutes = Number(process.argv.find((arg) => arg.startsWith('--long-run-minutes='))?.split('=')[1] ?? 0);
  const observationStartedAtMs = Number(process.argv.find((arg) => arg.startsWith('--observation-started-at-ms='))?.split('=')[1]);
  const report = await runW10Evidence({ outputPath: output, installed, longRunMinutes: minutes, observationStartedAtMs });
  console.log(JSON.stringify(report, null, 2));
}
