// Display-only helpers for the 「模型与路由」 settings section and the one-line
// routing failure notice in the exec flow. Nothing here changes runtime events
// or the frozen protocol; it only reads existing projections.
import type { RuntimeDecisionNode } from './models';

export const LEGACY_PINNED_MODEL_KEY = 'hmcodex.pinnedModel';

export type RouteFailureNotice =
  | { kind: 'ROUTE_BLOCKED'; runId: string; text: string; linkable: true }
  | { kind: 'NO_MODEL_CANDIDATE'; runId: string; text: string; linkable: false };

/** Derive the one-line exec-flow notice from a run.failed payload. */
export const routeFailureNotice = (runId: string, payload: Record<string, unknown> | undefined): RouteFailureNotice | undefined => {
  const code = typeof payload?.code === 'string' ? payload.code : '';
  const message = typeof payload?.message === 'string' ? payload.message : '';
  if (code === 'ROUTE_BLOCKED') return { kind: 'ROUTE_BLOCKED', runId, text: '路由被拒绝', linkable: true };
  if (code === 'ROLE_BINDING_BLOCKED' && message.includes('NO_MODEL_CANDIDATE')) {
    return { kind: 'NO_MODEL_CANDIDATE', runId, text: `没有可用的模型候选：${message}`, linkable: false };
  }
  return undefined;
};

/** route.selected with a blocked status must not paint a normal 「执行路由」 line. */
export const isBlockedRouteSelection = (payload: Record<string, unknown> | undefined): boolean =>
  typeof payload?.status === 'string' && payload.status.toUpperCase() === 'BLOCKED';

/** Decisions for one runtime runId, newest first. */
export const decisionsForRun = (decisions: readonly RuntimeDecisionNode[] | undefined, runId: string | undefined): RuntimeDecisionNode[] =>
  !runId ? [] : (decisions ?? [])
    .filter((node) => node.runId === runId)
    .slice()
    .sort((left, right) => (right.updatedAtMs ?? 0) - (left.updatedAtMs ?? 0));

/** 「查看原因」 is enabled only once a post-run dashboard read returned a SELECT_ROUTE row for the run. */
export const hasRouteDecisionRecord = (decisions: readonly RuntimeDecisionNode[] | undefined, runId: string | undefined): boolean =>
  decisionsForRun(decisions, runId).some((node) => node.decisionType === 'SELECT_ROUTE');

export type PinMigrationPlan = 'NONE' | 'DELETE' | 'MIGRATE' | 'SKIP_NOTIFY' | 'RETRY_LATER';

/**
 * Legacy pin migration (frozen v7 item 4 + BOT2 amendment):
 * - no pin -> NONE
 * - pin == config.model -> DELETE
 * - model list unavailable -> RETRY_LATER (keep key, never use pin)
 * - pin not in configured list -> SKIP_NOTIFY (delete key, one-time notice)
 * - otherwise -> MIGRATE (save as config.model, then delete key)
 */
export const planPinMigration = (pin: string | null | undefined, configModel: string, availableModels: readonly string[] | undefined): PinMigrationPlan => {
  const value = pin?.trim();
  if (!value) return 'NONE';
  if (value === configModel) return 'DELETE';
  if (!availableModels) return 'RETRY_LATER';
  return availableModels.includes(value) ? 'MIGRATE' : 'SKIP_NOTIFY';
};

export interface PinMigrationDeps<Config extends { model: string }> {
  storage: Pick<Storage, 'getItem' | 'removeItem'>;
  loadConfig: () => Promise<Config | undefined>;
  configuredModels: () => Promise<readonly string[] | undefined>;
  saveConfig: (config: Config) => Promise<Config>;
  refreshRuntime?: () => Promise<void>;
  log?: (message: string) => void;
}

export interface PinMigrationResult { plan: PinMigrationPlan; notice?: string; migratedModel?: string }

/** Runs once at startup, awaited before the first task. Never returns the pin for use as an override. */
export const migrateLegacyPinnedModel = async <Config extends { model: string }>(deps: PinMigrationDeps<Config>): Promise<PinMigrationResult> => {
  const pin = deps.storage.getItem(LEGACY_PINNED_MODEL_KEY);
  if (!pin?.trim()) {
    if (pin !== null) deps.storage.removeItem(LEGACY_PINNED_MODEL_KEY);
    return { plan: 'NONE' };
  }
  let config: Config | undefined;
  try { config = await deps.loadConfig(); } catch { config = undefined; }
  if (!config) return { plan: 'RETRY_LATER' };
  let available: readonly string[] | undefined;
  try { available = await deps.configuredModels(); } catch { available = undefined; }
  const plan = planPinMigration(pin, config.model, available);
  const value = pin.trim();
  if (plan === 'RETRY_LATER') return { plan };
  if (plan === 'DELETE') { deps.storage.removeItem(LEGACY_PINNED_MODEL_KEY); return { plan }; }
  if (plan === 'SKIP_NOTIFY') {
    deps.storage.removeItem(LEGACY_PINNED_MODEL_KEY);
    return { plan, notice: `之前固定的模型 ${value} 已不在当前可用模型列表中，已改用设置里的模型 ${config.model}。` };
  }
  try {
    const saved = await deps.saveConfig({ ...config, model: value });
    deps.storage.removeItem(LEGACY_PINNED_MODEL_KEY);
    try { await deps.refreshRuntime?.(); } catch { /* snapshot refresh is best-effort */ }
    return { plan, migratedModel: saved.model };
  } catch (error) {
    // Validation/I-O rejection: keep config.model unchanged, delete the key, log once.
    deps.storage.removeItem(LEGACY_PINNED_MODEL_KEY);
    deps.log?.(`legacy pinned model migration rejected: ${error instanceof Error ? error.message : String(error)}`);
    return { plan: 'DELETE', notice: `之前固定的模型 ${value} 无法保存为全局默认模型，已改用设置里的模型 ${config.model}。` };
  }
};

/** One-time pin-migration notice, persisted until the Settings 「模型与路由」 section has shown it once. */
export const PIN_MIGRATION_NOTICE_KEY = 'hmcodex.pinMigrationNotice';
export const storePinMigrationNotice = (storage: Pick<Storage, 'setItem'>, notice: string | undefined): void => {
  if (notice) storage.setItem(PIN_MIGRATION_NOTICE_KEY, notice);
};
export const takePinMigrationNotice = (storage: Pick<Storage, 'getItem' | 'removeItem'>): string | undefined => {
  const notice = storage.getItem(PIN_MIGRATION_NOTICE_KEY);
  if (notice === null) return undefined;
  storage.removeItem(PIN_MIGRATION_NOTICE_KEY);
  return notice || undefined;
};

/**
 * Runtime runId for a selected (history) thread: the newest timeline run that has a
 * decision record. Never falls back to another
 * thread's run; undefined means the 「在设置中查看」 button is disabled.
 */
export const threadRuntimeRunId = (
  timeline: readonly { runId?: string; createdAtMs?: number }[] | undefined,
  decisions: readonly RuntimeDecisionNode[] | undefined
): string | undefined => {
  const items = (timeline ?? []).filter((item) => item.runId).slice().sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
  const known = new Set((decisions ?? []).map((node) => node.runId).filter(Boolean));
  return items.find((item) => known.has(item.runId))?.runId;
};

/** Thread that owns a runtime run, recorded at run start / bridge result. Never the currently viewed thread. */
export const routeFailureThread = (runThreads: ReadonlyMap<string, string | undefined>, runId: string): string | undefined =>
  runThreads.get(runId);


/**
 * Settings-scoped holder for the one-time pin notice. The first render while
 * Settings is open takes it from storage (deleting it there) and keeps it in
 * memory across re-renders; close() drops the memory copy so reopening is empty.
 */
export const createPinNoticeSession = (storage: Pick<Storage, 'getItem' | 'removeItem'>) => {
  let notice: string | undefined;
  return {
    /** Only takes from storage when the 「模型与路由」 tab is the visible one. */
    forRender: (routingVisible = true): string | undefined => {
      const taken = routingVisible ? takePinMigrationNotice(storage) : undefined;
      if (taken) notice = taken;
      return notice;
    },
    close: (): void => { notice = undefined; }
  };
};
