import { writeSync } from 'node:fs';

// Standalone process. The parent task inherits its stderr pipe to us so the
// desktop supervisor can see this beat even when the task's main thread is
// blocked. A worker thread cannot be used here: on Windows its inherited
// stderr does not reach a piped parent fd.
const requested = Number(process.argv[2]);
const intervalMs = Number.isFinite(requested)
  ? Math.max(250, Math.min(10_000, Math.trunc(requested)))
  : 2000;

const timer = setInterval(() => {
  const line = `{"type":"runtime_heartbeat","emittedAtMs":${Date.now()}}\n`;
  try {
    writeSync(2, line);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code === 'EPIPE' || code === 'EBADF') {
      clearInterval(timer);
      process.exit(0);
    }
  }
}, intervalMs);
