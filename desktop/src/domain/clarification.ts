export interface ClarificationOption {
  optionId: string;
  label: string;
}

export interface ClarificationView {
  requestId: string;
  question: string;
  options: ClarificationOption[];
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u;
const OPTION_ID = /^option-[1-4]$/u;

const cleanQuestion = (value: unknown): string => String(value ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
  .replace(/\r\n/gu, '\n')
  .trim()
  .slice(0, 600);

const cleanAnswer = (value: unknown): string => String(value ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
  .replace(/\r\n/gu, '\n')
  .trim()
  .slice(0, 4000);

const ENDED_RUN_STATES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED']);

/** A finished run can no longer accept an answer, so the question card must close. */
export const clarificationRunEnded = (state: string | undefined): boolean =>
  typeof state === 'string' && ENDED_RUN_STATES.has(state);

export const clarificationFailureText = (code: string): string | undefined => {
  if (code === 'CLARIFICATION_EXPIRED') return '还没有收到补充说明，任务已停止，没有替你猜。';
  if (code === 'CLARIFICATION_NO_LIVE_USER') return '当前没有可以回答问题的界面，任务已停止。';
  if (code === 'CLARIFICATION_CANCELLED') return '补充说明已取消。';
  return undefined;
};

export const clarificationFromPayload = (payload: unknown): ClarificationView | undefined => {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const requestId = typeof record.requestId === 'string' ? record.requestId.trim() : '';
  const question = cleanQuestion(record.question);
  if (!REQUEST_ID.test(requestId) || !question) return undefined;
  const options: ClarificationOption[] = [];
  if (Array.isArray(record.options)) {
    for (const raw of record.options.slice(0, 4)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const optionId = typeof item.optionId === 'string' ? item.optionId : '';
      const label = cleanAnswer(item.label).replace(/\s+/gu, ' ').slice(0, 80);
      if (!OPTION_ID.test(optionId) || !label) continue;
      if (options.some((option) => option.optionId === optionId || option.label === label)) continue;
      options.push({ optionId, label });
    }
  }
  return { requestId, question, options };
};

export const clarificationReply = (
  request: Pick<ClarificationView, 'options'>,
  input: { text?: string; optionId?: string }
): { ok: true; answer: string; selectedOptionId?: string } | { ok: false; error: string } => {
  const optionId = input.optionId?.trim() ?? '';
  if (optionId) {
    const option = request.options.find((item) => item.optionId === optionId);
    if (!option) return { ok: false, error: '这个选项已经不在当前问题上。' };
    return { ok: true, answer: option.label, selectedOptionId: option.optionId };
  }
  const raw = String(input.text ?? '').trim();
  if (!raw) return { ok: false, error: '请先写出你的说明。' };
  if (raw.length > 4000) return { ok: false, error: '说明请控制在 4000 字以内。' };
  const answer = cleanAnswer(raw);
  if (!answer) return { ok: false, error: '请先写出你的说明。' };
  return { ok: true, answer };
};

export const clarificationCardHtml = (
  request: ClarificationView & { submitting?: boolean },
  escapeHtml: (value: string) => string
): string => {
  const options = request.options.map((option) =>
    `<button class="clarification-option" type="button" data-action="answer-clarification" data-request-id="${escapeHtml(request.requestId)}" data-option-id="${escapeHtml(option.optionId)}" ${request.submitting ? 'disabled' : ''}>${escapeHtml(option.label)}</button>`
  ).join('');
  return `<div class="clarification-card" data-clarification-request="${escapeHtml(request.requestId)}">
    <p class="clarification-kicker">${request.submitting ? '正在提交你的说明' : '需要你补充后才能继续'}</p>
    <p class="clarification-question">${escapeHtml(request.question)}</p>
    ${options ? `<div class="clarification-options">${options}</div>` : ''}
    <p class="clarification-hint">${request.submitting ? '提交后当前任务会按这个说明继续。' : '可以选择上面的一项，或在下面输入说明后发送。这只补充任务目标，不会批准任何操作。'}</p>
  </div>`;
};
