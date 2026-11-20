import { describe, expect, it } from 'vitest';
import {
  composerChoiceBindsSession,
  readTaskComposerModels,
  resolveTaskComposerModel
} from './task-composer-model';

describe('readTaskComposerModels', () => {
  it('keeps thread ids mapped to model ids and drops junk', () => {
    const parsed = readTaskComposerModels(JSON.stringify({
      'thread-a': 'deepseek-v4.1-flash',
      '  thread-b  ': '  glm  ',
      '': 'nope',
      'thread-c': '',
      'thread-d': 3,
      ['x'.repeat(201)]: 'too-long'
    }));
    expect(parsed).toEqual({
      'thread-a': 'deepseek-v4.1-flash',
      'thread-b': 'glm'
    });
  });

  it('returns an empty map when storage is missing or not an object', () => {
    expect(readTaskComposerModels(null)).toEqual({});
    expect(readTaskComposerModels('[]')).toEqual({});
    expect(readTaskComposerModels('{')).toEqual({});
  });
});

describe('resolveTaskComposerModel', () => {
  it('prefers the session choice, then the thread memory, then the default', () => {
    expect(resolveTaskComposerModel({
      sessionModelId: 'session-model',
      rememberedModelId: 'thread-model',
      defaultModelId: 'default-model'
    })).toBe('session-model');
    expect(resolveTaskComposerModel({
      rememberedModelId: 'thread-model',
      defaultModelId: 'default-model'
    })).toBe('thread-model');
    expect(resolveTaskComposerModel({ defaultModelId: 'default-model' })).toBe('default-model');
    expect(resolveTaskComposerModel({})).toBe('');
  });

  it('uses the history thread model instead of an unrelated session', () => {
    expect(resolveTaskComposerModel({
      sessionModelId: 'session-a',
      sessionThreadId: 'thread-a',
      historyThreadId: 'thread-b',
      rememberedModelId: 'model-b',
      defaultModelId: 'default-model'
    })).toBe('model-b');
    expect(resolveTaskComposerModel({
      sessionModelId: 'session-a',
      sessionThreadId: 'thread-a',
      historyThreadId: 'thread-b',
      defaultModelId: 'default-model'
    })).toBe('default-model');
  });

  it('keeps the session choice while viewing that same thread', () => {
    expect(resolveTaskComposerModel({
      sessionModelId: 'session-a',
      sessionThreadId: 'thread-a',
      historyThreadId: 'thread-a',
      rememberedModelId: 'older',
      defaultModelId: 'default-model'
    })).toBe('session-a');
  });
});

describe('composerChoiceBindsSession', () => {
  it('binds a normal pick, and a history pick only when the session owns that thread', () => {
    expect(composerChoiceBindsSession(undefined, undefined)).toBe(true);
    expect(composerChoiceBindsSession('thread-a', undefined)).toBe(true);
    expect(composerChoiceBindsSession('thread-a', 'thread-a')).toBe(true);
    expect(composerChoiceBindsSession('thread-a', 'thread-b')).toBe(false);
    expect(composerChoiceBindsSession(undefined, 'thread-b')).toBe(false);
  });
});
