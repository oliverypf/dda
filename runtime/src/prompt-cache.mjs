import { createHash } from 'node:crypto';

// Provider prompt caching reuses an identical prefix, never an execution result.
// Keep all arrays except the unordered tool catalogue in their original order.
const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
};
export const cacheDigest = (value) => createHash('sha256').update(JSON.stringify(canonicalValue(value)) ?? 'null').digest('hex');
export const stableToolDefinitions = (tools) => Array.isArray(tools)
  ? tools.map(canonicalValue).sort((a, b) => {
      const left = JSON.stringify(a), right = JSON.stringify(b);
      return left < right ? -1 : left > right ? 1 : 0;
    }) : tools;

// A hashed scope partitions provider routing, and never carries a path, prompt,
// credential or thread id in a request header. It grants no permission.
export const cacheSessionId = ({ scope, endpoint, model, role, system, tools }) => {
  const hash = cacheDigest({ version: 1, scope, endpoint, model, role, system, tools: stableToolDefinitions(tools ?? []) });
  return hash.slice(0, 8) + '-' + hash.slice(8, 12) + '-' + hash.slice(12, 16) + '-' + hash.slice(16, 20) + '-' + hash.slice(20, 32);
};
export const prefixShape = (request) => ({
  systemDigest: cacheDigest(request.system ?? ''),
  toolsDigest: cacheDigest(stableToolDefinitions(request.tools ?? [])),
  // Only provider-visible first-message content, not local source/turn IDs.
  firstMessageDigest: cacheDigest(request.messages?.[0]?.content ?? [])
});
export const comparePrefixShapes = (previous, current) => previous
  ? Object.keys(current).filter((key) => previous[key] !== current[key])
  : [];
