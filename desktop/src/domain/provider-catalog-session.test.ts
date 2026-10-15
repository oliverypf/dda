import { describe, expect, it } from 'vitest';
import mainSource from '../main.ts?raw';
import bridgeSource from '../services/desktopBridge.ts?raw';
import {
  PROVIDER_CATALOG_COMMANDS,
  applySavedCatalog,
  beginCatalogFetch,
  catalogConfirmWrite,
  dismissCatalogPicker,
  emptyCatalogSession,
  failCatalogFetch,
  succeedCatalogFetch,
  type CatalogSession,
  catalogModelLabel,
  modelMissingFromCatalog
} from './provider-catalog-session';

const seeded = (): CatalogSession => ({
  ...emptyCatalogSession(),
  providerKey: 'opencode-go',
  models: [
    { id: 'minimax-m3', displayName: 'MiniMax-M3' },
    { id: 'local-only', displayName: 'Local Only' }
  ]
});

describe('provider catalog session', () => {
  it('does not change the catalog when fetch fails or the picker is dismissed', () => {
    const start = beginCatalogFetch(seeded());
    expect(start.kind).toBe('start');
    if (start.kind !== 'start') return;
    expect(start.session.models).toEqual(seeded().models);
    expect(start.session.fetching).toBe(true);
    const failed = failCatalogFetch(start.session, '获取可用模型失败（HTTP 500）。');
    expect(failed.models).toEqual(seeded().models);
    expect(failed.fetching).toBe(false);
    expect(failed.notice).toContain('HTTP 500');
    const opened = succeedCatalogFetch(start.session, {
      ok: true,
      providerKey: 'opencode-go',
      remote: [{ id: 'qwen3.7-max', name: 'Qwen3.7 Max' }],
      rows: [
        { id: 'local-only', displayName: 'Local Only', checked: true, localOnly: true },
        { id: 'qwen3.7-max', displayName: 'Qwen3.7 Max', checked: false, localOnly: false }
      ]
    });
    expect(opened.models).toEqual(seeded().models);
    expect(beginCatalogFetch(opened).kind).toBe('blocked');
    const dismissed = dismissCatalogPicker(opened);
    expect(dismissed.picker).toBeNull();
    expect(dismissed.models).toEqual(seeded().models);
    expect(catalogConfirmWrite(dismissed, [])).toEqual({ kind: 'noop' });
  });

  it('writes only through save_provider_model_catalog after confirm', () => {
    const opened = succeedCatalogFetch({ ...seeded(), fetching: true }, {
      ok: true,
      providerKey: 'opencode-go',
      remote: [],
      rows: [{ id: 'local-only', displayName: 'Local Only', checked: true, localOnly: true }]
    });
    const write = catalogConfirmWrite(opened, ['minimax-m3']);
    expect(write.kind).toBe('write');
    if (write.kind !== 'write') return;
    expect(write.command).toBe('save_provider_model_catalog');
    expect(write.command).not.toBe('save_model_config');
    expect(PROVIDER_CATALOG_COMMANDS.save).toBe(write.command);
    expect(write.payload.checkedIds).toEqual(['minimax-m3']);
    expect(opened.models.some((model) => model.id === 'local-only')).toBe(true);
    const saved = applySavedCatalog(opened, [{ id: 'minimax-m3', displayName: 'MiniMax-M3' }]);
    expect(saved.models.map((model) => model.id)).toEqual(['minimax-m3']);
    expect(saved.picker).toBeNull();
  });
});

describe('provider catalog settings surface', () => {
  const modal = mainSource.slice(mainSource.indexOf('const renderSettingsModal'), mainSource.indexOf('const openSettings'));
  const panel = mainSource.slice(mainSource.indexOf('function renderProviderCatalogPanel'), mainSource.indexOf('function removeCatalogPickerDialog'));
  const formStart = modal.indexOf('data-form="model-settings"');
  const formEnd = modal.indexOf('</form>');

  it('keeps the catalog page outside the form and also exposes fetch on roles/models', () => {
    expect(formStart).toBeGreaterThan(-1);
    expect(modal.indexOf('renderProviderCatalogPanel()')).toBeGreaterThan(formEnd);
    const formHtml = modal.slice(formStart, formEnd);
    expect(formHtml).toContain('renderRolesModelField(config)');
    const rolesField = mainSource.slice(
      mainSource.indexOf('function renderRolesModelField'),
      mainSource.indexOf('function renderProviderCatalogPanel')
    );
    expect(rolesField).toContain('获取可用模型');
    expect(rolesField).toContain('provider-catalog-model-options');
    expect(rolesField).toContain('不在目录');
    expect(rolesField).toContain('catalogModelLabel');
    expect(rolesField).toContain('modelMissingFromCatalog');
    expect(panel).toContain('data-settings-panel="catalog"');
    expect(panel).toContain('获取可用模型');
    expect(panel).not.toContain('添加提供方');
    expect(panel).not.toContain('删除提供方');
    expect(panel).not.toContain('恢复默认模型');
    expect(panel).not.toContain('打开配置文件');
    expect(mainSource).toContain('saveProviderModelCatalog');
    expect(mainSource).not.toContain('data-action="delete-catalog-model"');
  });

  it('labels catalog options with displayName else id and flags missing models', () => {
    expect(catalogModelLabel({ id: 'a', displayName: 'Alpha' })).toBe('Alpha');
    expect(catalogModelLabel({ id: 'a', displayName: '  ' })).toBe('a');
    expect(catalogModelLabel({ id: 'a' })).toBe('a');
    expect(modelMissingFromCatalog('a', [{ id: 'b' }], true)).toBe(true);
    expect(modelMissingFromCatalog('a', [{ id: 'a' }], true)).toBe(false);
    expect(modelMissingFromCatalog('a', [], false)).toBe(false);
    expect(modelMissingFromCatalog('', [{ id: 'a' }], true)).toBe(false);
  });

  it('closes the catalog dialog on Escape without writing', () => {
    const capture = mainSource.indexOf("if (event.key !== 'Escape' || !catalogPickerDialog) return;");
    expect(capture).toBeGreaterThan(-1);
    const captureEnd = mainSource.indexOf('}, true);', capture);
    const captureBlock = mainSource.slice(capture, captureEnd);
    expect(captureBlock).toContain('stopPropagation()');
    expect(captureBlock).toContain('cancelCatalogPicker()');
    expect(captureBlock).not.toContain('saveProviderModelCatalog');
    expect(captureBlock).not.toContain('save_model_config');
  });

  it('saves the catalog with its own bridge command', () => {
    const saveStart = bridgeSource.indexOf('saveProviderModelCatalog');
    const saveBody = bridgeSource.slice(saveStart, bridgeSource.indexOf('async desktopSettings'));
    expect(saveBody).toContain('PROVIDER_CATALOG_COMMANDS.save');
    expect(saveBody).not.toContain('save_model_config');
    expect(PROVIDER_CATALOG_COMMANDS.save).toBe('save_provider_model_catalog');
    expect(PROVIDER_CATALOG_COMMANDS.fetch).not.toBe('save_model_config');
  });
});
