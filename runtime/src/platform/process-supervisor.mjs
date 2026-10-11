import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tracks processes this application started. Reclaim only consults that
 * record and the process command line; it never scans the system process table.
 */
export function createProcessSupervisor({ platform = process.platform, registryPath } = {}) {
  const records = new Map();

  const persist = async () => {
    if (!registryPath) return;
    const snapshot = [...records.values()].map((record) => ({
      processId: record.processId,
      pid: record.pid,
      pgid: record.pgid,
      startedAtMs: record.startedAtMs,
      marker: record.marker,
      commandDigest: record.commandDigest,
      workspace: record.workspace,
      runId: record.runId,
      cancelState: record.cancelState
    }));
    await mkdir(dirname(registryPath), { recursive: true, mode: 0o700 });
    await writeFile(registryPath, `${JSON.stringify({ schemaVersion: '1.0', processes: snapshot })}\n`, { mode: 0o600 });
  };

  return {
    records,
    spawn(spec = {}) {
      if (typeof spec.executable !== 'string' || !spec.executable || !Array.isArray(spec.argv)) {
        throw new Error('PROCESS_SPEC_INVALID');
      }
      const detached = platform !== 'win32';
      const child = spawn(spec.executable, spec.argv, {
        cwd: spec.cwd,
        env: spec.env,
        detached,
        stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false
      });
      const record = {
        processId: spec.processId ?? randomUUID(),
        pid: child.pid,
        pgid: detached ? child.pid : undefined,
        startedAtMs: Date.now(),
        workspace: spec.workspace,
        runId: spec.runId,
        commandDigest: spec.commandDigest,
        timeoutMs: spec.timeoutMs,
        marker: spec.marker,
        cancelState: 'RUNNING',
        child
      };
      records.set(record.processId, record);
      child.once('exit', () => {
        if (record.cancelState === 'RUNNING') record.cancelState = 'EXITED';
      });
      void persist().catch(() => undefined);
      return record;
    },
    async cancel(processId, reason = 'USER_REQUESTED') {
      const record = records.get(processId);
      if (!record) return { ok: false, code: 'PROCESS_NOT_FOUND' };
      record.cancelState = 'CANCEL_REQUESTED';
      record.cancelReason = reason;
      await persist().catch(() => undefined);
      return { ok: true, processId, reason, state: 'UNKNOWN_UNTIL_TERMINAL_EVENT' };
    },
    async terminateGroup(processId, graceMs = 2000) {
      const record = records.get(processId);
      if (!record?.pid) return;
      record.cancelState = 'TERMINATING';
      const pid = record.pid;
      if (platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
        record.child.kill('SIGTERM');
      } else if (!record.pgid) {
        record.child.kill('SIGTERM');
      } else {
        try { process.kill(-pid, 'SIGTERM'); } catch { record.child.kill('SIGTERM'); }
      }
      await Promise.race([
        new Promise((resolve) => record.child.once('exit', resolve)),
        delay(graceMs).then(() => {
          if (platform !== 'win32' && record.pgid) {
            try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
          } else {
            record.child.kill('SIGKILL');
          }
        })
      ]);
      record.cancelState = 'TERMINATED';
      records.delete(processId);
      await persist().catch(() => undefined);
    },
    wait(processId) {
      const record = records.get(processId);
      if (!record) return Promise.reject(new Error('PROCESS_NOT_FOUND'));
      if (record.child.exitCode !== null || record.child.signalCode !== null) {
        return Promise.resolve({ exitCode: record.child.exitCode, signal: record.child.signalCode });
      }
      return new Promise((resolve, reject) => {
        record.child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
        record.child.once('error', reject);
      });
    }
  };
}

async function commandLineIncludes(pid, marker) {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`);
    return raw.includes(marker);
  } catch {
    return false;
  }
}

export async function reclaimRecordedProcesses(registryPath, { graceMs = 500, now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(registryPath, 'utf8'));
  } catch {
    return { reclaimed: [] };
  }
  const processes = Array.isArray(parsed?.processes) ? parsed.processes : [];
  const reclaimed = [];
  for (const record of processes) {
    if (!Number.isInteger(record?.pid) || record.pid <= 1 || typeof record.marker !== 'string' || !record.marker) continue;
    if (!Number.isInteger(record.startedAtMs) || now - record.startedAtMs > maxAgeMs || now + 60_000 < record.startedAtMs) continue;
    if (process.platform === 'win32') continue;
    if (!await commandLineIncludes(record.pid, record.marker)) continue;
    const signalTarget = record.pgid && record.pgid === record.pid ? -record.pid : record.pid;
    try { process.kill(signalTarget, 'SIGTERM'); } catch { continue; }
    await delay(graceMs);
    try { process.kill(signalTarget, 0); process.kill(signalTarget, 'SIGKILL'); } catch { /* exited */ }
    reclaimed.push({ pid: record.pid, processId: record.processId });
  }
  if (reclaimed.length > 0) {
    await writeFile(registryPath, `${JSON.stringify({ schemaVersion: '1.0', processes: [] })}\n`, { mode: 0o600 }).catch(() => undefined);
  }
  return { reclaimed };
}
