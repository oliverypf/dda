import { describe, expect, it } from 'vitest';
import {
  clarificationCardHtml,
  clarificationFailureText,
  clarificationFromPayload,
  clarificationReply,
  clarificationRunEnded
} from './clarification';

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

describe('clarification requests', () => {
  it('keeps a concrete question and its choices', () => {
    const request = clarificationFromPayload({
      requestId: 'clarify-1',
      question: ' hy 4 指哪一个？ ',
      options: [
        { optionId: 'option-1', label: '混元 4.0 API' },
        { optionId: 'option-2', label: '云实例规格' },
        { optionId: 'nope', label: '丢掉' }
      ]
    });
    expect(request).toEqual({
      requestId: 'clarify-1',
      question: 'hy 4 指哪一个？',
      options: [
        { optionId: 'option-1', label: '混元 4.0 API' },
        { optionId: 'option-2', label: '云实例规格' }
      ]
    });
  });

  it('rejects a question that has no id', () => {
    expect(clarificationFromPayload({ question: '哪一个？' })).toBeUndefined();
    expect(clarificationFromPayload({ requestId: 'clarify-1', question: '   ' })).toBeUndefined();
  });

  it('uses the clicked choice and rejects an unknown one', () => {
    const request = {
      options: [{ optionId: 'option-1', label: '混元 4.0 API' }]
    };
    expect(clarificationReply(request, { optionId: 'option-1', text: '其他' })).toEqual({
      ok: true,
      answer: '混元 4.0 API',
      selectedOptionId: 'option-1'
    });
    expect(clarificationReply(request, { optionId: 'option-9' }).ok).toBe(false);
  });

  it('accepts a typed answer and refuses an empty one', () => {
    expect(clarificationReply({ options: [] }, { text: ' 按 API 调用计费 ' })).toEqual({
      ok: true,
      answer: '按 API 调用计费'
    });
    expect(clarificationReply({ options: [] }, { text: '   ' })).toMatchObject({ ok: false });
    expect(clarificationReply({ options: [] }, { text: '字'.repeat(4001) })).toMatchObject({ ok: false });
  });

  it('renders the question as text, not as markup', () => {
    const html = clarificationCardHtml({
      requestId: 'clarify-1',
      question: '<script>alert(1)</script>',
      options: [{ optionId: 'option-1', label: 'A & B' }]
    }, escapeHtml);
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('data-option-id="option-1"');
    expect(html).toContain('A &amp; B');
    expect(html).toContain('不会批准任何操作');
  });

  it('names the failure when nobody answered', () => {
    expect(clarificationFailureText('CLARIFICATION_EXPIRED')).toContain('没有替你猜');
    expect(clarificationFailureText('OTHER')).toBeUndefined();
  });

  it('closes the question once the run can no longer continue', () => {
    expect(clarificationRunEnded('EXECUTING_READ')).toBe(false);
    expect(clarificationRunEnded(undefined)).toBe(false);
    expect(clarificationRunEnded('CANCELLED')).toBe(true);
    expect(clarificationRunEnded('FAILED')).toBe(true);
    expect(clarificationRunEnded('SUCCEEDED')).toBe(true);
    expect(clarificationRunEnded('QUARANTINED')).toBe(true);
  });
});
