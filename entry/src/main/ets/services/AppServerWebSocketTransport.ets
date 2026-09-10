import webSocket from '@ohos.net.webSocket';
import util from '@ohos.util';
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
  JsonRpcRequest,
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

interface PendingRequest {
  resolve: (message: RpcEnvelope) => void;
  reject: (error: Error) => void;
}

interface ApprovalRoute {
  rpcId: number | string;
  legacy: boolean;
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
  private connected: boolean = false;
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
    socket.on('message', (error: Error, value: string | ArrayBuffer) => {
      if (!error) {
        this.handleIncoming(this.decodeMessage(value));
      }
    });
    socket.on('error', (error: Error) => {
      this.failConnection(error);
    });
    socket.on('close', (_error: Error, _result: webSocket.CloseResult) => {
      this.connected = false;
      this.emit({
        kind: SessionEventKind.ConnectionChanged,
        id: 'connection',
        state: ConnectionState.Disconnected,
        text: 'App Server 连接已关闭'
      });
    });

    try {
      await socket.connect(this.endpoint);
    } catch (error) {
      const failure: Error = error as Error;
      this.failConnection(failure);
      throw failure;
    }
    this.connected = true;
    this.emit({
      kind: SessionEventKind.ConnectionChanged,
      id: 'connection',
      state: ConnectionState.Connected,
      text: 'Codex App Server 已连接'
    });

    const initializeParams: InitializeParams = {
      clientInfo: {
        name: 'hmcodex',
        title: 'hmCodex',
        version: '0.1.0'
      },
      capabilities: {
        experimentalApi: true
      }
    };
    await this.request('initialize', initializeParams);
    await this.sendRaw(CodexProtocol.initialized());
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.socket !== undefined) {
      try {
        await this.socket.close();
      } catch (error) {
        this.failConnection(error as Error);
      }
    }
    this.socket = undefined;
    this.rejectPending(new Error('连接已断开'));
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
    this.threadId = id;
    return id;
  }

  async sendTurn(threadId: string, input: string): Promise<string> {
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
    return turn?.id ?? '';
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
    this.sendRaw(CodexProtocol.approvalResponse(route.rpcId, approved, route.legacy)).catch((error: Error) => {
      this.emitError(error.message);
    });
  }

  private request(method: string, params: RpcRequestParams): Promise<RpcEnvelope> {
    const id: number = ++this.requestId;
    const key: string = id.toString();
    const response: Promise<RpcEnvelope> = new Promise<RpcEnvelope>((resolve, reject) => {
      this.pending.set(key, {
        resolve: resolve,
        reject: reject
      });
    });
    this.sendRequest(id, method, params).catch((error: Error) => {
      const pending: PendingRequest | undefined = this.pending.get(key);
      if (pending !== undefined) {
        this.pending.delete(key);
        pending.reject(error);
      }
    });
    return response;
  }

  private async sendRequest(id: number, method: string, params: RpcRequestParams): Promise<void> {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: id,
      method: method,
      params: params
    };
    await this.sendRaw(JSON.stringify(request));
  }

  private async sendRaw(raw: string): Promise<void> {
    if (!this.connected || this.socket === undefined) {
      throw new Error('App Server 连接不可用');
    }
    let sent: boolean = false;
    try {
      sent = await this.socket.send(raw);
    } catch (error) {
      throw error as Error;
    }
    if (!sent) {
      throw new Error('App Server 消息发送失败');
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
      this.threadId = threadId;
      this.emit({
        kind: SessionEventKind.ThreadStarted,
        id: threadId,
        threadId: threadId,
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
    const requestId: string = message.id.toString();
    const method: string = message.method ?? '';
    this.approvalIds.set(requestId, {
      rpcId: message.id,
      legacy: method === 'execCommandApproval' || method === 'applyPatchApproval'
    });
    this.emit({
      kind: SessionEventKind.ApprovalRequired,
      id: requestId,
      threadId: threadId,
      turnId: params.turnId,
      requestId: requestId,
      command: this.commandText(params.command),
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

  private failConnection(error: Error): void {
    this.connected = false;
    this.emit({
      kind: SessionEventKind.ConnectionChanged,
      id: 'connection',
      state: ConnectionState.Error,
      text: error.message
    });
    this.emitError(error.message);
    this.rejectPending(error);
  }

  private rejectPending(error: Error): void {
    this.pending.forEach((pending: PendingRequest) => pending.reject(error));
    this.pending.clear();
  }
}
