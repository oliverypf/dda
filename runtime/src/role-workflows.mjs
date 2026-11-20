// Workflows describe how a role uses capabilities already granted by the host.
const roleNames = new Set(['planner', 'executor', 'critic']);
const types = { skill: 'skill', agentProfile: 'agent', executorId: 'executor' };
const refPattern = /^[a-z0-9][a-z0-9._:-]{0,239}$/iu;

export function roleWorkflowRefs(binding = {}, role) {
  const refs = {};
  for (const [key, type] of Object.entries(types)) {
    if (binding?.[key] === undefined) continue;
    if (!roleNames.has(role) || (type === 'executor' && role !== 'executor')
      || typeof binding[key] !== 'string' || !refPattern.test(binding[key])) throw new Error('ROLE_WORKFLOW_BINDING_INVALID:' + role + '.' + key);
    refs[key] = binding[key];
  }
  return refs;
}

export function validateWorkflow(contribution) {
  const workflow = contribution.workflow;
  if (workflow === undefined) return;
  const boundedList = (items, max, test) => Array.isArray(items) && items.length > 0 && items.length <= max && items.every(test);
  if (!Object.values(types).includes(contribution.type) || !workflow || typeof workflow !== 'object'
    || typeof workflow.instructions !== 'string' || !workflow.instructions.trim() || workflow.instructions.length > 2000
    || !boundedList(workflow.roles, 4, role => roleNames.has(role))
    || (workflow.matches !== undefined && !boundedList(workflow.matches, 24, v => typeof v === 'string' && v.trim().length >= 2 && v.length <= 80))
    || (workflow.tools !== undefined && !boundedList(workflow.tools, 64, v => typeof v === 'string' && refPattern.test(v)))
    || (contribution.type === 'executor' && (!workflow.tools || workflow.roles.some(role => role !== 'executor')))) {
    throw new Error('PLUGIN_ROLE_WORKFLOW_INVALID:' + contribution.id);
  }
}

export function resolveRoleWorkflows({ manifests, bindings, prompt, toolNames }) {
  const available = manifests.flatMap(manifest => manifest.contributions.filter(item => item.workflow)
    .map(item => ({ ...item, pluginId: manifest.id, ref: manifest.id + ':' + item.id })));
  const result = {};
  for (const [role, binding] of Object.entries(bindings)) {
    const eligible = available.filter(item => item.workflow.roles.includes(role)
      && (item.workflow.tools ?? []).every(name => toolNames.has(name)));
    const selected = [];
    for (const [key, type] of Object.entries(types)) {
      const ref = binding[key];
      if (!ref) continue;
      const found = eligible.filter(item => item.type === type && [item.ref, item.id, item.pluginId].includes(ref));
      if (found.length !== 1) throw new Error('ROLE_WORKFLOW_UNAVAILABLE:' + role + '.' + key + ':' + ref);
      selected.push(found[0]);
    }
    if (!binding.skill) {
      const goal = prompt.toLowerCase();
      const matching = eligible.filter(item => item.type === 'skill' && item.workflow.matches?.some(term => goal.includes(term.toLowerCase())));
      selected.push(...matching.sort((a, b) => a.ref.localeCompare(b.ref)).slice(0, 4));
    }
    if (selected.length) result[role] = {
      refs: selected.map(item => item.ref),
      instructions: selected.map(item => '[' + item.ref + '] ' + item.workflow.instructions).join('\n'),
      ...(binding.executorId ? { tools: selected.find(item => item.type === 'executor').workflow.tools } : {})
    };
  }
  return result;
}

export const presentationWorkflow = {
  id: 'presentation-authoring', type: 'skill', capabilities: [], permissions: [], permissionCeiling: 'OBSERVE',
  workflow: { roles: ['planner', 'executor'], matches: ['pptx', 'powerpoint', 'slide deck', '演示文稿', '幻灯片', '制作ppt', '生成ppt'],
    instructions: 'For a requested new PowerPoint, gather the actual requested sources first. Use a supported presentation writer in the workspace via the governed tools. Create an editable .pptx with the requested slides, concise readable text, and a sources slide when requested. Read the finished file with workspace.read to confirm its slide count, text and references. When reporting an intermediate generation step, identify the output by its workspace path. Leave process metadata in the host receipts unless the user requested it. Report any missing requirements explicitly. For a review of an existing deck, inspect the file and report findings within the requested scope.' }
};
