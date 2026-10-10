import { DEFAULT_RELEASE_CHANNEL, isControlledRelease, isReadOnlyRelease } from '../release-channel.mjs';

export const PLATFORM_IDENTITIES = Object.freeze([
  'linux-cli',
  'windows-cli',
  'windows-desktop',
  'harmonyos-cli',
  'harmonyos'
]);

const CLI_HOSTS = new Set(['linux-cli', 'windows-cli', 'harmonyos-cli']);
const HARMONY_MARKERS = /(?:^|[^a-z])(ohos|harmonyos|openharmony|harmony)(?:[^a-z]|$)/iu;

export const architectureLabel = (arch = process.arch) => (arch === 'x64' ? 'x64' : arch);

export function policyChannelForRelease(channel) {
  if (isReadOnlyRelease(channel)) return 'READ_ONLY';
  if (isControlledRelease(channel)) return 'CONTROLLED';
  return 'PRE_PHASE1';
}

/**
 * Platform identity is explicit. A Linux host running the Windows runtime
 * stays `windows-desktop` until `HMCODEX_PLATFORM=linux-cli` is set.
 */
export function resolvePlatformIdentity(env = process.env) {
  const requested = typeof env.HMCODEX_PLATFORM === 'string' ? env.HMCODEX_PLATFORM.trim() : '';
  const platform = PLATFORM_IDENTITIES.includes(requested) ? requested : 'windows-desktop';
  const requestedChannel = env.HMCODEX_BAKED_RELEASE_CHANNEL ?? env.HMCODEX_RELEASE_CHANNEL ?? DEFAULT_RELEASE_CHANNEL;
  return {
    platform,
    architecture: architectureLabel(),
    runtime: 'node',
    policyChannel: policyChannelForRelease(requestedChannel),
    executor: platform === 'linux-cli'
      ? 'linux-posix'
      : platform === 'harmonyos-cli' || platform === 'harmonyos'
        ? 'harmonyos-posix'
        : 'restricted-windows'
  };
}

/**
 * Pick the CLI host from an explicit override, HarmonyOS markers, then the
 * process platform. Linux stays `linux-cli` unless those markers are present,
 * so a HarmonyOS PC that reports a Linux-like Node platform still lands on
 * the HarmonyOS profile.
 */
export function detectCliHost({ env = process.env, platform = process.platform, release = '' } = {}) {
  const requested = typeof env.HMCODEX_PLATFORM === 'string' ? env.HMCODEX_PLATFORM.trim() : '';
  if (CLI_HOSTS.has(requested) || PLATFORM_IDENTITIES.includes(requested)) return requested;
  const evidence = [platform, release, env.OHOS_SDK_HOME, env.HARMONYOS_SDK_HOME, env.HM_SDK_HOME]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n');
  if (HARMONY_MARKERS.test(evidence)) return 'harmonyos-cli';
  if (platform === 'win32') return 'windows-cli';
  return 'linux-cli';
}

const EXECUTOR_DESCRIPTORS = Object.freeze({
  'linux-cli': Object.freeze({
    id: 'linux-posix@0.1.0',
    pluginId: 'executor-linux',
    title: 'Restricted POSIX Executor',
    executor: 'linux-posix'
  }),
  'harmonyos-cli': Object.freeze({
    id: 'harmonyos-posix@0.1.0',
    pluginId: 'executor-harmonyos',
    title: 'Restricted HarmonyOS Executor',
    executor: 'harmonyos-posix'
  }),
  harmonyos: Object.freeze({
    id: 'harmonyos-posix@0.1.0',
    pluginId: 'executor-harmonyos',
    title: 'Restricted HarmonyOS Executor',
    executor: 'harmonyos-posix'
  }),
  'windows-cli': Object.freeze({
    id: 'restricted-windows-executor@0.1.0',
    pluginId: 'executor-windows',
    title: 'Restricted Windows Executor',
    executor: 'restricted-windows'
  }),
  'windows-desktop': Object.freeze({
    id: 'restricted-windows-executor@0.1.0',
    pluginId: 'executor-windows',
    title: 'Restricted Windows Executor',
    executor: 'restricted-windows'
  })
});

/** Stable executor id and plugin manifest for the selected platform. */
export function executorDescriptor(env = process.env) {
  const platform = resolvePlatformIdentity(env).platform;
  return EXECUTOR_DESCRIPTORS[platform] ?? EXECUTOR_DESCRIPTORS['windows-desktop'];
}

/** Scenario label stored on feedback. Product platform, not the Node host name. */
export function scenarioPlatform(env = process.env) {
  const platform = resolvePlatformIdentity(env).platform;
  if (platform === 'linux-cli') return 'LINUX';
  if (platform === 'harmonyos-cli' || platform === 'harmonyos') return 'HARMONYOS';
  return 'WINDOWS';
}

export function releaseChannelForPolicy(policy) {
  if (policy === 'CONTROLLED') return 'LINUX_CLI_CONTROLLED';
  if (policy === 'READ_ONLY') return 'LINUX_CLI_READ_ONLY';
  throw new Error('POLICY_CHANNEL_INVALID');
}
