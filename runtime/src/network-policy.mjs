import { isIP } from 'node:net';
import { isPrivateNetworkAddress } from './runtime-safety-monitor.mjs';
import { isWebLookupTool } from './web-lookup.mjs';

export const PUBLIC_NETWORK_TARGET = Object.freeze({ host: '*' });

export const isNetworkUrlReviewTool = name => name === 'network.request' || name === 'browser.open' || isWebLookupTool(name);

export const networkUrlForReview = (name, request = {}) => {
  let value;
  if (name === 'browser.open') {
    value = request.url;
  } else if (name === 'network.request' || isWebLookupTool(name)) {
    const { host, scheme = 'https', port, path = '/' } = request;
    if (typeof host !== 'string' || !host || host.length > 253 || /[\s/\\@?#\u0000-\u001f\u007f]/u.test(host)
      || (host.includes(':') && isIP(host) !== 6)
      || !['https', 'http'].includes(scheme)
      || (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535))
      || typeof path !== 'string' || (path && !path.startsWith('/')) || path.length > 2048
      || /[\s\u0000-\u001f\u007f]/u.test(path)) return undefined;
    const authority = isIP(host) === 6 ? `[${host}]` : host;
    value = `${scheme}://${authority}${port === undefined ? '' : `:${port}`}${path || '/'}`;
  }
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    const hostname = url.hostname.replace(/^\[|\]$/gu, '');
    if (!['https:', 'http:'].includes(url.protocol) || isPrivateNetworkAddress(hostname)
      || /(?:^|\.)(?:localhost|local|internal)\.?$/iu.test(hostname)) return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
};

/**
 * A desktop task always requests network.request and omits --network-targets
 * until the operator types a list. That omission means public internet: the
 * model chooses the URL. An explicit value, including [], is used as written.
 * Private and local addresses are still rejected later, whatever this list says.
 */
export const resolveApprovedNetworkTargets = ({ explicitValue, capabilities = [], parseTargets } = {}) => {
  const requested = Array.isArray(capabilities) && capabilities.includes('network.request');
  if (explicitValue === undefined && requested) return [{ host: PUBLIC_NETWORK_TARGET.host }];
  if (typeof parseTargets !== 'function') throw new TypeError('NETWORK_TARGETS_PARSER_REQUIRED');
  return parseTargets(explicitValue);
};
