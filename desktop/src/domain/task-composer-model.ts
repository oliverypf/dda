export const TASK_COMPOSER_MODEL_STORAGE_KEY = 'hmcodex.taskComposerModels';

const boundedId = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 200 ? trimmed : '';
};

/** Thread id → composer model. Invalid entries are dropped. */
export const readTaskComposerModels = (raw: string | null | undefined): Record<string, string> => {
  if (!raw) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const threadId = boundedId(key);
    const modelId = boundedId(value);
    if (threadId && modelId) next[threadId] = modelId;
  }
  return next;
};

/**
 * Model shown for the task on screen.
 * An explicit session choice wins, then the model remembered for that thread,
 * then the global default. A history overlay of a different thread does not
 * borrow the session that happens to be installed underneath it.
 */
export const resolveTaskComposerModel = (input: {
  sessionModelId?: string;
  sessionThreadId?: string;
  historyThreadId?: string;
  rememberedModelId?: string;
  defaultModelId?: string;
}): string => {
  const sessionModelId = input.sessionModelId?.trim() ?? '';
  const sessionThreadId = input.sessionThreadId?.trim() ?? '';
  const historyThreadId = input.historyThreadId?.trim() ?? '';
  const remembered = input.rememberedModelId?.trim() ?? '';
  const fallback = input.defaultModelId?.trim() ?? '';
  if (historyThreadId && sessionThreadId !== historyThreadId) return remembered || fallback;
  return sessionModelId || remembered || fallback;
};

/** A pick during another thread's history must not overwrite the session underneath. */
export const composerChoiceBindsSession = (sessionThreadId: string | undefined, historyThreadId: string | undefined): boolean => {
  const history = historyThreadId?.trim() ?? '';
  if (!history) return true;
  return (sessionThreadId?.trim() ?? '') === history;
};
