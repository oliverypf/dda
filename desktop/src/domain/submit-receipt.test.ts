import { describe, expect, it } from 'vitest';
import mainSource from '../main.ts?raw';

describe('submit receipt card removed from the task timeline', () => {
  it('no longer renders 提交回执 or the receipt live region', () => {
    expect(mainSource).not.toContain('提交回执');
    expect(mainSource).not.toContain('data-live-region="receipt"');
    expect(mainSource).not.toContain("slot('receipt')");
    expect(mainSource).not.toContain('class="submit-receipt');
  });
  it('keeps receipt state bookkeeping (used by evidence checks)', () => {
    expect(mainSource).toContain('lastSubmitReceipt');
    expect(mainSource).toMatch(/SubmitReceiptStatus = 'pending' \| 'accepted' \| 'rejected' \| 'unconfirmed'/);
  });
});
