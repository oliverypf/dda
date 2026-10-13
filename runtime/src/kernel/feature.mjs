import { isLinuxCliPlatform } from '../platform/paths.mjs';

/**
 * Feature gating for the Phase-1 resident kernel.
 *
 * Frozen MVP decisions encoded here:
 *  - default OFF: the kernel only runs when DDA_RESIDENT_KERNEL is truthy;
 *  - Linux-only OS sandbox boundary (Phase-1 subprocess "sandbox" is Linux);
 *  - Windows `windows-cli` may attach without OS sandbox (Phase-2b follow-on;
 *    sandboxAvailable stays false; not authorization for cells alone);
 *  - Node >=24: the resident kernel must run on a modern runtime;
 *  - if the sandbox is unavailable on Linux, callers fall back to discrete
 *    read-only workspace tools instead of failing.
 */

export const RESIDENT_KERNEL_FLAG = 'DDA_RESIDENT_KERNEL';
const SANDBOX_OVERRIDE_FLAG = 'DDA_RESIDENT_KERNEL_SANDBOX';
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
 * feature is enabled, the platform identity matches, the Node runtime is new
 * enough, and (on Linux) the Phase-1 sandbox check passes.
 *
 * Windows amendment (Phase-2b follow-on): `win32` + `DDA_PLATFORM=windows-cli`
 * may attach without an OS sandbox. `sandboxAvailable` stays false. The
 * `DDA_RESIDENT_KERNEL_SANDBOX` override must not light sandboxAvailable on
 * Windows and is not authorization for Windows cells.
 */
export const residentKernelAvailability = (env = process.env, { platform = process.platform, nodeVersion = process.version } = {}) => {
  const enabled = isResidentKernelEnabled(env);
  const linuxCliIdentity = isLinuxCliPlatform(env);
  const windowsCliIdentity = env?.DDA_PLATFORM === 'windows-cli';
  const supportedNode = isSupportedNodeVersion(nodeVersion);

  // Windows attach path: win32 + windows-cli, no OS sandbox required.
  if (enabled && supportedNode && platform === 'win32' && windowsCliIdentity) {
    return {
      available: true,
      enabled,
      supportedNode,
      linuxCliIdentity: false,
      windowsCliIdentity: true,
      sandboxAvailable: false,
      reason: 'AVAILABLE'
    };
  }

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
    windowsCliIdentity: false,
    sandboxAvailable: sandbox.available,
    reason
  };
};


/** Phase-2b flag names (default OFF). Imported by docs/tests; gating lives in cell-host/sandbox. */
export const KERNEL_CODE_CELLS_FLAG = 'DDA_KERNEL_CODE_CELLS';
export const KERNEL_SANDBOX_FLAG = 'DDA_KERNEL_SANDBOX';
/** Win32-only explicit confirm for unsandboxed cells (Prime-aligned). Default OFF. */
export const KERNEL_WINDOWS_UNSANDBOXED_FLAG = 'DDA_KERNEL_WINDOWS_UNSANDBOXED';
