// DDA_JEV_PLAN_TIER_ENABLED (default OFF): multi-mode pre-planner tier.
//
// Selected BEFORE the planner turn; it only decides whether the council may
// run after the planner. The planner always runs (DIRECT does NOT skip it).
//   DIRECT       planner, no council (skipping the planner is not specified
//                yet, so DIRECT and PLAN currently have the same effect)
//   PLAN         planner, no council
//   PLAN_COUNCIL today's multi: planner, then the existing council heuristic
//                (steps > 2 or modify/test)
// A tier can therefore only remove the council, never add model turns.
// Flag off, Jev disabled/timeout/unknown choice, resumed plan, or
// DDA_JEV_TOPOLOGY_ENABLED => no tier; today's behavior is kept.
//
// CONTROLLED + modify/test: host forces PLAN_COUNCIL only. Skipping the
// council (DIRECT or PLAN) is never offered there so the quality net stays.

export const PLAN_TIERS = Object.freeze(['DIRECT', 'PLAN', 'PLAN_COUNCIL']);

/** Why the tier decision is inert for this run, or undefined when it may run. */
export const planTierInactiveReason = ({ agentMode, decisionEnabled, planTierEnabled, topologyEnabled, resumedPlan } = {}) => {
  if (planTierEnabled !== true) return 'PLAN_TIER_DISABLED';
  if (agentMode !== 'multi') return 'PLAN_TIER_SINGLE_AGENT';
  if (decisionEnabled !== true) return 'PLAN_TIER_JEV_DISABLED';
  if (resumedPlan) return 'PLAN_TIER_RESUMED_PLAN';
  // Mutually exclusive with the post-planner SELECT_TOPOLOGY decision: when
  // both are configured the established topology decision wins.
  if (topologyEnabled === true) return 'PLAN_TIER_TOPOLOGY_EXCLUSIVE';
  return undefined;
};

/** Host-filtered candidates. CONTROLLED modify/test forces PLAN_COUNCIL —
 * neither DIRECT nor PLAN is offered, so the council cannot be skipped. */
export const planTierCandidates = ({ mode, taskClass } = {}) => {
  if (mode === 'CONTROLLED' && ['modify', 'test'].includes(taskClass)) {
    return ['PLAN_COUNCIL'];
  }
  return [...PLAN_TIERS];
};

/** Map a tier onto the council decision. Unknown tier => heuristic. */
export const councilForTier = (tier, heuristic) => {
  if (tier === 'DIRECT' || tier === 'PLAN') return false;
  return heuristic === true;
};
