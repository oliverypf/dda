import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';

export const needsProjectTool = name => /^(?:workspace\.|kernel\.workspace_|file\.)/u.test(name)
  || name === 'shell.execute' || name === 'test.execute';

// The parent owns the launch directory and the concurrent worktree lease.
// A reply is accepted only on the task's stdin and for this claim.
export function claimDesktopWorkspace(input, emit, signal) {
  if (!input) throw new Error('WORKSPACE_HOST_UNAVAILABLE');
  signal.throwIfAborted();
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const finish = (error, path) => {
      clearTimeout(timer);
      input.off('line', receive);
      input.off('close', closed);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve(path);
    };
    const aborted = () => finish(signal.reason);
    const closed = () => finish(new Error('WORKSPACE_HOST_UNAVAILABLE'));
    const receive = line => {
      let reply;
      try { reply = JSON.parse(line); } catch { return; }
      if (reply?.type !== 'workspace.claim_result' || reply.requestId !== requestId) return;
      if (typeof reply.path !== 'string' || !isAbsolute(reply.path) || reply.error)
        finish(new Error('WORKSPACE_CLAIM_FAILED:' + String(reply.error ?? 'invalid directory')));
      else finish(undefined, reply.path);
    };
    const timer = setTimeout(() => finish(new Error('WORKSPACE_CLAIM_TIMEOUT')), 120000);
    input.on('line', receive);
    input.once('close', closed);
    signal.addEventListener('abort', aborted, { once: true });
    emit('workspace.claim_requested', { requestId });
  });
}
