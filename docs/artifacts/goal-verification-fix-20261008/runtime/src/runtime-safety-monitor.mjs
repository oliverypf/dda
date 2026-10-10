import { randomUUID, createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalMappedPath, preferMappedPath } from './windows-path.mjs';

/**
 * The safety monitor is the policy boundary for every operation that can
 * change state or start a process.  It is intentionally independent from the
 * model and from Cordis: callers must present a normalized action and an
 * optional one-shot lease before an executor can do anything.
 */
export const EXECUTION_MODES = Object.freeze({ READ_ONLY: 'READ_ONLY', CONTROLLED: 'CONTROLLED' });
export const ACTIONS = Object.freeze({ SHELL: 'shell', WRITE_FILE: 'write_file', TEST: 'test', NETWORK: 'network_request' });
export const CAPABILITIES = Object.freeze({
  SHELL: 'shell.execute',
  WRITE_FILE: 'file.write',
  TEST: 'test.execute',
  NETWORK: 'network.request'
});
export const SAFETY_POLICY_VERSION = 'runtime-safety-1';

export const SAFETY_ERROR_CODES = Object.freeze({
  INVALID_OPTIONS: 'SAFETY_INVALID_OPTIONS',
  READ_ONLY: 'SAFETY_READ_ONLY',
  INVALID_ACTION: 'SAFETY_INVALID_ACTION',
  LEASE_REQUIRED: 'SAFETY_LEASE_REQUIRED',
  LEASE_INVALID: 'SAFETY_LEASE_INVALID',
  LEASE_EXPIRED: 'SAFETY_LEASE_EXPIRED',
  LEASE_USED: 'SAFETY_LEASE_USED',
  CAPABILITY_DENIED: 'SAFETY_CAPABILITY_DENIED',
  COMMAND_REQUIRED: 'SAFETY_COMMAND_REQUIRED',
  COMMAND_INVALID: 'SAFETY_COMMAND_INVALID',
  COMMAND_NOT_ALLOWED: 'SAFETY_COMMAND_NOT_ALLOWED',
  PATH_REQUIRED: 'SAFETY_PATH_REQUIRED',
  PATH_INVALID: 'SAFETY_PATH_INVALID',
  WORKSPACE_REQUIRED: 'SAFETY_WORKSPACE_REQUIRED',
  WORKSPACE_NOT_FOUND: 'SAFETY_WORKSPACE_NOT_FOUND',
  WORKSPACE_PATH_FORBIDDEN: 'SAFETY_WORKSPACE_PATH_FORBIDDEN',
  WORKSPACE_SENSITIVE_PATH: 'SAFETY_WORKSPACE_SENSITIVE_PATH',
  WORKSPACE_GIT_METADATA: 'SAFETY_WORKSPACE_GIT_METADATA',
  WORKSPACE_LINK_FORBIDDEN: 'SAFETY_WORKSPACE_LINK_FORBIDDEN',
  WORKSPACE_PARENT_NOT_FOUND: 'SAFETY_WORKSPACE_PARENT_NOT_FOUND',
  CONTENT_INVALID: 'SAFETY_CONTENT_INVALID',
  CONTENT_TOO_LARGE: 'SAFETY_CONTENT_TOO_LARGE',
  RELEASE_CHANNEL_MISMATCH: 'SAFETY_RELEASE_CHANNEL_MISMATCH',
  NETWORK_REQUIRED: 'SAFETY_NETWORK_REQUIRED',
  NETWORK_INVALID: 'SAFETY_NETWORK_INVALID',
  NETWORK_NOT_ALLOWED: 'SAFETY_NETWORK_NOT_ALLOWED',
  NETWORK_TARGET_FORBIDDEN: 'SAFETY_NETWORK_TARGET_FORBIDDEN',
  NETWORK_RESOLVED_FORBIDDEN: 'SAFETY_NETWORK_RESOLVED_FORBIDDEN',
  NETWORK_REDIRECT_FORBIDDEN: 'SAFETY_NETWORK_REDIRECT_FORBIDDEN',
  NETWORK_BODY_TOO_LARGE: 'SAFETY_NETWORK_BODY_TOO_LARGE',
  NETWORK_CONCURRENCY_LIMIT: 'SAFETY_NETWORK_CONCURRENCY_LIMIT',
  NETWORK_SECRET_REJECTED: 'SAFETY_NETWORK_SECRET_REJECTED',
  WORKSPACE_LEASE_BUSY: 'SAFETY_WORKSPACE_LEASE_BUSY'
});

const DEFAULT_COMMANDS = Object.freeze(['node', 'node.exe', 'npm', 'npm.cmd', 'npx', 'npx.cmd', 'cargo', 'cargo.exe', 'rustc', 'rustc.exe', 'git', 'git.exe']);
const SENSITIVE_PATH = /(^|[\\/])(?:\.env(?:\.[^\\/]+)?|credentials?(?:\.[^\\/]+)?|secrets?(?:\.[^\\/]+)?|tokens?(?:\.[^\\/]+)?|passwords?(?:\.[^\\/]+)?|private(?:\.[^\\/]+)?|id_rsa(?:\.[^\\/]+)?)(?:[\\/]|$)/i;
const SECRET_OUTPUT = [
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|passwd|authorization|bearer)[ \t]*[=:][ \t]*)([^\s,;]+)/gi,
  /(bearer[ \t]+)([^\s]+)/gi,
  /(-----BEGIN [^-]*PRIVATE KEY-----)[\s\S]*?(-----END [^-]*PRIVATE KEY-----)/gi
];
const LEASE_CLAIM = Symbol('hmcodex.policyLeaseClaim');
const LEASE_FACTORY = Symbol('hmcodex.policyLeaseFactory');
const LEASE_OWNER = Symbol('hmcodex.policyLeaseOwner');

const workspaceLeaseKey = (value) => {
  const canonical = canonicalMappedPath(String(value ?? ''));
  const normalized = canonical.replace(/[\\/]+/g, '\\');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

export class WorkspaceLeaseRegistry {
  #entries = new Map();
  #lockDirectory;

  constructor({ lockDirectory = join(tmpdir(), 'hmcodex-workspace-leases') } = {}) {
    if (typeof lockDirectory !== 'string' || !lockDirectory.trim()) {
      throw new SafetyError(SAFETY_ERROR_CODES.INVALID_OPTIONS, 'lockDirectory');
    }
    this.#lockDirectory = resolve(lockDirectory);
  }

  #lockPath(workspaceRoot) {
    const key = workspaceLeaseKey(workspaceRoot);
    const fingerprint = createHash('sha256').update(key, 'utf8').digest('hex');
    return join(this.#lockDirectory, `workspace-${fingerprint}.lock`);
  }

  #readLock(path) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed?.leaseId !== 'string' || !Number.isFinite(parsed?.expiresAt)) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  acquire(workspaceRoot, leaseId, expiresAt) {
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new SafetyError(SAFETY_ERROR_CODES.INVALID_OPTIONS, 'expiresAt');
    }
    const key = workspaceLeaseKey(workspaceRoot);
    const path = this.#lockPath(workspaceRoot);
    const active = this.#entries.get(key);
    if (active && active.expiresAt > Date.now() && active.leaseId !== leaseId) {
      throw new SafetyError(SAFETY_ERROR_CODES.WORKSPACE_LEASE_BUSY);
    }
    mkdirSync(this.#lockDirectory, { recursive: true });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let descriptor;
      try {
        descriptor = openSync(path, 'wx');
        writeFileSync(descriptor, JSON.stringify({ leaseId, expiresAt }), { encoding: 'utf8' });
        this.#entries.set(key, { leaseId, expiresAt });
        return;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = this.#readLock(path);
        if (existing && existing.expiresAt > Date.now() && existing.leaseId !== leaseId) {
          throw new SafetyError(SAFETY_ERROR_CODES.WORKSPACE_LEASE_BUSY);
        }
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          if (unlinkError?.code !== 'ENOENT') throw unlinkError;
        }
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    throw new SafetyError(SAFETY_ERROR_CODES.WORKSPACE_LEASE_BUSY);
  }

  release(workspaceRoot, leaseId) {
    const key = workspaceLeaseKey(workspaceRoot);
    const path = this.#lockPath(workspaceRoot);
    const existing = this.#readLock(path);
    if (existing?.leaseId === leaseId) {
      try {
        unlinkSync(path);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    const active = this.#entries.get(key);
    if (active?.leaseId === leaseId) this.#entries.delete(key);
  }

  active(workspaceRoot) {
    const path = this.#lockPath(workspaceRoot);
    const active = this.#readLock(path) ?? this.#entries.get(workspaceLeaseKey(workspaceRoot));
    return active && active.expiresAt > Date.now() ? { ...active } : undefined;
  }
}

const fail = (code, message = '') => {
  throw new SafetyError(code, message);
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = (value) => `sha256:${createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
const contractPath = (value) => value.split(sep).join('/');
const inside = (root, candidate) => {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('..'));
};
const mappedRealpath = async (value) => preferMappedPath(await realpath(value));
const isGitMetadataPath = (value) => value === '.git' || value.startsWith('.git/') || value.startsWith(`.git${sep}`);
const rejectGitMetadata = (value) => {
  if (isGitMetadataPath(value)) fail(SAFETY_ERROR_CODES.WORKSPACE_GIT_METADATA);
};
const rejectLinkChain = async (candidate, root) => {
  let current = candidate;
  while (inside(root, current)) {
    const metadata = await lstat(current).catch(() => null);
    if (metadata?.isSymbolicLink()) fail(SAFETY_ERROR_CODES.WORKSPACE_LINK_FORBIDDEN);
    if (current === root) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
};

export class SafetyError extends Error {
  constructor(code, message = '') {
    super(message ? `${code}:${message}` : code);
    this.name = 'SafetyError';
    this.code = code;
  }
}

const normalizeAction = (action) => {
  if (action === ACTIONS.SHELL || action === 'shell.execute') return ACTIONS.SHELL;
  if (action === ACTIONS.WRITE_FILE || action === 'file.write' || action === 'write-file') return ACTIONS.WRITE_FILE;
  if (action === ACTIONS.TEST || action === 'test.execute' || action === 'test.execute.run') return ACTIONS.TEST;
  if (action === ACTIONS.NETWORK || action === 'network.request') return ACTIONS.NETWORK;
  fail(SAFETY_ERROR_CODES.INVALID_ACTION);
};

const capabilityFor = (action) => action === ACTIONS.SHELL ? CAPABILITIES.SHELL
  : action === ACTIONS.WRITE_FILE ? CAPABILITIES.WRITE_FILE
    : action === ACTIONS.TEST ? CAPABILITIES.TEST : CAPABILITIES.NETWORK;

const normalizeCapability = (value) => value === ACTIONS.SHELL ? CAPABILITIES.SHELL
  : value === ACTIONS.WRITE_FILE ? CAPABILITIES.WRITE_FILE
    : value === ACTIONS.TEST ? CAPABILITIES.TEST
      : value === ACTIONS.NETWORK || value === 'network' ? CAPABILITIES.NETWORK : value;

const normalizeStringList = (value, name, { allowWildcard = false } = {}) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 256 || /[\u0000-\u001f\u007f]/u.test(item))) {
    fail(SAFETY_ERROR_CODES.INVALID_OPTIONS, `${name} must be a list of short strings`);
  }
  if (!allowWildcard && value.some((item) => item === '*')) fail(SAFETY_ERROR_CODES.INVALID_OPTIONS, `${name} cannot contain wildcard`);
  return [...new Set(value.map((item) => item.toLowerCase()))];
};

const normalizeRelativePath = (value, { allowEmpty = false } = {}) => {
  if (allowEmpty && ['', '.', './', '.\\'].includes(value)) return '';
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || value.includes('\0') || isAbsolute(value)) {
    fail(value === '' ? SAFETY_ERROR_CODES.PATH_REQUIRED : SAFETY_ERROR_CODES.PATH_INVALID);
  }
  const normalized = value.replace(/[\\/]+/g, sep);
  const parts = normalized.split(sep).filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..' || part.includes(':'))) fail(SAFETY_ERROR_CODES.PATH_INVALID);
  return parts.join(sep);
};

const commandBase = (command) => basename(command).toLowerCase();
const commandMatches = (set, name) => {
  if (set.has(name)) return true;
  const stem = name.replace(/\.(?:exe|cmd)$/i, '');
  return set.has(stem) || set.has(`${stem}.exe`) || set.has(`${stem}.cmd`);
};

const parseCommand = (request) => {
  if (!isObject(request)) fail(SAFETY_ERROR_CODES.COMMAND_REQUIRED);
  let command = request.command;
  let args = request.args;
  if (typeof command !== 'string' || !command.trim() || command.length > 4096) fail(SAFETY_ERROR_CODES.COMMAND_REQUIRED);
  // Accept a small quoted command-line grammar, but execute with shell:false.
  if (args === undefined) {
    const tokens = command.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s]+/g) ?? [];
    if (!tokens.length) fail(SAFETY_ERROR_CODES.COMMAND_REQUIRED);
    const unquote = (token) => (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))
      ? token.slice(1, -1) : token;
    command = unquote(tokens.shift());
    args = tokens.map(unquote);
  }
  if (typeof command !== 'string' || !command || command.includes('\0') || /[\u0000-\u001f\u007f]/u.test(command)) fail(SAFETY_ERROR_CODES.COMMAND_INVALID);
  if (!Array.isArray(args) || args.length > 128 || args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) {
    fail(SAFETY_ERROR_CODES.COMMAND_INVALID);
  }
  return { command, args: [...args], commandName: commandBase(command) };
};

const sanitizeOutput = (value) => {
  let output = String(value ?? '');
  for (const pattern of SECRET_OUTPUT) {
    output = output.replace(pattern, (_match, prefix, secret) => `${prefix}[REDACTED]`);
  }
  return output;
};

export const boundOutput = (value, { maxOutputBytes = 64 * 1024, maxOutputChars = 64 * 1024 } = {}) => {
  const sanitized = sanitizeOutput(value);
  const byChars = sanitized.slice(0, maxOutputChars);
  const bytes = Buffer.byteLength(byChars, 'utf8');
  if (bytes <= maxOutputBytes && sanitized.length <= maxOutputChars) return { text: byChars, truncated: false };
  let text = byChars;
  while (Buffer.byteLength(text, 'utf8') > maxOutputBytes) text = text.slice(0, -1);
  return { text, truncated: true };
};

export const isPrivateNetworkAddress = (value) => {
  const address = String(value ?? '').trim().toLowerCase();
  if (!address) return false;
  if (address === '::1' || address === '::') return true;
  if (/^f[c-d][0-9a-f]{2}:/u.test(address) || /^fe[89ab][0-9a-f]:/u.test(address)) return true;
  const mapped = address.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u);
  const ipv4 = mapped ? mapped[1] : address;
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(ipv4)) return false;
  const [first, second] = ipv4.split('.').map(Number);
  return first === 0 || first === 10 || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0)
    || (first === 192 && second === 168)
    || (first === 198 && (second === 18 || second === 19))
    || first >= 224;
};

const NETWORK_HOSTNAME = /^[a-z0-9._-]+$/u;
const NETWORK_IPV6_LITERAL = /^[0-9a-f:.]+$/u;
const NETWORK_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const NETWORK_FORBIDDEN_HEADERS = /^(?:host|content-length|connection|authorization|cookie|proxy-authorization|transfer-encoding|upgrade)$/iu;

const containsSecret = (value) => SECRET_OUTPUT.some((pattern) => {
  pattern.lastIndex = 0;
  return pattern.test(value);
});

const failNetwork = (code, message = '') => fail(code, message);

const normalizeNetworkHost = (value) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 253 || value.includes('\0') || /[\s/\\@?#]/u.test(value)) {
    failNetwork(SAFETY_ERROR_CODES.NETWORK_REQUIRED, 'host');
  }
  const host = value.toLowerCase();
  if (!NETWORK_HOSTNAME.test(host) && !NETWORK_IPV6_LITERAL.test(host)) {
    failNetwork(SAFETY_ERROR_CODES.NETWORK_INVALID, 'host');
  }
  return host;
};

const normalizeNetworkPort = (value, scheme) => {
  if (value === undefined) return scheme === 'http' ? 80 : 443;
  if (!Number.isInteger(value) || value < 1 || value > 65535) failNetwork(SAFETY_ERROR_CODES.NETWORK_INVALID, 'port');
  return value;
};

const normalizeNetworkScheme = (value) => {
  if (value === undefined) return 'https';
  if (value !== 'https' && value !== 'http') failNetwork(SAFETY_ERROR_CODES.NETWORK_INVALID, 'scheme');
  return value;
};

const normalizeNetworkMethod = (value) => {
  if (value === undefined) return 'GET';
  if (typeof value !== 'string' || !NETWORK_METHODS.includes(value.toUpperCase())) {
    failNetwork(SAFETY_ERROR_CODES.NETWORK_INVALID, 'method');
  }
  return value.toUpperCase();
};

const normalizeNetworkPath = (value) => {
  if (value === undefined || value === '') return '/';
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048
    || /[\s\u0000-\u001f\u007f]/u.test(value)) failNetwork(SAFETY_ERROR_CODES.NETWORK_INVALID, 'path');
  return value;
};

const normalizeNetworkTargets = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) failNetwork(SAFETY_ERROR_CODES.INVALID_OPTIONS, 'networkTargets');
  return value.map((target) => {
    if (!isObject(target)) failNetwork(SAFETY_ERROR_CODES.INVALID_OPTIONS, 'networkTargets');
    const host = normalizeNetworkHost(target.host);
    const scheme = normalizeNetworkScheme(target.scheme);
    const port = normalizeNetworkPort(target.port, scheme);
    const methods = target.methods === undefined
      ? ['GET', 'HEAD']
      : (Array.isArray(target.methods) && target.methods.length && target.methods.length <= NETWORK_METHODS.length
        ? [...new Set(target.methods.map(normalizeNetworkMethod))]
        : failNetwork(SAFETY_ERROR_CODES.INVALID_OPTIONS, 'networkTargets.methods'));
    return { host, port, scheme, methods };
  });
};

const networkTargetAllows = (targets, request) => targets.some((target) => target.host === request.host
  && (target.port === undefined || target.port === request.port)
  && (target.scheme === undefined || target.scheme === request.scheme)
  && target.methods.includes(request.method));

const parseNetworkRequest = (request, { maxBodyBytes }) => {
  if (!isObject(request)) failNetwork(SAFETY_ERROR_CODES.NETWORK_REQUIRED);
  const host = normalizeNetworkHost(request.host);
  const scheme = normalizeNetworkScheme(request.scheme);
  const port = normalizeNetworkPort(request.port, scheme);
  const method = normalizeNetworkMethod(request.method);
  const path = normalizeNetworkPath(request.path);
  if (isPrivateNetworkAddress(host)) failNetwork(SAFETY_ERROR_CODES.NETWORK_TARGET_FORBIDDEN, host);
  const headers = request.headers === undefined ? undefined : (() => {
    if (!isObject(request.headers) || Object.keys(request.headers).length > 16) {
      failNetwork(SAFETY_ERROR_CODES.NETWORK_INVALID, 'headers');
    }
    return Object.fromEntries(Object.entries(request.headers).map(([key, value]) => {
      if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/iu.test(key) || NETWORK_FORBIDDEN_HEADERS.test(key)
        || typeof value !== 'string' || value.length > 4096 || /[\r\n\u0000-\u001f\u007f]/u.test(value)) {
        failNetwork(SAFETY_ERROR_CODES.NETWORK_INVALID, 'headers');
      }
      return [key, value];
    }));
  })();
  if (request.body === undefined) return { host, port, scheme, method, path, headers };
  if (typeof request.body !== 'string' || request.body.includes('\0')
    || Buffer.byteLength(request.body, 'utf8') > maxBodyBytes) {
    failNetwork(SAFETY_ERROR_CODES.NETWORK_BODY_TOO_LARGE);
  }
  if (containsSecret(request.body)) failNetwork(SAFETY_ERROR_CODES.NETWORK_SECRET_REJECTED);
  return { host, port, scheme, method, path, headers, body: request.body };
};

export class PolicyLease {
  #id;
  #capabilities;
  #commands;
  #expiresAt;
  #releaseChannel;
  #used = false;
  #networkTargets = [];
  #workspaceRoot;
  #workspaceLeaseRegistry;
  #workspaceReleased = false;

  constructor({
    capabilities, commands, networkTargets, expiresAt, monitorId, releaseChannel, id,
    workspaceRoot, workspaceLeaseRegistry, [LEASE_FACTORY]: factory
  } = {}) {
    if (factory !== LEASE_FACTORY) fail(SAFETY_ERROR_CODES.LEASE_INVALID);
    this.#id = typeof id === 'string' && id ? id : `lease-${randomUUID()}`;
    this.#capabilities = new Set(capabilities);
    this.#commands = new Set(commands);
    this.#networkTargets = normalizeNetworkTargets(networkTargets);
    this.#expiresAt = expiresAt;
    this.#monitorId = monitorId;
    this.#releaseChannel = typeof releaseChannel === 'string' && releaseChannel.trim()
      ? releaseChannel.trim().slice(0, 80)
      : 'WINDOWS_MVP_PRE_PHASE1';
    this.#workspaceRoot = workspaceRoot;
    this.#workspaceLeaseRegistry = workspaceLeaseRegistry instanceof WorkspaceLeaseRegistry ? workspaceLeaseRegistry : undefined;
  }

  #monitorId;

  get id() { return this.#id; }
  get expiresAt() { return this.#expiresAt; }
  get consumed() { return this.#used; }
  get capabilities() { return [...this.#capabilities]; }
  get commands() { return [...this.#commands]; }
  get networkTargets() { return clone(this.#networkTargets); }
  get releaseChannel() { return this.#releaseChannel; }

  allows(capability, commandName = undefined) {
    if (!this.#capabilities.has(capability)) return false;
    if (commandName === undefined) return true;
    return this.#commands.size === 0 || this.#commands.has('*') || commandMatches(this.#commands, commandName.toLowerCase());
  }

  allowsNetworkTarget(request) {
    return networkTargetAllows(this.#networkTargets, request);
  }

  [LEASE_OWNER](monitorId) {
    return this.#monitorId === monitorId;
  }

  [LEASE_CLAIM](capability, commandName = undefined) {
    if (this.#used) fail(SAFETY_ERROR_CODES.LEASE_USED);
    if (Date.now() >= this.#expiresAt) fail(SAFETY_ERROR_CODES.LEASE_EXPIRED);
    if (!this.allows(capability, commandName)) fail(SAFETY_ERROR_CODES.CAPABILITY_DENIED);
    this.#used = true;
    return { id: this.#id, expiresAt: this.#expiresAt, releaseChannel: this.#releaseChannel };
  }

  toJSON() {
    return { id: this.#id, expiresAt: this.#expiresAt, consumed: this.#used, capabilities: this.capabilities };
  }

  releaseWorkspace() {
    if (this.#workspaceReleased) return;
    this.#workspaceReleased = true;
    this.#workspaceLeaseRegistry?.release(this.#workspaceRoot, this.#id);
  }
}

export class RuntimeSafetyMonitor {
  #id = `monitor-${randomUUID()}`;
  #mode;
  #workspaceRoot;
  #allowedCommands;
  #maxFileBytes;
  #maxOutputBytes;
  #maxOutputChars;
  #maxLeaseMs;
  #releaseChannel;
  #networkTargets;
  #workspaceLeaseRegistry;

  constructor(options = {}) {
    if (!isObject(options)) fail(SAFETY_ERROR_CODES.INVALID_OPTIONS);
    this.#mode = options.mode === undefined ? EXECUTION_MODES.READ_ONLY : options.mode;
    if (!Object.values(EXECUTION_MODES).includes(this.#mode)) fail(SAFETY_ERROR_CODES.INVALID_OPTIONS, 'mode');
    this.#workspaceRoot = options.workspaceRoot ? resolve(String(options.workspaceRoot)) : undefined;
    this.#releaseChannel = typeof options.releaseChannel === 'string' && options.releaseChannel.trim()
      ? options.releaseChannel.trim().slice(0, 80)
      : 'WINDOWS_MVP_PRE_PHASE1';
    const allowlist = options.commandAllowlist ?? options.allowedCommands ?? DEFAULT_COMMANDS;
    if (Array.isArray(allowlist)) {
      const commands = normalizeStringList(allowlist, 'commandAllowlist');
      this.#allowedCommands = { shell: new Set(commands), test: new Set(commands) };
    } else if (isObject(allowlist)) {
      this.#allowedCommands = {
        shell: new Set(normalizeStringList(allowlist.shell ?? allowlist['shell.execute'], 'shell commands')),
        test: new Set(normalizeStringList(allowlist.test ?? allowlist['test.execute'], 'test commands'))
      };
    } else {
      fail(SAFETY_ERROR_CODES.INVALID_OPTIONS, 'commandAllowlist');
    }
    this.#networkTargets = normalizeNetworkTargets(options.networkTargets);
    this.#workspaceLeaseRegistry = options.workspaceLeaseRegistry instanceof WorkspaceLeaseRegistry
      ? options.workspaceLeaseRegistry
      : undefined;
    this.#maxFileBytes = Number.isInteger(options.maxFileBytes) ? options.maxFileBytes : 1024 * 1024;
    this.#maxOutputBytes = Number.isInteger(options.maxOutputBytes) ? options.maxOutputBytes : 64 * 1024;
    this.#maxOutputChars = Number.isInteger(options.maxOutputChars) ? options.maxOutputChars : 64 * 1024;
    this.#maxLeaseMs = Number.isInteger(options.maxLeaseMs) ? options.maxLeaseMs : 5 * 60 * 1000;
    if (this.#maxFileBytes < 1 || this.#maxOutputBytes < 1 || this.#maxOutputChars < 1 || this.#maxLeaseMs < 1) fail(SAFETY_ERROR_CODES.INVALID_OPTIONS, 'limits');
  }

  get mode() { return this.#mode; }
  get workspaceRoot() { return this.#workspaceRoot; }
  get policyVersion() { return SAFETY_POLICY_VERSION; }
  get releaseChannel() { return this.#releaseChannel; }
  get limits() { return Object.freeze({ maxFileBytes: this.#maxFileBytes, maxOutputBytes: this.#maxOutputBytes, maxOutputChars: this.#maxOutputChars }); }
  get networkTargets() { return clone(this.#networkTargets); }

  issueLease(options = {}) {
    if (this.#mode !== EXECUTION_MODES.CONTROLLED) fail(SAFETY_ERROR_CODES.READ_ONLY);
    if (!isObject(options)) fail(SAFETY_ERROR_CODES.INVALID_OPTIONS);
    const capabilities = normalizeStringList(options.capabilities ?? options.actions, 'capabilities').map(normalizeCapability);
    if (!capabilities.length || capabilities.some((capability) => !Object.values(CAPABILITIES).includes(capability))) fail(SAFETY_ERROR_CODES.INVALID_OPTIONS, 'capabilities');
    const commands = normalizeStringList(options.commands ?? options.commandAllowlist, 'commands', { allowWildcard: true });
    const networkTargets = normalizeNetworkTargets(options.networkTargets);
    const ttl = options.ttlMs ?? options.expiresInMs ?? 60 * 1000;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > this.#maxLeaseMs) fail(SAFETY_ERROR_CODES.INVALID_OPTIONS, 'ttlMs');
    const expiresAt = Date.now() + ttl;
    if (this.#workspaceLeaseRegistry && capabilities.some((capability) => capability !== CAPABILITIES.NETWORK)) {
      const leaseId = `lease-${randomUUID()}`;
      this.#workspaceLeaseRegistry.acquire(this.#workspaceRoot, leaseId, expiresAt);
      return new PolicyLease({
        capabilities,
        commands,
        networkTargets,
        expiresAt,
        monitorId: this.#id,
        releaseChannel: this.#releaseChannel,
        id: leaseId,
        workspaceRoot: this.#workspaceRoot,
        workspaceLeaseRegistry: this.#workspaceLeaseRegistry,
        [LEASE_FACTORY]: LEASE_FACTORY
      });
    }
    return new PolicyLease({
      capabilities,
      commands,
      networkTargets,
      expiresAt,
      monitorId: this.#id,
      releaseChannel: this.#releaseChannel,
      [LEASE_FACTORY]: LEASE_FACTORY
    });
  }

  async canonicalPath(value, { allowEmpty = false, forWrite = false } = {}) {
    if (!this.#workspaceRoot) fail(SAFETY_ERROR_CODES.WORKSPACE_REQUIRED);
    const root = await mappedRealpath(this.#workspaceRoot).catch(() => { throw new SafetyError(SAFETY_ERROR_CODES.WORKSPACE_NOT_FOUND); });
    const rootMetadata = await stat(root).catch(() => null);
    if (!rootMetadata?.isDirectory()) fail(SAFETY_ERROR_CODES.WORKSPACE_NOT_FOUND);
    const normalized = normalizeRelativePath(value, { allowEmpty });
    const candidate = resolve(root, normalized || '.');
    if (!inside(root, candidate)) fail(SAFETY_ERROR_CODES.WORKSPACE_PATH_FORBIDDEN);
    const relativeCandidate = contractPath(relative(root, candidate));
    rejectGitMetadata(relativeCandidate);
    if (SENSITIVE_PATH.test(relativeCandidate)) fail(SAFETY_ERROR_CODES.WORKSPACE_SENSITIVE_PATH);
    await rejectLinkChain(candidate, root);
    const existing = await mappedRealpath(candidate).catch(() => null);
    if (existing) {
      if (!inside(root, existing)) fail(SAFETY_ERROR_CODES.WORKSPACE_PATH_FORBIDDEN);
      const metadata = await stat(existing).catch(() => null);
      if (!metadata) fail(SAFETY_ERROR_CODES.WORKSPACE_PATH_FORBIDDEN);
      const existingPath = contractPath(relative(root, existing));
      rejectGitMetadata(existingPath);
      if (SENSITIVE_PATH.test(existingPath)) fail(SAFETY_ERROR_CODES.WORKSPACE_SENSITIVE_PATH);
      return { root, path: existingPath, absolutePath: existing, exists: true, metadata };
    }
    if (!forWrite) fail(SAFETY_ERROR_CODES.WORKSPACE_PATH_FORBIDDEN);
    // A dangling link has no realpath, but writeFile would still follow it.
    // Reject links at the lexical target before allowing creation.
    const linkMetadata = await lstat(candidate).catch(() => null);
    if (linkMetadata?.isSymbolicLink()) fail(SAFETY_ERROR_CODES.WORKSPACE_LINK_FORBIDDEN);
    const parent = await mappedRealpath(dirname(candidate)).catch(() => null);
    if (!parent || !inside(root, parent)) fail(SAFETY_ERROR_CODES.WORKSPACE_PARENT_NOT_FOUND);
    return { root, path: relativeCandidate, absolutePath: candidate, exists: false, parent };
  }

  async authorize(action, request = {}, lease = undefined) {
    const normalizedAction = normalizeAction(action);
    if (this.#mode !== EXECUTION_MODES.CONTROLLED) fail(SAFETY_ERROR_CODES.READ_ONLY);
    // Controlled mode is an explicit elevation, but it is still not enough by
    // itself: every state-changing or process-starting operation needs a
    // one-shot lease so the caller can audit exactly what was approved.
    if (!(lease instanceof PolicyLease) || !lease[LEASE_OWNER](this.#id)) fail(SAFETY_ERROR_CODES.LEASE_REQUIRED);
    if (lease.releaseChannel !== this.#releaseChannel) fail(SAFETY_ERROR_CODES.RELEASE_CHANNEL_MISMATCH);
    if (normalizedAction === ACTIONS.WRITE_FILE) {
      const path = await this.canonicalPath(request.path, { forWrite: true });
      if (typeof request.content !== 'string') fail(SAFETY_ERROR_CODES.CONTENT_INVALID);
      if (Buffer.byteLength(request.content, 'utf8') > this.#maxFileBytes) fail(SAFETY_ERROR_CODES.CONTENT_TOO_LARGE);
      const claim = lease[LEASE_CLAIM](CAPABILITIES.WRITE_FILE);
      return { action: normalizedAction, capability: CAPABILITIES.WRITE_FILE, path, lease: claim };
    }
    if (normalizedAction === ACTIONS.NETWORK) {
      const target = parseNetworkRequest(request, { maxBodyBytes: this.#maxFileBytes });
      if (!networkTargetAllows(this.#networkTargets, target) || !lease.allowsNetworkTarget(target)) {
        fail(SAFETY_ERROR_CODES.NETWORK_NOT_ALLOWED);
      }
      const claim = lease[LEASE_CLAIM](CAPABILITIES.NETWORK);
      return { action: normalizedAction, capability: CAPABILITIES.NETWORK, target, lease: claim };
    }
    const command = parseCommand(request);
    const allowed = commandMatches(this.#allowedCommands[normalizedAction], command.commandName);
    let claim;
    if (!allowed && !lease.allows(capabilityFor(normalizedAction), command.commandName)) {
      fail(SAFETY_ERROR_CODES.COMMAND_NOT_ALLOWED);
    }
    // A supplied lease always has one-shot semantics, including allowlisted
    // commands. A lease with an empty command list is an explicit wildcard.
    claim = lease[LEASE_CLAIM](capabilityFor(normalizedAction), command.commandName);
    const cwd = request.cwd === undefined ? await this.canonicalPath('', { allowEmpty: true }) : await this.canonicalPath(request.cwd, { allowEmpty: true });
    return { action: normalizedAction, capability: capabilityFor(normalizedAction), command, cwd, lease: claim };
  }
}

export { commandBase, parseCommand, sanitizeOutput, digest };
