export const RELEASE_CHANNELS = Object.freeze([
  'WINDOWS_MVP_PRE_PHASE1',
  'WINDOWS_PHASE1_READ_ONLY',
  'WINDOWS_PHASE1_5_CONTROLLED',
  'WINDOWS_FULL_LOCAL'
]);

// Linux names are policy aliases. They canonicalize onto the existing Windows
// gates so READ_ONLY and CONTROLLED keep the same meaning on both platforms.
const RELEASE_CHANNEL_ALIASES = Object.freeze({
  LINUX_CLI_READ_ONLY: 'WINDOWS_PHASE1_READ_ONLY',
  LINUX_CLI_CONTROLLED: 'WINDOWS_FULL_LOCAL'
});

export function resolveReleaseChannel(value = process.env.HMCODEX_BAKED_RELEASE_CHANNEL ?? process.env.HMCODEX_RELEASE_CHANNEL) {
  const requested = value ?? 'WINDOWS_MVP_PRE_PHASE1';
  const channel = RELEASE_CHANNEL_ALIASES[requested] ?? requested;
  if (!RELEASE_CHANNELS.includes(channel)) throw new Error('RELEASE_CHANNEL_INVALID');
  return channel;
}

export function assertReleaseExecutionMode(mode, channel = resolveReleaseChannel()) {
  const canonical = resolveReleaseChannel(channel);
  if (canonical === 'WINDOWS_PHASE1_READ_ONLY' && mode !== 'READ_ONLY') {
    throw new Error('RELEASE_CHANNEL_READ_ONLY');
  }
  return mode;
}

export function assertReleaseHarnessStore(storagePath, channel = resolveReleaseChannel()) {
  const canonical = resolveReleaseChannel(channel);
  if (canonical === 'WINDOWS_PHASE1_READ_ONLY'
    && (typeof storagePath !== 'string' || !/\.db$/iu.test(storagePath))) {
    throw new Error('RELEASE_CHANNEL_SQLITE_REQUIRED');
  }
  return storagePath;
}
