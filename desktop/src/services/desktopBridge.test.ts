import { expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { desktopBridge } from './desktopBridge';

vi.mock('@tauri-apps/api/core', async importOriginal => ({
  ...await importOriginal<typeof import('@tauri-apps/api/core')>(),
  invoke: vi.fn(),
  isTauri: () => true
}));

it('passes the model chosen for this submission and its session to the desktop host', async () => {
  const options = { threadId: 'thread-A', clientSessionId: 'session-A' };
  await desktopBridge.runModelTask('继续', 'composer-model', options);
  expect(invoke).toHaveBeenCalledWith('run_model_task', { prompt: '继续', model: 'composer-model', ...options });
});
