import { createInterface } from 'node:readline';

/**
 * Build the approval IO that bin/dda.mjs hands to main(). The terminal reader
 * is created lazily, so commands that never ask for approval never touch
 * stdin and the process can exit as soon as the runtime finishes.
 *
 * - readApprovalLine(event) asks one y/N question on the terminal. Questions
 *   are answered one at a time in request order. EOF or a closed terminal
 *   answers "n", so a missing human never turns into an approval.
 * - approvalInput is the stream `--approval-mode jsonl` reads approval
 *   responses from (stdin by default).
 */
export function createStdioApprovalIO({ stdin = process.stdin, stderr = process.stderr } = {}) {
  let reader;
  let closed = false;
  let queue = Promise.resolve();
  const waiting = new Set();

  const ensureReader = () => {
    if (closed) return undefined;
    if (reader) return reader;
    reader = createInterface({ input: stdin, output: stderr, terminal: Boolean(stdin?.isTTY && stderr?.isTTY) });
    reader.once('close', () => {
      closed = true;
      reader = undefined;
      for (const resolve of waiting) resolve('n');
      waiting.clear();
    });
    return reader;
  };

  const ask = () => new Promise((resolve) => {
    const active = ensureReader();
    if (!active) {
      resolve('n');
      return;
    }
    waiting.add(resolve);
    try {
      active.question('批准这次操作？[y/N] ', (answer) => {
        waiting.delete(resolve);
        resolve(typeof answer === 'string' ? answer : 'n');
      });
    } catch {
      waiting.delete(resolve);
      resolve('n');
    }
  });

  return {
    approvalInput: stdin,
    stdin,
    readApprovalLine() {
      const next = queue.then(ask, ask);
      queue = next.catch(() => undefined);
      return next;
    },
    close() {
      closed = true;
      reader?.close();
      reader = undefined;
      for (const resolve of waiting) resolve('n');
      waiting.clear();
    }
  };
}
