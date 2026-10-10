import { backup } from 'node:sqlite';
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openHarnessDatabase, readHarnessDatabase } from './harness-store-schema.mjs';
import { validateHarnessStore, harnessDigest } from './harness-event-store.mjs';

// Both checkpoint and recovery create a new file. Never repair or overwrite a
// damaged fact store in place; it remains available for diagnosis.
export async function checkpointHarnessDatabase(sourcePath, outputPath) {
  if (typeof sourcePath !== 'string' || typeof outputPath !== 'string'
    || !sourcePath.trim() || !outputPath.trim()) throw new Error('HARNESS_CHECKPOINT_PATH_REQUIRED');
  if (resolve(sourcePath).toLowerCase() === resolve(outputPath).toLowerCase()) throw new Error('HARNESS_CHECKPOINT_SAME_PATH');
  const source = openHarnessDatabase(sourcePath, { readOnly: true });
  let ownedOutput = false;
  try {
    validateHarnessStore(readHarnessDatabase(source));
    // Reserve exclusively: an existing destination, including the live DB,
    // must never be overwritten by SQLite's backup API.
    const reservation = await open(outputPath, 'wx');
    ownedOutput = true;
    await reservation.close();
    await backup(source, outputPath);
    const restored = openHarnessDatabase(outputPath, { readOnly: true });
    try {
      const snapshot = readHarnessDatabase(restored);
      validateHarnessStore(snapshot);
      return {
        status: 'VERIFIED', storageSchemaVersion: 1,
        eventCount: snapshot.events.length, receiptCount: snapshot.receipts.length,
        tombstoneCount: snapshot.tombstones.length, snapshotDigest: harnessDigest(snapshot)
      };
    } finally { restored.close(); }
  } catch (error) {
    if (ownedOutput) await unlink(outputPath).catch(() => {});
    throw error;
  } finally { source.close(); }
}

export const restoreHarnessDatabase = checkpointHarnessDatabase;
