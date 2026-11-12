export const DEFAULT_RELEASE_CHANNEL = 'WINDOWS_PHASE1_5_CONTROLLED';
export const CONTROLLED_RELEASE_CHANNELS = Object.freeze(['WINDOWS_PHASE1_5_CONTROLLED', 'WINDOWS_FULL_LOCAL']);
export const RELEASE_CHANNELS = CONTROLLED_RELEASE_CHANNELS;
// These identifiers remain valid historical data, never live execution gates.
export const RETIRED_RELEASE_CHANNELS = Object.freeze([
  'WINDOWS_MVP_PRE_PHASE1', 'WINDOWS_PHASE1_READ_ONLY', 'LINUX_CLI_READ_ONLY'
]);

// CONTROLLED maps to the Phase 1.5 controlled channel, not the phase-2 target
// WINDOWS_FULL_LOCAL: the Linux CLI only ships the restricted controlled policy
// (lease + approval + audit), so it must not inherit the full-local release gate.
const RELEASE_CHANNEL_ALIASES = Object.freeze({
  LINUX_CLI_CONTROLLED: 'WINDOWS_PHASE1_5_CONTROLLED'
});

const canonicalReleaseChannel = (value) => RELEASE_CHANNEL_ALIASES[value] ?? value;

export function resolveReleaseChannel(value = process.env.DDA_BAKED_RELEASE_CHANNEL ?? process.env.DDA_RELEASE_CHANNEL) {
  const requested = value ?? DEFAULT_RELEASE_CHANNEL;
  if (RETIRED_RELEASE_CHANNELS.includes(requested)) throw new Error('RELEASE_CHANNEL_RETIRED');
  const channel = canonicalReleaseChannel(requested);
  if (!RELEASE_CHANNELS.includes(channel)) throw new Error('RELEASE_CHANNEL_INVALID');
  return channel;
}

/**
 * Controlled policy. A missing channel is not controlled; this does not read
 * the process environment, matching the release-manifest gate.
 */
export function isControlledRelease(channel) {
  if (typeof channel !== 'string' || !channel) return false;
  return CONTROLLED_RELEASE_CHANNELS.includes(canonicalReleaseChannel(channel));
}

/** Active channels are release candidates, still subject to their release gates. */
export function isApprovedRelease(channel) {
  return isControlledRelease(channel);
}

/**
 * The controlled release contract requires a durable SQLite event store. A
 * scoped `.json`/JSONL path or a missing store fails closed (ADR-0026 keeps
 * this gate; it was never part of the retired execution mode).
 */
export function assertReleaseHarnessStore(storagePath, channel = resolveReleaseChannel()) {
  if (isControlledRelease(resolveReleaseChannel(channel))
    && (typeof storagePath !== 'string' || !/\.db$/iu.test(storagePath))) {
    throw new Error('RELEASE_CHANNEL_SQLITE_REQUIRED');
  }
  return storagePath;
}

export function assertReleaseExecutionMode(mode, channel = resolveReleaseChannel()) {
  resolveReleaseChannel(channel);
  if (mode !== 'CONTROLLED') throw new Error('EXECUTION_MODE_INVALID');
  return mode;
}
