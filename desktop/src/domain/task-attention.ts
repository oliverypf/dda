/**
 * Sidebar attention for a task row.
 * Approval and a live run are visible immediately. A finished task is marked
 * unseen only after this client watched it leave that active state while the
 * conversation was not open — historical rows stay seen.
 */
export type TaskAttentionState = 'approval' | 'running' | 'unseen' | 'seen';

export interface AttentionSnapshot {
  running: boolean;
  needsApproval: boolean;
}

export interface AttentionObservation {
  id: string;
  /** Ids this row used before it was bound to a saved thread. */
  aliases?: readonly string[];
  running: boolean;
  needsApproval: boolean;
  /** The conversation is open in the workbench right now. */
  viewing: boolean;
}

export const taskAttentionState = (input: {
  needsApproval: boolean;
  running: boolean;
  viewing: boolean;
  unseen: boolean;
}): TaskAttentionState => {
  if (input.needsApproval) return 'approval';
  if (input.running) return 'running';
  if (input.viewing || !input.unseen) return 'seen';
  return 'unseen';
};

export const taskAttentionLabel = (state: TaskAttentionState, failed = false): string => {
  switch (state) {
    case 'approval': return '需要授权';
    case 'running': return '正在执行';
    case 'unseen': return failed ? '已结束，尚未查看' : '已完成，尚未查看';
    case 'seen': return '已查看';
  }
};

const wasActive = (
  prior: ReadonlyMap<string, AttentionSnapshot>,
  keys: readonly string[],
): boolean => keys.some((key) => {
  const snap = prior.get(key);
  return Boolean(snap && (snap.running || snap.needsApproval));
});

/**
 * Carry unseen ids across paints. The first paint only records activity, so
 * tasks that were already finished when the window opened are not all marked.
 */
export const reconcileUnseenTasks = (
  unseen: ReadonlySet<string>,
  prior: ReadonlyMap<string, AttentionSnapshot>,
  current: readonly AttentionObservation[],
  initialized: boolean,
  pruneAbsent = false,
): { unseen: Set<string>; prior: Map<string, AttentionSnapshot> } => {
  const nextUnseen = new Set<string>();
  const nextPrior = new Map<string, AttentionSnapshot>();
  const rowIds = new Set<string>();
  for (const item of current) {
    rowIds.add(item.id);
    const keys = [item.id, ...(item.aliases ?? [])];
    const active = item.running || item.needsApproval;
    const carried = keys.some((key) => unseen.has(key));
    const finishedAway = initialized && wasActive(prior, keys) && !active && !item.viewing;
    if (!item.viewing && (carried || finishedAway)) nextUnseen.add(item.id);
    const snapshot = { running: item.running, needsApproval: item.needsApproval };
    nextPrior.set(item.id, snapshot);
    for (const alias of item.aliases ?? []) {
      if (!nextPrior.has(alias)) nextPrior.set(alias, snapshot);
    }
  }
  if (!pruneAbsent) {
    const migrated = new Set(current.flatMap((item) => item.aliases ?? []));
    for (const id of unseen) {
      if (!rowIds.has(id) && !migrated.has(id)) nextUnseen.add(id);
    }
  }
  return { unseen: nextUnseen, prior: nextPrior };
};
