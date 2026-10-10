const clone = (value) => structuredClone(value);

const bounded = (value, max = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ').trim().slice(0, max);

/**
 * Provider-neutral context boundary. Implementations may be backed by a
 * local journal, OpenViking, or another store, but callers only see bounded
 * records and digests.
 */
export class ContextPort {
  #adapter;

  constructor(adapter = {}) {
    for (const method of ['recall', 'record', 'used', 'commit']) {
      if (typeof adapter[method] !== 'function') throw new Error(`CONTEXT_PORT_METHOD_REQUIRED:${method}`);
    }
    this.#adapter = adapter;
  }

  async recall(input = {}) { return clone(await this.#adapter.recall(clone(input))); }
  async record(input = {}) { return clone(await this.#adapter.record(clone(input))); }
  async used(input = {}) { return clone(await this.#adapter.used(clone(input))); }
  async commit(input = {}) { return clone(await this.#adapter.commit(clone(input))); }
  async health() {
    if (typeof this.#adapter.health !== 'function') return { status: 'AVAILABLE', provider: 'UNKNOWN' };
    return clone(await this.#adapter.health());
  }
}

export const contextPortInputDigest = (input) => {
  const text = bounded(JSON.stringify(input), 4000);
  return text ? `bounded:${text}` : 'bounded:';
};

export const createContextPort = (adapter) => new ContextPort(adapter);
