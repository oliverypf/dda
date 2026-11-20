import { createHash } from 'node:crypto';
import { memoryWorkspaceKey } from './memory-workspace.mjs';
import { ContextPort } from './context-port.mjs';
import { experienceTakesEffect } from './experience-placement.mjs';

const clone = (value) => structuredClone(value);
const bounded = (value, max = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ').trim().slice(0, max);
const tokenize = (value) => {
  const lower = String(value ?? '').toLowerCase();
  const out = new Set(lower.match(/[a-z0-9_.-]{2,}/gu) ?? []);
  for (const run of lower.match(/\p{Script=Han}+/gu) ?? []) {
    if (run.length === 1) continue;
    if (run.length === 2) { out.add(run); continue; }
    for (let i = 0; i <= run.length - 2; i += 1) out.add(run.slice(i, i + 2));
  }
  return [...out];
};
const digest = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;

const scoreMemory = (memory, queryTokens) => {
  const tokens = tokenize(memory.statement);
  if (!tokens.length || !queryTokens.length) return 0;
  const matches = queryTokens.filter((token) => tokens.includes(token)).length;
  return matches / Math.max(tokens.length, queryTokens.length);
};

/** A local ContextPort implementation used until the OpenViking sidecar is
 * available. It deliberately exposes only bounded summaries to callers. */
export class JournalContextPort {
  #journal;
  #provider;
  #locateMemories;

  constructor({ journal, provider = 'memory-journal', locateMemories = records => records } = {}) {
    if (!journal || typeof journal.list !== 'function' || typeof journal.propose !== 'function' || typeof journal.flush !== 'function') {
      throw new Error('JOURNAL_CONTEXT_ADAPTER_INVALID');
    }
    this.#journal = journal;
    this.#locateMemories = locateMemories;
    this.#provider = bounded(provider, 80) || 'memory-journal';
  }

  async recall({ query = '', scope = 'workspace', workspacePath, limit = 16, maxChars = 3000 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 64 || !Number.isInteger(maxChars) || maxChars < 128 || maxChars > 16000) {
      throw new Error('CONTEXT_RECALL_OPTIONS_INVALID');
    }
    const queryTokens = tokenize(query);
    const workspace = memoryWorkspaceKey(workspacePath);
    const scoped = ['workspace', 'project'].includes(String(scope).toLowerCase());
    const records = await this.#locateMemories(this.#journal.list());
    const activeInScope = records
      .filter(memory => !scoped || (workspace && memoryWorkspaceKey(memory.workspacePath) === workspace))
      .filter((memory) => experienceTakesEffect(memory))
      .filter((memory) => String(memory.scope).toLowerCase() === String(scope).toLowerCase());
    const scored = activeInScope
      .map((memory) => ({
        memory,
        score: scoreMemory(memory, queryTokens),
        isProjectGuidance: String(memory.kind ?? 'PROJECT').toUpperCase() !== 'TASK_OUTCOME'
      }))
      .filter(({ score }) => score > 0 || !queryTokens.length)
      .sort((left, right) => right.score - left.score || Number(right.isProjectGuidance) - Number(left.isProjectGuidance) || right.memory.updatedAtMs - left.memory.updatedAtMs)
      .slice(0, limit);
    const items = [];
    let chars = 0;
    for (const { memory, score } of scored) {
      const item = {
        memoryId: memory.memoryId,
        scope: bounded(memory.scope, 160),
        kind: bounded(memory.kind, 64),
        status: memory.status,
        ...(memory.workspacePath ? { workspacePath: memory.workspacePath } : {}),
        ...(memory.key ? { key: bounded(memory.key, 240) } : {}),
        statement: bounded(memory.statement, 1200),
        confidence: memory.confidence,
        score,
        sourceDigest: digest(memory.sourceEventIds)
      };
      const nextChars = JSON.stringify(item).length;
      if (chars + nextChars > maxChars) break;
      chars += nextChars;
      items.push(item);
    }
    return { provider: this.#provider, status: 'AVAILABLE', queryDigest: digest(String(query)), items, chars };
  }

  async record(input = {}) {
    const payload = {
      runId: bounded(input.runId, 240) || 'unknown',
      statement: bounded(input.statement, 2000),
      sourceEventIds: Array.isArray(input.sourceEventIds) ? input.sourceEventIds.slice(0, 32) : [],
      scope: bounded(input.scope, 256) || 'workspace',
      workspacePath: input.workspacePath,
      confidence: input.confidence,
      kind: bounded(input.kind, 64) || 'PROJECT',
      key: input.key === undefined ? undefined : bounded(input.key, 256),
      validFromMs: input.validFromMs,
      expiresAtMs: input.expiresAtMs
    };
    const record = this.#journal.hasDurableSink && typeof this.#journal.proposeDurably === 'function'
      ? await this.#journal.proposeDurably(payload)
      : this.#journal.propose(payload);
    return { provider: this.#provider, status: 'RECORDED', memory: clone(record) };
  }

  async used({ runId = 'unknown', memoryIds = [] } = {}) {
    if (!Array.isArray(memoryIds) || memoryIds.length > 64) throw new Error('CONTEXT_USED_IDS_INVALID');
    const records = this.#journal.markUsed({ runId: bounded(runId, 240) || 'unknown', memoryIds });
    return { provider: this.#provider, status: 'RECORDED', used: records };
  }

  async commit({ memoryIds = [] } = {}) {
    if (!Array.isArray(memoryIds) || memoryIds.length > 64) throw new Error('CONTEXT_COMMIT_IDS_INVALID');
    await this.#journal.flush();
    const memories = memoryIds.map((id) => this.#journal.get(id)).filter(Boolean);
    return { provider: this.#provider, status: 'COMMITTED', memoryIds: memories.map((memory) => memory.memoryId), count: memories.length };
  }

  async health() {
    return { status: 'AVAILABLE', provider: this.#provider, recordCount: this.#journal.list().length };
  }
}

export const createJournalContextPort = (options) => new ContextPort(new JournalContextPort(options));
