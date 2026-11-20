import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Side-channel liveness for the desktop supervisor. Stdout heartbeats stay on
// the main thread because callers and tests read them as runtime events. A
// worker thread cannot reliably inherit a piped stderr on Windows, so this is
// a tiny child process: its event loop keeps writing while the task thread is
// blocked inside synchronous work.
export function startProcessHeartbeat(intervalMs = 2000) {
  const period = Number(intervalMs);
  const safePeriod = Number.isFinite(period)
    ? Math.max(250, Math.min(10_000, Math.trunc(period)))
    : 2000;
  const child = spawn(process.execPath, [
    fileURLToPath(new URL('./heartbeat-worker.mjs', import.meta.url)),
    String(safePeriod)
  ], {
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true
  });
  child.unref();
  child.on('error', () => {});
  return child;
}
