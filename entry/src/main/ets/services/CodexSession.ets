import {
  CodexTransport,
  ConnectionState,
  SessionEvent,
  SessionEventKind,
  SessionEventListener,
  WorkspaceEntry
} from '../models/CodexTypes';

export class CodexSession {
  private transport: CodexTransport;
  private listener?: SessionEventListener;
  private threadId: string = '';
  private connected: boolean = false;
  private generation: number = 0;
  private opening?: Promise<void>;

  constructor(transport: CodexTransport) {
    this.transport = transport;
  }

  setListener(listener: SessionEventListener): void {
    this.listener = listener;
  }

  async connect(): Promise<void> {
    if (this.opening) {
      return this.opening;
    }
    if (this.connected) {
      return;
    }
    const generation = ++this.generation;
    const opening = this.openConnection(this.transport, generation);
    this.opening = opening;
    try {
      await opening;
    } finally {
      if (this.opening === opening) {
        this.opening = undefined;
      }
    }
  }

  private checkGeneration(generation: number): void {
    if (this.generation !== generation) {
      throw new Error('连接已切换，请重试');
    }
  }

  private async openConnection(transport: CodexTransport, generation: number): Promise<void> {
    let ready: SessionEvent = {
      kind: SessionEventKind.ConnectionChanged, state: ConnectionState.Connected, id: 'connection'
    };
    let disconnected = false;
    try {
      await transport.connect((event: SessionEvent) => {
        if (this.generation !== generation) { return; }
        if (event.state === ConnectionState.Connected) {
          ready = event;
          return;
        }
        if (event.state === ConnectionState.Disconnected || event.state === ConnectionState.Error) {
          disconnected = true;
          this.connected = false;
        }
        if (event.threadId && this.threadId && event.threadId !== this.threadId &&
          event.kind !== SessionEventKind.ThreadStarted) { return; }
        this.listener?.(event);
      });
      this.checkGeneration(generation);
      if (!disconnected && this.threadId.length === 0) {
        const id = await transport.startThread();
        this.checkGeneration(generation);
        if (!this.threadId) { this.threadId = id; }
      }
      if (disconnected) {
        throw new Error('会话准备期间连接已断开');
      }
      this.connected = true;
      this.listener?.(ready);
    } catch (error) {
      if (this.generation === generation) {
        this.connected = false;
        this.generation++;
        // startThread may fail after a successful handshake. Release the socket
        // so the next connect can establish one fresh connection.
        await transport.disconnect();
      }
      throw error as Error;
    }
  }

  currentThread(): string {
    return this.threadId;
  }

  async newThread(): Promise<void> {
    if (!this.threadId && !this.connected) {
      await this.connect();
      return;
    }
    const transport = this.transport;
    await this.connect();
    if (transport !== this.transport) { throw new Error('连接已切换，请重试'); }
    const generation = this.generation;
    const id = await transport.startThread();
    this.checkGeneration(generation);
    this.threadId = id;
  }

  selectThread(id: string): void {
    this.threadId = id;
  }

  async disconnect(): Promise<void> {
    this.generation++;
    this.connected = false;
    this.opening = undefined;
    await this.transport.disconnect();
  }

  async replaceTransport(transport: CodexTransport): Promise<void> {
    const closing = this.disconnect();
    this.transport = transport;
    this.threadId = '';
    await closing;
  }

  async sendPrompt(input: string): Promise<void> {
    const transport = this.transport;
    const id = this.threadId;
    await this.connect();
    if (transport !== this.transport || (id && id !== this.threadId) || !this.connected) {
      throw new Error('会话已切换，请重新发送');
    }
    await transport.sendTurn(this.threadId, input);
  }

  async readDirectory(path: string): Promise<Array<WorkspaceEntry>> {
    const transport = this.transport;
    await this.connect();
    const generation = this.generation;
    if (transport !== this.transport) { throw new Error('连接已切换，请重试'); }
    const entries = await transport.readDirectory(path);
    this.checkGeneration(generation);
    return entries;
  }

  async readFile(path: string): Promise<string> {
    const transport = this.transport;
    await this.connect();
    const generation = this.generation;
    if (transport !== this.transport) { throw new Error('连接已切换，请重试'); }
    const content = await transport.readFile(path);
    this.checkGeneration(generation);
    return content;
  }

  resolveApproval(requestId: string, approved: boolean): void {
    if (this.connected) {
      this.transport.resolveApproval(requestId, approved);
    }
  }
}
