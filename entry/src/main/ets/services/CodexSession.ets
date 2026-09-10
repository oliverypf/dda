import {
  CodexTransport,
  ConnectionState,
  SessionEvent,
  SessionEventListener,
  WorkspaceEntry
} from '../models/CodexTypes';
import { MockCodexTransport } from './MockCodexTransport';

export class CodexSession {
  private transport: CodexTransport;
  private listener?: SessionEventListener;
  private threadId: string = '';
  private connected: boolean = false;

  constructor(transport: CodexTransport = new MockCodexTransport()) {
    this.transport = transport;
  }

  setListener(listener: SessionEventListener): void {
    this.listener = listener;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    await this.transport.connect((event: SessionEvent) => {
      if (event.state === ConnectionState.Connected) {
        this.connected = true;
      } else if (event.state === ConnectionState.Disconnected ||
        event.state === ConnectionState.Error) {
        this.connected = false;
      }
      this.listener?.(event);
    });
    this.threadId = await this.transport.startThread();
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    await this.transport.disconnect();
  }

  async replaceTransport(transport: CodexTransport): Promise<void> {
    await this.disconnect();
    this.transport = transport;
    this.threadId = '';
    this.connected = false;
  }

  async sendPrompt(input: string): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
    if (this.threadId.length === 0) {
      this.threadId = await this.transport.startThread();
    }
    await this.transport.sendTurn(this.threadId, input);
  }

  async readDirectory(path: string): Promise<Array<WorkspaceEntry>> {
    if (!this.connected) {
      await this.connect();
    }
    return this.transport.readDirectory(path);
  }

  async readFile(path: string): Promise<string> {
    if (!this.connected) {
      await this.connect();
    }
    return this.transport.readFile(path);
  }

  resolveApproval(requestId: string, approved: boolean): void {
    this.transport.resolveApproval(requestId, approved);
  }
}
