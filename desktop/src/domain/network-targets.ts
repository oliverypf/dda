import type { NetworkTargetOption } from './models';

export const PUBLIC_NETWORK_TARGET: NetworkTargetOption = { host: '*' };

/** Blank text means public internet. An explicit list, including [], is kept. Invalid text stays closed. */
export const effectiveLeaseNetworkTargets = (text: string, parsed: NetworkTargetOption[], error: string): NetworkTargetOption[] => {
  if (error || text.trim()) return parsed.map((target) => ({ ...target }));
  return [{ ...PUBLIC_NETWORK_TARGET }];
};

export const networkAccessSummary = (text: string, parsed: NetworkTargetOption[], error: string): { open: boolean; label: string } => {
  if (error) return { open: false, label: '名单无效，本次不开放' };
  if (!text.trim()) return { open: true, label: '默认开放公网 · 模型选择网址' };
  if (!parsed.length) return { open: false, label: '已关闭' };
  return { open: true, label: `仅这些网站 · ${parsed.map((target) => target.host).join(', ')}` };
};

const NETWORK_TARGET_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'];

export const parseNetworkTargetsText = (value: string): { targets: NetworkTargetOption[]; error: string } => {
  const text = value.trim();
  if (!text) return { targets: [], error: '' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { targets: [], error: '格式无效：需要 JSON 数组' };
  }
  if (!Array.isArray(parsed) || parsed.length > 32) {
    return { targets: [], error: '格式无效：最多 32 个目标对象' };
  }
  const targets: NetworkTargetOption[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { targets: [], error: '格式无效：目标必须是对象' };
    const target = item as Record<string, unknown>;
    const host = typeof target.host === 'string' ? target.host.trim().toLowerCase() : '';
    if (!host || host.length > 253 || /[\s/\\@?#]/u.test(host)) return { targets: [], error: `host 无效：${JSON.stringify(target.host ?? '')}` };
    if (target.port !== undefined && (!Number.isInteger(target.port) || (target.port as number) < 1 || (target.port as number) > 65535)) {
      return { targets: [], error: `port 无效：${String(target.port)}` };
    }
    if (target.scheme !== undefined && target.scheme !== 'https' && target.scheme !== 'http') {
      return { targets: [], error: `scheme 无效：${String(target.scheme)}` };
    }
    if (target.methods !== undefined
      && (!Array.isArray(target.methods) || target.methods.length === 0
        || target.methods.some((method) => !NETWORK_TARGET_METHODS.includes(String(method))))) {
      return { targets: [], error: 'methods 无效' };
    }
    targets.push({
      host,
      ...(target.port !== undefined ? { port: target.port as number } : {}),
      ...(target.scheme !== undefined ? { scheme: target.scheme as 'https' | 'http' } : {}),
      ...(target.methods !== undefined ? { methods: target.methods.map(String) } : {})
    });
  }
  return { targets, error: '' };
};
