#!/usr/bin/env node
// Add subsequently available invoices/activity to a new derived report.
// Original runs, raw evidence and append-only history remain untouched.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readInterventionLedger, reconcileGoalBilling, measureInterventions } from './goal-measurements.mjs';
import { summarizeGoalRuns } from './goal-evidence-harness.mjs';

export const reconcileGoalReport = (source, { billingEntries, decisionBillingEntries, interventionEvents } = {}) => {
  const report = structuredClone(source);
  if (report.mode !== 'live' || !Array.isArray(report.rows) || !report.rows.length) throw Error('RECONCILIATION_REQUIRES_LIVE_REPORT');
  for (const row of report.rows) {
    row.originalMeasurements = { actualCost: row.actualCost, billing: row.billing, decisionProvider: structuredClone(row.decisionProvider),
      manualInterventionMinutes: row.manualInterventionMinutes, manualMeasurement: row.manualMeasurement,
      interventionMeasurement: row.interventionMeasurement, interventions: row.interventions };
    if (billingEntries) {
      row.billing = reconcileGoalBilling(billingEntries, { runKey: row.runKey, model: row.model, modelCalls: row.modelCalls });
      row.actualCost = row.billing.amount;
    }
    if (row.decisionProvider?.mode === 'LIVE_JEV') {
      const provider = row.decisionProvider;
      const languageCost = row.billing?.amount ?? row.languageModelActualCost ?? row.originalMeasurements.actualCost;
      if (provider.calls === 0 && decisionBillingEntries?.some(entry => entry.runKey === row.runKey)) throw Error('DECISION_BILLING_WITHOUT_DECISION_CALLS');
      if (decisionBillingEntries) provider.billing = reconcileGoalBilling(decisionBillingEntries, {
        runKey: row.runKey, model: provider.requestedModel ?? 'jev-latest', modelCalls: provider.calls
      });
      provider.actualCost = provider.calls === 0 ? 0 : provider.billing?.amount ?? null;
      row.languageModelActualCost = languageCost ?? null;
      row.actualCost = Number.isFinite(languageCost) && Number.isFinite(provider.actualCost) ? languageCost + provider.actualCost : null;
      row.costScope = 'ALL_EXTERNAL_PROVIDERS; PUBLISHED_USAGE_ESTIMATES_REMAIN_SEPARATE';
    } else if (decisionBillingEntries?.some(entry => entry.runKey === row.runKey)) throw Error('DECISION_BILLING_WITHOUT_DECISION_CALLS');
    if (interventionEvents) {
      const human = measureInterventions(interventionEvents, { mode: row.manualMeasurement === 'NO_HUMAN_CHANNEL' ? 'HEADLESS' : 'OPERATOR',
        runKey: row.runKey, startedAtMs: row.startedAtMs, endedAtMs: row.endedAtMs });
      row.manualInterventionMinutes = human.minutes; row.manualMeasurement = human.measurement;
      row.interventionMeasurement = human;
      row.interventions = interventionEvents.filter(event => event.runKey === row.runKey);
    }
  }
  report.conditions = Object.fromEntries(Object.keys(report.conditions).map(condition => [condition, summarizeGoalRuns(report.rows, condition)]));
  const matched = new Set(report.rows.map(row => row.runKey));
  report.reconciliation = { generatedAt: new Date().toISOString(),
    unmatchedRunKeys: [...new Set([...(billingEntries ?? []), ...(decisionBillingEntries ?? []), ...(interventionEvents ?? [])].map(row => row.runKey).filter(key => !matched.has(key)))] };
  return report;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
  const sourcePath = option('--report'), output = option('--output');
  if (!sourcePath || !output || resolve(sourcePath) === resolve(output)
    || (!option('--billing-ledger') && !option('--decision-billing-ledger') && !option('--interventions-ledger'))) throw Error('Use --report source.json --output NEW-report.json and a billing/activity ledger');
  const raw = await readFile(resolve(sourcePath));
  const report = reconcileGoalReport(JSON.parse(raw), {
    billingEntries: option('--billing-ledger') ? await readInterventionLedger(option('--billing-ledger')) : undefined,
    decisionBillingEntries: option('--decision-billing-ledger') ? await readInterventionLedger(option('--decision-billing-ledger')) : undefined,
    interventionEvents: option('--interventions-ledger') ? await readInterventionLedger(option('--interventions-ledger')) : undefined
  });
  Object.assign(report.reconciliation, { sourceReport: resolve(sourcePath), sourceSha256: createHash('sha256').update(raw).digest('hex') });
  await mkdir(dirname(resolve(output)), { recursive: true });
  await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ output: resolve(output), conditions: report.conditions, reconciliation: report.reconciliation }));
}
