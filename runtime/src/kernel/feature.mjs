import { isLinuxCliPlatform } from '../platform/paths.mjs';

/**
 * Feature gating for the Phase-1 resident kernel.
 *
 * Frozen MVP decisions encoded here:
 *  - default OFF: the kernel only runs when HMCODEX_RESIDENT_KERNEL is truthy;
 *  - Linux-only: the subprocess sandbox boundary is only offered on Linux;
 *  - Node >=24: the resident kernel must run on a modern runtime;
 *  - if the sandbox is unavailable, callers fall back to the discrete
 *    read-only workspace tools instead of failing.
 */

export const RESIDENT_KERNEL_FLAG = 'HMCODEX_RESIDENT_KERNEL';
const SANDBOX_OVERRIDE_FLAG = 'HMCODEX_RESIDENT_KERNEL_SANDBOX';
const MIN_NODE_MAJOR = 24;

const isTruthyFlag = (value) => typeof value === 'string' && ['1', 'true', 'on', 'yes', 'enabled'].includes(value.trim().toLowerCase());
const isFalsyFlag = (value) => typeof value === 'string' && ['0', 'false', 'off', 'no', 'disabled'].includes(value.trim().toLowerCase());

export const isResidentKernelEnabled = (env = process.env) => isTruthyFlag(env?.[RESIDENT_KERNEL_FLAG]);

const nodeMajor = (version = process.version) => {
  const match = /^v?(\d+)\./.exec(String(version ?? ''));
  return match ? Number(match[1]) : 0;
};

export const isSupportedNodeVersion = (version = process.version) => nodeMajor(version) >= MIN_NODE_MAJOR;

/**
 * Detect whether the Phase-1 process sandbox is available. For the MVP the
 * "sandbox" is the resident kernel subprocess itself: a separate Linux process
 * with a restricted environment and no side-effect capabilities. OS-level
 * isolation (namespaces/seccomp) is deferred to Phase-2 when side effects land.
 * An explicit override lets tests force the decision without a platform.
 */
export const detectKernelSandbox = (env = process.env, platform = process.platform) => {
  const override = env?.[SANDBOX_OVERRIDE_FLAG];
  if (isTruthyFlag(override)) return { available: true, reason: 'OVERRIDE_FORCED' };
  if (isFalsyFlag(override)) return { available: false, reason: 'OVERRIDE_DISABLED' };
  if (platform !== 'linux') return { available: false, reason: 'NON_LINUX_PLATFORM' };
  return { available: true, reason: 'LINUX_SUBPROCESS' };
};

/**
 * Resolve the full availability decision. `available` is only true when the
 * feature is enabled, the platform identity is a portable Linux CLI host, the
 * Node runtime is new enough and the sandbox check passes. Every other outcome
 * carries a stable reason so the caller can log why it fell back to discrete
 * tools.
 */
export const residentKernelAvailability = (env = process.env, { platform = process.platform, nodeVersion = process.version } = {}) => {
  const enabled = isResidentKernelEnabled(env);
  const linuxCliIdentity = isLinuxCliPlatform(env);
  const supportedNode = isSupportedNodeVersion(nodeVersion);
  const sandbox = detectKernelSandbox(env, platform);

  let reason = 'AVAILABLE';
  if (!enabled) reason = 'DISABLED';
  else if (!supportedNode) reason = 'NODE_TOO_OLD';
  else if (!linuxCliIdentity) reason = 'NON_LINUX_PLATFORM_IDENTITY';
  else if (!sandbox.available) reason = sandbox.reason;

  const available = enabled && supportedNode && linuxCliIdentity && sandbox.available;
  return {
    available,
    enabled,
    supportedNode,
    linuxCliIdentity,
    sandboxAvailable: sandbox.available,
    reason
  };
};
