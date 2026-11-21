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

interface TaskView {
  threadId: string;
  title: string;
  messages: ChatMessage[];
  draft: string;
}

@Entry
@Component
struct Index {
  private readonly session: CodexSession = new CodexSession();
  private activeAssistantId: string = '';
  private activeToolId: string = '';

  @State messages: ChatMessage[] = [];
  @State tasks: TaskView[] = [];
  @State currentTitle: string = '新建任务';
  @State panel: string = '任务对话';
  @State availableWidth: number = 1000;
  @State compactMenu: boolean = false;
  @State projectExpanded: boolean = true;
  @State demo: boolean = true;
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
  @State endpoint: string = '';
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
    Row() {
      if (this.availableWidth >= 720) {
        this.sidebar();
      }
      Column() {
        Row() {
          if (this.availableWidth < 720) {
            Button('项目').onClick(() => { this.compactMenu = !this.compactMenu; });
          }
          Column({ space: 3 }) {
            Text(this.currentTitle).fontSize(18).fontWeight(FontWeight.Bold).maxLines(1)
              .textOverflow({ overflow: TextOverflow.Ellipsis });
            Text('当前工作区  ' + this.workspaceRoot).fontSize(12).fontColor('#768398');
          }.alignItems(HorizontalAlign.Start).layoutWeight(1);
          if (this.availableWidth < 980) {
            Button('功能导航').fontSize(13).onClick(() => {
              this.panel = this.panel === '导航' ? '任务对话' : '导航';
              this.compactMenu = false;
            });
          }
        }.width('100%').height(68).padding({ left: 18, right: 16 }).backgroundColor('#FFFFFF');
        Divider();
        Row({ space: 8 }) {
          Text('●').fontSize(11).fontColor(this.connectionState === ConnectionState.Connected ? '#12814D' : '#A66A00');
          Text(this.statusText).fontSize(12).fontColor('#566477');
        }.height(38).width('100%').padding({ left: 18 }).backgroundColor('#FAFBFD');
        Divider();
        if (this.compactMenu && this.availableWidth < 720) {
          this.sidebar();
        } else if (this.availableWidth < 980 && this.panel !== '任务对话') {
          Scroll() {
            Column() {
              this.navigation();
              this.panelContent();
            }.width('100%');
          }.layoutWeight(1).width('100%');
        } else {
          this.buildTranscript();
          if (this.hasApproval) { this.buildApprovalCard(); }
          this.buildComposer();
        }
      }.layoutWeight(1).height('100%').backgroundColor('#F7F8FA');
      if (this.availableWidth >= 980) {
        Scroll() {
          Column() {
            this.navigation();
            this.panelContent();
          }.width('100%');
        }.width('29%').height('100%').align(Alignment.TopStart)
          .border({ width: { left: 1 }, color: '#DAE0EA' }).backgroundColor('#FFFFFF');
      }
    }.width('100%').height('100%').alignItems(VerticalAlign.Top)
      .onAreaChange((_old: Area, area: Area) => { this.availableWidth = Number(area.width); });
  }

  @Builder
  private sidebar() {
    Column({ space: 10 }) {
      Row({ space: 10 }) {
        Text('dda').fontSize(15).fontColor('#FFFFFF').fontWeight(FontWeight.Bold)
          .backgroundColor('#181B20').padding(8).borderRadius(7);
        Column({ space: 3 }) {
          Text('dda').fontSize(17).fontWeight(FontWeight.Bold);
          Text(this.demo ? '鸿蒙演示模式' : '鸿蒙 App Server').fontSize(12).fontColor('#768398');
        }.alignItems(HorizontalAlign.Start);
      }.width('100%').padding({ top: 10, bottom: 12 });
      Button('＋  新建任务').width('100%').height(40).borderRadius(7).backgroundColor('#1968E9')
        .enabled(!this.isBusy && this.connectionState === ConnectionState.Connected)
        .onClick(() => this.newTask());
      Text('项目').width('100%').fontSize(13).fontColor('#748094').margin({ top: 20 });
      Text((this.projectExpanded ? '⌄   ' : '›   ') + this.workspaceRoot)
        .fontWeight(FontWeight.Medium).fontSize(14).width('100%').padding(6)
        .onClick(() => { this.projectExpanded = !this.projectExpanded; });
      Scroll() {
        Column({ space: 5 }) {
          if (this.projectExpanded) {
            Text(this.currentTitle).fontSize(14).width('100%').padding(10)
              .backgroundColor('#F1F3F6').borderRadius(6).maxLines(2)
              .onClick(() => this.openPanel('任务对话'));
            this.taskList();
          }
        }.width('100%');
      }.layoutWeight(1).width('100%').align(Alignment.TopStart);
      Button('⚙  设置').width('100%').fontColor('#475569').backgroundColor('#F7F8FA')
        .onClick(() => this.openPanel('设置与排查'));
    }.height(this.availableWidth < 720 ? '80%' : '100%').width(this.availableWidth < 720 ? '100%' : '20%')
      .padding(14).alignItems(HorizontalAlign.Start).backgroundColor('#FFFFFF')
      .border({ width: { right: 1 }, color: '#DAE0EA' });
  }

  @Builder
  private taskList() {
    ForEach(this.tasks, (task: TaskView) => {
      Text(task.title).width('100%').fontSize(14).maxLines(2).padding(9)
        .textOverflow({ overflow: TextOverflow.Ellipsis }).enabled(!this.isBusy)
        .onClick(() => this.restoreTask(task));
    }, (task: TaskView) => task.threadId);
  }

  @Builder
  private navItem(label: string, hint: string, icon: string) {
    Row({ space: 8 }) {
      Text(icon).fontSize(18).fontColor(this.panel === label ? '#1359B9' : '#526174');
      Column({ space: 4 }) {
        Text(label).fontSize(14).fontWeight(FontWeight.Bold);
        Text(hint).fontSize(12).fontColor('#66758A');
      }.alignItems(HorizontalAlign.Start);
    }.layoutWeight(1).height(58).padding(8).borderRadius(6)
      .backgroundColor(this.panel === label ? '#E9F1FE' : '#FFFFFF')
      .onClick(() => this.openPanel(label));
  }

  @Builder
  private navigation() {
    Column({ space: 3 }) {
      Text('功能导航').fontSize(12).fontColor('#77869A').width('100%');
      Row() { this.navItem('任务对话', '提需求、看回答', '⊞'); this.navItem('历史任务', '查找过去的任务', '◷'); }
      Row() { this.navItem('项目文件', '浏览文件内容', '☷'); this.navItem('技能与记忆', '想看时再打开', '▤'); }
      Row() { this.navItem('操作权限', '查看授权与审批', '◇'); this.navItem('设置与排查', '配置连接、查故障', '⚙'); }
    }.padding(12).width('100%').backgroundColor('#FFFFFF');
    Divider();
  }

  @Builder
  private panelContent() {
    if (this.panel === '项目文件') {
      this.buildWorkspacePanel();
    } else if (this.panel === '设置与排查') {
      this.buildConnectionSettings();
    } else if (this.panel !== '导航') {
      Column({ space: 14 }) {
        Text(this.panel === '任务对话' ? '任务 Agent' : this.panel).fontSize(18).fontWeight(FontWeight.Bold);
        if (this.panel === '历史任务') {
          Text(this.currentTitle).onClick(() => this.openPanel('任务对话'));
          this.taskList();
        } else if (this.panel === '操作权限') {
          if (this.hasApproval) { this.buildApprovalCard(); }
          else { Text('当前没有待审批操作').fontSize(14).fontColor('#64748B'); }
        } else if (this.panel === '技能与记忆') {
          Text('当前鸿蒙连接未提供技能与记忆数据').fontSize(14).fontColor('#64748B');
        } else {
          Text('先看下一步，需要时再展开工具。').fontSize(14).fontColor('#64748B');
          Divider();
          Text('现在需要做什么').fontSize(16).fontWeight(FontWeight.Bold);
          Text(this.hasApproval ? '请确认待审批操作' : this.isBusy ? '任务执行中' :
            this.messages.length ? '可继续追问当前任务' : '描述你要完成的任务').fontSize(14);
        }
      }.alignItems(HorizontalAlign.Start).padding(16).width('100%');
    }
  }

  private openPanel(label: string): void {
    this.panel = label;
    this.compactMenu = false;
  }

  private snapshot(): TaskView {
    return { threadId: this.session.currentThread(), title: this.currentTitle, messages: this.messages.slice(), draft: this.composer };
  }

  private async newTask(): Promise<void> {
    if (this.isBusy) { return; }
    this.openPanel('任务对话');
    if (!this.messages.length && !this.composer.trim()) { return; }
    const previous = this.snapshot();
    this.isBusy = true;
    try {
      await this.session.newThread();
      this.tasks = [previous].concat(this.tasks);
      this.messages = [];
      this.composer = '';
      this.currentTitle = '新建任务';
    } catch (error) {
      this.statusText = (error as Error).message;
    } finally {
      this.isBusy = false;
    }
  }

  private restoreTask(task: TaskView): void {
    if (this.isBusy) { return; }
    const previous = this.snapshot();
    this.tasks = this.tasks.filter((item: TaskView) => item.threadId !== task.threadId);
    if (previous.messages.length || previous.draft) { this.tasks = [previous].concat(this.tasks); }
    this.session.selectThread(task.threadId);
    this.messages = task.messages.slice();
    this.currentTitle = task.title;
    this.composer = task.draft;
    this.openPanel('任务对话');
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
          .enabled(!this.isBusy)
          .onClick(() => this.useDemoTransport());
        Button('连接 App Server')
          .fontSize(12)
          .fontColor('#FFFFFF')
          .backgroundColor('#2563EB')
          .layoutWeight(1)
          .margin({ left: 8 })
          .enabled(!this.isBusy)
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
    .backgroundColor('#FFFFFF');
  }

  @Builder
  private buildTranscript() {
    Scroll() {
      Column() {
        ForEach(this.messages, (message: ChatMessage) => {
          this.buildMessage(message);
        }, (message: ChatMessage) => message.id + String(message.text.length));
      }
      .width('100%')
      .padding({ left: 16, right: 16, top: 16, bottom: 16 });
    }
    .layoutWeight(1)
    .width('100%')
    .align(Alignment.TopStart)
    .scrollable(ScrollDirection.Vertical)
    .scrollBar(BarState.Off);
  }

  @Builder
  private buildMessage(message: ChatMessage) {
    Row({ space: 12 }) {
      Text(message.role === MessageRole.User ? '人' : message.role === MessageRole.Tool ? '◇' : '✦')
        .fontSize(14).width(28).height(28).textAlign(TextAlign.Center)
        .fontColor('#2466BD').backgroundColor('#EAF2FE').borderRadius(14);
      Column({ space: 6 }) {
        Text(message.role === MessageRole.User ? '你' : (message.title ?? 'dda'))
          .fontSize(13).fontWeight(FontWeight.Medium).fontColor('#647184');
        Text(message.text).fontSize(15).fontColor('#202631').lineHeight(23);
      }.alignItems(HorizontalAlign.Start).layoutWeight(1);
    }.width('100%').alignItems(VerticalAlign.Top).margin({ bottom: 20 });
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
    Column() {
      TextArea({ placeholder: '描述任务，必要的副作用会逐项请求审批', text: this.composer })
        .width('100%')
        .height(68)
        .fontSize(15)
        .backgroundColor('#FFFFFF')
        .borderRadius(12)
        .onChange((value: string) => {
          this.composer = value;
        });
      Row({ space: 8 }) {
        Text(this.workspaceRoot).fontSize(12).fontColor('#718094').layoutWeight(1);
        Text(this.demo ? '演示模式' : 'App Server').fontSize(12).fontColor('#526174');
        Button(this.isBusy ? '处理中' : '发送')
        .enabled(!this.isBusy && this.composer.trim().length > 0)
        .fontSize(14)
        .fontColor('#FFFFFF')
        .backgroundColor('#2563EB')
        .height(34)
        .margin({ left: 8 })
        .onClick(() => this.sendPrompt());
      }.width('100%');
    }
    .width('100%')
    .padding({ left: 12, right: 12, top: 10, bottom: 14 })
    .backgroundColor('#FFFFFF').border({ width: 1, color: '#C9D7EE' }).borderRadius(8);
  }

  private async sendPrompt(): Promise<void> {
    const prompt: string = this.composer.trim();
    if (prompt.length === 0 || this.isBusy) {
      return;
    }
    if (!this.messages.length) { this.currentTitle = prompt.slice(0, 60); }
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
      this.workspaceRoot = this.demo ? '演示工作区' : this.projectRoot;
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

  private resetWorkspace(): void {
    this.tasks = [];
    this.messages = [];
    this.composer = '';
    this.currentTitle = '新建任务';
    this.workspaceEntries = [];
    this.selectedFilePath = '';
    this.selectedFileContent = '';
    this.hasApproval = false;
    this.isBusy = false;
  }

  private async useDemoTransport(): Promise<void> {
    await this.session.replaceTransport(new MockCodexTransport());
    this.openPanel('任务对话');
    this.demo = true;
    this.resetWorkspace();
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
    this.openPanel('任务对话');
    this.statusText = '正在连接 App Server';
    try {
      await this.session.replaceTransport(new AppServerWebSocketTransport(address, root));
      this.demo = false;
      this.resetWorkspace();
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
        this.statusText = 'dda 工作中';
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
        title: 'dda',
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
