export const DEFAULT_RELEASE_CHANNEL = 'WINDOWS_MVP_PRE_PHASE1';
export const READ_ONLY_RELEASE_CHANNEL = 'WINDOWS_PHASE1_READ_ONLY';
export const CONTROLLED_RELEASE_CHANNELS = Object.freeze(['WINDOWS_PHASE1_5_CONTROLLED', 'WINDOWS_FULL_LOCAL']);
export const RELEASE_CHANNELS = Object.freeze([
  DEFAULT_RELEASE_CHANNEL,
  READ_ONLY_RELEASE_CHANNEL,
  ...CONTROLLED_RELEASE_CHANNELS
]);

// Platform names are policy aliases. They canonicalize onto the existing
// channel gates so READ_ONLY and CONTROLLED keep the same meaning everywhere.
const RELEASE_CHANNEL_ALIASES = Object.freeze({
  LINUX_CLI_READ_ONLY: READ_ONLY_RELEASE_CHANNEL,
  LINUX_CLI_CONTROLLED: 'WINDOWS_FULL_LOCAL'
});

const canonicalReleaseChannel = (value) => RELEASE_CHANNEL_ALIASES[value] ?? value;

export function resolveReleaseChannel(value = process.env.HMCODEX_BAKED_RELEASE_CHANNEL ?? process.env.HMCODEX_RELEASE_CHANNEL) {
  const requested = value ?? DEFAULT_RELEASE_CHANNEL;
  const channel = canonicalReleaseChannel(requested);
  if (!RELEASE_CHANNELS.includes(channel)) throw new Error('RELEASE_CHANNEL_INVALID');
  return channel;
}

/** Read-only policy. Omitted channel uses the current process channel. */
export function isReadOnlyRelease(channel = resolveReleaseChannel()) {
  return canonicalReleaseChannel(channel) === READ_ONLY_RELEASE_CHANNEL;
}

/**
 * Controlled policy. A missing channel is not controlled; this does not read
 * the process environment, matching the release-manifest gate.
 */
export function isControlledRelease(channel) {
  if (typeof channel !== 'string' || !channel) return false;
  return CONTROLLED_RELEASE_CHANNELS.includes(canonicalReleaseChannel(channel));
}

/** Any channel past the pre-phase-1 baseline is an approved release candidate. */
export function isApprovedRelease(channel) {
  return typeof channel === 'string' && channel !== DEFAULT_RELEASE_CHANNEL && RELEASE_CHANNELS.includes(canonicalReleaseChannel(channel));
}

export function assertReleaseExecutionMode(mode, channel = resolveReleaseChannel()) {
  if (isReadOnlyRelease(resolveReleaseChannel(channel)) && mode !== 'READ_ONLY') {
    throw new Error('RELEASE_CHANNEL_READ_ONLY');
  }
  return mode;
}

export function assertReleaseHarnessStore(storagePath, channel = resolveReleaseChannel()) {
  if (isReadOnlyRelease(resolveReleaseChannel(channel))
    && (typeof storagePath !== 'string' || !/\.db$/iu.test(storagePath))) {
    throw new Error('RELEASE_CHANNEL_SQLITE_REQUIRED');
  }
  return storagePath;
}
