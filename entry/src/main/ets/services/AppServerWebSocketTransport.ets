import webSocket from '@ohos.net.webSocket';
import util from '@ohos.util';
import { permissionResponse, PermissionReview, reviewPermissions } from './RemotePermissionApproval';
import {
  CodexTransport,
  ConnectionState,
  SessionEvent,
  SessionEventKind,
  SessionEventListener,
  WorkspaceEntry
} from '../models/CodexTypes';
import {
  CodexProtocol,
  FsReadDirectoryParams,
  FsReadFileParams,
  InitializeParams,
  RpcDirectoryEntry,
  RpcEnvelope,
  RpcInput,
  RpcItem,
  RpcParams,
  RpcRequestParams,
  RpcThread,
  RpcTurn,
  ThreadStartParams,
  TurnStartParams
} from './CodexProtocol';

const RPC_TIMEOUT_MS: number = 30000;

interface PendingRequest {
  timer: number;
  resolve: (message: RpcEnvelope) => void;
  reject: (error: Error) => void;
}

interface AppServerRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: RpcRequestParams | RpcParams;
}

interface ThreadStartedEventParams extends RpcParams {
  thread?: RpcThread;
}

interface ApprovalRoute {
  rpcId: number | string;
  legacy: boolean;
  permissionReview?: PermissionReview;
}

/**
 * JSON-RPC client for `codex app-server --listen ws://...`.
 *
 * The upstream server is the execution authority. This class only transports
 * messages and turns server notifications/approval requests into UI events;
 * it never executes commands or writes workspace files on the device.
 */
export class AppServerWebSocketTransport implements CodexTransport {
  private readonly endpoint: string;
  private readonly cwd: string;
  private socket?: webSocket.WebSocket;
  private listener?: SessionEventListener;
  private readonly pending: Map<string, PendingRequest> = new Map();
  private readonly approvalIds: Map<string, ApprovalRoute> = new Map();
  private requestId: number = 0;
  private approvalSequence: number = 0;
  private rejectHandshake?: (error: Error) => void;
  private readonly attachedThreads: Set<string> = new Set();
  private threadId: string = '';

  constructor(endpoint: string, cwd: string = '/workspace') {
    this.endpoint = endpoint;
    this.cwd = cwd;
  }

  async connect(listener: SessionEventListener): Promise<void> {
    this.listener = listener;
    this.emit({
      kind: SessionEventKind.ConnectionChanged,
      id: 'connection',
      state: ConnectionState.Connecting,
      text: '正在连接 Codex App Server'
    });

    const socket: webSocket.WebSocket = webSocket.createWebSocket();
    this.socket = socket;
    let signalOpen: () => void = () => {};
    const opened = new Promise<void>((resolve) => { signalOpen = resolve; });
    socket.on('open', () => { if (this.socket === socket) { signalOpen(); } });
    socket.on('message', (error: Error, value: string | ArrayBuffer) => {
      if (this.socket === socket && !error) {
        this.handleIncoming(this.decodeMessage(value));
      }
    });
    socket.on('error', (error: Error) => {
      if (this.socket === socket) { this.closeConnection(socket, error, true); }
    });
    socket.on('close', () => {
      if (this.socket === socket) {
        this.closeConnection(socket, new Error('App Server 连接已关闭'), false);
      }
    });

    // Socket.connect() initiates the connection. Only 'open' means data can be sent.
    // Race the entire handshake against closure/timeout, including the initialized send.
    const aborted = new Promise<void>((_resolve, reject) => { this.rejectHandshake = reject; });
    const timeout = setTimeout(() => {
      if (this.socket === socket) {
        this.closeConnection(socket, new Error('App Server 握手超时'), true);
      }
    }, RPC_TIMEOUT_MS);
    try {
      await Promise.race([this.handshake(socket, opened), aborted]);
      if (this.socket !== socket) { throw new Error('App Server 连接已关闭'); }
      this.emit({
        kind: SessionEventKind.ConnectionChanged,
        id: 'connection',
        state: ConnectionState.Connected,
        text: 'Codex App Server 已连接'
      });
    } catch (error) {
      if (this.socket === socket) { this.closeConnection(socket, error as Error, true); }
      throw error as Error;
    } finally {
      clearTimeout(timeout);
      signalOpen();
      if (this.socket === socket) { this.rejectHandshake = undefined; }
    }
  }

  private async handshake(socket: webSocket.WebSocket, opened: Promise<void>): Promise<void> {
    try {
      if (!await socket.connect(this.endpoint)) { throw new Error('连接请求未受理'); }
    } catch (error) {
      throw new Error('未能建立 WebSocket 连接：' + (error as Error).message);
    }
    await opened;
    if (this.socket !== socket) { throw new Error('App Server 连接已关闭'); }
    const initializeParams: InitializeParams = {
      clientInfo: { name: 'dda', title: 'dda', version: '0.1.0' },
      capabilities: { experimentalApi: true }
    };
    await this.request('initialize', initializeParams);
    if (this.socket !== socket) { throw new Error('App Server 连接已关闭'); }
    await this.sendRaw(CodexProtocol.initialized());
  }

  async disconnect(): Promise<void> {
    const socket = this.socket;
    if (socket) {
      this.closeConnection(socket, new Error('已断开 App Server'), false);
      await this.closeSocket(socket);
    }
  }

  private async closeSocket(socket: webSocket.WebSocket): Promise<void> {
    try {
      await socket.close();
    } catch (_) {
      // Peer closure or a failed handshake may already have closed the native socket.
    }
  }

  async startThread(): Promise<string> {
    const params: ThreadStartParams = {
      approvalPolicy: 'on-request',
      cwd: this.cwd,
      sandbox: 'workspace-write'
    };
    const response: RpcEnvelope = await this.request('thread/start', params);
    const thread: RpcThread | undefined = response.result?.thread;
    const id: string = thread?.id ?? '';
    if (id.length === 0) {
      throw new Error('App Server 未返回 thread id');
    }
    this.attachedThreads.add(id);
    this.threadId = id;
    return id;
  }

  async sendTurn(threadId: string, input: string): Promise<string> {
    const socket = this.socket;
    if (!this.attachedThreads.has(threadId)) {
      // Reconnect to the selected thread on this connection. Never silently start a
      // new conversation while the user is looking at a previously opened one.
      const resumed = await this.request('thread/resume', { threadId: threadId });
      if (this.socket !== socket || resumed.result?.thread?.id !== threadId) {
        throw new Error('App Server 未能恢复所选会话');
      }
      this.attachedThreads.add(threadId);
    }
    this.threadId = threadId;
    const inputItem: RpcInput = {
      type: 'text',
      text: input
    };
    const params: TurnStartParams = {
      threadId: threadId,
      input: [inputItem]
    };
    const response: RpcEnvelope = await this.request('turn/start', params);
    const turn: RpcTurn | undefined = response.result?.turn;
    const turnId = turn?.id ?? '';
    if (!turnId) { throw new Error('App Server 未返回 turn id'); }
    return turnId;
  }

  async readDirectory(path: string): Promise<Array<WorkspaceEntry>> {
    const params: FsReadDirectoryParams = {
      path: path
    };
    const response: RpcEnvelope = await this.request('fs/readDirectory', params);
    const entries: Array<RpcDirectoryEntry> = response.result?.entries ?? [];
    const normalized: Array<WorkspaceEntry> = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry: RpcDirectoryEntry = entries[index];
      const childPath: string = path === '/' ? `/${entry.fileName}` : `${path}/${entry.fileName}`;
      normalized.push({
        path: childPath,
        fileName: entry.fileName,
        isDirectory: entry.isDirectory,
        isFile: entry.isFile
      });
    }
    return normalized;
  }

  async readFile(path: string): Promise<string> {
    const params: FsReadFileParams = {
      path: path
    };
    const response: RpcEnvelope = await this.request('fs/readFile', params);
    const dataBase64: string = response.result?.dataBase64 ?? '';
    if (dataBase64.length === 0) {
      return '';
    }
    const base64: util.Base64Helper = new util.Base64Helper();
    const bytes: Uint8Array = base64.decodeSync(dataBase64);
    const decoder: util.TextDecoder = util.TextDecoder.create('utf-8');
    return decoder.decodeToString(bytes);
  }

  resolveApproval(requestId: string, approved: boolean): void {
    const route: ApprovalRoute | undefined = this.approvalIds.get(requestId);
    if (route === undefined) {
      return;
    }
    this.approvalIds.delete(requestId);
    const socket = this.socket;
    const reply = route.permissionReview ? permissionResponse(route.rpcId, approved ? route.permissionReview : undefined) :
      CodexProtocol.approvalResponse(route.rpcId, approved, route.legacy);
    this.sendRaw(reply).catch((error: Error) => {
      if (this.socket === socket) { this.emitError(error.message); }
    });
  }

  private request(method: string, params: RpcRequestParams | RpcParams): Promise<RpcEnvelope> {
    const id: number = ++this.requestId;
    const key: string = id.toString();
    const response: Promise<RpcEnvelope> = new Promise<RpcEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`App Server 请求超时：${method}`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(key, {
        timer: timer,
        resolve: resolve,
        reject: reject
      });
    });
    const request: AppServerRequest = { jsonrpc: '2.0', id: id, method: method, params: params };
    const raw = JSON.stringify(request);
    this.sendRaw(raw).catch((error: Error) => {
      const pending: PendingRequest | undefined = this.pending.get(key);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pending.delete(key);
        pending.reject(error);
      }
    });
    return response;
  }

  private async sendRaw(raw: string): Promise<void> {
    if (this.socket === undefined) {
      throw new Error('App Server 连接不可用');
    }
    try {
      if (!await this.socket.send(raw)) { throw new Error('消息未送达'); }
    } catch (error) {
      throw new Error('App Server 消息发送失败：' + (error as Error).message);
    }
  }

  private handleIncoming(raw: string): void {
    const lines: Array<string> = raw.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line: string = lines[index].trim();
      if (line.length === 0) {
        continue;
      }
      const message: RpcEnvelope | null = CodexProtocol.parse(line);
      if (message === null) {
        this.emitError('收到无法解析的 App Server 消息');
        continue;
      }
      if (message.id !== undefined && message.method === undefined) {
        const pending: PendingRequest | undefined = this.pending.get(message.id.toString());
        if (pending !== undefined) {
          clearTimeout(pending.timer);
          this.pending.delete(message.id.toString());
          if (message.error !== undefined) {
            pending.reject(new Error(message.error.message));
          } else {
            pending.resolve(message);
          }
        }
        continue;
      }
      if (message.method !== undefined) {
        this.handleMethod(message);
      }
    }
  }

  private decodeMessage(value: string | ArrayBuffer): string {
    if (typeof value === 'string') {
      return value;
    }
    const decoder: util.TextDecoder = util.TextDecoder.create('utf-8');
    return decoder.decodeToString(new Uint8Array(value));
  }

  private handleMethod(message: RpcEnvelope): void {
    const emptyParams: RpcParams = {};
    const params: RpcParams = message.params ?? emptyParams;
    const method: string = message.method ?? '';
    const threadId: string = params.threadId ?? params.conversationId ?? this.threadId;
    if (method === 'item/agentMessage/delta') {
      this.emit({
        kind: SessionEventKind.AssistantDelta,
        id: `${params.itemId ?? 'agent'}-${Date.now()}`,
        threadId: threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        text: params.delta ?? ''
      });
    } else if (method === 'item/commandExecution/outputDelta') {
      this.emit({
        kind: SessionEventKind.CommandOutputDelta,
        id: `${params.itemId ?? 'command'}-${Date.now()}`,
        threadId: threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        text: params.delta ?? ''
      });
    } else if (method === 'turn/started') {
      this.emit({
        kind: SessionEventKind.TurnStarted,
        id: params.turn?.id ?? params.turnId ?? `turn-${Date.now()}`,
        threadId: threadId,
        turnId: params.turn?.id ?? params.turnId,
        text: 'Codex 开始处理请求'
      });
    } else if (method === 'turn/completed') {
      this.emit({
        kind: SessionEventKind.TurnCompleted,
        id: params.turn?.id ?? params.turnId ?? `turn-${Date.now()}`,
        threadId: threadId,
        turnId: params.turn?.id ?? params.turnId,
        text: 'Turn 已完成'
      });
    } else if (method === 'thread/started') {
      const started = (params as ThreadStartedEventParams).thread?.id ?? threadId;
      this.emit({
        kind: SessionEventKind.ThreadStarted,
        id: started,
        threadId: started,
        text: '新会话已准备好'
      });
    } else if (method === 'item/commandExecution/requestApproval' ||
      method === 'execCommandApproval' || method === 'applyPatchApproval' ||
      method === 'item/fileChange/requestApproval' ||
      method === 'item/permissions/requestApproval') {
      this.handleApprovalRequest(message, params, threadId);
    } else if (method === 'item/started') {
      const item: RpcItem | undefined = params.item;
      const itemId: string = item?.id ?? params.itemId ?? `item-${Date.now()}`;
      this.emit({
        kind: SessionEventKind.ToolStarted,
        id: itemId,
        threadId: threadId,
        turnId: params.turnId,
        itemId: itemId,
        command: this.commandText(item?.command),
        text: 'Codex 开始执行工具'
      });
    } else if (method === 'item/completed') {
      const item: RpcItem | undefined = params.item;
      const itemId: string = item?.id ?? params.itemId ?? `item-${Date.now()}`;
      this.emit({
        kind: SessionEventKind.ToolCompleted,
        id: itemId,
        threadId: threadId,
        turnId: params.turnId,
        itemId: itemId,
        text: '工具执行完成'
      });
    } else if (method === 'error') {
      this.emitError(params.reason ?? 'App Server 返回错误');
    }
  }

  private handleApprovalRequest(message: RpcEnvelope, params: RpcParams, threadId: string): void {
    if (message.id === undefined) {
      this.emitError('审批请求缺少 JSON-RPC id');
      return;
    }
    // A server may reuse a JSON-RPC id after reconnect. Keep the UI action
    // tied to this single approval and send the wire id only on its own socket.
    const requestId = `server-approval-${++this.approvalSequence}`;
    const method: string = message.method ?? '';
    let review: PermissionReview | null = null;
    if (method === 'item/permissions/requestApproval') {
      review = reviewPermissions(params.permissions, this.cwd);
      if (!review) {
        const socket = this.socket;
        this.sendRaw(permissionResponse(message.id)).catch((error: Error) => {
          if (this.socket === socket) { this.emitError(error.message); }
        });
        this.emit({ kind: SessionEventKind.ToolStarted, id: requestId, itemId: requestId, threadId: threadId,
          turnId: params.turnId, command: '已拒绝额外权限：鸿蒙端只支持逐项显示的项目内读写路径。' });
        return;
      }
    }
    this.approvalIds.set(requestId, {
      rpcId: message.id,
      legacy: method === 'execCommandApproval' || method === 'applyPatchApproval',
      permissionReview: review ?? undefined
    });
    this.emit({
      kind: SessionEventKind.ApprovalRequired,
      id: requestId,
      threadId: threadId,
      turnId: params.turnId,
      requestId: requestId,
      command: review ? review.display : this.commandText(params.command),
      reason: params.reason ?? 'Codex 请求执行受保护操作。'
    });
  }

  private commandText(command: string | Array<string> | null | undefined): string {
    if (typeof command === 'string') {
      return command;
    }
    if (command === null || command === undefined) {
      return '';
    }
    return command.join(' ');
  }

  private emit(event: SessionEvent): void {
    this.listener?.(event);
  }

  private emitError(message: string): void {
    this.emit({
      kind: SessionEventKind.Error,
      id: `error-${Date.now()}`,
      text: message
    });
  }

  private closeConnection(socket: webSocket.WebSocket, error: Error, failed: boolean): void {
    this.socket = undefined;
    this.attachedThreads.clear();
    this.approvalIds.clear();
    this.rejectHandshake?.(error);
    this.rejectHandshake = undefined;
    this.pending.forEach((pending: PendingRequest) => {
      clearTimeout(pending.timer);
      pending.reject(error);
    });
    this.pending.clear();
    this.emit({
      kind: SessionEventKind.ConnectionChanged,
      id: 'connection',
      state: failed ? ConnectionState.Error : ConnectionState.Disconnected,
      text: error.message
    });
    if (failed) { this.closeSocket(socket); }
  }
}
