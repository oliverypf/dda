#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const integer = (value, fallback, minimum, maximum, code) => {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(code);
  return parsed;
};

export const parseOpenVikingSidecarURL = (value = 'http://127.0.0.1:1933') => {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('OPENVIKING_SIDECAR_URL_INVALID');
  }
  if (
    parsed.protocol !== 'http:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
    || !['', '/'].includes(parsed.pathname)
  ) {
    throw new Error('OPENVIKING_SIDECAR_URL_INVALID');
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, '').toLowerCase() === 'localhost'
    ? '127.0.0.1'
    : parsed.hostname.replace(/^\[|\]$/gu, '');
  return {
    url: parsed.toString().replace(/\/$/u, ''),
    host,
    port: Number(parsed.port || 80)
  };
};

const requireFile = async (value, code, statImpl) => {
  if (typeof value !== 'string' || !value.trim() || !isAbsolute(value.trim())) throw new Error(code);
  const path = value.trim();
  let metadata;
  try {
    metadata = await statImpl(path);
  } catch {
    throw new Error(code);
  }
  if (!metadata.isFile()) throw new Error(code);
  return path;
};

export const resolveOpenVikingSidecarConfig = async ({ env = process.env, statImpl = stat, platform = process.platform } = {}) => {
  const executable = await requireFile(env.HMCODEX_OPENVIKING_EXECUTABLE, 'OPENVIKING_SIDECAR_EXECUTABLE_INVALID', statImpl);
  if (platform === 'win32' && extname(executable).toLowerCase() !== '.exe') {
    throw new Error('OPENVIKING_SIDECAR_EXECUTABLE_INVALID');
  }
  const endpoint = parseOpenVikingSidecarURL(env.HMCODEX_OPENVIKING_URL);
  const configPath = env.HMCODEX_OPENVIKING_CONFIG
    ? await requireFile(env.HMCODEX_OPENVIKING_CONFIG, 'OPENVIKING_SIDECAR_CONFIG_INVALID', statImpl)
    : undefined;
  const workingDirectory = env.HMCODEX_OPENVIKING_WORKING_DIR
    ? String(env.HMCODEX_OPENVIKING_WORKING_DIR).trim()
    : dirname(executable);
  if (!isAbsolute(workingDirectory)) throw new Error('OPENVIKING_SIDECAR_WORKDIR_INVALID');
  let workingMetadata;
  try {
    workingMetadata = await statImpl(workingDirectory);
  } catch {
    throw new Error('OPENVIKING_SIDECAR_WORKDIR_INVALID');
  }
  if (!workingMetadata.isDirectory()) throw new Error('OPENVIKING_SIDECAR_WORKDIR_INVALID');
  return {
    executable,
    endpoint,
    configPath,
    workingDirectory,
    startupTimeoutMs: integer(env.HMCODEX_OPENVIKING_START_TIMEOUT_MS, 30000, 1000, 120000, 'OPENVIKING_SIDECAR_START_TIMEOUT_INVALID'),
    healthIntervalMs: integer(env.HMCODEX_OPENVIKING_HEALTH_INTERVAL_MS, 2000, 250, 30000, 'OPENVIKING_SIDECAR_HEALTH_INTERVAL_INVALID'),
    healthFailureThreshold: integer(env.HMCODEX_OPENVIKING_HEALTH_FAILURE_THRESHOLD, 3, 1, 20, 'OPENVIKING_SIDECAR_HEALTH_THRESHOLD_INVALID'),
    maxRestarts: integer(env.HMCODEX_OPENVIKING_MAX_RESTARTS, 3, 0, 20, 'OPENVIKING_SIDECAR_MAX_RESTARTS_INVALID')
  };
};

export const probeOpenVikingReady = async (url, { fetchImpl = globalThis.fetch, timeoutMs = 1000 } = {}) => {
  if (typeof fetchImpl !== 'function') return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${String(url).replace(/\/$/u, '')}/ready`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal
    });
    if (!response.ok) return false;
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > 64 * 1024) return false;
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024) return false;
    const body = JSON.parse(text);
    return body && typeof body === 'object' && body.status === 'ok';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const defaultKillTree = (child) => {
  if (!child || !Number.isInteger(child.pid)) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
  } else {
    child.kill('SIGTERM');
  }
};

/** A bounded supervisor process owned by the Windows desktop host. */
export class OpenVikingSidecarSupervisor {
  #child;
  #config;
  #delay;
  #emit;
  #health;
  #killTree;
  #restartCount = 0;
  #spawn;
  #stopping = false;

  constructor({ config, spawnImpl = spawn, healthImpl = probeOpenVikingReady, delayImpl = delay, killTree = defaultKillTree, emit = () => {} } = {}) {
    if (!config || typeof config !== 'object') throw new Error('OPENVIKING_SIDECAR_CONFIG_REQUIRED');
    this.#config = config;
    this.#spawn = spawnImpl;
    this.#health = healthImpl;
    this.#delay = delayImpl;
    this.#killTree = killTree;
    this.#emit = emit;
  }

  stop() {
    this.#stopping = true;
    if (this.#child) this.#killTree(this.#child);
  }

  #spawnServer() {
    const args = [
      ...(this.#config.configPath ? ['--config', this.#config.configPath] : []),
      '--host', this.#config.endpoint.host,
      '--port', String(this.#config.endpoint.port)
    ];
    const child = this.#spawn(this.#config.executable, args, {
      cwd: this.#config.workingDirectory,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: 'ignore'
    });
    this.#child = child;
    this.#emit({ state: 'STARTING', pid: child.pid, restartCount: this.#restartCount });
    return child;
  }

  async #waitUntilReady(child) {
    const attempts = Math.max(1, Math.ceil(this.#config.startupTimeoutMs / 250));
    for (let attempt = 0; attempt < attempts && !this.#stopping; attempt += 1) {
      if (child.exitCode !== null) return false;
      if (await this.#health(this.#config.endpoint.url)) return true;
      await this.#delay(250);
    }
    return false;
  }

  async run() {
    while (!this.#stopping) {
      const child = this.#spawnServer();
      const ready = await this.#waitUntilReady(child);
      if (this.#stopping) break;
      if (!ready) {
        this.#killTree(child);
        this.#emit({ state: 'UNHEALTHY', pid: child.pid, restartCount: this.#restartCount });
      } else {
        this.#emit({ state: 'READY', pid: child.pid, restartCount: this.#restartCount });
        let failures = 0;
        while (!this.#stopping && child.exitCode === null) {
          await this.#delay(this.#config.healthIntervalMs);
          if (this.#stopping || child.exitCode !== null) break;
          if (await this.#health(this.#config.endpoint.url)) failures = 0;
          else failures += 1;
          if (failures >= this.#config.healthFailureThreshold) {
            this.#killTree(child);
            this.#emit({ state: 'UNHEALTHY', pid: child.pid, restartCount: this.#restartCount });
            break;
          }
        }
      }
      this.#child = undefined;
      if (this.#stopping) break;
      if (this.#restartCount >= this.#config.maxRestarts) {
        throw new Error('OPENVIKING_SIDECAR_RESTART_LIMIT');
      }
      this.#restartCount += 1;
      this.#emit({ state: 'RESTARTING', restartCount: this.#restartCount });
      await this.#delay(Math.min(5000, 250 * (2 ** (this.#restartCount - 1))));
    }
    this.#emit({ state: 'STOPPED', restartCount: this.#restartCount });
  }
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  try {
    const config = await resolveOpenVikingSidecarConfig();
    const supervisor = new OpenVikingSidecarSupervisor({ config });
    process.once('SIGINT', () => supervisor.stop());
    process.once('SIGTERM', () => supervisor.stop());
    await supervisor.run();
  } catch (error) {
    const code = error instanceof Error ? error.message : 'OPENVIKING_SIDECAR_FAILED';
    process.stderr.write(`${/^OPENVIKING_[A-Z0-9_]+$/u.test(code) ? code : 'OPENVIKING_SIDECAR_FAILED'}\n`);
    process.exitCode = 1;
  }
}
