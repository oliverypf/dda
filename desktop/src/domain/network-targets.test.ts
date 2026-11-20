import { describe, expect, it } from 'vitest';
import { effectiveLeaseNetworkTargets, networkAccessSummary, parseNetworkTargetsText } from './network-targets';

describe('parseNetworkTargetsText', () => {
  it('returns no targets for empty text', () => {
    expect(parseNetworkTargetsText('')).toEqual({ targets: [], error: '' });
    expect(parseNetworkTargetsText('   ')).toEqual({ targets: [], error: '' });
  });

  it('parses a valid allowlist and normalizes the host', () => {
    const result = parseNetworkTargetsText('[{"host":"API.Example.com","port":8443,"scheme":"https","methods":["GET","POST"]}]');
    expect(result.error).toBe('');
    expect(result.targets).toEqual([{ host: 'api.example.com', port: 8443, scheme: 'https', methods: ['GET', 'POST'] }]);
  });

  it('rejects malformed JSON and non-object entries', () => {
    expect(parseNetworkTargetsText('not json').error).toContain('JSON');
    expect(parseNetworkTargetsText('["host"]').error).toContain('对象');
    expect(parseNetworkTargetsText('[]').targets).toEqual([]);
  });

  it('opens public internet when the box is blank and keeps an explicit list', () => {
    expect(effectiveLeaseNetworkTargets('', [], '')).toEqual([{ host: '*' }]);
    expect(effectiveLeaseNetworkTargets('   ', [], '').map((target) => target.host)).toEqual(['*']);
    expect(effectiveLeaseNetworkTargets('[]', [], '')).toEqual([]);
    expect(effectiveLeaseNetworkTargets('[{"host":"cloud.tencent.com"}]', [{ host: 'cloud.tencent.com' }], '')).toEqual([{ host: 'cloud.tencent.com' }]);
    expect(effectiveLeaseNetworkTargets('{bad', [], '格式无效：需要 JSON 数组')).toEqual([]);
    expect(networkAccessSummary('', [], '')).toEqual({ open: true, label: '默认开放公网 · 模型选择网址' });
    expect(networkAccessSummary('[]', [], '').open).toBe(false);
    expect(networkAccessSummary('{bad', [], '格式无效：需要 JSON 数组').open).toBe(false);
  });

  it('rejects invalid host, port, scheme and methods', () => {
    expect(parseNetworkTargetsText('[{"host":"a b"}]').error).toContain('host');
    expect(parseNetworkTargetsText('[{"host":"ok","port":0}]').error).toContain('port');
    expect(parseNetworkTargetsText('[{"host":"ok","scheme":"ftp"}]').error).toContain('scheme');
    expect(parseNetworkTargetsText('[{"host":"ok","methods":["BREW"]}]').error).toContain('methods');
  });
});
