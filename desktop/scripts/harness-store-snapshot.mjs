import { existsSync } from 'node:fs';
import { createHarnessEventStore } from '../../runtime/src/harness-event-store.mjs';
import { describeStorePath } from './windows-store-identity.mjs';

/**
 * Physical store snapshots for long-run and W10 evidence.
 *
 * A logical store path such as `%LOCALAPPDATA%\hmCodex\hmcodex.db` can resolve to
 * more than one physical file: the user profile file, and a package-local copy
 * Windows keeps for an MSIX-packaged process. A count is only meaningful
 * together with the file it came from, so every snapshot carries the identity
 * of the file that was actually read.
 */

const isUncPath = (path) => typeof path === 'string' && path.startsWith('\\\\');

/** Read one physical store file. A missing file is never created to be read. */
export const readStoreCounts = async (storePath) => {
  if (!storePath || !existsSync(storePath)) return {};
  if (isUncPath(storePath)) return { countSkipped: 'UNC_PATH_REQUIRES_LOCAL_CONTEXT' };
  try {
    const store = createHarnessEventStore({ storagePath: storePath });
    await store.load();
    const summary = store.summary();
    return {
      storeKind: summary.store,
      eventCount: summary.eventCount,
      receiptCount: summary.receiptCount,
      tombstoneCount: summary.tombstoneCount
    };
  } catch (error) {
    // A locked or corrupt store must not stop the observation; the snapshot
    // records the failure instead of a fabricated count.
    return { readError: String(error?.message ?? error).slice(0, 160) };
  }
};

export const readStoreSnapshot = async (storePath, options = {}) => {
  const identity = describeStorePath(storePath, options);
  if (!storePath) return identity;
  const counts = await readStoreCounts(storePath);
  const additional = [];
  for (const copy of identity.packageLocalCacheCopies ?? []) {
    if (!copy.exists) continue;
    additional.push({ role: 'PACKAGE_LOCAL_CACHE_COPY', packageFamily: copy.packageFamily, path: copy.path, exists: true, sizeBytes: copy.sizeBytes, modifiedAtMs: copy.modifiedAtMs, ...(await readStoreCounts(copy.path)) });
  }
  const alias = identity.unredactedProfileAlias;
  if (alias) {
    additional.push({ role: 'UNREDACTED_PROFILE_FILE', path: alias.path, exists: true, sizeBytes: alias.sizeBytes, modifiedAtMs: alias.modifiedAtMs, ...(await readStoreCounts(alias.path)) });
  }
  // `storePath` keeps the historical sample field name next to the resolved identity.
  return { storePath: identity.requestedPath ?? null, ...identity, ...counts, ...(additional.length ? { additionalStores: additional } : {}) };
};

export const readStoreEventCount = async (storePath, options = {}) => {
  const snapshot = await readStoreSnapshot(storePath, options);
  return snapshot.eventCount;
};
