import { readFile } from 'node:fs/promises';

/**
 * Resolve the task prompt from --prompt / --prompt-file / stdin per
 * SCRIPTABLE-CLI-GAPS-R3. Does not pass the prompt on the runtime child's stdin.
 *
 * @returns {{ ok: true, prompt: string, approvalMode?: string }
 *   | { ok: false, code: string }}
 */
export async function resolveTaskPrompt({
  options,
  executionMode,
  approvalTTY,
  stdin,
  stdinIsTTY,
  readStdin
}) {
  const hasPromptFlag = options.prompt !== undefined;
  const hasFileFlag = options.promptFile !== undefined;
  if (hasPromptFlag && hasFileFlag) {
    return { ok: false, code: 'ARGUMENT_INVALID' };
  }

  let approvalMode;
  if (executionMode === 'CONTROLLED') {
    approvalMode = options.approvalMode ?? (approvalTTY ? 'prompt' : undefined);
  }

  if (hasFileFlag) {
    const path = options.promptFile;
    if (typeof path !== 'string' || !path.trim()) {
      return { ok: false, code: 'ARGUMENT_INVALID' };
    }
    let raw;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return { ok: false, code: 'ARGUMENT_INVALID' };
    }
    // Optional nit: drop a single trailing newline.
    if (raw.endsWith('\n')) raw = raw.slice(0, -1);
    if (!raw.trim()) return { ok: false, code: 'ARGUMENT_INVALID' };
    return { ok: true, prompt: raw, approvalMode };
  }

  if (hasPromptFlag) {
    if (!options.prompt?.trim()) return { ok: false, code: 'PROMPT_REQUIRED' };
    return { ok: true, prompt: options.prompt, approvalMode };
  }

  // Neither --prompt nor --prompt-file.
  const mode = executionMode === 'CONTROLLED' ? approvalMode : undefined;
  const denyOrReadOnly =
    executionMode === 'READ_ONLY' || (executionMode === 'CONTROLLED' && mode === 'deny');

  if (denyOrReadOnly) {
    if (stdinIsTTY) return { ok: false, code: 'PROMPT_REQUIRED' };
    const text = await readStdin(stdin);
    if (!text.trim()) return { ok: false, code: 'PROMPT_REQUIRED' };
    return { ok: true, prompt: text, approvalMode };
  }

  if (executionMode === 'CONTROLLED' && mode === 'jsonl') {
    if (!stdinIsTTY) return { ok: false, code: 'ARGUMENT_INVALID' };
    return { ok: false, code: 'PROMPT_REQUIRED' };
  }

  if (executionMode === 'CONTROLLED' && mode === 'prompt' && approvalTTY) {
    return { ok: false, code: 'PROMPT_REQUIRED' };
  }

  // CONTROLLED with unset mode or prompt when stdin+stderr are not both TTYs.
  if (executionMode === 'CONTROLLED' && (mode === undefined || mode === 'prompt') && !approvalTTY) {
    return { ok: false, code: 'APPROVAL_UNAVAILABLE' };
  }

  return { ok: false, code: 'PROMPT_REQUIRED' };
}

export async function readStdinText(stdin) {
  if (!stdin) return '';
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return '';
  return Buffer.concat(chunks).toString('utf8');
}
