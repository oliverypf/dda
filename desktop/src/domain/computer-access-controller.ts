// Pure controller for the global machine-user access mode. Rust is the sole
// writer; this only orchestrates read/write + state. No localStorage.

import type { AccessMode, AccessStatus } from './computer-access';

export interface AccessModeState {
  loading: boolean;
  saving: boolean;
  status?: AccessStatus;
  error?: string;
}

const VALID = new Set<AccessMode>(['REQUIRE_APPROVAL', 'FULL_ACCESS']);

const validStatus = (value: unknown): AccessStatus | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const s = value as Partial<AccessStatus>;
  return VALID.has(s.mode as AccessMode) && s.scope === 'USER_FILESYSTEM' ? (s as AccessStatus) : undefined;
};

export class ComputerAccessController {
  #read: () => Promise<AccessStatus>;
  #write: (mode: AccessMode, confirmed: boolean) => Promise<AccessStatus>;
  #onChange: () => void;
  #state: AccessModeState;
  #generation = 0;

  constructor({ read, write, onChange }: {
    read: () => Promise<AccessStatus>;
    write: (mode: AccessMode, confirmed: boolean) => Promise<AccessStatus>;
    onChange: () => void;
  }) {
    this.#read = read;
    this.#write = write;
    this.#onChange = onChange;
    this.#state = { loading: false, saving: false };
  }

  get state(): AccessModeState { return { ...this.#state }; }
  get mode(): AccessMode { return this.#state.status?.mode ?? 'REQUIRE_APPROVAL'; }

  async load(): Promise<void> {
    if (this.#state.saving) return;
    const generation = ++this.#generation;
    this.#state = { ...this.#state, loading: true, error: undefined };
    this.#onChange();
    try {
      const status = validStatus(await this.#read());
      if (generation !== this.#generation) return;
      // Invalid/malformed reads fail closed — never retain a stale grant.
      this.#state = { loading: false, saving: this.#state.saving, status: status, error: status ? undefined : '读取访问模式失败' };
    } catch {
      if (generation !== this.#generation) return;
      this.#state = { loading: false, saving: this.#state.saving, status: undefined, error: '读取访问模式失败' };
    }
    this.#onChange();
  }

  async enable(acknowledged: boolean): Promise<boolean> {
    if (!acknowledged || this.#state.loading || this.#state.saving) return false;
    return this.#apply('FULL_ACCESS', true);
  }

  async disable(): Promise<boolean> {
    if (this.#state.loading || this.#state.saving) return false;
    return this.#apply('REQUIRE_APPROVAL', false);
  }

  async #apply(mode: AccessMode, confirmed: boolean): Promise<boolean> {
    const generation = ++this.#generation;
    this.#state = { ...this.#state, saving: true, error: undefined };
    this.#onChange();
    try {
      const status = validStatus(await this.#write(mode, confirmed));
      if (!status || status.mode !== mode) throw new Error('invalid status');
      this.#state = { ...this.#state, saving: false, status, error: undefined };
      this.#onChange();
      return true;
    } catch {
      if (generation !== this.#generation) return false;
      this.#state = { ...this.#state, saving: false, error: '修改失败，原模式未改变' };
      this.#onChange();
      return false;
    }
  }
}
