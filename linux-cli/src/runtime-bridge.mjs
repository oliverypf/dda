import { createInterface } from 'node:readline';
import { createProcessSupervisor } from '../../runtime/src/platform/process-supervisor.mjs';
import { approvalResponse } from './approval.mjs';

const readLines = (stream, onLine) => {
  if (!stream) return { close() {} };
  const reader = createInterface({ input: stream });
  reader.on('line', onLine);
  return reader;
};

/**
 * Start one runtime command in its own process group and return parsed
 * stdout objects. Logging stays on stderr. A second interrupt is handled by
 * the caller through terminateGroup.
 */
export async function runRuntimeCommand({
  supervisor = createProcessSupervisor(),
  executable = process.execPath,
  entry,
  command,
  args = [],
  env,
  cwd,
  timeoutMs,
  onStdout,
  onStderr,
  onReady,
  approvalMode,
  tty = false,
  approvalInput,
  readApprovalLine
} = {}) {
  const record = supervisor.spawn({
    executable,
    argv: [entry, command, ...args],
    env,
    cwd,
    marker: entry
  });
  onReady?.(record);
  const objects = [];
  let protocolError = false;
  let runId;
  let timedOut = false;
  const pending = [];
  let approvalInputClosed = false;
  const writeApproval = (message) => {
    if (!message || !record.child.stdin.writable) return;
    record.child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const deny = (event) => writeApproval(approvalResponse({ request: event, mode: 'deny' }).message);
  const handleApproval = (event) => {
    if (!approvalMode) return;
    if (approvalMode === 'deny') {
      deny(event);
      return;
    }
    if (approvalMode === 'prompt') {
      if (typeof readApprovalLine !== 'function') {
        deny(event);
        return;
      }
      void Promise.resolve(readApprovalLine(event)).then((line) => {
        const decision = approvalResponse({ request: event, mode: 'prompt', tty, input: line ?? 'n' });
        // An unavailable channel (for example no TTY) still answers the
        // runtime with an explicit denial instead of leaving it waiting.
        if (decision.message) writeApproval(decision.message);
        else deny(event);
      }).catch(() => deny(event));
      return;
    }
    // jsonl: wait for a host line. If the host input already ended nobody can
    // answer, so deny now instead of waiting for the approval to expire.
    if (approvalInputClosed) {
      deny(event);
      return;
    }
    pending.push(event);
  };
  const stdoutReader = readLines(record.child.stdout, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      protocolError = true;
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      protocolError = true;
      return;
    }
    if (typeof parsed.runId === 'string') runId = parsed.runId;
    objects.push(parsed);
    const isApproval = parsed.type === 'runtime_event' && parsed.kind === 'approval.requested';
    // Register deny/jsonl handling before the event reaches the host, so a
    // host that answers as soon as it sees the request cannot race it. The
    // terminal prompt is asked after the caller rendered the details.
    if (isApproval && approvalMode !== 'prompt') handleApproval(parsed);
    onStdout?.(parsed);
    if (isApproval && approvalMode === 'prompt') handleApproval(parsed);
  });
  const stderrReader = readLines(record.child.stderr, (line) => onStderr?.(line));
  let approvalReader;
  if (approvalMode === 'jsonl' && approvalInput) {
    approvalReader = readLines(approvalInput, (line) => {
      if (!line.trim()) return;
      let requestId;
      try { requestId = JSON.parse(line)?.requestId; } catch { requestId = undefined; }
      // Answer the request the host named; anything unmatched or malformed
      // fails closed against the oldest pending request.
      const index = pending.findIndex((event) => (event?.payload?.requestId ?? event?.requestId) === requestId);
      const [event] = pending.splice(index === -1 ? 0 : index, 1);
      if (!event) return;
      const decision = approvalResponse({ request: event, mode: 'jsonl', tty, input: line });
      if (decision.message) writeApproval(decision.message);
      else deny(event);
    });
    approvalReader.once?.('close', () => {
      approvalInputClosed = true;
      for (const event of pending.splice(0)) deny(event);
    });
  } else if (approvalMode === 'jsonl') {
    approvalInputClosed = true;
  }
  let timer;
  if (Number.isInteger(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      void supervisor.terminateGroup(record.processId, 200);
    }, timeoutMs);
    timer.unref?.();
  }
  let exitCode = null;
  let signal = null;
  try {
    const result = await supervisor.wait(record.processId);
    exitCode = result.exitCode;
    signal = result.signal;
  } finally {
    if (timer) clearTimeout(timer);
    stdoutReader.close();
    stderrReader.close();
    approvalReader?.close();
    record.child.stdin?.end?.();
  }
  return { supervisor, record, objects, protocolError, runId, timedOut, exitCode, signal };
}
