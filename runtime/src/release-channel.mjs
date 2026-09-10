export const RELEASE_CHANNELS = Object.freeze([
  'WINDOWS_MVP_PRE_PHASE1',
  'WINDOWS_PHASE1_READ_ONLY',
  'WINDOWS_PHASE1_5_CONTROLLED',
  'WINDOWS_FULL_LOCAL'
]);

export function resolveReleaseChannel(value = process.env.HMCODEX_BAKED_RELEASE_CHANNEL ?? process.env.HMCODEX_RELEASE_CHANNEL) {
  const channel = value ?? 'WINDOWS_MVP_PRE_PHASE1';
  if (!RELEASE_CHANNELS.includes(channel)) throw new Error('RELEASE_CHANNEL_INVALID');
  return channel;
}

export function assertReleaseExecutionMode(mode, channel = resolveReleaseChannel()) {
  resolveReleaseChannel(channel);
  if (channel === 'WINDOWS_PHASE1_READ_ONLY' && mode !== 'READ_ONLY') {
    throw new Error('RELEASE_CHANNEL_READ_ONLY');
  }
  return mode;
}

export function assertReleaseHarnessStore(storagePath, channel = resolveReleaseChannel()) {
  resolveReleaseChannel(channel);
  if (channel === 'WINDOWS_PHASE1_READ_ONLY'
    && (typeof storagePath !== 'string' || !/\.db$/iu.test(storagePath))) {
    throw new Error('RELEASE_CHANNEL_SQLITE_REQUIRED');
  }
  return storagePath;
}
