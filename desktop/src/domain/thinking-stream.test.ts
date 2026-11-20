import { describe, expect, it } from 'vitest';
import {
  consumeInlineThinkDelta,
  createThinkingStreamState,
  flushInlineThinkState,
  formatThinkingDuration,
  splitCompleteInlineThinking
} from './thinking-stream';
import { completeAllStreamingThinking, createInitialReadModel, upsertStreamingThinking } from './store';

describe('thinking-stream parser and store reducers', () => {
  it('splits chunked <think>...</think> across arbitrary token boundaries without leaking tags', () => {
    const state = createThinkingStreamState();
    const chunks = ['<thi', 'nk>先检查 Cargo.toml', '，再核对构建脚本</th', 'ink>\n\n已完成检查。'];
    let visible = '';
    let thinking = '';
    for (const chunk of chunks) {
      const part = consumeInlineThinkDelta(state, chunk);
      visible += part.visibleDelta;
      thinking += part.thinkingDelta;
    }
    const tail = flushInlineThinkState(state);
    visible += tail.visibleDelta;
    thinking += tail.thinkingDelta;
    expect(thinking).toBe('先检查 Cargo.toml，再核对构建脚本');
    expect(visible.trim()).toBe('已完成检查。');
    expect(visible).not.toContain('<think>');
  });

  it('extracts complete inline thinking blocks from non-streamed text', () => {
    const split = splitCompleteInlineThinking('<think>分析配置与路径</think>\n最终结论');
    expect(split.thinkingText).toBe('分析配置与路径');
    expect(split.visibleText).toBe('最终结论');
  });

  it('upserts and completes streaming thinking timeline items with duration', () => {
    let model = createInitialReadModel();
    model = upsertStreamingThinking(model, 'run-1-thinking-r1', '第一段思考', { runId: 'run-1', label: '思考过程' });
    model = upsertStreamingThinking(model, 'run-1-thinking-r1', '，第二段思考', { runId: 'run-1' });
    const live = model.timeline.find((i) => i.itemId === 'run-1-thinking-r1')!;
    expect(live.thinking).toBe(true);
    expect(live.status).toBe('STREAMING');
    expect(live.body).toBe('第一段思考，第二段思考');

    model = completeAllStreamingThinking(model, 'run-1');
    const done = model.timeline.find((i) => i.itemId === 'run-1-thinking-r1')!;
    expect(done.status).toBe('COMPLETE');
    expect(done.thinkingCompletedAtMs).toBeGreaterThan(0);
    expect(formatThinkingDuration(1000, 4200)).toBe('3 秒');
  });
});
