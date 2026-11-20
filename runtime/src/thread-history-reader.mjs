import { existsSync } from 'node:fs';
import { planFailureFacts } from './plan-failure-facts.mjs';
import { readRunImages, readRunResponse, readRunThinking } from './run-response-store.mjs';
import { createHash } from 'node:crypto';
import { archiveDatabasePath, readArchivedRunIds } from './harness-event-archive.mjs';
import { openHarnessDatabase, readHarnessEventTail } from './harness-store-schema.mjs';
import { createHarnessEventStore } from './harness-event-store.mjs';
import { createThreadStore, THREAD_STATES, checkpointDigest, titleDigest,
  compareThreadEvents as compare, checkpointClearApplies, checkpointResumeMode,
  checkpointRecoveryBlock } from './thread-store.mjs';
import { readPersistentJsonFile } from './persistent-json-store.mjs';
import { createTrajectoryStore } from './trajectory-store.mjs';

const historyKinds = [
  'TaskRunCreated', 'RunStateChanged', 'ModelRouteResolved', 'RoleContextsAllocated',
  'WorkspaceSnapshotCreated', 'PlanStepStateChanged', 'ToolCallRequested', 'ToolInvocationCompleted', 'ToolActionNotExecuted',
  'VerificationCompleted', 'SemanticVerificationCompleted', 'CouncilPlanReviewCompleted',
  'TaskRunCompleted', 'TaskRunFailed', 'TaskHarnessProgress', 'ApprovalRequested', 'ApprovalResolved',
  'ActionIntentCreated', 'LeaseIssued', 'LeaseClaimed', 'LeaseConsumed', 'LeaseFailed',
  'CandidateSelected', 'CandidateVerificationCompleted', 'FeedbackFactRecorded'
];
const metadataKinds = ['ThreadCreated', 'ThreadTurnAppended', 'ThreadStateChanged',
  'ThreadCheckpointCommitted', 'ThreadCheckpointCleared', 'ThreadRunAttached', 'ThreadWorkspaceBound'];
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
    : JSON.stringify(v) ?? 'null';
const digest = (v) => `sha256:${createHash('sha256').update(canonical(v)).digest('hex')}`;
const validate = (event) => {
  const { recordDigest, ...unsigned } = event;
  if (recordDigest !== digest(unsigned) || event.payloadDigest !== digest(event.payload)) {
    throw new Error('THREAD_HISTORY_EVENT_DIGEST_INVALID');
  }
  return event;
};
const recoverySummary = (checkpoint) => {
  const resumeMode = checkpointResumeMode(checkpoint);
  const recoveryBlock = checkpointRecoveryBlock(checkpoint);
  return {
    resumeMode,
    resumable: (resumeMode === 'PLAN' || resumeMode === 'PREPARATION') && !recoveryBlock,
    ...(recoveryBlock ? { recoveryBlock } : {})
  };
};
const rememberHistoryRun = (ids, runId) => {
  if (typeof runId === 'string' && runId && !runId.startsWith('thread:')) ids.add(runId);
};

const summary = ({ turns = [], checkpoint, runIds: _runIds, ...thread }) => {
  // A stale block must never survive a checkpoint replacement or clear.
  delete thread.recoveryBlock;
  return { ...thread, turnCount: turns.length, ...recoverySummary(checkpoint) };
};

// Thread titles are local presentation metadata. The durable event keeps only
// titleDigest so support bundles and event exports never contain the prompt.
// Restore the display title only when the local cache still matches that
// digest; stale or tampered cache entries safely fall back to Thread <id>.
const readThreadTitleCache = async (threadPath) => {
  if (!threadPath) return new Map();
  try {
    const titles = await readPersistentJsonFile(threadPath + '.titles.json');
    const parsed = await readPersistentJsonFile(threadPath);
    const legacy = parsed?.schemaVersion === '1.0' && Array.isArray(parsed.threads) ? parsed.threads : [];
    return new Map([...Object.entries(titles ?? {}), ...legacy.flatMap((thread) => typeof thread?.id === 'string' && thread.id
      && typeof thread.title === 'string' && thread.title && thread.title.length <= 240
      ? [[thread.id, thread.title]] : [])]);
  } catch {
    return new Map();
  }
};
const displayTitle = (threadId, expectedDigest, titles) => {
  const candidate = titles.get(threadId);
  return candidate && typeof expectedDigest === 'string' && titleDigest(candidate) === expectedDigest
    ? candidate
    : `Thread ${threadId.slice(-8)}`;
};

function readSqliteMetadata(db, threadId, includeRuns, titles = new Map()) {
  const records = new Map();
  if (!db) return records;
  const scope = threadId ? "AND json_extract(envelope, '$.payload.threadId') = ?" : '';
  const params = threadId ? [threadId] : [];
  const rows = (kinds) => db.prepare(`SELECT envelope FROM trajectory_events
    WHERE json_extract(envelope, '$.kind') IN (SELECT value FROM json_each(?)) ${scope}
    ORDER BY json_extract(envelope, '$.emittedAtMs'), run_id, sequence`).iterate(JSON.stringify(kinds), ...params);
  // Fold only summary fields and membership. In particular, never clone/store
  // all turn summaries or old checkpoint plans just to populate the sidebar.
  for (const row of rows(['ThreadCreated'])) {
    const event = validate(JSON.parse(row.envelope));
    const p = event.payload;
    if (typeof p.threadId !== 'string' || !p.threadId) continue;
    const turns = Array.isArray(p.turns) ? p.turns : [];
    records.set(p.threadId, {
      thread: { id: p.threadId, title: displayTitle(p.threadId, p.titleDigest, titles),
        cwd: typeof p.cwd === 'string' ? p.cwd : '', state: THREAD_STATES.includes(p.state) ? p.state : 'IDLE',
        createdAtMs: Number.isFinite(p.createdAtMs) ? p.createdAtMs : event.emittedAtMs,
        updatedAtMs: Number.isFinite(p.updatedAtMs) ? p.updatedAtMs : event.emittedAtMs,
        turnCount: turns.length, ...recoverySummary(undefined),
        ...(typeof p.forkedFrom === 'string' ? { forkedFrom: p.forkedFrom } : {}) },
      turnIds: new Set(turns.map((turn) => turn.id)),
      runIds: new Set(includeRuns ? turns.map((turn) => turn.runId).filter(Boolean) : []),
      checkpointRunId: undefined
    });
  }
  for (const row of rows(metadataKinds.filter((kind) => kind !== 'ThreadCreated'))) {
    const event = validate(JSON.parse(row.envelope));
    const p = event.payload;
    const record = records.get(p.threadId);
    if (!record) continue;
    const thread = record.thread;
    if (event.kind === 'ThreadTurnAppended' && p.turn?.id) {
      if (!record.turnIds.has(p.turn.id)) {
        record.turnIds.add(p.turn.id);
        thread.turnCount++;
        if (includeRuns && p.turn.runId) record.runIds.add(p.turn.runId);
      }
    } else if (event.kind === 'ThreadWorkspaceBound') {
      if (!thread.cwd && typeof p.cwd === 'string') thread.cwd = p.cwd;
    } else if (event.kind === 'ThreadStateChanged') {
      if (p.expectedRunId && (thread.activeRunId !== p.expectedRunId || thread.state !== 'RUNNING')) continue;
      if (THREAD_STATES.includes(p.state)) thread.state = p.state;
      if (typeof p.activeRunId === 'string' && p.activeRunId) thread.activeRunId = p.activeRunId;
      else delete thread.activeRunId;
      if (typeof p.stateReason === 'string' && p.stateReason) thread.stateReason = p.stateReason;
    } else if (event.kind === 'ThreadRunAttached') {
      // Once a conversation has a session id, later runs of that same task
      // join it. A different session's checkpoint must not be pulled in.
      const attachedSession = typeof p.sessionId === 'string' && p.sessionId ? p.sessionId : undefined;
      if (!thread.sessionId && attachedSession) thread.sessionId = attachedSession;
      if (includeRuns && (!thread.sessionId || !attachedSession || attachedSession === thread.sessionId)) {
        rememberHistoryRun(record.runIds, p.runId);
      }
    } else if (event.kind === 'ThreadCheckpointCommitted') {
      // Runs from before session ids were stored are still one conversation:
      // every checkpoint on the thread belongs to it until a session is bound.
      if (includeRuns && !thread.sessionId) {
        rememberHistoryRun(record.runIds, p.runId);
        rememberHistoryRun(record.runIds, p.checkpoint?.runId);
        rememberHistoryRun(record.runIds, event.runId);
      }
      if (THREAD_STATES.includes(p.state)) thread.state = p.state;
      if (typeof p.runId === 'string' && p.runId) thread.activeRunId = p.runId;
      if (p.checkpoint && p.checkpoint.checkpointDigest === checkpointDigest(p.checkpoint)) {
        record.checkpointRunId = p.checkpoint.runId;
        delete thread.recoveryBlock;
        Object.assign(thread, recoverySummary(p.checkpoint));
        thread.state = THREAD_STATES.includes(p.checkpoint.state) ? p.checkpoint.state : 'RUNNING';
      }
    } else if (event.kind === 'ThreadCheckpointCleared') {
      if (!checkpointClearApplies(record.checkpointRunId, event)) continue;
      record.checkpointRunId = undefined;
      delete thread.recoveryBlock;
      Object.assign(thread, recoverySummary(undefined));
      if (THREAD_STATES.includes(p.state)) thread.state = p.state;
      delete thread.activeRunId;
    }
    if (Number.isFinite(p.updatedAtMs)) thread.updatedAtMs = Math.max(thread.updatedAtMs, p.updatedAtMs);
  }
  return records;
}

export function parseHistoryOptions({ limit = 100, before, threadId } = {}) {
  limit = Number(limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('THREAD_HISTORY_LIMIT_INVALID');
  let cursor;
  if (before !== undefined) {
    try {
      if (typeof before !== 'string' || before.length > 2048) throw new Error();
      cursor = JSON.parse(Buffer.from(before, 'base64url').toString('utf8'));
      if (cursor.threadId !== threadId || !Number.isSafeInteger(cursor.emittedAtMs) || cursor.emittedAtMs < 0
        || typeof cursor.runId !== 'string' || !cursor.runId || cursor.runId.length > 240
        || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 1) throw new Error();
    } catch { throw new Error('THREAD_HISTORY_CURSOR_INVALID'); }
  }
  return { limit, before: cursor };
}

// This is a read-only UI projection, never a checkpoint or execution authority.
// SQLite opens a read transaction and validates only the metadata/current page;
// the normal Harness APIs retain whole-store verification for audits/writes.
const mergeHistoryPages = (pages, limit) => {
  const byId = new Map();
  for (const page of pages) {
    for (const event of page.events ?? []) byId.set(event.eventId, event);
  }
  const events = [...byId.values()].sort(compare);
  return {
    events: events.length > limit ? events.slice(-limit) : events,
    hasMore: pages.some((page) => page.hasMore) || events.length > limit
  };
};

export async function readThreadHistory({ harnessPath, threadPath, trajectoryPath, explicitThreadStore,
  threadId, limit = 100, before, listOnly = false, summariesOnly = false }) {
  const options = parseHistoryOptions({ limit, before, threadId });
  const sqlite = harnessPath?.endsWith('.db');
  const titleCache = explicitThreadStore ? new Map() : await readThreadTitleCache(threadPath);
  const readers = [];
  let db;
  try {
    if (sqlite && existsSync(harnessPath)) {
      db = openHarnessDatabase(harnessPath, { readOnly: true, verifyIntegrity: false });
      db.exec('BEGIN');
      readers.push(db);
    }
    let threads;
    let thread;
    let runIds;
    if (!explicitThreadStore && sqlite) {
      const records = readSqliteMetadata(db, threadId, !listOnly && !summariesOnly, titleCache);
      if (listOnly) return { ok: true, threads: [...records.values()].map((r) => r.thread).sort((a, b) => b.updatedAtMs - a.updatedAtMs) };
      const record = records.get(threadId);
      thread = record?.thread;
      runIds = !record ? [] : thread.sessionId
        ? [...record.runIds]
        : [...new Set([...record.runIds, thread.activeRunId, record.checkpointRunId].filter(Boolean))];
    } else {
      threads = createThreadStore(!explicitThreadStore && harnessPath
        ? { storagePath: threadPath, eventStore: createHarnessEventStore({ storagePath: harnessPath }) }
        : { storagePath: threadPath });
      if (listOnly) return { ok: true, threads: (await threads.list()).map(summary) };
      const fullThread = await threads.get(threadId);
      thread = fullThread ? summary(fullThread) : undefined;
      const attached = Array.isArray(fullThread?.runIds) ? fullThread.runIds : [];
      const turnRuns = (fullThread?.turns ?? []).map((turn) => turn.runId);
      runIds = thread?.sessionId
        ? [...new Set([...attached, ...turnRuns].filter((id) => typeof id === 'string' && id))]
        : [...new Set([...attached, ...turnRuns, fullThread?.activeRunId, fullThread?.checkpoint?.runId].filter((id) => typeof id === 'string' && id))];
    }
    if (!thread) throw new Error('THREAD_NOT_FOUND');
    if (summariesOnly) return { ok: true, thread };
    let page;
    if (db) {
      if (sqlite) {
        const archivedRunIds = await readArchivedRunIds(harnessPath, threadId);
        if (archivedRunIds.length) runIds = [...new Set([...runIds, ...archivedRunIds])];
      }
      const archivePath = sqlite ? archiveDatabasePath(harnessPath) : undefined;
      const pages = [readHarnessEventTail(db, { runIds, kinds: historyKinds, ...options })];
      if (archivePath && existsSync(archivePath)) {
        const archiveDb = openHarnessDatabase(archivePath, { readOnly: true, verifyIntegrity: false });
        archiveDb.exec('BEGIN');
        readers.push(archiveDb);
        pages.push(readHarnessEventTail(archiveDb, { runIds, kinds: historyKinds, ...options }));
      }
      page = pages.length === 1 ? pages[0] : mergeHistoryPages(pages, options.limit);
      page.events.forEach(validate);
    } else if (sqlite) {
      page = { events: [], hasMore: false };
    } else {
      const trajectory = createTrajectoryStore(trajectoryPath, harnessPath ? { harnessStoragePath: harnessPath } : {});
      const listed = await trajectory.list();
      const members = new Set(runIds);
      if (!thread.sessionId) {
        for (const event of listed) {
          if (event?.kind !== 'ThreadCheckpointCommitted' || event.payload?.threadId !== threadId) continue;
          rememberHistoryRun(members, event.payload?.runId);
          rememberHistoryRun(members, event.payload?.checkpoint?.runId);
          rememberHistoryRun(members, event.runId);
        }
      }
      const events = listed.filter((event) => members.has(event.runId)
        && historyKinds.includes(event.kind) && (!options.before || compare(event, options.before) < 0)).sort(compare);
      page = { events: events.slice(-options.limit), hasMore: events.length > options.limit };
    }
    const responses = new Map();
    const thinking = new Map();
    const images = new Map();
    for (const event of page.events) {
      if (event.kind === 'TaskRunCreated' && Array.isArray(event.payload?.imageRefs)) {
        const restored = await readRunImages(harnessPath ?? trajectoryPath ?? threadPath, event.runId, event.payload.imageRefs);
        if (restored.length) images.set(event.eventId, restored);
      }
      if (event.kind !== 'TaskRunCompleted' && event.kind !== 'TaskRunFailed') continue;
      const responseText = await readRunResponse(harnessPath ?? trajectoryPath ?? threadPath,
        event.runId, event.payload.outputDigest);
      if (responseText !== undefined) responses.set(event.eventId, responseText);
      const thinkingText = await readRunThinking(harnessPath ?? trajectoryPath ?? threadPath,
        event.runId, event.payload.reasoningDigest);
      if (thinkingText !== undefined) thinking.set(event.eventId, thinkingText);
    }
    const first = page.events[0];
    return {
      ok: true, threadId, thread, limit: options.limit, hasMore: page.hasMore,
      ...(page.hasMore && first ? { nextCursor: Buffer.from(JSON.stringify({ threadId,
        emittedAtMs: first.emittedAtMs, runId: first.runId, sequence: first.sequence })).toString('base64url') } : {}),
      events: page.events.map((event) => ({ eventId: event.eventId, type: 'runtime_event', schemaVersion: '1.0',
        runId: event.runId, sequence: event.sequence, emittedAtMs: event.emittedAtMs,
        kind: `history.${event.kind.replace(/([a-z0-9])([A-Z])/g, '$1.$2').toLowerCase()}`,
        payload: { ...event.payload, persistedKind: event.kind,
          ...(event.kind === 'TaskRunFailed' && event.payload?.stepId && !event.payload.stepFacts
            ? { stepFacts: planFailureFacts(page.events.filter(item => item.sequence < event.sequence),
                event.runId, event.payload.stepId) } : {}),
          ...(images.has(event.eventId) ? { images: images.get(event.eventId) } : {}),
          ...(thinking.has(event.eventId) ? { thinkingText: thinking.get(event.eventId) } : {}),
          ...(responses.has(event.eventId) ? { responseText: responses.get(event.eventId) }
            : event.kind === 'TaskRunCompleted' ? { responseUnavailable: true } : {}) } }))
    };
  } finally {
    for (const item of readers) {
      try { item.exec('ROLLBACK'); } finally { item.close(); }
    }
  }
}
