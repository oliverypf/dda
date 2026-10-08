import { appendFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const validateGoalPricing = pricing => {
  if (!pricing || pricing.schemaVersion !== '1.0' || !pricing.model || !pricing.source
    || !['API_PRICE', 'SUBSCRIPTION_QUOTA'].includes(pricing.basis) || pricing.currency !== 'USD'
    || !Number.isFinite(Date.parse(pricing.checkedAt))) throw Error('GOAL_PRICING_INVALID');
  for (const field of ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion']) {
    if (!Number.isFinite(pricing[field]) || pricing[field] < 0) throw Error(`GOAL_PRICING_INVALID:${field}`);
  }
  return structuredClone(pricing);
};

export const priceGoalUsage = (usage, rawPricing) => {
  if (!rawPricing) return { value: null, reason: 'PRICE_SOURCE_MISSING' };
  const pricing = validateGoalPricing(rawPricing);
  const { inputTokens, outputTokens, cachedInputTokens } = usage;
  if (![inputTokens, outputTokens, cachedInputTokens].every(value => Number.isInteger(value) && value >= 0)
    || cachedInputTokens > inputTokens) return { value: null, reason: 'USAGE_UNKNOWN_OR_INVALID', pricing };
  const components = {
    uncachedInput: (inputTokens - cachedInputTokens) * pricing.inputPerMillion / 1e6,
    cachedInput: cachedInputTokens * pricing.cachedInputPerMillion / 1e6,
    output: outputTokens * pricing.outputPerMillion / 1e6
  };
  return { value: Object.values(components).reduce((sum, value) => sum + value, 0),
    basis: pricing.basis, currency: pricing.currency, components, pricing };
};

export const measureInterventions = (events, { mode = 'HEADLESS', runKey, startedAtMs, endedAtMs } = {}) => {
  if (!['HEADLESS', 'OPERATOR'].includes(mode) || !Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)
    || endedAtMs < startedAtMs) throw Error('INTERVENTION_WINDOW_INVALID');
  const ids = new Set(), active = new Map(), intervals = [];
  let incomplete = false, automationEvents = 0;
  for (const event of [...events].filter(event => event.runKey === runKey).sort((a, b) => a.atMs - b.atMs)) {
    if (!event.eventId || ids.has(event.eventId)) continue;
    ids.add(event.eventId);
    if (!['HUMAN', 'AUTOMATION'].includes(event.actor) || !['START', 'END'].includes(event.phase)
      || !event.activityId || !Number.isFinite(event.atMs)) throw Error('INTERVENTION_EVENT_INVALID');
    if (event.actor === 'AUTOMATION') { automationEvents++; continue; }
    if (mode === 'HEADLESS') throw Error('HUMAN_EVENT_IN_HEADLESS_RUN');
    if (event.atMs < startedAtMs || event.atMs > endedAtMs) throw Error('INTERVENTION_EVENT_OUTSIDE_RUN');
    if (event.phase === 'START') {
      if (active.has(event.activityId)) throw Error('INTERVENTION_DUPLICATE_START');
      active.set(event.activityId, event.atMs);
    } else if (active.has(event.activityId)) {
      intervals.push([active.get(event.activityId), event.atMs]);
      active.delete(event.activityId);
    } else incomplete = true;
  }
  if (active.size) incomplete = true;
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  const unobserved = mode === 'OPERATOR' && merged.length === 0;
  return { minutes: incomplete || unobserved ? null : merged.reduce((sum, [start, end]) => sum + (end - start) / 60000, 0),
    measurement: mode === 'HEADLESS' ? 'NO_HUMAN_CHANNEL' : incomplete ? 'INCOMPLETE_ACTIVITY_LEDGER' : unobserved ? 'NO_HUMAN_ACTIVITY_EVIDENCE' : 'OBSERVED_HUMAN_ACTIVE_TIME',
    intervals: merged, automationEvents, events: ids.size };
};

export const readInterventionLedger = async path => {
  if (!path) return [];
  return (await readFile(path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
};

export const reconcileGoalBilling = (entries, { runKey, model, modelCalls } = {}) => {
  const charges = new Map();
  for (const entry of entries.filter(entry => entry.runKey === runKey)) {
    if (entry.schemaVersion !== '1.0' || entry.model !== model || entry.currency !== 'USD'
      || !entry.chargeId || !entry.source || !Number.isFinite(entry.amount) || entry.amount < 0
      || !['FULL_RUN', 'PER_CALL'].includes(entry.coverage)
      || (entry.coverage === 'PER_CALL' && (!Number.isInteger(entry.sequence) || entry.sequence < 1 || entry.sequence > modelCalls))) {
      throw Error('BILLING_IMPORT_INVALID');
    }
    const previous = charges.get(entry.chargeId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) throw Error('BILLING_CHARGE_CONFLICT');
    charges.set(entry.chargeId, entry);
  }
  const rows = [...charges.values()];
  const full = rows.filter(row => row.coverage === 'FULL_RUN');
  if (full.length > 1 || (full.length && rows.length > 1)) throw Error('BILLING_COVERAGE_CONFLICT');
  const sequences = new Set(rows.map(row => row.sequence));
  const covered = full.length === 1 || (modelCalls > 0 && sequences.size === modelCalls);
  const sum = rows.reduce((value, row) => value + row.amount, 0);
  return { amount: covered ? sum : null, partialAmount: rows.length ? sum : null,
    coverage: covered ? 'FULL_RUN' : rows.length ? 'PARTIAL' : 'UNKNOWN',
    measurement: rows.length ? 'OPERATOR_IMPORTED_BILLING' : 'NO_INVOICE_SOURCE', sources: rows };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , path, runKey, activityId, phase, actor = 'HUMAN'] = process.argv;
  if (!path || !runKey || !activityId || !['START', 'END'].includes(phase) || !['HUMAN', 'AUTOMATION'].includes(actor)) {
    throw Error('Usage: node goal-measurements.mjs ledger.jsonl runKey activityId START|END [HUMAN|AUTOMATION]');
  }
  const event = { eventId: randomUUID(), runKey, activityId, phase, actor, atMs: Date.now() };
  await appendFile(resolve(path), `${JSON.stringify(event)}\n`);
  console.log(JSON.stringify(event));
}
