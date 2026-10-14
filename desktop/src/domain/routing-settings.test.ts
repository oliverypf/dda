import { describe, expect, it, vi } from 'vitest';
import type { RuntimeDecisionNode } from './models';
import mainSource from '../main.ts?raw';
import {
  LEGACY_PINNED_MODEL_KEY, decisionsForRun, hasRouteDecisionRecord, isBlockedRouteSelection,
  migrateLegacyPinnedModel, planPinMigration, routeFailureNotice,
  PIN_MIGRATION_NOTICE_KEY, createPinNoticeSession, routeFailureThread, storePinMigrationNotice, takePinMigrationNotice, threadRuntimeRunId
} from './routing-settings';

const node = (decisionId: string, runId: string, decisionType: string, updatedAtMs: number): RuntimeDecisionNode =>
  ({ decisionId, runId, decisionType, status: 'COMMITTED', optionCount: 1, updatedAtMs });

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return { data, getItem: (key: string) => data.get(key) ?? null, removeItem: (key: string) => { data.delete(key); } };
};

describe('exec flow no longer renders routing/decision regions', () => {
  const main = mainSource;
  it('has no route/decisions live regions or patches and no card select', () => {
    expect(main).not.toContain('data-live-region="route"');
    expect(main).not.toContain('data-live-region="decisions"');
    expect(main).not.toMatch(/patchLiveRegion\(slot\('(route|decisions)'\)/);
    expect(main).not.toContain('data-action="pinned-model"');
    expect(main).not.toContain('renderRoutePanel');
    expect(main).toContain('data-live-region="route-notice"');
  });
  it('never sends a model override and retry does not prompt for a model', () => {
    expect(main).toContain('desktopBridge.runModelTask(prompt, undefined, taskOptions)');
    expect(main).not.toContain('modelOverride ??');
    expect(main).not.toContain('重试模型');
    expect(main).not.toContain('更换模型');
    expect(main).toContain("actionRow('retry-task', '重试任务'");
    expect(main).not.toMatch(/localStorage\.setItem\('hmcodex\.pinnedModel'/);
  });
});

describe('routing failure notice', () => {
  it('ROUTE_BLOCKED is linkable', () => {
    expect(routeFailureNotice('run-1', { code: 'ROUTE_BLOCKED', message: 'ROUTE_BLOCKED:JEV_ROUTE_BLOCKED' }))
      .toEqual({ kind: 'ROUTE_BLOCKED', runId: 'run-1', text: '路由被拒绝', linkable: true });
  });
  it('NO_MODEL_CANDIDATE shows the error inline without link', () => {
    const notice = routeFailureNotice('run-2', { code: 'ROLE_BINDING_BLOCKED', message: 'ROLE_BINDING_BLOCKED:NO_MODEL_CANDIDATE' });
    expect(notice?.kind).toBe('NO_MODEL_CANDIDATE');
    expect(notice?.linkable).toBe(false);
    expect(notice?.text).toContain('ROLE_BINDING_BLOCKED:NO_MODEL_CANDIDATE');
  });
  it('other failures produce no notice', () => {
    expect(routeFailureNotice('r', { code: 'ROLE_BINDING_BLOCKED', message: 'ROLE_BINDING_BLOCKED:UNKNOWN_EXECUTOR_MODEL' })).toBeUndefined();
    expect(routeFailureNotice('r', { code: 'RUNTIME_ERROR' })).toBeUndefined();
  });
  it('link is enabled only once a SELECT_ROUTE record for the runtime runId is loaded', () => {
    expect(hasRouteDecisionRecord([], 'run-1')).toBe(false);
    expect(hasRouteDecisionRecord([node('d0', 'other', 'SELECT_ROUTE', 1)], 'run-1')).toBe(false);
    expect(hasRouteDecisionRecord([node('d1', 'run-1', 'SELECT_ROUTE', 1)], 'run-1')).toBe(true);
  });
  it('blocked route.selected is detected', () => {
    expect(isBlockedRouteSelection({ status: 'BLOCKED' })).toBe(true);
    expect(isBlockedRouteSelection({ status: 'SELECTED' })).toBe(false);
  });
});

describe('Settings 模型与路由 filter', () => {
  it('filters by runtime runId and sorts by updatedAtMs desc', () => {
    const all = [node('a', 'run-1', 'SELECT_ROUTE', 10), node('b', 'run-2', 'SELECT_ROUTE', 30), node('c', 'run-1', 'ROUTE_MODEL', 20)];
    expect(decisionsForRun(all, 'run-1').map((item) => item.decisionId)).toEqual(['c', 'a']);
    expect(decisionsForRun(all, undefined)).toEqual([]);
  });
});

describe('legacy pinned model migration', () => {
  const config = { model: 'current', provider: 'x' };
  const run = (pin: string | undefined, models: string[] | undefined | Error, save?: (c: typeof config) => Promise<typeof config>) => {
    const storage = memoryStorage(pin === undefined ? {} : { [LEGACY_PINNED_MODEL_KEY]: pin });
    const saveConfig = vi.fn(save ?? (async (c: typeof config) => c));
    const refreshRuntime = vi.fn(async () => {});
    const promise = migrateLegacyPinnedModel({
      storage, loadConfig: async () => ({ ...config }), saveConfig, refreshRuntime,
      configuredModels: async () => { if (models instanceof Error) throw models; return models; }
    });
    return { storage, saveConfig, refreshRuntime, promise };
  };
  it('pin in list and different: saves as config.model, refreshes, then deletes key', async () => {
    const { storage, saveConfig, refreshRuntime, promise } = run('pinned', ['current', 'pinned']);
    const result = await promise;
    expect(result).toMatchObject({ plan: 'MIGRATE', migratedModel: 'pinned' });
    expect(saveConfig).toHaveBeenCalledWith({ model: 'pinned', provider: 'x' });
    expect(refreshRuntime).toHaveBeenCalled();
    expect(storage.data.has(LEGACY_PINNED_MODEL_KEY)).toBe(false);
  });
  it('pin not in list: skip migration, delete key, one-time notice', async () => {
    const { storage, saveConfig, promise } = run('retired', ['current']);
    const result = await promise;
    expect(result.plan).toBe('SKIP_NOTIFY');
    expect(result.notice).toContain('retired');
    expect(saveConfig).not.toHaveBeenCalled();
    expect(storage.data.has(LEGACY_PINNED_MODEL_KEY)).toBe(false);
  });
  it('model list unavailable: keep key for next launch', async () => {
    for (const models of [undefined, new Error('offline')]) {
      const { storage, saveConfig, promise } = run('pinned', models);
      expect((await promise).plan).toBe('RETRY_LATER');
      expect(saveConfig).not.toHaveBeenCalled();
      expect(storage.data.get(LEGACY_PINNED_MODEL_KEY)).toBe('pinned');
    }
  });
  it('pin equal to config.model: just delete', async () => {
    const { storage, saveConfig, promise } = run('current', ['current']);
    expect((await promise).plan).toBe('DELETE');
    expect(saveConfig).not.toHaveBeenCalled();
    expect(storage.data.has(LEGACY_PINNED_MODEL_KEY)).toBe(false);
  });
  it('save rejected: config unchanged, key deleted', async () => {
    const { storage, promise } = run('pinned', ['pinned'], async () => { throw new Error('MODEL_CONFIG_INVALID'); });
    const result = await promise;
    expect(result.plan).toBe('DELETE');
    expect(result.notice).toContain('pinned');
    expect(result.notice).toContain('current');
    expect(storage.data.has(LEGACY_PINNED_MODEL_KEY)).toBe(false);
  });
  it('plan table', () => {
    expect(planPinMigration(null, 'm', ['m'])).toBe('NONE');
    expect(planPinMigration('m', 'm', undefined)).toBe('DELETE');
  });
});

describe('review fixes', () => {
  it('pin notice persists until Settings shows it once', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
    storePinMigrationNotice(storage, undefined);
    expect(data.has(PIN_MIGRATION_NOTICE_KEY)).toBe(false);
    storePinMigrationNotice(storage, 'n');
    expect(takePinMigrationNotice(storage)).toBe('n');
    expect(takePinMigrationNotice(storage)).toBeUndefined();
    expect(mainSource).toContain('data-pin-migration-notice');
  });
  it('pin notice survives re-renders while Settings is open, gone after close+reopen', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
    storePinMigrationNotice(storage, 'pin dropped');
    const session = createPinNoticeSession(storage);
    expect(session.forRender()).toBe('pin dropped');
    expect(data.has(PIN_MIGRATION_NOTICE_KEY)).toBe(false);
    expect(session.forRender()).toBe('pin dropped');
    session.close();
    expect(session.forRender()).toBeUndefined();
    expect(mainSource).toContain('pinNoticeSession.close()');
  });
  it('pin notice is only taken when the 模型与路由 tab is visible', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
    storePinMigrationNotice(storage, 'pin dropped');
    const session = createPinNoticeSession(storage);
    expect(session.forRender(false)).toBeUndefined();
    expect(data.get(PIN_MIGRATION_NOTICE_KEY)).toBe('pin dropped');
    expect(session.forRender(true)).toBe('pin dropped');
    expect(data.has(PIN_MIGRATION_NOTICE_KEY)).toBe(false);
    expect(session.forRender(true)).toBe('pin dropped');
    session.close();
    expect(session.forRender(true)).toBeUndefined();
    expect(mainSource).toContain("pinNoticeSession.forRender(settingsSection === 'routing')");
    const handler = mainSource.slice(mainSource.indexOf("if (action === 'settings-section')"));
    const partial = handler.indexOf("panel.outerHTML = renderRoutingSettingsPanel()");
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(handler.indexOf('syncSettingsView()'));
    expect(mainSource).not.toContain("title: '模型设置', body: pinMigrationNotice");
  });
  it('route failure attaches to the run own thread, not the viewed one', () => {
    const map = new Map<string, string | undefined>([['r1', 't1']]);
    expect(routeFailureThread(map, 'r1')).toBe('t1');
    expect(routeFailureThread(map, 'r2')).toBeUndefined();
    expect(mainSource).not.toContain('threadId: model.activeThreadId } : undefined');
    expect(mainSource).toContain('routeFailureThread(runThreadIds, event.runId)');
  });
  it('history thread uses its own runId, never recentRunIds fallback', () => {
    const decisions = [node('d', 'r-old', 'SELECT_ROUTE', 1)];
    expect(threadRuntimeRunId([{ runId: 'r-old', createdAtMs: 1 }, { runId: 'r-new', createdAtMs: 2 }], decisions)).toBe('r-old');
    expect(threadRuntimeRunId([{ runId: 'r-new', createdAtMs: 2 }, {}], [])).toBeUndefined();
    expect(threadRuntimeRunId([{ createdAtMs: 1 }], decisions)).toBeUndefined();
    expect(mainSource).toContain('selectedThreadRuntimeRunId()');
    expect(mainSource).toContain('此会话没有路由记录');
  });
});
