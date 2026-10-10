import { createHash, randomUUID } from 'node:crypto';

const MAX_INPUT_CHARS = 12000;
const MAX_SUMMARY_CHARS = 1200;
const MAX_CLAIM_CHARS = 2000;
const MAX_EVIDENCE_REFS = 32;
const MAX_ACTIONS = 16;
const MAX_MEMBERS = 32;
const MAX_CONCURRENCY = 8;
const MAX_TIMEOUT_MS = 120000;

export const COUNCIL_DECISIONS = Object.freeze([
  'ACCEPT_PLAN',
  'REQUEST_PROBE',
  'ESCALATE',
  'ABSTAIN'
]);

export const COUNCIL_MEMBER_STATES = Object.freeze([
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED'
]);

const FORBIDDEN_KEY = /(?:prompt|messages?|reasoning|chain[_-]?of[_-]?thought|credential|password|secret|token|authorization|api[_-]?key|private[_-]?key)/iu;
const clone = (value) => structuredClone(value);
const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value) ?? 'null';
const digest = (value) => `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;
const bounded = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ').trim().slice(0, max);

const safeCopy = (value, depth = 0) => {
  if (depth > 6) throw new Error('COUNCIL_CONTEXT_TOO_DEEP');
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error('COUNCIL_CONTEXT_TOO_LARGE');
    return value.map((item) => safeCopy(item, depth + 1));
  }
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/u.test(key) || FORBIDDEN_KEY.test(key)) {
      throw new Error(`COUNCIL_FORBIDDEN_FIELD:${key}`);
    }
    result[key] = safeCopy(child, depth + 1);
  }
  if (JSON.stringify(result).length > MAX_INPUT_CHARS) throw new Error('COUNCIL_CONTEXT_TOO_LARGE');
  return result;
};

const normalizeMember = (member, index) => {
  if (!member || typeof member !== 'object' || Array.isArray(member)) throw new Error('COUNCIL_MEMBER_INVALID');
  const id = bounded(member.id ?? `member-${index + 1}`, 120);
  const role = bounded(member.role ?? 'critic', 80);
  if (!id || !role || !/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/u.test(id)) throw new Error('COUNCIL_MEMBER_INVALID');
  return {
    id,
    role,
    ...(member.modelId === undefined ? {} : { modelId: bounded(member.modelId, 160) }),
    ...(member.profileId === undefined ? {} : { profileId: bounded(member.profileId, 160) })
  };
};

const normalizeProposal = (raw, member) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('COUNCIL_PROPOSAL_INVALID');
  const safe = safeCopy(raw);
  const summary = bounded(safe.summary ?? safe.claim, MAX_SUMMARY_CHARS);
  const claim = bounded(safe.claim ?? summary, MAX_CLAIM_CHARS);
  if (!summary || !claim) throw new Error('COUNCIL_PROPOSAL_EMPTY');
  const evidenceRefs = Array.isArray(safe.evidenceRefs)
    ? safe.evidenceRefs.map((value) => bounded(value, 240)).filter(Boolean).slice(0, MAX_EVIDENCE_REFS)
    : [];
  const nextActions = Array.isArray(safe.nextActions)
    ? safe.nextActions.map((value) => bounded(value, 320)).filter(Boolean).slice(0, MAX_ACTIONS)
    : [];
  const confidence = safe.confidence === undefined
    ? undefined
    : Number.isFinite(safe.confidence) ? Math.max(0, Math.min(1, safe.confidence)) : undefined;
  const proposal = {
    proposalId: bounded(safe.proposalId ?? `proposal-${member.id}`, 160),
    memberId: member.id,
    role: member.role,
    summary,
    claim,
    ...(evidenceRefs.length ? { evidenceRefs } : {}),
    ...(Array.isArray(safe.risks) && safe.risks.length
      ? { risks: safe.risks.map((value) => bounded(value, 320)).filter(Boolean).slice(0, MAX_ACTIONS) }
      : {}),
    ...(nextActions.length ? { nextActions } : {}),
    ...(confidence === undefined ? {} : { confidence })
  };
  return { ...proposal, proposalDigest: digest(proposal) };
};

const normalizeVerdict = (raw, proposals) => {
  const safe = safeCopy(raw ?? {});
  const decision = bounded(safe.decision ?? 'ABSTAIN', 40).toUpperCase();
  if (!COUNCIL_DECISIONS.includes(decision)) throw new Error('COUNCIL_DECISION_INVALID');
  const ids = Array.isArray(safe.selectedProposalIds)
    ? [...new Set(safe.selectedProposalIds.map((value) => bounded(value, 160)).filter(Boolean))]
    : [];
  const available = new Set(proposals.map((proposal) => proposal.proposalId));
  if (ids.some((id) => !available.has(id))) throw new Error('COUNCIL_SELECTION_INVALID');
  if (decision === 'ACCEPT_PLAN' && ids.length === 0) throw new Error('COUNCIL_SELECTION_REQUIRED');
  if (decision === 'REQUEST_PROBE' && !bounded(safe.probe, 600)) throw new Error('COUNCIL_PROBE_REQUIRED');
  return {
    decision,
    ...(ids.length ? { selectedProposalIds: ids } : {}),
    ...(safe.probe ? { probe: bounded(safe.probe, 600) } : {}),
    ...(safe.rationale ? { rationale: bounded(safe.rationale, 1000) } : {}),
    ...(safe.reasonCode ? { reasonCode: bounded(safe.reasonCode, 120) } : {})
  };
};

const abortError = () => Object.assign(new Error('COUNCIL_CANCELLED'), { code: 'COUNCIL_CANCELLED' });

/**
 * Short-lived, bounded multi-agent deliberation. Members only return
 * proposals; the council never invokes tools or grants execution authority.
 * A missing/failed judge always produces ABSTAIN rather than implicit
 * consensus.
 */
export class AgentCouncil {
  #members;
  #runMember;
  #judge;
  #now;
  #idFactory;
  #maxConcurrency;
  #timeoutMs;

  constructor({ members = [], runMember, judge, now = Date.now, idFactory = randomUUID, maxConcurrency = 4, timeoutMs = 30000 } = {}) {
    if (!Array.isArray(members) || members.length < 1 || members.length > MAX_MEMBERS) throw new Error('COUNCIL_MEMBERS_INVALID');
    if (typeof runMember !== 'function') throw new Error('COUNCIL_MEMBER_RUNNER_REQUIRED');
    if (judge !== undefined && typeof judge !== 'function') throw new Error('COUNCIL_JUDGE_INVALID');
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_CONCURRENCY) throw new Error('COUNCIL_CONCURRENCY_INVALID');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new Error('COUNCIL_TIMEOUT_INVALID');
    this.#members = members.map(normalizeMember);
    if (new Set(this.#members.map((member) => member.id)).size !== this.#members.length) throw new Error('COUNCIL_MEMBER_DUPLICATE');
    this.#runMember = runMember;
    this.#judge = judge;
    this.#now = typeof now === 'function' ? now : Date.now;
    this.#idFactory = typeof idFactory === 'function' ? idFactory : randomUUID;
    this.#maxConcurrency = maxConcurrency;
    this.#timeoutMs = timeoutMs;
  }

  async run({ runId, taskClass = 'unknown', input = {}, evidence = [], signal, budget = {} } = {}) {
    const councilId = `council-${this.#idFactory()}`;
    const startedAtMs = this.#now();
    if (typeof runId !== 'string' || !runId.trim()) throw new Error('COUNCIL_RUN_ID_REQUIRED');
    const safeInput = safeCopy(input);
    const safeEvidence = safeCopy(Array.isArray(evidence) ? evidence.slice(0, 128) : []);
    const maxMembers = Math.max(1, Math.min(this.#members.length, Number.isInteger(budget.maxMembers) ? budget.maxMembers : this.#members.length));
    const selectedMembers = this.#members.slice(0, maxMembers);
    const results = new Array(selectedMembers.length);
    let cursor = 0;
    const invokeNext = async () => {
      while (true) {
        const index = cursor++;
        if (index >= selectedMembers.length) return;
        const member = selectedMembers[index];
        if (signal?.aborted) {
          results[index] = { memberId: member.id, role: member.role, state: 'CANCELLED', errorCode: 'COUNCIL_CANCELLED' };
          continue;
        }
        results[index] = await this.#invokeMember({ member, runId, taskClass, input: safeInput, evidence: safeEvidence, signal });
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.#maxConcurrency, selectedMembers.length) }, invokeNext));
    const proposals = results.filter((result) => result?.state === 'SUCCEEDED' && result.proposal).map((result) => result.proposal);
    let verdict;
    let judgeError;
    if (!proposals.length) {
      verdict = { decision: 'ABSTAIN', reasonCode: signal?.aborted ? 'COUNCIL_CANCELLED' : 'NO_VALID_PROPOSALS' };
    } else if (!this.#judge) {
      verdict = { decision: 'ABSTAIN', reasonCode: 'JUDGE_REQUIRED' };
    } else if (signal?.aborted) {
      verdict = { decision: 'ABSTAIN', reasonCode: 'COUNCIL_CANCELLED' };
    } else {
      try {
        const rawVerdict = await this.#judge({
          councilId,
          runId,
          taskClass,
          proposals: clone(proposals),
          evidence: clone(safeEvidence),
          signal
        });
        verdict = normalizeVerdict(rawVerdict, proposals);
      } catch (error) {
        judgeError = error instanceof Error ? error.message : String(error);
        verdict = { decision: 'ABSTAIN', reasonCode: 'JUDGE_FAILED' };
      }
    }
    const completedAtMs = this.#now();
    const result = {
      councilId,
      runId,
      taskClass: bounded(taskClass, 80) || 'unknown',
      state: verdict.decision === 'ABSTAIN' ? 'ABSTAINED' : 'DECIDED',
      startedAtMs,
      completedAtMs,
      budget: { maxMembers: selectedMembers.length, maxConcurrency: this.#maxConcurrency, timeoutMs: this.#timeoutMs },
      members: results,
      proposals,
      verdict,
      ...(judgeError ? { judgeErrorCode: bounded(judgeError, 160) } : {})
    };
    return { ...result, resultDigest: digest(result) };
  }

  async #invokeMember({ member, runId, taskClass, input, evidence, signal }) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    let timer;
    try {
      const output = await Promise.race([
        this.#runMember({ member: clone(member), runId, taskClass, input: clone(input), evidence: clone(evidence), signal: controller.signal }),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('COUNCIL_MEMBER_TIMEOUT'), { code: 'COUNCIL_MEMBER_TIMEOUT' })); }, this.#timeoutMs); })
      ]);
      if (signal?.aborted) throw abortError();
      return { memberId: member.id, role: member.role, state: 'SUCCEEDED', proposal: normalizeProposal(output, member) };
    } catch (error) {
      const code = signal?.aborted || error?.code === 'COUNCIL_CANCELLED' ? 'COUNCIL_CANCELLED'
        : error?.code === 'COUNCIL_MEMBER_TIMEOUT' ? 'COUNCIL_MEMBER_TIMEOUT'
          : bounded(error instanceof Error ? error.message : error, 160) || 'COUNCIL_MEMBER_FAILED';
      return {
        memberId: member.id,
        role: member.role,
        state: code === 'COUNCIL_CANCELLED' ? 'CANCELLED' : code === 'COUNCIL_MEMBER_TIMEOUT' ? 'TIMED_OUT' : 'FAILED',
        errorCode: code
      };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

export const createAgentCouncil = (options) => new AgentCouncil(options);
export const councilDigest = digest;
