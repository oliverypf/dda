const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

export interface ThinkingStreamState {
  inThink: boolean;
  carry: string;
}

export const createThinkingStreamState = (): ThinkingStreamState => ({
  inThink: false,
  carry: ''
});

/**
 * Incrementally split inline `<think>...</think>` blocks from streamed visible
 * text so gateways that embed reasoning inside `content` render in the thinking
 * disclosure rather than leaking `<think>` tags into the reply body.
 */
export const consumeInlineThinkDelta = (
  state: ThinkingStreamState,
  delta: string
): { visibleDelta: string; thinkingDelta: string } => {
  if (!delta) return { visibleDelta: '', thinkingDelta: '' };
  let buf = state.carry + delta;
  state.carry = '';
  let visibleDelta = '';
  let thinkingDelta = '';

  while (buf.length > 0) {
    if (!state.inThink) {
      const openIdx = buf.indexOf(THINK_OPEN);
      if (openIdx >= 0) {
        visibleDelta += buf.slice(0, openIdx);
        buf = buf.slice(openIdx + THINK_OPEN.length);
        state.inThink = true;
        continue;
      }
      const hold = partialPrefixHold(buf, THINK_OPEN);
      if (hold > 0) {
        visibleDelta += buf.slice(0, buf.length - hold);
        state.carry = buf.slice(buf.length - hold);
      } else {
        visibleDelta += buf;
      }
      break;
    } else {
      const closeIdx = buf.indexOf(THINK_CLOSE);
      if (closeIdx >= 0) {
        thinkingDelta += buf.slice(0, closeIdx);
        buf = buf.slice(closeIdx + THINK_CLOSE.length);
        state.inThink = false;
        continue;
      }
      const hold = partialPrefixHold(buf, THINK_CLOSE);
      if (hold > 0) {
        thinkingDelta += buf.slice(0, buf.length - hold);
        state.carry = buf.slice(buf.length - hold);
      } else {
        thinkingDelta += buf;
      }
      break;
    }
  }
  return { visibleDelta, thinkingDelta };
};

export const flushInlineThinkState = (
  state: ThinkingStreamState
): { visibleDelta: string; thinkingDelta: string } => {
  const leftover = state.carry;
  state.carry = '';
  if (!leftover) return { visibleDelta: '', thinkingDelta: '' };
  return state.inThink
    ? { visibleDelta: '', thinkingDelta: leftover }
    : { visibleDelta: leftover, thinkingDelta: '' };
};

/**
 * Extract `<think>...</think>` blocks from a complete non-streamed text string.
 */
export const splitCompleteInlineThinking = (
  raw: string
): { visibleText: string; thinkingText: string } => {
  const state = createThinkingStreamState();
  const first = consumeInlineThinkDelta(state, raw);
  const tail = flushInlineThinkState(state);
  return {
    visibleText: (first.visibleDelta + tail.visibleDelta).replace(/^\n+/, ''),
    thinkingText: (first.thinkingDelta + tail.thinkingDelta).trim()
  };
};

const partialPrefixHold = (text: string, tag: string): number => {
  const maxCheck = Math.min(text.length, tag.length - 1);
  for (let len = maxCheck; len >= 1; len -= 1) {
    if (tag.startsWith(text.slice(text.length - len))) {
      return len;
    }
  }
  return 0;
};

export const formatThinkingDuration = (startedAtMs?: number, completedAtMs?: number): string => {
  if (!startedAtMs || !Number.isFinite(startedAtMs)) return '';
  const end = completedAtMs && Number.isFinite(completedAtMs) ? completedAtMs : Date.now();
  const seconds = Math.max(1, Math.round((end - startedAtMs) / 1000));
  return `${seconds} 秒`;
};
