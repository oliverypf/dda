import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoleWorkflows, validateWorkflow, roleWorkflowRefs, presentationWorkflow } from '../src/role-workflows.mjs';
import { validateModelConfig } from '../src/model-config.mjs';
import { normalizePlannerPlan, restorePlannerPlan } from '../src/agent-turns.mjs';
import { stepExecutionProfile, executionToolAllowed } from '../src/decision/bounded-judgments.mjs';

const tools = new Set(['bundled.write']);
const contributions = [
  presentationWorkflow,
  { id: 'reviewer', type: 'agent', workflow: { roles: ['planner'], instructions: 'Review requirements.' } },
  { id: 'writer', type: 'executor', workflow: { roles: ['executor'], tools: ['bundled.write'], instructions: 'Use bundled.write.' } }
];
const manifests = [{ id: 'office', contributions }];
test('role configuration binds active methods to their role and only selects relevant automatic skills', () => {
  const config = validateModelConfig({ schemaVersion: '1.0', provider: 'openai-chat', model: 'm', protocol: 'chat-completions',
    roleBindings: { planner: { agentProfile: 'office:reviewer' }, executor: { executorId: 'office:writer', skill: 'presentation-authoring' } } });
  const result = resolveRoleWorkflows({ manifests, bindings: config.roleBindings, prompt: 'Create slides.pptx', toolNames: tools });
  assert.deepEqual(result.executor.tools, ['bundled.write']);
  assert.equal(result.planner.refs.includes('office:reviewer'), true);
  assert.match(result.executor.instructions, /Use bundled.write/);
  assert.equal(resolveRoleWorkflows({ manifests, bindings: { executor: {} }, prompt: 'Read notes.txt', toolNames: tools }).executor, undefined);
  assert.equal(resolveRoleWorkflows({ manifests, bindings: { executor: {} }, prompt: 'Create slides.pptx', toolNames: tools }).executor.refs[0], 'office:presentation-authoring');
  assert.equal(resolveRoleWorkflows({ manifests, bindings: { executor: {} }, prompt: '写一个介绍这个项目的 pptx', toolNames: tools }).executor.refs[0], 'office:presentation-authoring');
  assert.throws(() => resolveRoleWorkflows({ manifests: [], bindings: config.roleBindings, prompt: '', toolNames: tools }), /UNAVAILABLE/);
  assert.throws(() => resolveRoleWorkflows({ manifests, bindings: config.roleBindings, prompt: '', toolNames: new Set() }), /UNAVAILABLE/);
  assert.throws(() => roleWorkflowRefs({ executorId: 'office:writer' }, 'planner'), /INVALID/);
  assert.doesNotThrow(() => contributions.forEach(validateWorkflow));
  assert.throws(() => validateWorkflow({ ...contributions[2], workflow: { roles: ['executor'], instructions: 'x' } }), /INVALID/);
});

test('step-specific source profiles survive checkpoint restoration and never grant write tools to research', () => {
  const initial = 'external-lookup';
  const plan = normalizePlannerPlan({ steps: [{ stepId: 'research', summary: 'Gather facts', actionKind: 'READ', evidenceSources: ['workspace', 'web'] }] });
  const step = restorePlannerPlan(plan).steps[0];
  const profile = stepExecutionProfile({ initial, step, goal: 'Gather facts', readOnly: true });
  assert.equal(executionToolAllowed(profile, 'workspace.read'), true);
  assert.equal(executionToolAllowed(profile, 'web.fetch'), true);
  assert.equal(executionToolAllowed(profile, 'shell.execute'), false);
  assert.equal(executionToolAllowed(profile, 'mcp.docs.find', { readOnly: true }), true);
  assert.equal(executionToolAllowed(profile, 'mcp.docs.update', { readOnly: false }), false);
  assert.equal(stepExecutionProfile({ initial, step: { summary: 'Read README.md' }, goal: '', readOnly: true }), 'workspace-readonly');
  assert.equal(stepExecutionProfile({ initial: 'workspace-readonly', step: { summary: 'Read the official documentation' }, goal: '', readOnly: true }), 'external-lookup');
});
