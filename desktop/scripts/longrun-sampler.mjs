#!/usr/bin/env node
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accumulateLongRun } from './w10-evidence-harness.mjs';
import { readStoreEventCount, readStoreSnapshot } from './harness-store-snapshot.mjs';
import { projectPaths } from './windows-path.mjs';

/**
 * Real 24-hour long-run observation sampler.
 *
 * The W10 gate needs an observed wall-clock window of at least 1440 minutes
 * with gaps no larger than two minutes. Only sampled wall-clock time is
 * credited, so the observation has to be driven by a real recurring process
 * rather than by one harness run. This module is that process: it appends one
 * sample per invocation and never invents elapsed time.
 *
 * The sample names every physical file the store path resolves to on this
 * host, so a count is never attributed to the wrong file (see
 * `harness-store-snapshot.mjs`).
 */
export { readStoreCounts, readStoreEventCount, readStoreSnapshot } from './harness-store-snapshot.mjs';

export const defaultLongRunStatePath = (workspaceRoot) => join(
  workspaceRoot,
  'docs',
  'artifacts',
  'WINDOWS_PHASE2_W10_EVIDENCE.json.longrun.json'
);

export const sampleLongRun = async ({ statePath, storePath, nowMs = Date.now(), storeIdentityOptions } = {}) => {
  if (!statePath) throw new Error('LONG_RUN_STATE_PATH_REQUIRED');
  const sample = await readStoreSnapshot(storePath, storeIdentityOptions);
  return accumulateLongRun(statePath, { nowMs, sample });
};

const argumentOf = (prefix) => process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { workspaceRoot } = projectPaths(import.meta.url);
  const defaultStore = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'hmCodex', 'hmcodex.db') : undefined;
  const statePath = argumentOf('--state=') ?? process.env.HMCODEX_LONGRUN_STATE ?? defaultLongRunStatePath(workspaceRoot);
  const storePath = argumentOf('--store=') ?? process.env.HMCODEX_LONGRUN_STORE ?? defaultStore;
  const result = await sampleLongRun({ statePath, storePath });
  console.log(JSON.stringify({ statePath, storePath: storePath ?? null, ...result }));
}
