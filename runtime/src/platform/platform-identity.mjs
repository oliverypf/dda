export const PLATFORM_IDENTITIES = Object.freeze(['linux-cli', 'windows-desktop', 'harmonyos']);

const READ_ONLY_CHANNELS = new Set(['LINUX_CLI_READ_ONLY', 'WINDOWS_PHASE1_READ_ONLY']);
const CONTROLLED_CHANNELS = new Set(['LINUX_CLI_CONTROLLED', 'WINDOWS_PHASE1_5_CONTROLLED', 'WINDOWS_FULL_LOCAL']);

export const architectureLabel = (arch = process.arch) => (arch === 'x64' ? 'x64' : arch);

export function policyChannelForRelease(channel) {
  if (READ_ONLY_CHANNELS.has(channel)) return 'READ_ONLY';
  if (CONTROLLED_CHANNELS.has(channel)) return 'CONTROLLED';
  return 'PRE_PHASE1';
}

/**
 * Platform identity is explicit. A Linux host running the Windows runtime
 * stays `windows-desktop` until `HMCODEX_PLATFORM=linux-cli` is set.
 */
export function resolvePlatformIdentity(env = process.env) {
  const requested = typeof env.HMCODEX_PLATFORM === 'string' ? env.HMCODEX_PLATFORM.trim() : '';
  const platform = PLATFORM_IDENTITIES.includes(requested) ? requested : 'windows-desktop';
  const requestedChannel = env.HMCODEX_BAKED_RELEASE_CHANNEL ?? env.HMCODEX_RELEASE_CHANNEL ?? 'WINDOWS_MVP_PRE_PHASE1';
  return {
    platform,
    architecture: architectureLabel(),
    runtime: 'node',
    policyChannel: policyChannelForRelease(requestedChannel),
    executor: platform === 'linux-cli' ? 'linux-posix' : 'restricted-windows'
  };
}

export function releaseChannelForPolicy(policy) {
  if (policy === 'CONTROLLED') return 'LINUX_CLI_CONTROLLED';
  if (policy === 'READ_ONLY') return 'LINUX_CLI_READ_ONLY';
  throw new Error('POLICY_CHANNEL_INVALID');
}
