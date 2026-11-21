import { common } from '@kit.AbilityKit';
import { fileIo as fs } from '@kit.CoreFileKit';
import { util } from '@kit.ArkTS';
import { asset } from '@kit.AssetStoreKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { ChatMessage, ImageAttachment, MessageRole, ModelUsage } from '../models/CodexTypes';
import { publishText } from './LocalFileIO';
import { validAttachments } from './LocalImages';
import { LocalSkill, validLocalSkill } from './LocalSkills';

export interface StoredTask {
  threadId: string;
  title: string;
  messages: ChatMessage[];
  draft: string;
  draftImages?: ImageAttachment[];
  incomplete?: boolean;
  runId?: string;
  queued?: string[];
  usage?: ModelUsage;
  projectId?: string;
}

export interface StoredProject {
  id: string;
  name: string;
}

export interface StoredTurnInput {
  history: ChatMessage[];
  prompt: string;
  images: ImageAttachment[];
}

export function restoreTurnInput(messages: ChatMessage[]): StoredTurnInput | undefined {
  let index = messages.length - 1;
  while (index >= 0 && messages[index].role !== MessageRole.User) { index--; }
  if (index < 0) { return undefined; }
  return { history: messages.slice(0, index), prompt: messages[index].text, images: messages[index].images?.slice() ?? [] };
}

// Capture the prompt and its assigned run together before a model or tool can
// run. The caller supplies a detached task snapshot and publishes it atomically.
export function stageStoredTurn(task: StoredTask, message: ChatMessage, title: string, runId: string, fromQueue: boolean): void {
  task.messages = task.messages.concat([message]);
  task.runId = runId;
  task.incomplete = true;
  task.title = title;
  if (fromQueue) { task.queued = (task.queued ?? []).slice(1); }
  else { task.draft = ''; task.draftImages = []; }
}

export interface StoredModelProfile {
  baseUrl: string;
  model: string;
  hasSavedKey: boolean;
}

export interface WorkbenchState {
  current: StoredTask;
  tasks: StoredTask[];
  instructions: string;
  memories: string[];
  skills?: string[];
  localSkills?: LocalSkill[];
  projects?: StoredProject[];
  profiles?: StoredModelProfile[];
  maxOutputTokens?: number;
  baseUrl: string;
  model: string;
  hasSavedKey?: boolean;
  jevEnabled?: boolean;
  jevEndpoint?: string;
  jevModel?: string;
  jevHasSavedKey?: boolean;
}

function stringList(list: string[]): boolean {
  return Array.isArray(list) && list.every((item: string) => typeof item === 'string');
}

function validProjectId(id: string): boolean {
  return id === 'default' || /^p-\d+$/.test(id);
}

function validCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 0;
}

function validMessage(msg: ChatMessage): boolean {
  return !!msg && typeof msg.id === 'string' && typeof msg.text === 'string' &&
    (msg.images === undefined || validAttachments(msg.images)) &&
    (msg.role === MessageRole.User || msg.role === MessageRole.Assistant ||
    msg.role === MessageRole.System || msg.role === MessageRole.Tool);
}

function validTask(task: StoredTask): boolean {
  return !!task && typeof task.threadId === 'string' && typeof task.title === 'string' &&
    typeof task.draft === 'string' && Array.isArray(task.messages) && task.messages.every(validMessage) &&
    (task.draftImages === undefined || validAttachments(task.draftImages)) &&
    (task.incomplete === undefined || typeof task.incomplete === 'boolean') &&
    (task.runId === undefined || typeof task.runId === 'string') &&
    (task.queued === undefined || stringList(task.queued)) &&
    (task.usage === undefined || (!!task.usage && validCount(task.usage.inputTokens) &&
      validCount(task.usage.outputTokens) &&
      (task.usage.cachedTokens === undefined || validCount(task.usage.cachedTokens)))) &&
    (task.projectId === undefined || validProjectId(task.projectId));
}

export function decodeWorkbenchState(source: string): WorkbenchState {
  const state = JSON.parse(source) as WorkbenchState;
  if (!state || !validTask(state.current) || !Array.isArray(state.tasks) || !state.tasks.every(validTask) ||
    typeof state.instructions !== 'string' || !stringList(state.memories) ||
    (state.skills !== undefined && !stringList(state.skills)) ||
    (state.localSkills !== undefined && (!Array.isArray(state.localSkills) || !state.localSkills.every(validLocalSkill))) ||
    (state.projects !== undefined && (!Array.isArray(state.projects) ||
      !state.projects.every((p: StoredProject) => !!p && validProjectId(p.id) && typeof p.name === 'string'))) ||
    (state.profiles !== undefined && (!Array.isArray(state.profiles) ||
      !state.profiles.every((p: StoredModelProfile) => !!p && typeof p.baseUrl === 'string' &&
        typeof p.model === 'string' && typeof p.hasSavedKey === 'boolean'))) ||
    typeof state.baseUrl !== 'string' || typeof state.model !== 'string' ||
    (state.maxOutputTokens !== undefined && !validCount(state.maxOutputTokens)) ||
    (state.hasSavedKey !== undefined && typeof state.hasSavedKey !== 'boolean') ||
    (state.jevEnabled !== undefined && typeof state.jevEnabled !== 'boolean') ||
    (state.jevEndpoint !== undefined && typeof state.jevEndpoint !== 'string') ||
    (state.jevModel !== undefined && typeof state.jevModel !== 'string') ||
    (state.jevHasSavedKey !== undefined && typeof state.jevHasSavedKey !== 'boolean')) {
    throw new Error('本机会话文件格式无效');
  }
  return state;
}

export class WorkbenchStore {
  private readonly directory: string;
  private readonly filename: string;
  private static writes: Promise<void> = Promise.resolve();

  constructor(context: common.UIAbilityContext) {
    this.directory = context.filesDir;
    this.filename = this.directory + '/workbench-v1.json';
  }

  async load(): Promise<WorkbenchState | null> {
    await WorkbenchStore.writes;
    try {
      return decodeWorkbenchState(await fs.readText(this.filename));
    } catch (err) {
      if ((err as BusinessError).code === 13900002) { return null; }
      throw err as Error;
    }
  }

  save(state: WorkbenchState): Promise<void> {
    // Snapshot the caller's state before scheduling I/O. Credentials are
    // handled separately; only these named fields belong in the history file.
    const snapshot: WorkbenchState = {
      current: state.current, tasks: state.tasks, instructions: state.instructions,
      memories: state.memories, skills: state.skills, localSkills: state.localSkills, projects: state.projects, profiles: state.profiles,
      baseUrl: state.baseUrl, model: state.model, hasSavedKey: state.hasSavedKey, maxOutputTokens: state.maxOutputTokens,
      jevEnabled: state.jevEnabled, jevEndpoint: state.jevEndpoint, jevModel: state.jevModel,
      jevHasSavedKey: state.jevHasSavedKey
    };
    const data = JSON.stringify(snapshot);
    const write = WorkbenchStore.writes.then(() => publishText(this.directory, this.filename, data, true));
    WorkbenchStore.writes = write.catch(() => {});
    return write;
  }

  private async keyQuery(baseUrl: string, jev: boolean): Promise<asset.AssetMap> {
    const endpoint = baseUrl.trim().replace(/\/+$/, '');
    if (!endpoint) { throw new Error('保存凭据需要模型服务地址'); }
    const hash = cryptoFramework.createMd('SHA256');
    const prefix = jev ? 'dda-jev-key-v1:' : 'dda-provider-key-v1:';
    await hash.update({ data: util.TextEncoder.create().encodeInto(prefix + endpoint) });
    const digest = await hash.digest();
    const attrs: asset.AssetMap = new Map<asset.Tag, asset.Value>();
    attrs.set(asset.Tag.ALIAS, digest.data);
    return attrs;
  }

  async loadKey(baseUrl: string, jev: boolean = false): Promise<string> {
    const query = await this.keyQuery(baseUrl, jev);
    query.set(asset.Tag.RETURN_TYPE, asset.ReturnType.ALL);
    try {
      const records = await asset.query(query);
      if (!records.length) { return ''; }
      const value = records[0].get(asset.Tag.SECRET);
      if (!(value instanceof Uint8Array)) { throw new Error('模型凭据无法读取'); }
      return util.TextDecoder.create().decodeToString(value);
    } catch (err) {
      if ((err as BusinessError).code === asset.ErrorCode.NOT_FOUND) { return ''; }
      throw err as Error;
    }
  }

  async saveKey(baseUrl: string, key: string, jev: boolean = false): Promise<void> {
    const attrs = await this.keyQuery(baseUrl, jev);
    if (!key) {
      try {
        await asset.remove(attrs);
      } catch (err) {
        if ((err as BusinessError).code !== asset.ErrorCode.NOT_FOUND) { throw err as Error; }
      }
      return;
    }
    attrs.set(asset.Tag.SECRET, util.TextEncoder.create().encodeInto(key));
    attrs.set(asset.Tag.ACCESSIBILITY, asset.Accessibility.DEVICE_UNLOCKED);
    attrs.set(asset.Tag.CONFLICT_RESOLUTION, asset.ConflictResolution.OVERWRITE);
    await asset.add(attrs);
  }
}
