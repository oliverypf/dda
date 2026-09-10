import {
  CodexTransport,
  ConnectionState,
  SessionEvent,
  SessionEventKind,
  SessionEventListener,
  WorkspaceEntry
} from '../models/CodexTypes';

/**
 * Deterministic local harness used by the UI until a real App Server endpoint
 * is configured. It deliberately emits the same lifecycle concepts as the
 * official server: thread, turn, item deltas and an approval request.
 */
export class MockCodexTransport implements CodexTransport {
  private listener?: SessionEventListener;
  private threadId: string = '';
  private pendingApprovalId: string = '';
  private pendingApprovalResolve?: (approved: boolean) => void;
  private connected: boolean = false;

  connect(listener: SessionEventListener): Promise<void> {
    this.listener = listener;
    this.listener({
      kind: SessionEventKind.ConnectionChanged,
      id: 'connection',
      state: ConnectionState.Connecting
    });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        this.connected = true;
        this.listener?.({
          kind: SessionEventKind.ConnectionChanged,
          id: 'connection',
          state: ConnectionState.Connected,
          text: '演示传输层已连接'
        });
        resolve();
      }, 250);
    });
  }

  disconnect(): Promise<void> {
    this.connected = false;
    this.pendingApprovalResolve?.(false);
    this.pendingApprovalResolve = undefined;
    this.pendingApprovalId = '';
    this.listener?.({
      kind: SessionEventKind.ConnectionChanged,
      id: 'connection',
      state: ConnectionState.Disconnected
    });
    return Promise.resolve();
  }

  startThread(): Promise<string> {
    this.threadId = `thread-demo-${Date.now()}`;
    this.listener?.({
      kind: SessionEventKind.ThreadStarted,
      id: this.threadId,
      threadId: this.threadId,
      text: '新会话已准备好'
    });
    return Promise.resolve(this.threadId);
  }

  async sendTurn(threadId: string, input: string): Promise<string> {
    if (!this.connected) {
      throw new Error('传输层尚未连接');
    }
    const turnId: string = `turn-demo-${Date.now()}`;
    const itemId: string = `item-demo-${Date.now()}`;
    this.listener?.({
      kind: SessionEventKind.TurnStarted,
      id: turnId,
      threadId: threadId,
      turnId: turnId,
      text: 'Codex 正在处理请求'
    });

    const normalized: string = input.toLowerCase();
    const needsApproval: boolean = normalized.includes('run') ||
      normalized.includes('执行') || normalized.includes('命令');
    if (needsApproval) {
      const approvalId: string = `approval-${turnId}`;
      this.pendingApprovalId = approvalId;
      const approvalPromise: Promise<boolean> = new Promise<boolean>((resolve) => {
        this.pendingApprovalResolve = resolve;
      });
      this.listener?.({
        kind: SessionEventKind.ToolStarted,
        id: `tool-${turnId}`,
        threadId: threadId,
        turnId: turnId,
        itemId: `tool-${turnId}`,
        command: 'pwd && ls',
        text: 'Codex 请求执行工作区命令'
      });
      this.listener?.({
        kind: SessionEventKind.ApprovalRequired,
        id: approvalId,
        threadId: threadId,
        turnId: turnId,
        requestId: approvalId,
        command: 'pwd && ls',
        reason: '该命令会读取当前工作区目录，需要你的确认。'
      });
      const approved: boolean = await approvalPromise;
      this.pendingApprovalResolve = undefined;
      this.pendingApprovalId = '';
      if (!approved) {
        await this.streamAssistant(threadId, turnId, itemId,
          '已取消命令执行。我仍然可以继续分析代码或制定计划。');
        this.listener?.({
          kind: SessionEventKind.TurnCompleted,
          id: turnId,
          threadId: threadId,
          turnId: turnId,
          text: 'Turn 已取消命令并完成'
        });
        return turnId;
      }
      this.listener?.({
        kind: SessionEventKind.CommandOutputDelta,
        id: `output-${turnId}`,
        threadId: threadId,
        turnId: turnId,
        itemId: `tool-${turnId}`,
        text: '$ pwd\n/workspace/hmCodex\n$ ls\nAppScope  entry  hvigorfile.ts\n'
      });
      this.listener?.({
        kind: SessionEventKind.ToolCompleted,
        id: `tool-${turnId}-completed`,
        threadId: threadId,
        turnId: turnId,
        itemId: `tool-${turnId}`,
        text: '命令已完成'
      });
      await this.streamAssistant(threadId, turnId, itemId,
        '命令执行完成。我可以继续读取文件、解释结果，或按你的要求修改项目。');
    } else {
      await this.streamAssistant(threadId, turnId, itemId,
        '我已收到你的请求。当前鸿蒙端已经具备 Thread/Turn 生命周期、流式消息和审批卡片；你可以在设置中切换到真实 Codex App Server 连接。');
    }
    this.listener?.({
      kind: SessionEventKind.TurnCompleted,
      id: turnId,
      threadId: threadId,
      turnId: turnId,
      text: 'Turn 已完成'
    });
    return turnId;
  }

  readDirectory(path: string): Promise<Array<WorkspaceEntry>> {
    if (!this.connected) {
      return Promise.reject(new Error('传输层尚未连接'));
    }
    if (path === '/' || path.length === 0) {
      const entries: Array<WorkspaceEntry> = [
        { path: '/AppScope', fileName: 'AppScope', isDirectory: true, isFile: false },
        { path: '/entry', fileName: 'entry', isDirectory: true, isFile: false },
        { path: '/build-profile.json5', fileName: 'build-profile.json5', isDirectory: false, isFile: true },
        { path: '/README.md', fileName: 'README.md', isDirectory: false, isFile: true }
      ];
      return Promise.resolve(entries);
    }
    if (path === '/entry') {
      const entries: Array<WorkspaceEntry> = [
        { path: '/entry/src', fileName: 'src', isDirectory: true, isFile: false },
        { path: '/entry/module.json5', fileName: 'module.json5', isDirectory: false, isFile: true },
        { path: '/entry/oh-package.json5', fileName: 'oh-package.json5', isDirectory: false, isFile: true }
      ];
      return Promise.resolve(entries);
    }
    if (path === '/entry/src') {
      const entries: Array<WorkspaceEntry> = [
        { path: '/entry/src/main', fileName: 'main', isDirectory: true, isFile: false },
        { path: '/entry/src/ohosTest', fileName: 'ohosTest', isDirectory: true, isFile: false }
      ];
      return Promise.resolve(entries);
    }
    if (path === '/entry/src/main') {
      const entries: Array<WorkspaceEntry> = [
        { path: '/entry/src/main/ets', fileName: 'ets', isDirectory: true, isFile: false },
        { path: '/entry/src/main/module.json5', fileName: 'module.json5', isDirectory: false, isFile: true }
      ];
      return Promise.resolve(entries);
    }
    return Promise.resolve([]);
  }

  readFile(path: string): Promise<string> {
    if (!this.connected) {
      return Promise.reject(new Error('传输层尚未连接'));
    }
    if (path === '/README.md') {
      return Promise.resolve('# hmCodex\n\nHarmonyOS 原生 Codex 工作台演示文件。');
    }
    if (path === '/build-profile.json5') {
      return Promise.resolve('{\n  "app": {\n    "targetSdkVersion": "6.1.1(24)"\n  }\n}');
    }
    if (path === '/entry/module.json5') {
      return Promise.resolve('{\n  "module": {\n    "name": "entry",\n    "type": "entry"\n  }\n}');
    }
    return Promise.resolve(`// ${path}\n// Codex 工作区文件预览`);
  }

  resolveApproval(requestId: string, approved: boolean): void {
    if (requestId !== this.pendingApprovalId || !this.pendingApprovalResolve) {
      return;
    }
    const resolve: (value: boolean) => void = this.pendingApprovalResolve;
    this.pendingApprovalResolve = undefined;
    resolve(approved);
  }

  private async streamAssistant(threadId: string, turnId: string, itemId: string, text: string): Promise<void> {
    const chunks: string[] = text.split('');
    for (let index = 0; index < chunks.length; index += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 18));
      this.listener?.({
        kind: SessionEventKind.AssistantDelta,
        id: `delta-${turnId}-${index}`,
        threadId: threadId,
        turnId: turnId,
        itemId: itemId,
        text: chunks[index]
      });
    }
  }
}
