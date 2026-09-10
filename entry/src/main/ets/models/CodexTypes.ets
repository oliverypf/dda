export enum ConnectionState {
  Disconnected = 'disconnected',
  Connecting = 'connecting',
  Connected = 'connected',
  Error = 'error'
}

export enum MessageRole {
  User = 'user',
  Assistant = 'assistant',
  Tool = 'tool',
  System = 'system'
}

export enum SessionEventKind {
  ConnectionChanged = 'connectionChanged',
  ThreadStarted = 'threadStarted',
  TurnStarted = 'turnStarted',
  AssistantDelta = 'assistantDelta',
  CommandOutputDelta = 'commandOutputDelta',
  ToolStarted = 'toolStarted',
  ToolCompleted = 'toolCompleted',
  ApprovalRequired = 'approvalRequired',
  TurnCompleted = 'turnCompleted',
  Error = 'error'
}

export interface ChatMessage {
  id: string;
  role: MessageRole;
  text: string;
  title?: string;
  status?: string;
}

export interface ApprovalRequest {
  id: string;
  command: string;
  reason: string;
}

export interface WorkspaceEntry {
  path: string;
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface SessionEvent {
  kind: SessionEventKind;
  id: string;
  text?: string;
  state?: ConnectionState;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  command?: string;
  reason?: string;
  requestId?: string;
}

export type SessionEventListener = (event: SessionEvent) => void;

export interface CodexTransport {
  connect(listener: SessionEventListener): Promise<void>;
  disconnect(): Promise<void>;
  startThread(): Promise<string>;
  sendTurn(threadId: string, input: string): Promise<string>;
  readDirectory(path: string): Promise<Array<WorkspaceEntry>>;
  readFile(path: string): Promise<string>;
  resolveApproval(requestId: string, approved: boolean): void;
}
