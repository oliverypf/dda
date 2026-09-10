import {
  ApprovalRequest,
  ChatMessage,
  ConnectionState,
  MessageRole,
  SessionEvent,
  SessionEventKind,
  WorkspaceEntry
} from '../models/CodexTypes';
import { AppServerWebSocketTransport } from '../services/AppServerWebSocketTransport';
import { CodexSession } from '../services/CodexSession';
import { MockCodexTransport } from '../services/MockCodexTransport';

@Entry
@Component
struct Index {
  private readonly session: CodexSession = new CodexSession();
  private activeAssistantId: string = '';
  private activeToolId: string = '';

  @State messages: ChatMessage[] = [{
    id: 'welcome',
    role: MessageRole.Assistant,
    text: '你好，我是 Codex。告诉我你想分析、实现或修复什么，我会在工作区中协助你。',
    title: 'Codex'
  }];
  @State composer: string = '';
  @State connectionState: ConnectionState = ConnectionState.Disconnected;
  @State isBusy: boolean = false;
  @State statusText: string = '正在准备连接';
  @State workspaceRoot: string = '未选择项目';
  @State projectRoot: string = '/workspace';
  @State workspacePath: string = '/';
  @State workspaceEntries: Array<WorkspaceEntry> = [];
  @State selectedFilePath: string = '';
  @State selectedFileContent: string = '';
  @State showWorkspace: boolean = false;
  @State endpoint: string = '';
  @State showConnectionSettings: boolean = false;
  @State hasApproval: boolean = false;
  @State approval: ApprovalRequest = {
    id: '',
    command: '',
    reason: ''
  };

  aboutToAppear(): void {
    this.session.setListener((event: SessionEvent) => this.handleSessionEvent(event));
    this.session.connect().then(() => this.loadWorkspace('/')).catch((error: Error) => {
      this.connectionState = ConnectionState.Error;
      this.statusText = error.message;
      this.appendMessage({
        id: `error-${Date.now()}`,
        role: MessageRole.System,
        text: `连接失败：${error.message}`
      });
    });
  }

  aboutToDisappear(): void {
    this.session.disconnect();
  }

  build() {
    Column() {
      this.buildHeader();
      Divider().color('#E5E7EB');
      if (this.showConnectionSettings) {
        this.buildConnectionSettings();
      }
      this.buildWorkspaceBar();
      if (this.showWorkspace) {
        this.buildWorkspacePanel();
      }
      this.buildTranscript();
      if (this.hasApproval) {
        this.buildApprovalCard();
      }
      this.buildComposer();
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#F7F8FA');
  }

  @Builder
  private buildHeader() {
    Row() {
      Column() {
        Text('Codex')
          .fontSize(24)
          .fontWeight(FontWeight.Bold)
          .fontColor('#111827');
        Text('鸿蒙原生工作台')
          .fontSize(12)
          .fontColor('#6B7280');
      }
      .alignItems(HorizontalAlign.Start);
      Blank();
      Text(this.statusText)
        .fontSize(12)
        .fontColor(this.connectionState === ConnectionState.Connected ? '#16803C' : '#9A6700');
      Text(this.connectionState === ConnectionState.Connected ? '●' : '○')
        .fontSize(18)
        .fontColor(this.connectionState === ConnectionState.Connected ? '#22C55E' : '#D1D5DB')
        .margin({ left: 6 });
      Button('设置')
        .fontSize(12)
        .fontColor('#2563EB')
        .backgroundColor('#EFF6FF')
        .margin({ left: 10 })
        .onClick(() => {
          this.showConnectionSettings = !this.showConnectionSettings;
        });
    }
    .width('100%')
    .padding({ left: 18, right: 18, top: 16, bottom: 12 });
  }

  @Builder
  private buildConnectionSettings() {
    Column() {
      Text('App Server 连接')
        .fontSize(14)
        .fontWeight(FontWeight.Bold)
        .fontColor('#111827')
        .alignSelf(ItemAlign.Start);
      Text('真实模式需要一个可访问的 Codex App Server WebSocket 地址。')
        .fontSize(12)
        .fontColor('#6B7280')
        .margin({ top: 4, bottom: 8 });
      TextInput({ placeholder: '例如：wss://your-codex-host/app-server', text: this.endpoint })
        .height(44)
        .fontSize(13)
        .backgroundColor('#F9FAFB')
        .borderRadius(8)
        .onChange((value: string) => {
          this.endpoint = value;
        });
      TextInput({ placeholder: 'App Server 上的项目目录，例如：/workspace', text: this.projectRoot })
        .height(44)
        .fontSize(13)
        .backgroundColor('#F9FAFB')
        .borderRadius(8)
        .margin({ top: 8 })
        .onChange((value: string) => {
          this.projectRoot = value;
        });
      Row() {
        Button('使用演示模式')
          .fontSize(12)
          .fontColor('#374151')
          .backgroundColor('#F3F4F6')
          .layoutWeight(1)
          .onClick(() => this.useDemoTransport());
        Button('连接 App Server')
          .fontSize(12)
          .fontColor('#FFFFFF')
          .backgroundColor('#2563EB')
          .layoutWeight(1)
          .margin({ left: 8 })
          .onClick(() => this.connectAppServer());
      }
      .width('100%')
      .margin({ top: 10 });
    }
    .width('100%')
    .padding({ left: 18, right: 18, top: 12, bottom: 12 })
    .backgroundColor('#FFFFFF');
  }

  @Builder
  private buildWorkspaceBar() {
    Row() {
      Column() {
        Text('工作区')
          .fontSize(11)
          .fontColor('#6B7280');
        Text(this.workspaceRoot)
          .fontSize(14)
          .fontColor('#111827')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });
      }
      .alignItems(HorizontalAlign.Start)
      .layoutWeight(1);
      Button(this.showWorkspace ? '收起文件' : '浏览文件')
        .fontSize(12)
        .fontColor('#2563EB')
        .backgroundColor('#EFF6FF')
        .onClick(() => this.toggleWorkspace());
    }
    .width('100%')
    .padding({ left: 18, right: 18, top: 10, bottom: 10 })
    .backgroundColor('#FFFFFF');
  }

  @Builder
  private buildWorkspacePanel() {
    Column() {
      Row() {
        Text('项目文件')
          .fontSize(13)
          .fontWeight(FontWeight.Bold)
          .fontColor('#111827');
        Blank();
        Button('刷新')
          .fontSize(11)
          .fontColor('#2563EB')
          .backgroundColor('#EFF6FF')
          .onClick(() => this.loadWorkspace(this.workspacePath));
      }
      .width('100%');
      Text(this.workspacePath)
        .fontSize(11)
        .fontColor('#6B7280')
        .margin({ top: 4, bottom: 6 })
        .alignSelf(ItemAlign.Start);
      Scroll() {
        Column() {
          ForEach(this.workspaceEntries, (entry: WorkspaceEntry) => {
            Row() {
              Text(entry.isDirectory ? '▸' : '·')
                .fontSize(15)
                .fontColor(entry.isDirectory ? '#2563EB' : '#9CA3AF')
                .margin({ right: 8 });
              Text(entry.fileName)
                .fontSize(13)
                .fontColor('#1F2937')
                .maxLines(1)
                .textOverflow({ overflow: TextOverflow.Ellipsis });
            }
            .width('100%')
            .padding({ top: 7, bottom: 7, left: 8, right: 8 })
            .backgroundColor('#F9FAFB')
            .borderRadius(7)
            .margin({ bottom: 4 })
            .onClick(() => this.openWorkspaceEntry(entry));
          }, (entry: WorkspaceEntry) => entry.path);
        }
        .width('100%');
      }
      .height(118)
      .scrollable(ScrollDirection.Vertical)
      .scrollBar(BarState.Off);
      if (this.selectedFilePath.length > 0) {
        Column() {
          Text(`已选文件：${this.selectedFilePath}`)
            .fontSize(11)
            .fontColor('#2563EB')
            .margin({ bottom: 4 })
            .alignSelf(ItemAlign.Start);
          Scroll() {
            Text(this.selectedFileContent)
              .fontSize(11)
              .fontColor('#374151')
              .fontFamily('monospace')
              .lineHeight(17)
              .width('100%');
          }
          .height(100)
          .scrollable(ScrollDirection.Vertical)
          .scrollBar(BarState.Off)
          .width('100%')
          .backgroundColor('#FFFFFF')
          .borderRadius(7)
          .padding(8);
        }
        .width('100%')
        .margin({ top: 6 });
      }
    }
    .width('100%')
    .padding({ left: 18, right: 18, top: 10, bottom: 10 })
    .backgroundColor('#F0F6FF');
  }

  @Builder
  private buildTranscript() {
    Scroll() {
      Column() {
        ForEach(this.messages, (message: ChatMessage) => {
          this.buildMessage(message);
        }, (message: ChatMessage) => message.id);
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 16, bottom: 16 });
    }
    .layoutWeight(1)
    .scrollable(ScrollDirection.Vertical)
    .scrollBar(BarState.Off);
  }

  @Builder
  private buildMessage(message: ChatMessage) {
    Row() {
      if (message.role !== MessageRole.User) {
        Text(message.role === MessageRole.Tool ? '▣' : '✦')
          .fontSize(16)
          .fontColor(message.role === MessageRole.Tool ? '#B45309' : '#2563EB')
          .margin({ right: 8, top: 4 });
      }
      Column() {
        if (message.title !== undefined) {
          Text(message.title)
            .fontSize(11)
            .fontColor('#6B7280')
            .margin({ bottom: 4 });
        }
        Text(message.text)
          .fontSize(15)
          .fontColor(message.role === MessageRole.User ? '#FFFFFF' : '#1F2937')
          .lineHeight(23);
      }
      .alignItems(HorizontalAlign.Start)
      .padding(12)
      .backgroundColor(message.role === MessageRole.User ? '#2563EB' :
        message.role === MessageRole.Tool ? '#FFF7ED' : '#FFFFFF')
      .borderRadius(14)
      .constraintSize({ maxWidth: '86%' });
      if (message.role === MessageRole.User) {
        Text('●')
          .fontSize(16)
          .fontColor('#93C5FD')
          .margin({ left: 8, top: 4 });
      }
    }
    .width('100%')
    .justifyContent(message.role === MessageRole.User ? FlexAlign.End : FlexAlign.Start)
    .margin({ bottom: 12 });
  }

  @Builder
  private buildApprovalCard() {
    Column() {
      Row() {
        Text('需要你的确认')
          .fontSize(15)
          .fontWeight(FontWeight.Bold)
          .fontColor('#92400E');
        Blank();
        Text('权限边界')
          .fontSize(11)
          .fontColor('#B45309');
      }
      .width('100%');
      Text(this.approval.reason)
        .fontSize(13)
        .fontColor('#78350F')
        .margin({ top: 8, bottom: 8 });
      Text(this.approval.command)
        .fontSize(13)
        .fontColor('#111827')
        .fontFamily('monospace')
        .padding(10)
        .width('100%')
        .backgroundColor('#FFFBEB')
        .borderRadius(8);
      Row() {
        Button('拒绝')
          .fontSize(13)
          .fontColor('#92400E')
          .backgroundColor('#FFFFFF')
          .layoutWeight(1)
          .onClick(() => this.resolveApproval(false));
        Button('允许执行')
          .fontSize(13)
          .fontColor('#FFFFFF')
          .backgroundColor('#D97706')
          .layoutWeight(1)
          .margin({ left: 8 })
          .onClick(() => this.resolveApproval(true));
      }
      .width('100%')
      .margin({ top: 10 });
    }
    .width('100%')
    .padding(14)
    .backgroundColor('#FEF3C7')
    .borderRadius(14)
    .margin({ left: 16, right: 16, bottom: 10 });
  }

  @Builder
  private buildComposer() {
    Row() {
      TextArea({ placeholder: '询问 Codex，或描述你要完成的代码任务…', text: this.composer })
        .layoutWeight(1)
        .height(58)
        .fontSize(15)
        .backgroundColor('#FFFFFF')
        .borderRadius(12)
        .onChange((value: string) => {
          this.composer = value;
        });
      Button(this.isBusy ? '处理中' : '发送')
        .enabled(!this.isBusy && this.composer.trim().length > 0)
        .fontSize(14)
        .fontColor('#FFFFFF')
        .backgroundColor('#2563EB')
        .height(48)
        .margin({ left: 8 })
        .onClick(() => this.sendPrompt());
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 14 })
    .backgroundColor('#F7F8FA');
  }

  private async sendPrompt(): Promise<void> {
    const prompt: string = this.composer.trim();
    if (prompt.length === 0 || this.isBusy) {
      return;
    }
    this.appendMessage({
      id: `user-${Date.now()}`,
      role: MessageRole.User,
      text: prompt
    });
    this.composer = '';
    this.isBusy = true;
    try {
      await this.session.sendPrompt(prompt);
    } catch (error) {
      this.isBusy = false;
      this.appendMessage({
        id: `error-${Date.now()}`,
        role: MessageRole.System,
        text: `请求失败：${(error as Error).message}`
      });
    }
  }

  private toggleWorkspace(): void {
    this.showWorkspace = !this.showWorkspace;
    if (this.showWorkspace && this.workspaceEntries.length === 0) {
      this.loadWorkspace(this.workspacePath);
    }
  }

  private openWorkspaceEntry(entry: WorkspaceEntry): void {
    if (entry.isDirectory) {
      this.selectedFilePath = '';
      this.selectedFileContent = '';
      this.loadWorkspace(entry.path);
    } else {
      this.loadFile(entry);
    }
  }

  private async loadWorkspace(path: string): Promise<void> {
    try {
      const entries: Array<WorkspaceEntry> = await this.session.readDirectory(path);
      this.workspacePath = path;
      this.workspaceEntries = entries;
      this.workspaceRoot = path === '/' ? '演示工作区' : path;
      this.showWorkspace = true;
    } catch (error) {
      this.appendMessage({
        id: `workspace-error-${Date.now()}`,
        role: MessageRole.System,
        text: `读取工作区失败：${(error as Error).message}`
      });
    }
  }

  private async loadFile(entry: WorkspaceEntry): Promise<void> {
    try {
      const content: string = await this.session.readFile(entry.path);
      this.selectedFilePath = entry.path;
      this.selectedFileContent = content;
      this.statusText = `已打开 ${entry.fileName}`;
    } catch (error) {
      this.appendMessage({
        id: `file-error-${Date.now()}`,
        role: MessageRole.System,
        text: `读取文件失败：${(error as Error).message}`
      });
    }
  }

  private resolveApproval(approved: boolean): void {
    const requestId: string = this.approval.id;
    this.hasApproval = false;
    this.session.resolveApproval(requestId, approved);
  }

  private async useDemoTransport(): Promise<void> {
    await this.session.replaceTransport(new MockCodexTransport());
    this.showConnectionSettings = false;
    this.statusText = '正在切换演示模式';
    await this.session.connect();
    await this.loadWorkspace('/');
  }

  private async connectAppServer(): Promise<void> {
    const address: string = this.endpoint.trim();
    const root: string = this.projectRoot.trim().length > 0 ? this.projectRoot.trim() : '/workspace';
    if (address.length === 0) {
      this.statusText = '请先填写 App Server 地址';
      return;
    }
    if (!address.startsWith('ws://') && !address.startsWith('wss://')) {
      this.statusText = '地址必须使用 ws:// 或 wss://';
      return;
    }
    this.projectRoot = root;
    this.showConnectionSettings = false;
    this.statusText = '正在连接 App Server';
    try {
      await this.session.replaceTransport(new AppServerWebSocketTransport(address, root));
      await this.session.connect();
      await this.loadWorkspace(root);
    } catch (error) {
      this.connectionState = ConnectionState.Error;
      this.statusText = `连接失败：${(error as Error).message}`;
      this.appendMessage({
        id: `error-${Date.now()}`,
        role: MessageRole.System,
        text: `App Server 连接失败：${(error as Error).message}`
      });
    }
  }

  private handleSessionEvent(event: SessionEvent): void {
    switch (event.kind) {
      case SessionEventKind.ConnectionChanged:
        this.connectionState = event.state ?? ConnectionState.Disconnected;
        this.statusText = event.text ?? this.connectionState;
        break;
      case SessionEventKind.ThreadStarted:
        this.statusText = '会话已就绪';
        break;
      case SessionEventKind.TurnStarted:
        this.isBusy = true;
        this.statusText = 'Codex 工作中';
        this.activeAssistantId = '';
        this.activeToolId = '';
        break;
      case SessionEventKind.AssistantDelta:
        this.appendAssistantDelta(event);
        break;
      case SessionEventKind.ToolStarted:
        this.activeToolId = event.itemId ?? event.id;
        this.appendMessage({
          id: this.activeToolId,
          role: MessageRole.Tool,
          title: '工具调用',
          text: event.command ?? event.text ?? 'Codex 正在调用工具'
        });
        break;
      case SessionEventKind.CommandOutputDelta:
        this.appendToolDelta(event);
        break;
      case SessionEventKind.ApprovalRequired:
        this.approval = {
          id: event.requestId ?? event.id,
          command: event.command ?? '',
          reason: event.reason ?? 'Codex 请求执行受保护操作。'
        };
        this.hasApproval = true;
        this.statusText = '等待确认';
        break;
      case SessionEventKind.ToolCompleted:
        this.statusText = '工具执行完成';
        break;
      case SessionEventKind.TurnCompleted:
        this.isBusy = false;
        this.statusText = '准备就绪';
        break;
      case SessionEventKind.Error:
        this.isBusy = false;
        this.appendMessage({
          id: `error-${Date.now()}`,
          role: MessageRole.System,
          text: event.text ?? '发生未知错误'
        });
        break;
      default:
        break;
    }
  }

  private appendAssistantDelta(event: SessionEvent): void {
    const messageId: string = this.activeAssistantId.length > 0 ?
      this.activeAssistantId : (event.itemId ?? `assistant-${Date.now()}`);
    this.activeAssistantId = messageId;
    const next: ChatMessage[] = this.messages.slice();
    let index: number = -1;
    for (let cursor = 0; cursor < next.length; cursor += 1) {
      if (next[cursor].id === messageId) {
        index = cursor;
        break;
      }
    }
    if (index === -1) {
      next.push({
        id: messageId,
        role: MessageRole.Assistant,
        title: 'Codex',
        text: event.text ?? ''
      });
    } else {
      const existing: ChatMessage = next[index];
      next[index] = {
        id: existing.id,
        role: existing.role,
        title: existing.title,
        text: existing.text + (event.text ?? ''),
        status: existing.status
      };
    }
    this.messages = next;
  }

  private appendToolDelta(event: SessionEvent): void {
    const messageId: string = event.itemId ?? this.activeToolId;
    const next: ChatMessage[] = this.messages.slice();
    for (let index = 0; index < next.length; index += 1) {
      if (next[index].id === messageId) {
        const existing: ChatMessage = next[index];
        next[index] = {
          id: existing.id,
          role: existing.role,
          title: existing.title,
          text: existing.text + (event.text ?? ''),
          status: existing.status
        };
        this.messages = next;
        return;
      }
    }
  }

  private appendMessage(message: ChatMessage): void {
    this.messages = this.messages.concat([message]);
  }
}
