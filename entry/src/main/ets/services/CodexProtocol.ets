export interface RpcError {
  code: number;
  message: string;
}

export interface RpcClientInfo {
  name: string;
  title: string;
  version: string;
}

export interface RpcCapabilities {
  experimentalApi: boolean;
}

export interface InitializeParams {
  clientInfo: RpcClientInfo;
  capabilities: RpcCapabilities;
}

export interface ThreadStartParams {
  cwd: string;
  approvalPolicy: string;
  sandbox: string;
}

export interface RpcInput {
  type: string;
  text: string;
}

export interface TurnStartParams {
  threadId: string;
  input: Array<RpcInput>;
}

export interface FsReadDirectoryParams {
  path: string;
}

export interface FsReadFileParams {
  path: string;
}

export interface RpcThread {
  id?: string;
}

export interface RpcTurn {
  id?: string;
}

export interface RpcItem {
  id?: string;
  type?: string;
  command?: string | Array<string> | null;
}

export interface RpcDirectoryEntry {
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface RpcParams {
  threadId?: string;
  turnId?: string;
  itemId?: string;
  startedAtMs?: number;
  kind?: string;
  environmentId?: string | null;
  delta?: string;
  conversationId?: string;
  command?: string | Array<string> | null;
  availableDecisions?: Array<string>;
  cwd?: string;
  reason?: string | null;
  approvalId?: string | null;
  grantRoot?: string | null;
  item?: RpcItem;
  turn?: RpcTurn;
}

export interface RpcResult {
  thread?: RpcThread;
  turn?: RpcTurn;
  entries?: Array<RpcDirectoryEntry>;
  dataBase64?: string;
  decision?: string | LegacyDecision;
}

export interface RpcEnvelope {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: RpcParams;
  result?: RpcResult;
  error?: RpcError;
}

export interface InitializedNotification {
  jsonrpc: string;
  method: string;
}

export type RpcRequestParams = InitializeParams | ThreadStartParams | TurnStartParams |
  FsReadDirectoryParams | FsReadFileParams;

export interface JsonRpcRequest {
  jsonrpc: string;
  id: number;
  method: string;
  params: RpcRequestParams;
}

export interface LegacyDenied {
  rejection: string;
}

export interface LegacyDecision {
  denied: LegacyDenied;
}

export interface ApprovalResult {
  decision: string | LegacyDecision;
}

export interface ApprovalResponse {
  jsonrpc: string;
  id: number | string;
  result: ApprovalResult;
}

/**
 * Dependency-free representation of the Codex App Server wire contract.
 * The upstream schema remains the source of truth; this client keeps the
 * handshake and core turn lifecycle explicit for the HarmonyOS transport.
 */
export class CodexProtocol {
  static initialize(id: number, clientName: string, clientVersion: string): string {
    const params: InitializeParams = {
      clientInfo: {
        name: clientName,
        title: 'dda',
        version: clientVersion
      },
      capabilities: {
        experimentalApi: true
      }
    };
    return CodexProtocol.request(id, 'initialize', params);
  }

  static initialized(): string {
    const notification: InitializedNotification = {
      jsonrpc: '2.0',
      method: 'initialized'
    };
    return JSON.stringify(notification);
  }

  static threadStart(id: number, cwd: string): string {
    const params: ThreadStartParams = {
      cwd: cwd,
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write'
    };
    return CodexProtocol.request(id, 'thread/start', params);
  }

  static turnStart(id: number, threadId: string, input: string): string {
    const inputItem: RpcInput = {
      type: 'text',
      text: input
    };
    const params: TurnStartParams = {
      threadId: threadId,
      input: [inputItem]
    };
    return CodexProtocol.request(id, 'turn/start', params);
  }

  static approvalResponse(id: number | string, approved: boolean, legacy: boolean = false): string {
    let decision: string | LegacyDecision = approved ? 'accept' : 'decline';
    if (legacy && !approved) {
      const denied: LegacyDenied = {
        rejection: '用户拒绝了该操作。'
      };
      decision = {
        denied: denied
      };
    } else if (legacy && approved) {
      decision = 'approved';
    }
    const result: ApprovalResult = {
      decision: decision
    };
    const response: ApprovalResponse = {
      jsonrpc: '2.0',
      id: id,
      result: result
    };
    return JSON.stringify(response);
  }

  static parse(raw: string): RpcEnvelope | null {
    try {
      return JSON.parse(raw) as RpcEnvelope;
    } catch (error) {
      return null;
    }
  }

  private static request(id: number, method: string, params: RpcRequestParams): string {
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: id,
      method: method,
      params: params
    };
    return JSON.stringify(request);
  }
}
