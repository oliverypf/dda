import { describe, expect, it } from 'vitest';

import {
  emptyVerifierFormValues,
  formatVerifierFormValues,
  parseVerifierFormValues,
  type ContinuousVerifierConfig
} from './verifier-config';

const form = (overrides: Record<string, string>): Record<string, string> => ({
  ...emptyVerifierFormValues(),
  ...overrides
});

describe('continuous verifier configuration form', () => {
  it('treats an untouched form as no verifier section', () => {
    expect(parseVerifierFormValues(emptyVerifierFormValues())).toEqual({ ok: true, verifier: undefined });
    expect(parseVerifierFormValues(form({ verifierCriteria: '\n   \n' }))).toEqual({ ok: true, verifier: undefined });
  });

  it('parses every documented budget field', () => {
    const result = parseVerifierFormValues(form({
      verifierCriteria: ' Spec check \nOutput matches\n',
      verifierRepetitions: '3',
      verifierMaxComparisons: '64',
      verifierPivots: '4',
      verifierSeed: 'release-2026-09',
      verifierMaxPromptChars: '120000',
      verifierPassThreshold: '0.95',
      verifierFailThreshold: '0.4'
    }));
    expect(result).toEqual({
      ok: true,
      verifier: {
        criteria: ['Spec check', 'Output matches'],
        repetitions: 3,
        maxComparisons: 64,
        pivots: 4,
        seed: 'release-2026-09',
        maxPromptChars: 120000,
        passThreshold: 0.95,
        failThreshold: 0.4
      }
    });
  });

  it('omits only the fields the operator left blank', () => {
    const result = parseVerifierFormValues(form({ verifierRepetitions: '5' }));
    expect(result).toEqual({ ok: true, verifier: { repetitions: 5 } });
  });

  it('refuses values the runtime normaliser would reject', () => {
    const cases: Array<[string, string, string]> = [
      ['verifierRepetitions', '0', '重复次数'],
      ['verifierRepetitions', '2.5', '重复次数'],
      ['verifierMaxComparisons', '513', '最大比较数'],
      ['verifierPivots', '9', '支点数'],
      ['verifierMaxPromptChars', '1023', '提示长度上限'],
      ['verifierMaxPromptChars', 'abc', '提示长度上限'],
      ['verifierPassThreshold', '1.2', 'PASS 阈值'],
      ['verifierFailThreshold', '-0.1', 'FAIL 阈值']
    ];
    for (const [field, value, expected] of cases) {
      const result = parseVerifierFormValues(form({ [field]: value }));
      expect(result.ok, `${field}=${value}`).toBe(false);
      if (!result.ok) expect(result.error).toContain(expected);
    }
  });

  it('refuses an inverted threshold pair even when only one side is typed', () => {
    // The runtime normalises the omitted side to its default (0.9 / 0.5) before
    // it checks the ordering, so 0.4 as a lone PASS threshold is invalid.
    const result = parseVerifierFormValues(form({ verifierPassThreshold: '0.4' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('PASS 阈值必须大于 FAIL 阈值');
  });

  it('refuses more criteria than the runtime accepts', () => {
    const tooMany = Array.from({ length: 9 }, (_, index) => `criterion-${index}`).join('\n');
    const result = parseVerifierFormValues(form({ verifierCriteria: tooMany }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('最多 8 条');

    const tooLong = 'a'.repeat(1001);
    const longResult = parseVerifierFormValues(form({ verifierCriteria: tooLong }));
    expect(longResult.ok).toBe(false);

    const longSeed = parseVerifierFormValues(form({ verifierSeed: 's'.repeat(201) }));
    expect(longSeed.ok).toBe(false);
  });

  it('round-trips a stored verifier section through the form', () => {
    const stored: ContinuousVerifierConfig = {
      criteria: ['Specification: satisfies the task requirements', 'Errors: no failure signals'],
      repetitions: 2,
      maxComparisons: 32,
      pivots: 2,
      seed: 'verifier-v1',
      maxPromptChars: 60000,
      passThreshold: 0.9,
      failThreshold: 0.5
    };
    expect(parseVerifierFormValues(formatVerifierFormValues(stored))).toEqual({ ok: true, verifier: stored });
    expect(formatVerifierFormValues(undefined)).toEqual(emptyVerifierFormValues());
  });
});
