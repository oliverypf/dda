import { bounded } from './types.mjs';

const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const MAX_RESPONSE_CHARS = 64 * 1024;

const clone = (value) => structuredClone(value);

// The engine's finite choices are internal. TypeSafe's public choice schema
// requires named criteria and instructions, not choices/prompt/context.
const wireQuestions = questions => Object.fromEntries(Object.entries(questions).map(([name, question]) => {
  if (question?.type !== 'choice' || !Array.isArray(question.choices)) return [name, clone(question)];
  if (!question.choices.length || question.choices.some(choice => typeof choice !== 'string' || !choice)
    || new Set(question.choices).size !== question.choices.length) throw errorWithCode('JEV_QUESTIONS_INVALID');
  return [name, { type: 'choice', criteria: Object.fromEntries(question.choices.map(choice => [choice, question.criteria?.[choice] ?? null])),
    ...(question.prompt || question.context ? { instructions: { question: question.prompt ?? '', ...(question.context ? { context: clone(question.context) } : {}) } } : {}) }];
}));

const errorWithCode = (code, cause) => {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
};

const parseJson = (text) => {
  try { return JSON.parse(text); } catch { return undefined; }
};

const answerMap = (payload) => {
  const source = payload?.answers ?? payload?.result?.answers ?? payload?.decisions ?? payload?.result ?? payload;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  if (Array.isArray(source)) {
    return Object.fromEntries(source
      .filter((item) => item && typeof item === 'object' && typeof item.id === 'string')
      .map((item) => [item.id, item]));
  }
  return source;
};

const normalizeAnswer = (value) => {
  if (typeof value === 'string') return { choice: value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const distribution = value.scores ?? value.probabilities ?? value.distribution;
  return {
    ...(value.choice === undefined && value.decision === undefined && value.label === undefined && value.value === undefined
      ? {}
      : { choice: value.choice ?? value.decision ?? value.label ?? value.value }),
    ...(Number.isFinite(Number(value.confidence ?? value.score ?? value.probability))
      ? { confidence: Number(value.confidence ?? value.score ?? value.probability) }
      : {}),
    ...(distribution && typeof distribution === 'object' && !Array.isArray(distribution) ? { scores: clone(distribution) } : {}),
    ...(value.reasonCode ? { reasonCode: bounded(value.reasonCode, 160) } : {})
  };
};

/**
 * Small provider-neutral adapter for Jev/System One. The request is deliberately
 * a finite-question decision call: Jev selects among supplied choices and never
 * receives tool access or permission to create new actions.
 */
export class JevClient {
  #endpoint;
  #apiKey;
  #model;
  #timeoutMs;
  #verificationTimeoutMs;
  #fetch;

  constructor({ endpoint = DEFAULT_ENDPOINT, apiKey, model = DEFAULT_MODEL, timeoutMs = 1200, verificationTimeoutMs = 15000, fetchImpl = globalThis.fetch } = {}) {
    if (typeof endpoint !== 'string' || !endpoint.trim()) throw new Error('JEV_ENDPOINT_REQUIRED');
    if (typeof fetchImpl !== 'function') throw new Error('JEV_FETCH_UNAVAILABLE');
    this.#endpoint = endpoint.trim();
    this.#apiKey = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined;
    this.#model = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_MODEL;
    this.#timeoutMs = Number.isFinite(Number(timeoutMs)) ? Math.max(100, Math.min(10000, Math.trunc(Number(timeoutMs)))) : 1200;
    this.#verificationTimeoutMs = Number.isFinite(Number(verificationTimeoutMs))
      ? Math.max(100, Math.min(60000, Math.trunc(Number(verificationTimeoutMs)))) : 15000;
    this.#fetch = fetchImpl;
  }

  get configured() { return Boolean(this.#apiKey); }
  get endpoint() { return this.#endpoint; }
  get model() { return this.#model; }

  async decide({ state, questions, signal, purpose } = {}) {
    if (!this.#apiKey) throw errorWithCode('JEV_CREDENTIAL_MISSING');
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw errorWithCode('JEV_STATE_INVALID');
    if (!questions || typeof questions !== 'object' || Array.isArray(questions) || !Object.keys(questions).length) {
      throw errorWithCode('JEV_QUESTIONS_INVALID');
    }
    const controller = new AbortController();
    // Semantic verification gets its own bounded budget. Fast action gates
    // retain their original deadline; neither deadline grants a positive verdict.
    const timeoutMs = purpose === 'verification' ? this.#verificationTimeoutMs : this.#timeoutMs;
    const timeout = setTimeout(() => controller.abort(errorWithCode('JEV_TIMEOUT')), timeoutMs);
    timeout.unref?.();
    const abort = () => controller.abort(signal?.reason ?? errorWithCode('JEV_CANCELLED'));
    if (signal?.aborted) abort();
    else signal?.addEventListener?.('abort', abort, { once: true });
    const startedAtMs = Date.now();
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${this.#apiKey}`
        },
        body: JSON.stringify({
          model: this.#model,
          state: clone(state),
          questions: wireQuestions(questions)
        }),
        signal: controller.signal
      });
      const raw = await response.text();
      if (controller.signal.aborted) throw controller.signal.reason;
      if (!response.ok) throw errorWithCode(`JEV_HTTP_${response.status}`);
      if (raw.length > MAX_RESPONSE_CHARS) throw errorWithCode('JEV_RESPONSE_TOO_LARGE');
      const payload = parseJson(raw);
      if (!payload) throw errorWithCode('JEV_RESPONSE_INVALID_JSON');
      return {
        answers: Object.fromEntries(Object.entries(answerMap(payload)).map(([key, value]) => [key, normalizeAnswer(value)])),
        latencyMs: Math.max(0, Date.now() - startedAtMs),
        model: typeof payload.model === 'string' ? payload.model : this.#model,
        requestedModel: this.#model,
        ...(Number.isInteger(payload.usage?.input_tokens) && payload.usage.input_tokens >= 0
          && Number.isInteger(payload.usage?.output_tokens) && payload.usage.output_tokens >= 0
          ? { usage: { inputTokens: payload.usage.input_tokens, outputTokens: payload.usage.output_tokens, source: 'PROVIDER_USAGE' } } : {})
      };
    } catch (error) {
      let failure;
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        failure = errorWithCode(signal?.aborted ? 'JEV_CANCELLED' : 'JEV_TIMEOUT', error);
      } else failure = error?.code?.startsWith?.('JEV_') ? error : errorWithCode('JEV_REQUEST_FAILED', error);
      failure.latencyMs = Math.max(0, Date.now() - startedAtMs);
      failure.timeoutMs = timeoutMs;
      throw failure;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', abort);
    }
  }
}

export const createJevClient = (options) => new JevClient(options);
export const jevDefaults = Object.freeze({ endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MODEL, timeoutMs: 1200, verificationTimeoutMs: 15000 });
