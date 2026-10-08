import { normalizeCandidateSetSpec, planCandidateFanout } from './candidate-fanout.mjs';

const ROLES = Object.freeze(['planner', 'executor', 'verifier', 'semanticVerifier', 'critic', 'coordinator']);
const clone = (value) => structuredClone(value);
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const SELECTORS = Object.freeze(['PINNED', 'ALLOW_LIST', 'BEST_AVAILABLE', 'CANDIDATE_SET']);

const normalizeSpec = (spec, fallbackModelId) => {
  if (typeof spec === 'string') {
    if (spec === 'rule') return { kind: 'DETERMINISTIC', verifier: true };
    return { selector: 'PINNED', modelId: spec === 'default' ? fallbackModelId : spec };
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { selector: 'PINNED', modelId: fallbackModelId };
  const selector = spec.selector ?? (spec.modelId ? 'PINNED' : (Array.isArray(spec.candidateBindings) ? 'CANDIDATE_SET' : 'ALLOW_LIST'));
  if (!SELECTORS.includes(selector)) throw new Error('ROLE_BINDING_SELECTOR_INVALID');
  if (selector === 'CANDIDATE_SET') {
    // Validate the fanout contract up front; `fanout` defaults to 1 so an
    // existing single-model configuration keeps its exact behavior and cost.
    return {
      selector,
      candidateSet: normalizeCandidateSetSpec({
        mode: 'CANDIDATE_SET',
        candidateBindings: spec.candidateBindings,
        ...(spec.fanout !== undefined ? { fanout: spec.fanout } : {}),
        ...(spec.selectionPolicyRef !== undefined ? { selectionPolicyRef: spec.selectionPolicyRef } : {}),
        ...(spec.fanoutBudget !== undefined ? { fanoutBudget: spec.fanoutBudget } : {})
      })
    };
  }
  return {
    selector,
    ...(spec.modelId ? { modelId: String(spec.modelId) } : {}),
    ...(Array.isArray(spec.allowList) ? { allowList: spec.allowList.slice() } : {}),
    ...(Array.isArray(spec.requiredCapabilities) ? { requiredCapabilities: spec.requiredCapabilities.slice() } : {}),
    ...(spec.requireEligible === true ? { requireEligible: true } : {})
  };
};

/** Resolve immutable role bindings from a registry snapshot. This resolver
 * only selects already registered models; it cannot grant a capability or
 * change the executor safety ceiling.
 */
export class RoleBindingResolver {
  #registry;
  #defaultBindings;

  constructor({ registry, bindings = {} } = {}) {
    if (!registry || typeof registry.select !== 'function') throw new Error('ROLE_BINDING_REGISTRY_REQUIRED');
    this.#registry = registry;
    this.#defaultBindings = clone(bindings);
  }

  resolve({ roles = {}, taskClass = 'unknown', defaultModelId, profileRegistry, mode = 'READ_ONLY', bindings = {}, requireEligible = false, risk = 'LOW' } = {}) {
    const resolvedRoles = {};
    const rejected = [];
    // Include explicitly configured bindings even when the static route does
    // not request that role for the first attempt. Recovery may need a bound
    // alternate (for example critic as the strong-model fallback), and
    // dropping it here would silently collapse escalation back to the active
    // provider.
    const roleNames = [...new Set([...Object.keys(roles), ...Object.keys(bindings), ...Object.keys(this.#defaultBindings)])].filter((role) => ROLES.includes(role));
    for (const role of roleNames) {
      const spec = normalizeSpec(bindings[role] ?? this.#defaultBindings[role] ?? roles[role], defaultModelId);
      if (spec.kind === 'DETERMINISTIC') {
        resolvedRoles[role] = {
          role,
          kind: 'DETERMINISTIC',
          provider: 'rule',
          protocol: 'deterministic',
          selector: 'PINNED'
        };
        continue;
      }
      if (spec.selector === 'CANDIDATE_SET') {
        const plan = planCandidateFanout({ spec: spec.candidateSet, risk });
        const resolvedCandidates = [];
        const rejectedBindings = [];
        for (const binding of plan.candidateBindings) {
          const selection = this.#registry.select({
            role,
            taskClass,
            profileRegistry,
            allowedModelIds: [binding.modelId],
            requiredCapabilities: ['model.invoke.stream'],
            requireEligible: requireEligible && role === 'executor' && mode === 'CONTROLLED'
          });
          if (selection.status !== 'SELECTED') {
            rejectedBindings.push({ bindingId: binding.bindingId, modelId: binding.modelId, rejected: selection.rejected });
            continue;
          }
          const selected = selection.selected.model;
          resolvedCandidates.push({
            bindingId: binding.bindingId,
            modelId: selected.modelId,
            provider: selected.provider,
            protocol: selected.protocol,
            model: selected.model,
            ...(binding.expectedCost !== undefined ? { expectedCost: binding.expectedCost } : {}),
            ...(binding.expectedLatencyMs !== undefined ? { expectedLatencyMs: binding.expectedLatencyMs } : {}),
            ...(selection.selected.profile ? { profileId: selection.selected.profile.profileId } : {})
          });
        }
        if (!resolvedCandidates.length) {
          rejected.push({ role, selector: spec.selector, rejected: rejectedBindings });
          continue;
        }
        const [primary] = resolvedCandidates;
        resolvedRoles[role] = {
          role,
          kind: 'MODEL',
          selector: 'CANDIDATE_SET',
          modelId: primary.modelId,
          provider: primary.provider,
          protocol: primary.protocol,
          model: primary.model,
          fanout: resolvedCandidates.length,
          candidateBindings: resolvedCandidates,
          selectionPolicyRef: spec.candidateSet.selectionPolicyRef,
          candidateSetPlan: {
            requestedFanout: plan.requestedFanout,
            effectiveFanout: plan.fanout,
            risk: plan.risk,
            truncated: plan.truncated,
            truncationReasons: plan.truncationReasons,
            droppedBindingIds: plan.droppedBindingIds,
            maxConcurrency: plan.maxConcurrency
          },
          ...(rejectedBindings.length ? { rejectedCandidateBindings: rejectedBindings } : {}),
          ...(primary.profileId ? { profileId: primary.profileId } : {})
        };
        continue;
      }
      const allowedModelIds = spec.selector === 'PINNED'
        ? [spec.modelId ?? defaultModelId].filter(Boolean)
        : spec.allowList;
      const selection = this.#registry.select({
        role,
        taskClass,
        profileRegistry,
        allowedModelIds,
        requiredCapabilities: spec.requiredCapabilities ?? ['model.invoke.stream'],
        requireEligible: spec.requireEligible === true || (requireEligible && role === 'executor' && mode === 'CONTROLLED')
      });
      if (selection.status !== 'SELECTED') {
        rejected.push({ role, selector: spec.selector, rejected: selection.rejected });
        continue;
      }
      const selected = selection.selected.model;
      resolvedRoles[role] = {
        role,
        kind: 'MODEL',
        selector: spec.selector,
        modelId: selected.modelId,
        provider: selected.provider,
        protocol: selected.protocol,
        model: selected.model,
        ...(selection.selected.profile ? { profileId: selection.selected.profile.profileId } : {}),
        ...(selection.candidates.length > 1 ? { fallbackModelIds: selection.candidates.slice(1).map(({ model }) => model.modelId) } : {})
      };
    }
    return {
      status: rejected.length ? (Object.keys(resolvedRoles).length ? 'PARTIAL' : 'BLOCKED') : 'SELECTED',
      reason: rejected.length ? 'ROLE_BINDING_FALLBACK_OR_REJECTION' : 'ROLE_BINDINGS_RESOLVED',
      roles: resolvedRoles,
      rejected,
      snapshot: clone(resolvedRoles)
    };
  }
}

export const createRoleBindingResolver = (options) => new RoleBindingResolver(options);
export { ROLES as ROLE_BINDING_ROLES };
