// Upstream identifiers help join a later provider export to an inference.
// They are not invoices, proof of payment or a source for a cash amount.
const identifier = value => typeof value === 'string'
  && /^[A-Za-z0-9_.:/-]{1,240}$/u.test(value) ? value : null;

export const goalRequestCorrelation = (response, payload) => {
  const upstreamRequestIds = {};
  for (const name of ['x-request-id', 'request-id', 'x-amzn-requestid', 'x-correlation-id']) {
    const value = identifier(response?.headers?.get?.(name));
    if (value) upstreamRequestIds[name] = value;
  }
  const upstreamResponseId = identifier(payload?.id);
  return { upstreamRequestIds, upstreamResponseId,
    correlationMeasurement: Object.keys(upstreamRequestIds).length || upstreamResponseId ? 'UPSTREAM_RETURNED_IDS' : 'NOT_PROVIDED' };
};
