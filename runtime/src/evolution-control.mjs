import { createHash } from 'node:crypto';

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

const digest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
const bounded = (value, max = 160) => String(value ?? '').replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ').trim().slice(0, max);

const applyEvent = (state, event) => {
  const payload = event.payload ?? {};
  if (!['EvolutionControlChanged', 'EvolutionControlKilled', 'EvolutionControlEnabled'].includes(event.kind) ||
      typeof payload.enabled !== 'boolean' ||
      typeof payload.changedAtMs !== 'number' ||
      payload.controlDigest !== digest({
        enabled: payload.enabled,
        reason: payload.reason ?? null,
        actor: payload.actor ?? null,
        changedAtMs: payload.changedAtMs
      })) {
    throw new Error('EVOLUTION_CONTROL_STORE_INVALID');
  }
  return {
    enabled: payload.enabled,
    reason: typeof payload.reason === 'string' && payload.reason ? payload.reason : undefined,
    actor: typeof payload.actor === 'string' && payload.actor ? payload.actor : undefined,
    changedAtMs: payload.changedAtMs,
    commandId: typeof event.commandId === 'string' && event.commandId ? event.commandId : undefined
  };
};

export class EvolutionControlStore {
  #eventStore;
  #state = { enabled: true, changedAtMs: 0 };
  #loaded = false;

  constructor({ eventStore } = {}) {
    this.#eventStore = eventStore;
  }

  async load() {
    if (this.#loaded) return;
    if (!this.#eventStore?.list) {
      this.#loaded = true;
      return;
    }
    let events;
    try {
      events = await this.#eventStore.list({ aggregateType: 'EvolutionControl' });
    } catch {
      throw new Error('EVOLUTION_CONTROL_STORE_READ_FAILED');
    }
    let state = { enabled: true, changedAtMs: 0 };
    for (const event of events) state = applyEvent(state, event);
    this.#state = state;
    this.#loaded = true;
  }

  get state() {
    return structuredClone(this.#state);
  }

  async assertEnabled(operation = 'EVOLUTION') {
    await this.load();
    if (this.#state.enabled === false) throw new Error(`EVOLUTION_CONTROL_KILLED:${String(operation).slice(0, 40)}`);
  }

  async kill({ reason = 'MANUAL_KILL_SWITCH', actor = 'OPERATOR' } = {}) {
    await this.load();
    if (this.#state.enabled === false) return { idempotent: true, state: this.state() };
    const safeReason = bounded(reason);
    const safeActor = bounded(actor, 80);
    const changedAtMs = Date.now();
    const payload = {
      enabled: false,
      reason: safeReason || 'MANUAL_KILL_SWITCH',
      actor: safeActor,
      changedAtMs
    };
    payload.controlDigest = digest({
      enabled: payload.enabled,
      reason: payload.reason,
      actor: payload.actor,
      changedAtMs
    });
    await this.#commit('EvolutionControlKilled', payload, `evolution-control-kill:${changedAtMs}`);
    return { idempotent: false, state: this.state() };
  }

  async enable({ reason = 'MANUAL_RECOVERY', actor = 'OPERATOR' } = {}) {
    await this.load();
    if (this.#state.enabled === true) return { idempotent: true, state: this.state() };
    const safeReason = bounded(reason);
    const safeActor = bounded(actor, 80);
    const changedAtMs = Date.now();
    const payload = {
      enabled: true,
      reason: safeReason || 'MANUAL_RECOVERY',
      actor: safeActor,
      changedAtMs
    };
    payload.controlDigest = digest({
      enabled: payload.enabled,
      reason: payload.reason,
      actor: payload.actor,
      changedAtMs
    });
    await this.#commit('EvolutionControlEnabled', payload, `evolution-control-enable:${changedAtMs}`);
    return { idempotent: false, state: this.state() };
  }

  state() {
    return structuredClone(this.#state);
  }

  async #commit(kind, payload, commandId) {
    await this.#eventStore.append({
      runId: 'evolution-control',
      aggregateType: 'EvolutionControl',
      aggregateId: 'global',
      kind,
      payload,
      sensitivity: 'SECURITY_AUDIT',
      commandId
    });
    this.#state = {
      enabled: payload.enabled,
      reason: payload.reason,
      actor: payload.actor,
      changedAtMs: payload.changedAtMs,
      commandId
    };
    this.#loaded = true;
  }
}

export const createEvolutionControlStore = (options) => new EvolutionControlStore(options);
