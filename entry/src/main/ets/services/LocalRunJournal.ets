import { util } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { LocalWorkspace, workspaceParts } from './LocalWorkspace';

export interface LocalRunPending {
  id: string;
  tool: string;
  path: string;
  fingerprint?: string;
  expectedHash?: string;
}

export interface LocalRunReceipt extends LocalRunPending {
  status: string;
  exitCode?: number;
  verifiedOnRecovery?: boolean;
}

export interface LocalRunState {
  projectId: string;
  threadId: string;
  runId: string;
  binding: string;
  revision: number;
  phase: string;
  role: string;
  plan: string;
  draft: string;
  feedback: string;
  round: number;
  pending?: LocalRunPending;
  receipts: LocalRunReceipt[];
}

interface JournalFile {
  version: number;
  state: LocalRunState;
  digest: string;
}

const MAX_RECEIPTS: number = 128;
const PHASES: string[] = ['route', 'plan', 'execute', 'review', 'done', 'discarded'];

function identifier(value: string): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,144}$/.test(value);
}

function publicText(value: string, limit: number): boolean {
  return typeof value === 'string' && value.length <= limit &&
    !/(?:data:image\/[^,]*;base64,|<\/?(?:think|thinking|reasoning)\b|-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----)/i.test(value);
}

// Whitelist each field at runtime too. Neither raw command arguments nor
// tool output, attachment bytes, API settings or protocol items belong here.
function action(input: LocalRunPending): LocalRunPending {
  if (!input || !identifier(input.id) || !identifier(input.tool) ||
    typeof input.path !== 'string' || input.path.length > 2048 ||
    (input.fingerprint !== undefined && (typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint))) ||
    (input.expectedHash !== undefined && (typeof input.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedHash) ||
      !['create_file', 'edit_file'].includes(input.tool)))) {
    throw new Error('断点中的工具记录无效');
  }
  if (input.path) { workspaceParts(input.path); }
  return { id: input.id, tool: input.tool, path: input.path, fingerprint: input.fingerprint, expectedHash: input.expectedHash };
}

function receipt(input: LocalRunReceipt): LocalRunReceipt {
  const item = action(input);
  if (!['ok', 'failed', 'declined'].includes(input.status) ||
    (input.exitCode !== undefined && !Number.isSafeInteger(input.exitCode)) ||
    (input.verifiedOnRecovery !== undefined && input.verifiedOnRecovery !== true)) {
    throw new Error('断点中的工具结果无效');
  }
  return { id: item.id, tool: item.tool, path: item.path, fingerprint: item.fingerprint,
    status: input.status, exitCode: input.exitCode, verifiedOnRecovery: input.verifiedOnRecovery };
}

function checkpoint(input: LocalRunState): LocalRunState {
  if (!input || !identifier(input.projectId) || !identifier(input.threadId) || !identifier(input.runId) ||
    typeof input.binding !== 'string' || !/^[a-f0-9]{64}$/.test(input.binding) ||
    !Number.isSafeInteger(input.revision) || input.revision < 0 || !PHASES.includes(input.phase) ||
    !publicText(input.role, 160) || !publicText(input.plan, 32768) || !publicText(input.draft, 131072) ||
    !publicText(input.feedback, 32768) ||
    !Number.isSafeInteger(input.round) || input.round < 0 || input.round > 128 ||
    !Array.isArray(input.receipts) || input.receipts.length > MAX_RECEIPTS) {
    throw new Error('任务断点无效，或公开记录超过保存上限');
  }
  const completed = input.receipts.map(receipt);
  const ids = new Set<string>(completed.map((item: LocalRunReceipt) => item.id));
  const pending = input.pending === undefined ? undefined : action(input.pending);
  if (ids.size !== completed.length || (pending &&
    (ids.has(pending.id) || completed.length >= MAX_RECEIPTS || input.phase !== 'execute'))) {
    throw new Error('任务断点包含重复工具或无法提交的新操作');
  }
  return {
    projectId: input.projectId, threadId: input.threadId, runId: input.runId, binding: input.binding,
    revision: input.revision, phase: input.phase, role: input.role, plan: input.plan, draft: input.draft,
    feedback: input.feedback, round: input.round, pending: pending, receipts: completed
  };
}

export async function runFingerprint(text: string): Promise<string> {
  const md = cryptoFramework.createMd('SHA256');
  await md.update({ data: util.TextEncoder.create().encodeInto(text) });
  const result = await md.digest();
  let hex = '';
  for (const value of result.data) { hex += value.toString(16).padStart(2, '0'); }
  return hex;
}

function binding(goal: string, endpoint: string, model: string, jevIdentity: string): Promise<string> {
  if (!goal || !endpoint || !model) { throw new Error('缺少恢复任务的目标或模型信息'); }
  return runFingerprint(JSON.stringify([goal, endpoint, model, jevIdentity]));
}

function sameAction(left: LocalRunPending, right: LocalRunPending): boolean {
  return left.id === right.id && left.tool === right.tool && left.path === right.path &&
    (left.fingerprint === undefined || left.fingerprint === right.fingerprint);
}

export class LocalRunJournal {
  private static writes: Promise<void> = Promise.resolve();
  private readonly workspace: LocalWorkspace;
  private readonly threadId: string;
  // This capability never goes to disk. After a restart, releasing a write
  // fence requires checking the recorded postcondition or explicit discard.
  private pendingRevision: number = -1;
  private pendingRun: string = '';

  constructor(workspace: LocalWorkspace, threadId: string) {
    if (!identifier(threadId)) { throw new Error('断点的会话标识无效'); }
    this.workspace = workspace;
    this.threadId = threadId;
  }

  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const next = LocalRunJournal.writes.then(work);
    LocalRunJournal.writes = next.then(() => {}, () => {});
    return next;
  }

  private async read(): Promise<LocalRunState | undefined> {
    const text = await this.workspace.readCheckpoint(this.threadId);
    if (text === undefined) { return undefined; }
    const file = JSON.parse(text) as JournalFile;
    if (!file || file.version !== 1 || !file.state ||
      (await runFingerprint(JSON.stringify(file.state))) !== file.digest) {
      throw new Error('任务断点校验失败，请检查任务记录');
    }
    const state = checkpoint(file.state);
    if (state.projectId !== this.workspace.projectId || state.threadId !== this.threadId) {
      throw new Error('断点与当前项目或会话不匹配');
    }
    return state;
  }

  private async write(state: LocalRunState): Promise<void> {
    const envelope: JournalFile = { version: 1, state: state, digest: await runFingerprint(JSON.stringify(state)) };
    await this.workspace.writeCheckpoint(this.threadId, JSON.stringify(envelope));
  }

  async load(): Promise<LocalRunState | undefined> {
    await LocalRunJournal.writes;
    const state = await this.read();
    return state?.phase === 'discarded' ? undefined : state;
  }

  async matches(state: LocalRunState, goal: string, endpoint: string, model: string,
    jevIdentity: string = ''): Promise<boolean> {
    return state.threadId === this.threadId && state.projectId === this.workspace.projectId &&
      state.binding === await binding(goal, endpoint, model, jevIdentity);
  }

  start(runId: string, goal: string, endpoint: string, model: string, jevIdentity: string = ''): Promise<LocalRunState> {
    return this.transaction(async (): Promise<LocalRunState> => {
      const previous = await this.read();
      if (previous && (previous.runId === runId || !['done', 'discarded'].includes(previous.phase))) {
        throw new Error('此会话已有任务断点，请先恢复或放弃');
      }
      const state = checkpoint({
        runId: runId, threadId: this.threadId, projectId: this.workspace.projectId,
        binding: await binding(goal, endpoint, model, jevIdentity),
        revision: 0, phase: 'route', role: '', plan: '', draft: '', feedback: '', round: 0, receipts: []
      });
      await this.write(state);
      return state;
    });
  }

  private async current(state: LocalRunState): Promise<LocalRunState> {
    const previous = await this.read();
    if (!previous || previous.runId !== state.runId || previous.revision !== state.revision ||
      previous.projectId !== state.projectId || previous.threadId !== state.threadId || previous.binding !== state.binding) {
      throw new Error('任务断点已更新，请重新读取');
    }
    return previous;
  }

  async save(state: LocalRunState): Promise<LocalRunState> {
    const next = checkpoint(state);
    return this.transaction(async (): Promise<LocalRunState> => {
      const previous = await this.current(next);
      if (previous.phase === 'done' || previous.phase === 'discarded' || next.phase === 'discarded' ||
        next.round < previous.round || next.receipts.length < previous.receipts.length ||
        next.receipts.length > previous.receipts.length + 1 ||
        !previous.receipts.every((r: LocalRunReceipt, i: number) => JSON.stringify(r) === JSON.stringify(next.receipts[i]))) {
        throw new Error('不能覆盖已提交的任务步骤');
      }
      if (next.receipts.length > previous.receipts.length && next.receipts[next.receipts.length - 1].verifiedOnRecovery) {
        throw new Error('恢复回执必须来自文件核对');
      }
      if (previous.pending) {
        const last = next.receipts[next.receipts.length - 1];
        if (this.pendingRevision !== previous.revision || this.pendingRun !== previous.runId || next.pending ||
          !last || !sameAction(previous.pending, last)) {
          throw new Error('上次操作的结果尚未确认，请核对后放弃该断点');
        }
      } else if (next.receipts.length > previous.receipts.length) {
        const last = next.receipts[next.receipts.length - 1];
        if ((last.tool === 'edit_file' || last.tool === 'create_file') && last.status === 'ok') {
          throw new Error('已完成的写入缺少事先登记的操作');
        }
      }
      next.revision++;
      await this.write(next);
      this.pendingRevision = next.pending ? next.revision : -1;
      this.pendingRun = next.pending ? next.runId : '';
      return next;
    });
  }

  async discard(state: LocalRunState): Promise<void> {
    // Use the last committed record, not potentially dirty in-memory fields.
    const selected = checkpoint(state);
    return this.transaction(async (): Promise<void> => {
      const previous = await this.current(selected);
      previous.phase = 'discarded';
      previous.revision++;
      previous.pending = undefined;
      previous.receipts = [];
      previous.role = '';
      previous.plan = '';
      previous.draft = '';
      previous.feedback = '';
      await this.write(previous);
      this.pendingRevision = -1;
      this.pendingRun = '';
    });
  }

  async verifyPending(state: LocalRunState): Promise<LocalRunState> {
    const selected = checkpoint(state);
    return this.transaction(async (): Promise<LocalRunState> => {
      // The caller selects a revision. Both the target and its expected digest
      // must come from the original approved intent, not caller-provided data.
      const previous = await this.current(selected);
      const intent = previous.pending;
      if (previous.phase !== 'execute' || !intent?.expectedHash || !['create_file', 'edit_file'].includes(intent.tool)) {
        throw new Error('此断点没有可核对的写入结果');
      }
      let actual: string;
      try {
        actual = await runFingerprint(await this.workspace.read(intent.path, true));
      } catch (_) {
        throw new Error('无法读取待核对的项目文件，已保留断点');
      }
      if (actual !== intent.expectedHash) { throw new Error('文件内容与已批准结果不符，已保留断点'); }
      previous.pending = undefined;
      previous.receipts.push(receipt({ id: intent.id, tool: intent.tool, path: intent.path,
        fingerprint: intent.fingerprint, status: 'ok', verifiedOnRecovery: true }));
      previous.revision++;
      await this.write(previous);
      this.pendingRevision = -1;
      this.pendingRun = '';
      return previous;
    });
  }
}
