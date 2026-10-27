/**
 * Poison-loop counter for DDA bench jsonl.
 *
 * A poison loop instance is: after ≥1 harness.diagnose_probe_exhausted_recover,
 * a topology.upgraded PLAN_THEN_EXECUTE → DIAGNOSE_PROBE_RECOVER whose failure
 * evidence is probe-budget-only (TOPOLOGY_BUDGET_PROBES / ACTION_FAILED with that
 * in the actions.progress message).
 */

export const PROBE_BUDGET_ONLY_CODES = new Set([
  'ACTION_FAILED',
  'JEV_BEHAVIOR_REJECTED',
  'TOPOLOGY_BUDGET_PROBES',
]);

/**
 * @param {object} payload topology.upgraded payload
 * @param {object|null} lastVerification verification.completed payload (most recent before upgrade)
 * @returns {boolean}
 */
export function isProbeBudgetOnlyFailure(payload, lastVerification) {
  const codes = new Set(payload?.failureCodes || []);
  if (codes.size === 0) return false;
  if (![...codes].every((c) => PROBE_BUDGET_ONLY_CODES.has(c))) return false;

  const blobParts = [];
  blobParts.push(...(payload?.failureCodes || []));
  if (lastVerification) {
    blobParts.push(...(lastVerification.failureCodes || []));
    blobParts.push(lastVerification.summary || '');
    for (const check of lastVerification.checks || []) {
      blobParts.push(check?.id || '', check?.message || '', ...(check?.evidence || []));
    }
  }
  const blob = blobParts.join('\n');
  return blob.includes('TOPOLOGY_BUDGET_PROBES');
}

/**
 * @param {Iterable<object>} events runtime_event objects (or raw jsonl objects)
 * @returns {{ count: number, instances: object[], dprCount: number, stickyCount: number, timeline: object[] }}
 */
export function countPoisonLoops(events) {
  let seenDpr = 0;
  let stickyCount = 0;
  /** @type {object|null} */
  let lastVerification = null;
  /** @type {object[]} */
  const instances = [];
  /** @type {object[]} */
  const timeline = [];

  for (const raw of events) {
    if (!raw || raw.type !== 'runtime_event') continue;
    const kind = raw.kind;
    const payload = raw.payload || {};
    const seq = raw.sequence;
    const at = raw.emittedAtMs;

    if (kind === 'harness.diagnose_probe_exhausted_recover') {
      seenDpr += 1;
      timeline.push({
        kind: 'diagnose_probe_exhausted_recover',
        sequence: seq,
        emittedAtMs: at,
        recoverOrdinal: payload.recoverOrdinal,
        from: payload.fromTopology,
        to: payload.toTopology,
      });
      continue;
    }

    if (kind === 'harness.post_dpr_sticky_execute') {
      stickyCount += 1;
      timeline.push({
        kind: 'post_dpr_sticky_execute',
        sequence: seq,
        emittedAtMs: at,
        payload,
      });
      continue;
    }

    if (kind === 'topology.budget_blocked') {
      timeline.push({
        kind: 'budget_blocked',
        sequence: seq,
        emittedAtMs: at,
        reasonCode: payload.reasonCode,
        name: payload.name,
        topology: payload.topology,
      });
      continue;
    }

    if (kind === 'verification.completed') {
      lastVerification = payload;
      timeline.push({
        kind: 'verification.completed',
        sequence: seq,
        emittedAtMs: at,
        status: payload.status,
        failureCodes: payload.failureCodes || [],
      });
      continue;
    }

    if (kind === 'topology.upgraded') {
      const from = payload.from;
      const to = payload.to;
      timeline.push({
        kind: 'topology.upgraded',
        sequence: seq,
        emittedAtMs: at,
        from,
        to,
        failureCodes: payload.failureCodes || [],
        attempt: payload.attempt,
      });

      if (
        seenDpr >= 1 &&
        from === 'PLAN_THEN_EXECUTE' &&
        to === 'DIAGNOSE_PROBE_RECOVER' &&
        isProbeBudgetOnlyFailure(payload, lastVerification)
      ) {
        instances.push({
          sequence: seq,
          emittedAtMs: at,
          from,
          to,
          failureCodes: payload.failureCodes || [],
          afterDprCount: seenDpr,
          progressMessage: (lastVerification?.checks || []).find((c) => c.id === 'actions.progress')
            ?.message,
        });
      }
    }
  }

  return {
    count: instances.length,
    instances,
    dprCount: seenDpr,
    stickyCount,
    timeline,
  };
}

/**
 * Scriptable win gate: verification/exit green AND poison loop count == 0.
 * Green without loop zero = false win (do not adopt).
 *
 * @param {{ exitOk?: boolean, summaryOk?: boolean, verificationPass?: boolean, poisonLoopCount: number }} metrics
 */
export function evaluateWin(metrics) {
  const exitOk = metrics.exitOk !== false;
  const summaryOk = metrics.summaryOk !== false;
  const verificationPass = metrics.verificationPass === true;
  const poisonLoopCount = Number(metrics.poisonLoopCount) || 0;
  const green =
    exitOk && summaryOk && (verificationPass || metrics.allowGreenWithoutVerification === true);
  const loopZero = poisonLoopCount === 0;

  if (green && loopZero) {
    return { win: true, falseWin: false, reason: 'green_and_poison_loop_zero' };
  }
  if (green && !loopZero) {
    return {
      win: false,
      falseWin: true,
      reason: 'false_win_green_but_poison_loop_nonzero',
      poisonLoopCount,
    };
  }
  return {
    win: false,
    falseWin: false,
    reason: loopZero ? 'not_green' : 'not_green_and_poison_loop_nonzero',
    poisonLoopCount,
  };
}
