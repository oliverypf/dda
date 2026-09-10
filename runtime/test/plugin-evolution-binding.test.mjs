import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginGovernance } from '../src/plugin-governance.mjs';
import { EvolutionRegistry } from '../src/plugins/evolution-registry.mjs';
import { EvolutionEvaluator } from '../src/evolution-evaluator.mjs';

const manifest = {
  schemaVersion: '1.0',
  id: 'bound-plugin',
  name: 'Bound Plugin',
  version: '1.0.0',
  contributions: [{ id: 'bound-plugin.contribution', type: 'skill', capabilities: [], permissions: [] }]
};

test('strict plugin governance requires a verified evaluator promotion credential', async () => {
  const evolutionRegistry = new EvolutionRegistry({ idFactory: () => 'binding' });
  const evaluator = new EvolutionEvaluator({ registry: evolutionRegistry, idFactory: () => 'binding' });
  const governance = new PluginGovernance({
    requireEvaluation: true,
    evaluationVerifier: ({ plugin, evidence }) => evaluator.verifyPluginPromotion({
      ...evidence,
      pluginId: plugin.pluginId,
      packageDigest: plugin.packageDigest
    })
  });
  const plugin = governance.discover(manifest);
  governance.transition(plugin.pluginId, 'VALIDATING');
  governance.transition(plugin.pluginId, 'INSTALLED');
  governance.transition(plugin.pluginId, 'ENABLED');
  assert.throws(() => governance.transition(plugin.pluginId, 'ACTIVE'), /PLUGIN_EVALUATION_REQUIRED/);

  const proposal = await evolutionRegistry.propose({
    candidateId: plugin.pluginId,
    pluginId: plugin.pluginId,
    packageDigest: plugin.packageDigest,
    version: plugin.version
  });
  const fixtures = [{
    caseId: 'plugin-case',
    baseline: { status: 'FAILED' },
    candidate: { status: 'SUCCEEDED' }
  }];
  await evaluator.shadow({ proposalId: proposal.proposalId, fixtures });
  await evaluator.canary(proposal.proposalId, { fixtures, eligibleTrafficPercent: 5 });
  await evaluator.promote(proposal.proposalId);
  const report = evaluator.latest(proposal.proposalId, 'CANARY');
  assert.ok(report);

  const credential = {
    reportId: report.reportId,
    reportDigest: report.reportDigest,
    pluginId: plugin.pluginId,
    packageDigest: plugin.packageDigest
  };
  assert.throws(() => governance.transition(plugin.pluginId, 'ACTIVE', {
    evaluation: { ...credential, reportDigest: 'sha256:forged' }
  }), /PLUGIN_EVALUATION_INVALID/);
  assert.throws(() => governance.transition(plugin.pluginId, 'ACTIVE', {
    evaluation: { ...credential, pluginId: 'other-plugin' }
  }), /PLUGIN_EVALUATION_BINDING_MISMATCH/);
  const active = governance.transition(plugin.pluginId, 'ACTIVE', { evaluation: credential });
  assert.equal(active.state, 'ACTIVE');
  assert.deepEqual(active.transition.metadata.evaluation, credential);
  assert.equal(governance.assertLoadable(plugin.pluginId).state, 'ACTIVE');
  await evaluator.rollback(proposal.proposalId);
  assert.throws(() => governance.assertLoadable(plugin.pluginId), /PLUGIN_EVALUATION_INVALID/);
});

test('non-strict plugin governance keeps the legacy lifecycle API', () => {
  const governance = new PluginGovernance();
  const plugin = governance.discover(manifest);
  governance.transition(plugin.pluginId, 'VALIDATING');
  governance.transition(plugin.pluginId, 'INSTALLED');
  governance.transition(plugin.pluginId, 'ENABLED');
  assert.equal(governance.transition(plugin.pluginId, 'ACTIVE').state, 'ACTIVE');
});
