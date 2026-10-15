// UI state for the provider catalog page. Fetch, dismiss, and a blocked
// re-click never write. The only write command is save_provider_model_catalog.

export const PROVIDER_CATALOG_COMMANDS = {
  show: 'provider_model_catalog',
  fetch: 'fetch_provider_models',
  save: 'save_provider_model_catalog'
} as const;

export interface CatalogModelEntry {
  id: string;
  displayName?: string;
}

export interface CatalogRemoteModel {
  id: string;
  name?: string;
}

export interface CatalogPickerRow {
  id: string;
  displayName: string;
  checked: boolean;
  localOnly: boolean;
}

export interface CatalogPicker {
  providerKey: string;
  remote: CatalogRemoteModel[];
  rows: CatalogPickerRow[];
}

export interface CatalogSession {
  providerKey: string;
  models: CatalogModelEntry[];
  fetching: boolean;
  picker: CatalogPicker | null;
  notice: string;
  noticeTone: '' | 'error' | 'success';
}

export interface ProviderCatalogSnapshot {
  ok: true;
  providerKey: string;
  provider?: string;
  models: CatalogModelEntry[];
  warning?: string;
}

export interface ProviderCatalogFetchResult {
  ok: true;
  providerKey: string;
  remote: CatalogRemoteModel[];
  rows: CatalogPickerRow[];
}

export interface ProviderCatalogSaveResult {
  ok: true;
  providerKey: string;
  models: CatalogModelEntry[];
}

export const emptyCatalogSession = (): CatalogSession => ({
  providerKey: '',
  models: [],
  fetching: false,
  picker: null,
  notice: '',
  noticeTone: ''
});

export type FetchDecision =
  | { kind: 'start'; session: CatalogSession }
  | { kind: 'blocked' };

export const beginCatalogFetch = (session: CatalogSession): FetchDecision => {
  if (session.picker || session.fetching) return { kind: 'blocked' };
  return {
    kind: 'start',
    session: { ...session, fetching: true, notice: '', noticeTone: '', models: session.models }
  };
};

export const failCatalogFetch = (session: CatalogSession, message: string): CatalogSession => ({
  ...session,
  fetching: false,
  picker: null,
  models: session.models,
  notice: message,
  noticeTone: 'error'
});

export const succeedCatalogFetch = (session: CatalogSession, payload: ProviderCatalogFetchResult): CatalogSession => ({
  ...session,
  fetching: false,
  models: session.models,
  notice: '',
  noticeTone: '',
  picker: { providerKey: payload.providerKey, remote: payload.remote, rows: payload.rows }
});

export const dismissCatalogPicker = (session: CatalogSession): CatalogSession => ({
  ...session,
  picker: null,
  models: session.models
});

export const catalogConfirmWrite = (session: CatalogSession, checkedIds: readonly string[]):
  | { kind: 'noop' }
  | {
      kind: 'write';
      command: typeof PROVIDER_CATALOG_COMMANDS.save;
      payload: { providerKey: string; checkedIds: string[]; remote: CatalogRemoteModel[] };
    } => {
  if (!session.picker) return { kind: 'noop' };
  return {
    kind: 'write',
    command: PROVIDER_CATALOG_COMMANDS.save,
    payload: {
      providerKey: session.picker.providerKey,
      checkedIds: [...checkedIds],
      remote: session.picker.remote
    }
  };
};

export const applySavedCatalog = (session: CatalogSession, models: readonly CatalogModelEntry[]): CatalogSession => ({
  ...session,
  picker: null,
  fetching: false,
  models: models.map((model) => ({ ...model })),
  notice: '模型目录已更新。',
  noticeTone: 'success'
});

export const applyCatalogSnapshot = (session: CatalogSession, snapshot: ProviderCatalogSnapshot): CatalogSession => ({
  ...session,
  providerKey: snapshot.providerKey,
  models: snapshot.models.map((model) => ({ ...model })),
  fetching: false,
  notice: snapshot.warning ?? '',
  noticeTone: snapshot.warning ? 'error' : ''
});

export const catalogModelLabel = (model: CatalogModelEntry): string => {
  const name = model.displayName?.trim();
  return name || model.id;
};

export const modelMissingFromCatalog = (
  modelId: string,
  models: readonly CatalogModelEntry[],
  catalogReady: boolean
): boolean => {
  const id = modelId.trim();
  if (!catalogReady || !id) return false;
  return !models.some((model) => model.id === id);
};
