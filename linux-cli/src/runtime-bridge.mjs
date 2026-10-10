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
  const writeApproval = (message) => {
    if (!message || !record.child.stdin.writable) return;
    record.child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const handleApproval = (event) => {
    if (!approvalMode) return;
    if (approvalMode === 'deny') {
      writeApproval(approvalResponse({ request: event, mode: 'deny' }).message);
      return;
    }
    if (approvalMode === 'prompt') {
      void Promise.resolve(readApprovalLine?.(event)).then((line) => {
        const decision = approvalResponse({ request: event, mode: 'prompt', tty, input: line ?? 'n' });
        writeApproval(decision.message);
      }).catch(() => writeApproval(approvalResponse({ request: event, mode: 'deny' }).message));
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
    if (parsed.type === 'runtime_event' && parsed.kind === 'approval.requested') handleApproval(parsed);
    onStdout?.(parsed);
  });
  const stderrReader = readLines(record.child.stderr, (line) => onStderr?.(line));
  if (approvalMode === 'jsonl' && approvalInput) {
    readLines(approvalInput, (line) => {
      const event = pending.shift();
      if (!event) return;
      const decision = approvalResponse({ request: event, mode: 'jsonl', tty, input: line });
      writeApproval(decision.message);
    });
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
    record.child.stdin?.end?.();
  }
  return { supervisor, record, objects, protocolError, runId, timedOut, exitCode, signal };
}
