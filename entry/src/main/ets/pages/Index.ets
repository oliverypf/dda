import {
  ApprovalRequest,
  ChatMessage,
  ImageAttachment,
  CodexTransport,
  ConnectionState,
  MessageRole,
  ModelUsage,
  SessionEvent,
  SessionEventKind,
  WorkspaceEntry
} from '../models/CodexTypes';
import { AppServerWebSocketTransport } from '../services/AppServerWebSocketTransport';
import { CodexSession } from '../services/CodexSession';
import { MockCodexTransport } from '../services/MockCodexTransport';

import { common } from '@kit.AbilityKit';
import { LocalModelTransport, validateModelEndpoint } from '../services/LocalModelTransport';
import { fetchModelCatalog } from '../services/ModelCatalog';
import { chooseImages, readImageData, imageLocalUri } from '../services/LocalImages';
import { LocalSkill, importSkill } from '../services/LocalSkills';
import { LocalWorkspace } from '../services/LocalWorkspace';
import { LOCAL_COMMAND_HELP, LocalCommandResult, parseProjectCommand, runProjectCommand } from '../services/LocalCommandExecutor';
import { LocalRunState } from '../services/LocalRunJournal';
import { DEFAULT_JEV_ENDPOINT, DEFAULT_JEV_MODEL, LocalJevConfig, validateJevEndpoint } from '../services/LocalRoleOrchestrator';
import { restoreTurnInput, stageStoredTurn, StoredModelProfile, StoredProject, StoredTask, WorkbenchState,
  WorkbenchStore } from '../services/WorkbenchStore';
import { LocalKnowledgePanel } from './LocalKnowledgePanel';

// 24-unit outlines use the same visual vocabulary as the desktop toolbar.
const ICON_PATHS: Record<string, string> = {
  'image': 'M3 3h18v18H3zM3 17l6-6 4 4 3-3 5 5M16 7h.1',
  'plus': 'M12 5v14M5 12h14',
  'close': 'M6 6l12 12M18 6L6 18',
  'search': 'M18 10a8 8 0 1 1-16 0a8 8 0 0 1 16 0M16 16l5 5',
  'panel': 'M4 3h16q1 0 1 2v14q0 2-2 2H5q-2 0-2-2V5q0-2 1-2zM15 3v18',
  'folder': 'M3 6q0-2 2-2h5l2 3h7q2 0 2 2v9q0 2-2 2H5q-2 0-2-2z',
  'settings': 'M9 3h6l.7 2.4 2 .9 2.3-.5 2 3.5-1.6 1.8v2l1.6 1.9-2 3.5-2.3-.6-2 .9L15 21H9l-.7-2.2-2-.9-2.3.6-2-3.5 1.6-1.9v-2L2 9.3l2-3.5 2.3.5 2-.9zM15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0',
  'chevron-down': 'M6 9l6 6 6-6',
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-left': 'M15 6l-6 6 6 6',
  'dashboard': 'M3 3h7v10H3zM14 3h7v6h-7zM14 13h7v8h-7zM3 17h7v4H3z',
  'history': 'M3 11a9 9 0 1 1 2 7M3 4v6h6M12 7v5l3 2',
  'tree': 'M4 4v14h5M4 8h5M13 5h8v6h-8zM13 15h8v6h-8z',
  'file': 'M5 3h9l5 5v13H5zM14 3v6h5',
  'shield': 'M12 2l8 4v6q0 6-8 10-8-4-8-10V6zM8.5 12l2.5 2.5 4.5-5',
  'pulse': 'M3 13Q-1 5 6 4q4-1 6 3 3-5 8-2 6 4 0 11l-8 6-5-4M2 13h5l2-3 3 7 2-5h5',
  'user': 'M16 7a4 4 0 1 1-8 0a4 4 0 1 1 8 0M4 21v-2q0-5 8-5t8 5v2',
  'bot': 'M5 7h14q2 0 2 2v9q0 2-2 2H5q-2 0-2-2V9q0-2 2-2zM12 7V3H9M8 12v2M16 12v2',
  'terminal': 'M4 5l6 6-6 6M12 18h8',
  'alert': 'M12 3l10 18H2zM12 9v5M12 17v1',
  'send': 'M22 2L9 15M22 2l-7 20-4-9-9-4z',
  'cpu': 'M6 6h12v12H6zM10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  'server': 'M3 3h18v7H3zM3 14h18v7H3zM7 6v1M7 17v1',
  'check': 'M4 12l5 5L20 6',
  'refresh': 'M20 8a8 8 0 0 0-14-2L3 9m0-6v6h6M4 16a8 8 0 0 0 14 2l3-3m0 6v-6h-6'
};

@Entry
@Component
struct Index {
  private session?: CodexSession;
  private store?: WorkbenchStore;
  private workspace?: LocalWorkspace;
  private localTransport?: LocalModelTransport;
  private saveTimer: number = -1;
  private hydrated: boolean = false;
  private pageActive: boolean = false;
  private sendSequence: number = 0;
  private directoryRequest: number = 0;
  private fileRequest: number = 0;
  private activeAssistantId: string = '';
  private activeToolId: string = '';
  private activeRunId: string = '';
  private replaceAnswerId: string = '';
  private resumingTurn: boolean = false;
  private checkpointRequest: number = 0;
  private focusSearchOnAppear: boolean = false;

  @State messages: ChatMessage[] = [];
  @State tasks: StoredTask[] = [];
  @State currentTitle: string = '新任务';
  @State panel: string = '任务对话';
  @State availableWidth: number = 1000;
  @State contextOpen: boolean = false;
  @State settingsOpen: boolean = false;
  @State taskFilter: string = '';
  @State projectExpanded: boolean = true;
  @State mode: string = 'local';
  @State switching: boolean = true;
  @State settingsTab: string = '模型';
  @State baseUrl: string = 'https://api.openai.com/v1';
  @State model: string = '';
  @State hasSavedKey: boolean = false;
  @State editUrl: string = '';
  @State editModel: string = '';
  @State editKey: string = '';
  @State jevEnabled: boolean = false;
  @State jevEndpoint: string = DEFAULT_JEV_ENDPOINT;
  @State jevModel: string = DEFAULT_JEV_MODEL;
  @State jevHasSavedKey: boolean = false;
  @State editJevEnabled: boolean = false;
  @State editJevEndpoint: string = '';
  @State editJevModel: string = '';
  @State editJevKey: string = '';
  @State checkpointState: LocalRunState | undefined = undefined;
  @State checkpointLoading: boolean = false;
  @State checkpointError: string = '';
  @State settingsNotice: string = '';
  @State editProtocol: string = 'Chat Completions';
  @State catalog: string[] = [];
  @State profiles: StoredModelProfile[] = [];
  @State draftImages: ImageAttachment[] = [];
  @State preparingTurn: boolean = false;
  @State queued: string[] = [];
  @State lastUsage: ModelUsage | undefined = undefined;
  @State maxOutputTokens: number = 0;
  @State editMaxTokens: string = '';
  @State inputNotice: string = '';
  @State instructions: string = '';
  @State memories: string[] = [];
  @State skills: string[] = [];
  @State localSkills: LocalSkill[] = [];
  @State skillPreview: string = '';
  @State skillNotice: string = '';
  @State projects: StoredProject[] = [{ id: 'default', name: '本机工作区' }];
  @State projectId: string = 'default';
  @State projectNameDraft: string = '';
  @State fileNotice: string = '';
  @State commandPanelOpen: boolean = false;
  @State commandInput: string = 'ls /';
  @State commandRunning: boolean = false;
  @State commandResult: LocalCommandResult | undefined = undefined;
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
    this.pageActive = true;
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    this.store = new WorkbenchStore(context);
    this.restoreLocalWorkbench();
  }

  aboutToDisappear(): void {
    this.sendSequence++;
    this.localTransport?.cancelTurn();
    this.pageActive = false;
    this.persistNow().catch((error: Error) => { this.statusText = error.message; });
    this.preparingTurn = false;
    this.session?.disconnect().catch((error: Error) => { this.statusText = error.message; });
    this.editKey = '';
    this.editJevKey = '';
  }

  onPageHide(): void {
    this.persistNow().catch((error: Error) => { this.statusText = '本机保存失败：' + error.message; });
  }

  private attachmentUri(item: ImageAttachment): string {
    return imageLocalUri(this.getUIContext().getHostContext() as common.UIAbilityContext, item.id);
  }

  private async attach(transport: CodexTransport): Promise<void> {
    const previous = this.session;
    this.session = undefined;
    await previous?.disconnect();
    if (!this.pageActive) { return; }
    const session = new CodexSession(transport);
    this.session = session;
    session.setListener((event: SessionEvent) => {
      if (this.pageActive && this.session === session) { this.handleSessionEvent(event); }
    });
    await session.connect();
  }

  private async openLocalProject(id: string): Promise<void> {
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    const workspace = new LocalWorkspace(context, id);
    await workspace.initialize();
    const transport = new LocalModelTransport(workspace);
    this.workspace = workspace;
    this.commandInput = 'ls /';
    this.commandResult = undefined;
    this.commandRunning = false;
    this.commandPanelOpen = false;
    this.localTransport = transport;
    this.mode = 'local';
    await this.attach(transport);
    this.projectId = id;
    this.fileNotice = '';
    this.selectedFilePath = '';
    this.selectedFileContent = '';
    await this.loadWorkspace('/');
  }

  private async restoreLocalWorkbench(): Promise<void> {
    this.switching = true;
    this.hydrated = false;
    try {
      const saved = await this.store!.load();
      if (!this.pageActive) { return; }
      if (saved) {
        this.baseUrl = saved.baseUrl;
        this.model = saved.model;
        this.maxOutputTokens = saved.maxOutputTokens ?? 0;
        this.hasSavedKey = saved.hasSavedKey === true;
        this.jevEnabled = saved.jevEnabled === true;
        this.jevEndpoint = saved.jevEndpoint ?? DEFAULT_JEV_ENDPOINT;
        this.jevModel = saved.jevModel ?? DEFAULT_JEV_MODEL;
        this.jevHasSavedKey = saved.jevHasSavedKey === true;
        this.instructions = saved.instructions;
        this.memories = saved.memories;
        this.skills = saved.skills ?? [];
        this.localSkills = saved.localSkills ?? [];
        this.profiles = saved.profiles ?? [];
        this.projects = saved.projects?.length ? saved.projects : [{ id: 'default', name: '本机工作区' }];
      }
      await this.openLocalProject(saved?.current.projectId ?? 'default');
      if (!this.pageActive) { return; }
      this.resetTranscript();
      if (saved) {
        await this.displayTask(saved.current);
      }
      this.tasks = saved?.tasks ?? [];
      this.hydrated = true;
      this.statusText = this.model ? '本机工作台已就绪' : '先配置模型，即可发送真实任务';
      if (saved?.current.incomplete) { await this.persistNow(); }
    } catch (error) {
      this.connectionState = ConnectionState.Error;
      this.statusText = '本机工作台加载失败：' + (error as Error).message;
    } finally {
      this.switching = false;
    }
  }

  private async displayTask(task: StoredTask): Promise<void> {
    if (task.threadId) { this.session?.selectThread(task.threadId); }
    this.currentTitle = task.title;
    this.queued = (task.queued ?? []).slice();
    this.lastUsage = task.usage;
    this.messages = task.messages.slice();
    this.composer = task.draft;
    this.draftImages = (task.draftImages ?? []).slice();
    this.inputNotice = '';
    this.activeRunId = task.runId ?? '';
    await this.refreshCheckpoint(task.incomplete === true);
  }

  private async refreshCheckpoint(interrupted: boolean = false): Promise<void> {
    const transport = this.localTransport;
    const thread = this.session?.currentThread();
    const request = ++this.checkpointRequest;
    this.checkpointState = undefined;
    this.checkpointError = '';
    if (!transport || !thread || this.mode !== 'local') { this.checkpointLoading = false; return; }
    this.checkpointLoading = true;
    try {
      const state = await transport.latestCheckpoint(thread);
      if (request !== this.checkpointRequest || transport !== this.localTransport || thread !== this.session?.currentThread()) { return; }
      if (state && state.phase !== 'done') {
        this.checkpointState = state;
        this.activeRunId = state.runId;
      } else {
        if (interrupted && state && this.activeRunId === state.runId && state.draft) {
          const answerId = state.runId + '-answer-' + state.round;
          const answer: ChatMessage = { id: answerId, role: MessageRole.Assistant, text: state.draft };
          const index = this.messages.findIndex((message: ChatMessage) => message.id === answerId);
          if (index < 0) { this.appendMessage(answer); }
          else if (this.messages[index].text !== state.draft) {
            const restored = this.messages.slice();
            restored[index] = answer;
            this.messages = restored;
          }
        } else if (interrupted) {
          this.inputNotice = '已恢复任务记录。上次发送没有可继续的执行断点。';
        }
        this.activeRunId = '';
      }
    } catch (error) {
      if (request === this.checkpointRequest) { this.checkpointError = '断点读取失败：' + (error as Error).message; }
    } finally {
      if (request === this.checkpointRequest) { this.checkpointLoading = false; }
    }
  }

  private async updateCheckpoint(state: LocalRunState, verify: boolean): Promise<void> {
    const transport = this.localTransport;
    const thread = this.session?.currentThread();
    if (!transport || !thread || this.isBusy || this.switching || this.checkpointLoading ||
      this.checkpointState?.runId !== state.runId || this.checkpointState?.revision !== state.revision) { return; }
    this.switching = true;
    let verified: LocalRunState | undefined = undefined;
    try {
      if (verify) {
        verified = await transport.verifyCheckpoint(thread, state.runId, state.revision);
        this.inputNotice = '文件内容已核对。';
      } else {
        await transport.discardCheckpoint(thread, state.runId, state.revision);
        this.inputNotice = '已放弃断点，项目文件和对话记录已保留。';
      }
    } catch (error) {
      this.inputNotice = (verify ? '请查看项目文件。核对失败：' : '放弃断点失败：') + (error as Error).message;
    } finally {
      await this.refreshCheckpoint();
      this.switching = false;
      this.queueSave();
    }
    if (verified && this.pageActive && transport === this.localTransport && thread === this.session?.currentThread()) {
      await this.sendPrompt(false, verified);
    }
  }

  private queueSave(): void {
    if (!this.hydrated || this.mode !== 'local' || this.switching || this.saveTimer >= 0) { return; }
    this.saveTimer = setTimeout(() => {
      this.persistNow().catch((error: Error) => { this.statusText = '本机保存失败：' + error.message; });
    }, 350);
  }

  private async persistNow(current?: StoredTask): Promise<void> {
    if (this.saveTimer >= 0) { clearTimeout(this.saveTimer); this.saveTimer = -1; }
    if (!this.store || !this.session || !this.hydrated || this.mode !== 'local') { return; }
    const state: WorkbenchState = { current: current ?? this.snapshot(), tasks: this.tasks.slice(),
      instructions: this.instructions, memories: this.memories.slice(), skills: this.skills.slice(), localSkills: this.localSkills.slice(),
      projects: this.projects.slice(), profiles: this.profiles.slice(), maxOutputTokens: this.maxOutputTokens,
      baseUrl: this.baseUrl, model: this.model, hasSavedKey: this.hasSavedKey, jevEnabled: this.jevEnabled,
      jevEndpoint: this.jevEndpoint, jevModel: this.jevModel, jevHasSavedKey: this.jevHasSavedKey };
    await this.store.save(state);
  }

  private showSettings(): void {
    if (this.switching) { return; }
    this.settingsTab = this.mode === 'local' ? '模型' : '其他连接';
    this.editUrl = this.baseUrl.replace(/\/(?:chat\/completions|responses)$/, '');
    this.editProtocol = this.baseUrl.endsWith('/responses') ? 'Responses' : 'Chat Completions';
    this.catalog = [];
    this.editModel = this.model;
    this.editMaxTokens = this.maxOutputTokens ? String(this.maxOutputTokens) : '';
    this.editKey = '';
    this.editJevEnabled = this.jevEnabled;
    this.editJevEndpoint = this.jevEndpoint;
    this.editJevModel = this.jevModel;
    this.editJevKey = '';
    this.settingsNotice = '';
    this.settingsOpen = true;
  }

  private modeLabel(): string {
    return this.mode === 'local' ? '鸿蒙本机工作台' : this.mode === 'demo' ? '鸿蒙演示模式' : '鸿蒙 App Server';
  }

  @Builder
  private icon(name: string, size: number, color: ResourceColor) {
    Shape() {
      Path().commands(ICON_PATHS[name]).fill(Color.Transparent).stroke(color)
        .strokeWidth(1.8).strokeLineCap(LineCapStyle.Round).strokeLineJoin(LineJoinStyle.Round);
    }.viewPort({ x: 0, y: 0, width: 24, height: 24 }).width(size).height(size)
      .accessibilityLevel('no');
  }

  @Builder
  private iconButton(name: string, label: string, action: () => void) {
    Button({ type: ButtonType.Normal }) {
      this.icon(name, 18, $r('app.color.wb_secondary'));
    }.width(36).height(36).padding(0).borderRadius(6).backgroundColor(Color.Transparent)
      .accessibilityText(label).onClick(action);
  }

  build() {
    Stack({ alignContent: Alignment.End }) {
      Row() {
        this.sidebar();
        Column() {
          this.topbar();
          this.statusStrip();
          if (this.panel === '任务对话') {
            this.buildTranscript();
          } else {
            Scroll() {
              Column({ space: 12 }) {
                this.secondaryPage();
              }.constraintSize({ maxWidth: 800 }).width('100%').alignItems(HorizontalAlign.Start)
                .padding(this.availableWidth <= 760 ? 12 : 28);
            }.layoutWeight(1).width('100%').align(Alignment.Top).scrollBar(BarState.Auto);
          }
          this.buildComposer();
        }.layoutWeight(1).height('100%').backgroundColor($r('app.color.wb_canvas'));
        if (this.availableWidth > 1120) {
          this.contextPanel();
        }
      }.width('100%').height('100%').alignItems(VerticalAlign.Top);
      if (this.availableWidth <= 1120 && this.contextOpen) {
        Column().width('100%').height('100%').backgroundColor('#40000000')
          .onClick(() => { this.contextOpen = false; }).accessibilityText('关闭任务上下文');
        this.contextPanel();
      }
    }.width('100%').height('100%')
      .bindSheet($$this.settingsOpen, this.settingsDialog(), {
        preferType: SheetType.CENTER, height: SheetSize.FIT_CONTENT, width: Math.min(600, this.availableWidth - 24),
        onDisappear: () => { this.editKey = ''; }, dragBar: false, showClose: false, backgroundColor: $r('app.color.wb_surface')
      })
      .onAreaChange((_old: Area, area: Area) => {
        const width = Number(area.width);
        if ((width > 1120) !== (this.availableWidth > 1120)) {
          this.contextOpen = width > 1120;
        }
        this.availableWidth = width;
      });
  }

  onBackPress(): boolean {
    if (this.settingsOpen) {
      this.settingsOpen = false;
      return true;
    }
    if (this.availableWidth <= 1120 && this.contextOpen) {
      this.contextOpen = false;
      return true;
    }
    if (this.panel !== '任务对话') {
      this.openPanel('任务对话');
      return true;
    }
    return false;
  }

  @Builder
  private sidebar() {
    Column() {
      Row({ space: 10 }) {
        Text('dda').fontSize(13).fontWeight(FontWeight.Bold).fontColor(Color.White)
          .textAlign(TextAlign.Center).width(32).height(32).borderRadius(7).backgroundColor('#16191E');
        if (this.availableWidth > 760) {
          Column({ space: 2 }) {
            Text('dda').fontSize(14).fontWeight(FontWeight.Bold).fontColor($r('app.color.wb_text'));
            Text(this.modeLabel()).fontSize(11).fontColor($r('app.color.wb_muted'));
          }.alignItems(HorizontalAlign.Start);
        }
      }.width('100%').height(44).padding({ left: this.availableWidth <= 760 ? 0 : 6 })
        .justifyContent(this.availableWidth <= 760 ? FlexAlign.Center : FlexAlign.Start);
      Button({ type: ButtonType.Normal }) {
        Row({ space: 8 }) {
          this.icon('plus', 17, Color.White);
          if (this.availableWidth > 760) {
            Text('新建任务').fontColor(Color.White).fontWeight(FontWeight.Medium).fontSize(14);
          }
        }
      }.width(this.availableWidth <= 760 ? 40 : '100%').height(this.availableWidth <= 760 ? 40 : 38)
        .padding(0).borderRadius(6).backgroundColor($r('app.color.wb_blue'))
        .margin({ top: 18, bottom: 14 }).accessibilityText('新建任务')
        .enabled(!this.switching && !this.isBusy && this.connectionState === ConnectionState.Connected).onClick(() => this.newTask());
      if (this.availableWidth > 760) {
        Row({ space: 6 }) {
          Text('项目').fontSize(11).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_muted'));
          this.icon(this.projectExpanded ? 'chevron-down' : 'chevron-right', 13, $r('app.color.wb_muted'));
        }.height(34).width('100%').padding({ left: 6 }).onClick(() => { this.projectExpanded = !this.projectExpanded; });
        Scroll() {
          Column({ space: 3 }) {
            if (this.projectExpanded) {
              Row({ space: 7 }) {
                this.icon('folder', 16, $r('app.color.wb_secondary'));
                Text(this.workspaceRoot).fontSize(13).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_text'))
                  .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1);
              }.width('100%').height(36).padding({ left: 6 }).onClick(() => this.openPanel('项目文件'));
              if (this.messages.length || this.composer.length || this.draftImages.length) {
                this.taskRow(this.currentTitle, true, () => this.openPanel('任务对话'));
              } else if (!this.tasks.length) {
                Text('暂无会话').width('100%').padding({ left: 26, top: 8 }).fontSize(12).fontColor($r('app.color.wb_muted'));
              }
              ForEach(this.tasks.filter((item: StoredTask) => this.mode !== 'local' || (item.projectId ?? 'default') === this.projectId), (task: StoredTask) => {
                this.taskRow(task.title, false, () => this.restoreTask(task));
              }, (task: StoredTask) => task.threadId);
            }
          }.width('100%');
        }.layoutWeight(1).width('100%').align(Alignment.TopStart);
      } else {
        this.iconButton('folder', '项目与历史任务', () => this.openPanel('历史任务'));
        Blank();
      }
      Divider().color($r('app.color.wb_soft_border'));
      Button({ type: ButtonType.Normal }) {
        Row({ space: 10 }) {
          this.icon('settings', 17, $r('app.color.wb_secondary'));
          if (this.availableWidth > 760) {
            Text('设置').fontSize(13).fontColor($r('app.color.wb_secondary'));
          }
        }.width('100%').justifyContent(this.availableWidth <= 760 ? FlexAlign.Center : FlexAlign.Start);
      }.width('100%').height(38).padding({ left: this.availableWidth <= 760 ? 0 : 10 })
        .margin({ top: 10 }).backgroundColor(Color.Transparent)
        .accessibilityText('设置').onClick(() => this.showSettings());
    }.height('100%').width(this.availableWidth <= 760 ? 64 : this.availableWidth <= 1120 ? 214 : 248)
      .padding({ left: this.availableWidth <= 760 ? 8 : 12, right: this.availableWidth <= 760 ? 8 : 12,
        top: this.availableWidth <= 760 ? 12 : 16, bottom: 12 })
      .backgroundColor($r('app.color.wb_surface')).border({ width: { right: 1 }, color: $r('app.color.wb_border') });
  }

  @Builder
  private taskRow(title: string, active: boolean, action: () => void) {
    Button({ type: ButtonType.Normal }) {
      Text(title).width('100%').fontSize(13).fontColor($r('app.color.wb_text')).maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis });
    }.width('100%').height(35).padding({ left: 26, right: 8 }).borderRadius(6)
      .backgroundColor(active ? $r('app.color.wb_hover') : Color.Transparent)
      .enabled(active || !this.isBusy).onClick(action);
  }

  @Builder
  private topbar() {
    Row({ space: 6 }) {
      Column({ space: 2 }) {
        Text(this.currentTitle).fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_text'))
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
        Text('当前工作区  ' + this.workspaceRoot).fontSize(11).fontColor($r('app.color.wb_muted'))
          .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
      }.alignItems(HorizontalAlign.Start).layoutWeight(1);
      if (this.availableWidth > 760) {
        this.iconButton('search', '搜索历史任务', () => {
          if (this.panel === '历史任务') {
            this.getUIContext().getFocusController().requestFocus('task-search');
          } else {
            this.focusSearchOnAppear = true;
            this.openPanel('历史任务');
          }
        });
      }
      this.iconButton('panel', this.contextOpen ? '收起任务上下文' : '展开任务上下文', () => {
        this.contextOpen = !this.contextOpen;
      });
    }.width('100%').height(64).padding({ left: this.availableWidth <= 760 ? 10 : 18, right: 10 })
      .backgroundColor($r('app.color.wb_surface')).border({ width: { bottom: 1 }, color: $r('app.color.wb_border') });
  }

  private connectionLabel(): string {
    switch (this.connectionState) {
      case ConnectionState.Connected: return this.mode === 'local' ? '本机就绪' : this.mode === 'demo' ? '演示模式已连接' : 'App Server 已连接';
      case ConnectionState.Connecting: return '正在连接';
      case ConnectionState.Error: return '连接失败';
      default: return '未连接';
    }
  }

  @Builder
  private statusStrip() {
    Row({ space: 8 }) {
      Circle().width(8).height(8).fill(this.connectionState === ConnectionState.Connected ? $r('app.color.wb_green') :
        this.connectionState === ConnectionState.Error ? $r('app.color.wb_red') : $r('app.color.wb_amber'));
      Text(this.connectionLabel()).fontSize(11).fontColor($r('app.color.wb_secondary'));
      if (this.hasApproval) {
        Button('查看待审批操作', { type: ButtonType.Normal }).height(28).fontSize(12).borderRadius(6)
          .backgroundColor($r('app.color.wb_warning_bg')).fontColor($r('app.color.wb_amber'))
          .onClick(() => this.openPanel('操作权限'));
      } else if (this.availableWidth > 760) {
        Divider().vertical(true).height(14).color($r('app.color.wb_border')).margin({ left: 4, right: 4 });
        this.icon('shield', 14, $r('app.color.wb_secondary'));
        Text(this.statusText).fontSize(11).fontColor($r('app.color.wb_secondary')).maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis }).layoutWeight(1);
      }
    }.width('100%').height(38).padding({ left: this.availableWidth <= 760 ? 10 : 18, right: 10 })
      .backgroundColor($r('app.color.wb_surface')).border({ width: { bottom: 1 }, color: $r('app.color.wb_border') });
  }

  @Builder
  private navItem(label: string, hint: string, icon: string) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 8 }) {
        this.icon(icon, 16, this.panel === label ? $r('app.color.wb_accent_text') : $r('app.color.wb_secondary'));
        Column({ space: 2 }) {
          Text(label).fontSize(13).fontWeight(FontWeight.Medium)
            .fontColor(this.panel === label ? $r('app.color.wb_accent_text') : $r('app.color.wb_text'));
          Text(hint).fontSize(11).fontColor($r('app.color.wb_secondary'));
        }.layoutWeight(1).alignItems(HorizontalAlign.Start);
      }.width('100%').alignItems(VerticalAlign.Top);
    }.layoutWeight(1).constraintSize({ minHeight: 48 }).padding(8).borderRadius(6)
      .backgroundColor(this.panel === label ? $r('app.color.wb_selected') : Color.Transparent)
      .onClick(() => this.openPanel(label));
  }

  @Builder
  private navPair(a: string, ah: string, ai: string, b: string, bh: string, bi: string) {
    if (this.availableWidth > 1120 && !this.contextOpen) {
      Row() { this.navItem(a, ah, ai); }.width('100%');
      Row() { this.navItem(b, bh, bi); }.width('100%');
    } else {
      Row({ space: 4 }) {
        this.navItem(a, ah, ai);
        this.navItem(b, bh, bi);
      }.width('100%');
    }
  }

  @Builder
  private contextPanel() {
    Column() {
      Column({ space: 4 }) {
        Row() {
          Text('功能导航').fontSize(11).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_muted')).layoutWeight(1);
          if (this.availableWidth <= 1120) {
            this.iconButton('close', '关闭任务上下文', () => { this.contextOpen = false; });
          }
        }.width('100%');
        this.navPair('任务对话', '提需求、看回答', 'dashboard', '历史任务', '查找过去的任务', 'history');
        this.navPair('项目文件', '浏览文件内容', 'tree', '技能与记忆', '想看时再打开', 'file');
        this.navPair('操作权限', '查看授权与审批', 'shield', '设置与排查', '配置连接、查故障', 'pulse');
      }.padding({ left: 12, right: 12, top: 10, bottom: 10 }).width('100%');
      Divider().color($r('app.color.wb_border'));
      if (this.contextOpen) {
        Scroll() {
          this.taskContext();
        }.layoutWeight(1).width('100%').align(Alignment.TopStart);
      }
    }.width(this.availableWidth > 1120 ? (this.contextOpen ? 380 : 184) : Math.min(360, this.availableWidth * 0.92))
      .height('100%').backgroundColor($r('app.color.wb_surface'))
      .border({ width: { left: 1 }, color: $r('app.color.wb_border') });
  }

  @Builder
  private taskContext() {
    Column({ space: 10 }) {
      Text('任务 Agent').fontSize(16).fontWeight(FontWeight.Bold).fontColor($r('app.color.wb_text'));
      Text('先看下一步，需要时再展开工具。').fontSize(12).fontColor($r('app.color.wb_secondary'));
      Divider().color($r('app.color.wb_border')).margin({ top: 4, bottom: 6 });
      Text('现在需要做什么').fontSize(15).fontWeight(FontWeight.Bold).fontColor($r('app.color.wb_text'));
      Column({ space: 6 }) {
        Text(this.hasApproval ? '需要你确认的操作' : this.isBusy ? '任务执行中' :
          this.messages.length ? this.currentTitle : '还没有开始任务')
          .fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_text'));
        Text(this.hasApproval ? this.approval.reason : this.isBusy ? '进展会自动更新。' :
          this.messages.length ? '可以查看已有回答，或在下方继续追问。' :
          '在中间下方输入要完成的事情，例如“总结这个项目的功能”，然后发送。')
          .fontSize(13).lineHeight(21).fontColor($r('app.color.wb_secondary'));
      }.alignItems(HorizontalAlign.Start).width('100%').padding(12).borderRadius(6)
        .backgroundColor($r('app.color.wb_user_bg')).border({ width: { left: 3 }, color: $r('app.color.wb_blue') });
      if (this.hasApproval) {
        this.actionRow('查看待审批操作', '核对操作内容后允许或拒绝', () => this.openPanel('操作权限'));
      } else if (!this.isBusy) {
        this.actionRow(this.messages.length ? '继续当前对话' : '输入任务需求', '告诉 Agent 你想得到什么结果', () => {
          this.openPanel('任务对话');
          this.getUIContext().getFocusController().requestFocus('task-input');
        });
      }
      Divider().color($r('app.color.wb_soft_border')).margin({ top: 6 });
      Text('需要时使用').fontSize(14).fontWeight(FontWeight.Bold).fontColor($r('app.color.wb_text'));
      this.actionRow('查看项目文件', this.workspaceRoot, () => this.openPanel('项目文件'));
      this.actionRow('操作权限', this.hasApproval ? '1 项待确认' : '查看授权与审批', () => this.openPanel('操作权限'));
    }.padding(16).width('100%').alignItems(HorizontalAlign.Start);
  }

  @Builder
  private actionRow(title: string, detail: string, action: () => void) {
    Button({ type: ButtonType.Normal }) {
      Row({ space: 8 }) {
        Column({ space: 4 }) {
          Text(title).fontSize(13).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_text'));
          Text(detail).fontSize(12).fontColor($r('app.color.wb_secondary')).maxLines(2)
            .textOverflow({ overflow: TextOverflow.Ellipsis });
        }.layoutWeight(1).alignItems(HorizontalAlign.Start);
        this.icon('chevron-right', 16, $r('app.color.wb_muted'));
      }.width('100%');
    }.width('100%').padding(12).borderRadius(7).backgroundColor($r('app.color.wb_surface'))
      .border({ width: 1, color: $r('app.color.wb_border') }).onClick(action);
  }

  @Builder
  private pageHeading(label: string, title: string) {
    Text(label).fontSize(10).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_muted'));
    Text(title).fontSize(23).fontWeight(FontWeight.Bold).fontColor($r('app.color.wb_text'));
  }

  @Builder
  private pageNotice(detail: string) {
    Text(detail).width('100%').padding(14).fontSize(13).fontColor($r('app.color.wb_secondary'))
      .backgroundColor($r('app.color.wb_surface')).borderRadius(6)
      .border({ width: 1, color: $r('app.color.wb_soft_border') });
  }

  private matchesTask(title: string): boolean {
    return title.toLowerCase().includes(this.taskFilter.trim().toLowerCase());
  }

  @Builder
  private secondaryPage() {
    if (this.panel === '项目文件') {
      this.buildWorkspacePanel();
    } else if (this.panel === '历史任务') {
      this.pageHeading('运行记录', '历史任务');
      if (this.mode === 'local' && this.messages.length) { this.smallAction('导出当前会话', () => { this.exportContent(true); }); }
      TextInput({ text: this.taskFilter, placeholder: '搜索任务标题' }).id('task-search').fontSize(13)
        .fontColor($r('app.color.wb_text')).placeholderColor($r('app.color.wb_muted'))
        .height(38).borderRadius(6).backgroundColor($r('app.color.wb_surface'))
        .border({ width: 1, color: $r('app.color.wb_border') })
        .onAppear(() => {
          if (this.focusSearchOnAppear) {
            this.focusSearchOnAppear = false;
            this.getUIContext().getFocusController().requestFocus('task-search');
          }
        })
        .onChange((value: string) => { this.taskFilter = value; });
      if ((this.messages.length || this.composer.length || this.draftImages.length) && this.matchesTask(this.currentTitle)) {
        this.actionRow(this.currentTitle, '当前会话', () => this.openPanel('任务对话'));
      }
      ForEach(this.tasks.filter((item: StoredTask) => this.matchesTask(item.title)), (task: StoredTask) => {
        Column() {
          this.actionRow(task.title, (this.mode === 'local' ? this.projectTitle(task.projectId ?? 'default') + ' · ' : '') + task.messages.length + ' 条消息', () => this.restoreTask(task));
        }.width('100%').enabled(!this.isBusy);
      }, (task: StoredTask) => task.threadId);
      if ((!this.messages.length && !this.composer.length && !this.draftImages.length || !this.matchesTask(this.currentTitle)) &&
        !this.tasks.some((item: StoredTask) => this.matchesTask(item.title))) {
        this.pageNotice(this.taskFilter.trim() ? '没有匹配的任务' : '暂无运行记录');
      }
    } else if (this.panel === '操作权限') {
      this.pageHeading('授权与审批', '操作权限');
      if (this.hasApproval) { this.buildApprovalCard(); }
      else { this.pageNotice('当前没有待审批操作'); }
      ForEach(this.messages.filter((item: ChatMessage) => item.role === MessageRole.Tool && item.title === '操作审批'),
        (item: ChatMessage) => { this.pageNotice(item.text); }, (item: ChatMessage) => item.id);
    } else if (this.panel === '设置与排查') {
      this.pageHeading('设置与排查', '设置与诊断');
      this.pageNotice('运行时状态  ·  ' + this.connectionLabel() + '  ·  ' + this.statusText);
      this.actionRow('连接设置', this.mode === 'local' ? (this.model || '配置模型') : this.mode === 'demo' ? '演示模式' : 'App Server', () => this.showSettings());
    } else {
      this.pageHeading('供后续任务参考', '技能与记忆');
      if (this.mode === 'local') {
        this.importedSkillList();
        LocalKnowledgePanel({
          instructions: this.instructions, skills: this.skills, memories: this.memories,
          onInstructions: (value: string) => { this.instructions = value; this.queueSave(); },
          onChangeList: (isSkill: boolean, items: string[]) => {
            if (isSkill) { this.skills = items; } else { this.memories = items; }
            this.queueSave();
          },
          onUseSkill: (value: string) => {
            this.composer = this.composer ? this.composer + '\n' + value : value;
            this.openPanel('任务对话');
            this.queueSave();
          }
        });
      } else { this.pageNotice('切换到本机工作台可管理常用任务提示与长期记忆。'); }
    }
  }

  @Builder
  private importedSkillList() {
    Text('本机技能').fontSize(16).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_text'));
    this.smallAction('导入 SKILL.md', () => { this.addLocalSkill(); });
    if (this.skillNotice) { this.pageNotice(this.skillNotice); }
    ForEach(this.localSkills, (skill: LocalSkill) => {
      Column({ space: 6 }) {
        Text(skill.name).fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_text'));
        Text(skill.description).fontSize(12).fontColor($r('app.color.wb_secondary'));
        Flex({ wrap: FlexWrap.Wrap }) {
          this.smallAction(this.skillPreview === skill.name ? '收起' : '预览', () => {
            this.skillPreview = this.skillPreview === skill.name ? '' : skill.name;
          });
          this.smallAction('加入任务', () => {
            this.composer = (this.composer ? this.composer + '\n\n' : '') + skill.body;
            this.openPanel('任务对话');
            this.queueSave();
          });
          this.smallAction('移除', () => {
            this.localSkills = this.localSkills.filter((item: LocalSkill) => item.name !== skill.name);
            this.queueSave();
          });
        }
        if (this.skillPreview === skill.name) {
          Text(skill.body).fontSize(13).fontColor($r('app.color.wb_secondary')).copyOption(CopyOptions.InApp);
        }
      }.width('100%').padding(12).alignItems(HorizontalAlign.Start).borderRadius(6).backgroundColor($r('app.color.wb_surface'));
    }, (skill: LocalSkill) => skill.name);
  }

  private async addLocalSkill(): Promise<void> {
    if (this.switching || this.mode !== 'local' || !this.hydrated) { return; }
    this.switching = true;
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const skill = await importSkill(context);
      if (!skill) { return; }
      if (this.localSkills.some((item: LocalSkill) => item.name === skill.name)) {
        this.skillNotice = '已有同名技能，请先移除旧版本'; return;
      }
      this.localSkills = this.localSkills.concat([skill]);
      await this.persistNow();
      this.skillNotice = '已导入 ' + skill.name;
    } catch (error) { this.skillNotice = (error as Error).message; }
    finally { this.switching = false; }
  }

  @Builder
  private settingsDialog() {
    Scroll() {
      Column({ space: 16 }) {
        Row() {
          Text('工作台设置').fontSize(24).fontWeight(FontWeight.Bold).fontColor($r('app.color.wb_text')).layoutWeight(1);
          this.iconButton('close', '关闭设置', () => { this.settingsOpen = false; });
        }.width('100%');
        this.buildConnectionSettings();
      }.width('100%').padding(this.availableWidth <= 760 ? 20 : 32).alignItems(HorizontalAlign.Start);
    }.width('100%');
  }

  private openPanel(label: string): void {
    this.panel = label;
    this.settingsOpen = false;
    if (this.availableWidth <= 1120) { this.contextOpen = false; }
  }

  private snapshot(): StoredTask {
    return { threadId: this.session?.currentThread() ?? '', projectId: this.projectId, title: this.currentTitle,
      messages: this.messages.slice(), draft: this.composer, draftImages: this.draftImages.slice(),
      queued: this.queued.slice(), usage: this.lastUsage, runId: this.activeRunId || undefined,
      incomplete: this.mode === 'local' && (!!this.activeRunId || (this.isBusy && !this.preparingTurn)) };
  }

  private async newTask(): Promise<void> {
    if (this.isBusy || this.switching || !this.session) { return; }
    this.openPanel('任务对话');
    if (!this.messages.length && !this.composer.trim() && !this.draftImages.length) { return; }
    const previous = this.snapshot();
    this.isBusy = true;
    try {
      await this.session.newThread();
      this.tasks = [previous].concat(this.tasks);
      this.messages = [];
      this.composer = '';
      this.draftImages = [];
      this.queued = [];
      this.checkpointRequest++;
      this.checkpointState = undefined;
      this.checkpointError = '';
      this.checkpointLoading = false;
      this.activeRunId = '';
      this.lastUsage = undefined;
      this.inputNotice = '';
      this.currentTitle = '新任务';
      this.queueSave();
    } catch (error) {
      this.statusText = (error as Error).message;
      this.appendMessage({
        id: `thread-error-${Date.now()}`,
        role: MessageRole.System,
        text: '新建任务失败：' + this.statusText
      });
    } finally {
      this.isBusy = false;
    }
  }

  private async restoreTask(task: StoredTask): Promise<void> {
    if (this.isBusy || this.switching) { return; }
    const id = task.projectId ?? 'default';
    if (this.mode === 'local' && id !== this.projectId) {
      await this.switchProject(id, task);
      return;
    }
    const previous = this.snapshot();
    this.tasks = this.tasks.filter((item: StoredTask) => item.threadId !== task.threadId);
    if (previous.messages.length || previous.draft || previous.draftImages?.length) { this.tasks = [previous].concat(this.tasks); }
    this.switching = true;
    try {
      await this.displayTask(task);
      this.openPanel('任务对话');
    } finally { this.switching = false; this.queueSave(); }
  }

  private projectTitle(id: string): string {
    return this.projects.find((item: StoredProject) => item.id === id)?.name ?? '本机工作区';
  }

  private async switchProject(id: string, task?: StoredTask): Promise<void> {
    if (this.mode !== 'local' || this.switching || this.isBusy || !this.hydrated) { return; }
    const previous = this.snapshot();
    this.switching = true;
    try {
      await this.persistNow();
      const target = task ?? this.tasks.find((item: StoredTask) => (item.projectId ?? 'default') === id);
      await this.openLocalProject(id);
      this.tasks = this.tasks.filter((item: StoredTask) => item.threadId !== target?.threadId);
      if (previous.messages.length || previous.draft || previous.draftImages?.length) { this.tasks = [previous].concat(this.tasks); }
      this.resetTranscript();
      if (target) { await this.displayTask(target); }
      this.openPanel(task ? '任务对话' : '项目文件');
      await this.persistNow();
    } catch (error) {
      this.statusText = '切换项目失败：' + (error as Error).message;
      this.fileNotice = this.statusText;
    } finally { this.switching = false; }
  }

  private async createProject(): Promise<void> {
    const name = this.projectNameDraft.trim();
    if (!name || this.switching || this.isBusy || !this.hydrated) { return; }
    if (this.projects.some((item: StoredProject) => item.name === name)) {
      this.fileNotice = '已有同名项目';
      return;
    }
    const project: StoredProject = { id: 'p-' + Date.now(), name: name };
    this.projects = this.projects.concat([project]);
    this.projectNameDraft = '';
    await this.switchProject(project.id);
  }

  private editedEndpoint(): string {
    const entered = this.editUrl.trim().replace(/\/+$/, '');
    if (!entered) { throw new Error('请输入模型服务地址'); }
    const base = entered.replace(/\/(?:chat\/completions|responses)$/, '');
    return validateModelEndpoint(base + (this.editProtocol === 'Responses' ? '/responses' : '/chat/completions'));
  }

  private savedCredential(endpoint: string): boolean {
    return (this.baseUrl === endpoint && this.hasSavedKey) ||
      this.profiles.some((item: StoredModelProfile) => item.baseUrl === endpoint && item.hasSavedKey);
  }

  private async refreshModels(): Promise<void> {
    if (this.isBusy || this.switching) { return; }
    this.switching = true;
    try {
      const endpoint = this.editedEndpoint();
      const key = this.editKey.trim() || (this.savedCredential(endpoint) ? await this.store!.loadKey(endpoint) : '');
      this.catalog = await fetchModelCatalog(endpoint, key);
      this.settingsNotice = this.catalog.length ? '已读取 ' + this.catalog.length + ' 个模型' : '目录为空，请填写模型 ID';
    } catch (error) {
      this.catalog = [];
      this.settingsNotice = (error as Error).message;
    } finally { this.switching = false; }
  }

  private async saveModelSettings(): Promise<void> {
    if (this.mode !== 'local' || !this.hydrated || this.isBusy || this.switching) { return; }
    this.switching = true;
    try {
      const endpoint = this.editedEndpoint();
      const name = this.editModel.trim();
      const limit = this.editMaxTokens.trim();
      if (limit && (!/^[1-9]\d*$/.test(limit) || !Number.isSafeInteger(Number(limit)))) {
        throw new Error('输出上限须为正整数，留空使用服务默认值');
      }
      if (!name) { throw new Error('请输入服务提供的模型 ID'); }
      const key = this.editKey.trim();
      const keep = this.savedCredential(endpoint);
      if (key) { await this.store!.saveKey(endpoint, key); }
      this.hasSavedKey = key.length > 0 || Boolean(keep);
      this.model = name;
      this.maxOutputTokens = Number(limit);
      this.baseUrl = endpoint;
      const profile: StoredModelProfile = { baseUrl: endpoint, model: name, hasSavedKey: this.hasSavedKey };
      this.profiles = [profile].concat(this.profiles.filter((item: StoredModelProfile) =>
        item.baseUrl !== endpoint || item.model !== name));
      this.editKey = '';
      await this.persistNow();
      this.settingsOpen = false;
      this.statusText = '已选择模型 ' + name;
    } catch (error) {
      this.settingsNotice = '模型设置未保存：' + (error as Error).message;
    } finally { this.switching = false; }
  }

  private async forgetKey(): Promise<void> {
    if (!this.hasSavedKey || this.switching || this.isBusy) { return; }
    this.switching = true;
    try {
      await this.store!.saveKey(this.baseUrl, '');
      this.hasSavedKey = false;
      this.profiles = this.profiles.map((item: StoredModelProfile): StoredModelProfile => {
        return { baseUrl: item.baseUrl, model: item.model, hasSavedKey: item.baseUrl !== this.baseUrl && item.hasSavedKey };
      });
        this.editKey = '';
      await this.persistNow();
      this.settingsNotice = '已移除当前服务的密钥';
    } catch (error) { this.settingsNotice = (error as Error).message; }
    finally { this.switching = false; }
  }

  private async saveJevSettings(): Promise<void> {
    if (!this.store || this.mode !== 'local' || !this.hydrated || this.switching || this.isBusy) { return; }
    this.switching = true;
    try {
      const endpoint = validateJevEndpoint(this.editJevEndpoint.trim());
      const model = this.editJevModel.trim();
      if (!model) { throw new Error('请输入 Jev 模型 ID'); }
      const key = this.editJevKey.trim();
      const saved = key ? true : !!(await this.store.loadKey(endpoint, true));
      if (this.editJevEnabled && !saved) { throw new Error('启用编排需要此 Jev 服务的独立密钥'); }
      if (key) { await this.store.saveKey(endpoint, key, true); }
      this.jevHasSavedKey = saved;
      this.jevEndpoint = endpoint;
      this.jevModel = model;
      this.jevEnabled = this.editJevEnabled;
      this.editJevKey = '';
      await this.persistNow();
      this.settingsNotice = this.jevEnabled ? '已启用 Jev 多角色编排' : '已关闭 Jev 多角色编排';
    } catch (error) { this.settingsNotice = 'Jev 设置未保存：' + (error as Error).message; }
    finally { this.switching = false; }
  }

  private async forgetJevKey(): Promise<void> {
    if (!this.store || !this.jevHasSavedKey || this.switching || this.isBusy) { return; }
    this.switching = true;
    try {
      await this.store.saveKey(this.jevEndpoint, '', true);
      this.jevHasSavedKey = false;
      this.jevEnabled = false;
      this.editJevEnabled = false;
      this.editJevKey = '';
      await this.persistNow();
      this.settingsNotice = '已移除 Jev 密钥并关闭编排';
    } catch (error) { this.settingsNotice = (error as Error).message; }
    finally { this.switching = false; }
  }

  @Builder
  private smallAction(label: string, action: () => void, enabled: boolean = true) {
    Button(label, { type: ButtonType.Normal }).fontSize(12).height(36).borderRadius(6)
      .padding({ left: 12, right: 12 }).fontColor($r('app.color.wb_text')).backgroundColor($r('app.color.wb_surface'))
      .border({ width: 1, color: $r('app.color.wb_border') }).enabled(enabled && !this.switching).onClick(action);
  }

  @Builder
  private buildConnectionSettings() {
    Column({ space: 12 }) {
      Row({ space: 6 }) {
        this.smallAction('本机模型', () => { this.settingsTab = '模型'; this.settingsNotice = ''; });
        if (this.mode === 'local' && this.hydrated) {
          this.smallAction('Jev 编排', () => { this.settingsTab = 'Jev'; this.settingsNotice = ''; });
        }
        this.smallAction('其他连接', () => { this.settingsTab = '其他连接'; this.settingsNotice = ''; });
      }
      if (this.settingsTab === '模型' && this.mode === 'local' && this.hydrated) {
        if (this.profiles.length) {
          Select(this.profiles.map((item: StoredModelProfile): SelectOption => {
            return { value: item.model + ' · ' + item.baseUrl };
          })).value('已保存的模型').width('100%').onSelect((index: number) => {
            const profile = this.profiles[index];
            this.editUrl = profile.baseUrl.replace(/\/(?:chat\/completions|responses)$/, '');
            this.editProtocol = profile.baseUrl.endsWith('/responses') ? 'Responses' : 'Chat Completions';
            this.editModel = profile.model;
            this.editKey = '';
            this.catalog = [];
          });
        }
        Select([{ value: 'Chat Completions' }, { value: 'Responses' }]).value(this.editProtocol)
          .onSelect((index: number) => {
            this.editProtocol = index === 1 ? 'Responses' : 'Chat Completions';
            this.editKey = '';
          });
        Text('模型服务').fontSize(14).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_text'));
        this.connectionField('服务地址', 'https://api.openai.com/v1', this.editUrl, (value: string) => {
          if (this.editUrl !== value) { this.editKey = ''; this.catalog = []; }
          this.editUrl = value;
        });
        this.connectionField('模型 ID', '填写服务提供的模型 ID', this.editModel, (value: string) => { this.editModel = value; });
        this.connectionField('每次模型响应的输出上限', '默认（token）', this.editMaxTokens, (value: string) => { this.editMaxTokens = value; });
        if (this.catalog.length) {
          Select(this.catalog.map((id: string): SelectOption => { return { value: id }; })).value('选择目录中的模型')
            .onSelect((index: number) => { this.editModel = this.catalog[index]; });
        }
        Text('API 密钥').fontSize(13).fontColor($r('app.color.wb_text'));
        TextInput({ text: this.editKey, placeholder: this.hasSavedKey && this.editUrl === this.baseUrl.replace(/\/(?:chat\/completions|responses)$/, '') &&
          this.baseUrl.endsWith(this.editProtocol === 'Responses' ? '/responses' : '/chat/completions') ?
          '此服务已保存密钥，留空继续使用' : '无密钥的服务可留空' })
          .type(InputType.Password).height(38).fontSize(13).maxLength(4096)
          .onChange((value: string) => { this.editKey = value; });
        Flex({ wrap: FlexWrap.Wrap }) {
          this.smallAction('获取模型目录', () => { this.refreshModels(); }, !this.isBusy);
          this.smallAction('保存模型设置', () => { this.saveModelSettings(); }, !this.isBusy);
          if (this.hasSavedKey) { this.smallAction('移除已存密钥', () => { this.forgetKey(); }, !this.isBusy); }
        }
      } else if (this.settingsTab === 'Jev') {
        Row({ space: 8 }) {
          Text('启用 Jev 多角色编排').fontSize(14).fontColor($r('app.color.wb_text')).layoutWeight(1);
          Toggle({ type: ToggleType.Switch, isOn: this.editJevEnabled })
            .onChange((enabled: boolean) => { this.editJevEnabled = enabled; });
        }.width('100%');
        Text('启用后，Jev 会接收任务目标并选择角色。规划、执行和复核使用本机工作台配置的任务模型。')
          .fontSize(12).fontColor($r('app.color.wb_secondary'));
        this.connectionField('Jev 服务地址', DEFAULT_JEV_ENDPOINT, this.editJevEndpoint, (value: string) => {
          if (this.editJevEndpoint !== value) { this.editJevKey = ''; }
          this.editJevEndpoint = value;
        });
        this.connectionField('Jev 模型 ID', DEFAULT_JEV_MODEL, this.editJevModel, (value: string) => { this.editJevModel = value; });
        Text('Jev API 密钥').fontSize(13).fontColor($r('app.color.wb_text'));
        TextInput({ text: this.editJevKey, placeholder: this.jevHasSavedKey && this.editJevEndpoint === this.jevEndpoint ?
          '已保存在此设备，留空继续使用' : '填写此 Jev 服务的密钥' })
          .type(InputType.Password).height(38).fontSize(13).maxLength(4096)
          .onChange((value: string) => { this.editJevKey = value; });
        Flex({ wrap: FlexWrap.Wrap }) {
          this.smallAction('保存 Jev 设置', () => { this.saveJevSettings(); }, !this.isBusy);
          if (this.jevHasSavedKey && this.editJevEndpoint === this.jevEndpoint) {
            this.smallAction('移除 Jev 密钥', () => { this.forgetJevKey(); }, !this.isBusy);
          }
        }
      } else if (this.settingsTab === '模型') {
        this.smallAction('打开本机工作台', () => { this.switchMode('local'); }, !this.isBusy);
      } else {
        this.connectionField('App Server', 'wss://host/app-server', this.endpoint, (value: string) => { this.endpoint = value; });
        this.connectionField('远程项目目录', '/workspace', this.projectRoot, (value: string) => { this.projectRoot = value; });
        Flex({ wrap: FlexWrap.Wrap }) {
          this.smallAction('连接 App Server', () => { this.switchMode('remote'); }, !this.isBusy);
          this.smallAction('打开演示', () => { this.switchMode('demo'); }, !this.isBusy);
          if (this.mode !== 'local') { this.smallAction('返回本机工作台', () => { this.switchMode('local'); }, !this.isBusy); }
        }
      }
      Text(this.settingsNotice || this.statusText).fontSize(12).fontColor($r('app.color.wb_secondary'));
    }.width('100%').alignItems(HorizontalAlign.Start);
  }

  @Builder
  private connectionField(label: string, hint: string, value: string, change: (value: string) => void) {
    Flex({ direction: this.availableWidth <= 760 ? FlexDirection.Column : FlexDirection.Row,
      justifyContent: FlexAlign.SpaceBetween,
      alignItems: this.availableWidth <= 760 ? ItemAlign.Start : ItemAlign.Center }) {
      Text(label).fontSize(13).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_text'))
        .margin({ bottom: this.availableWidth <= 760 ? 10 : 0 });
      TextInput({ placeholder: hint, text: value }).width(this.availableWidth <= 760 ? '100%' : '62%').height(38)
        .accessibilityText(label).fontSize(13).fontColor($r('app.color.wb_text')).placeholderColor($r('app.color.wb_muted'))
        .padding({ left: 11, right: 11 }).borderRadius(8).backgroundColor($r('app.color.wb_surface'))
        .border({ width: 1, color: $r('app.color.wb_border') }).onChange(change);
    }.width('100%').padding({ top: 16, bottom: 16 });
  }

  private parentDirectory(): string {
    const root: string = this.mode === 'remote' ? this.workspaceRoot : '/';
    const path: string = this.workspacePath;
    if (path === root || !path.startsWith(root.endsWith('/') ? root : root + '/')) {
      return path;
    }
    const parent: string = path.substring(0, path.lastIndexOf('/'));
    return parent.length > root.length ? parent : root;
  }

  @Builder
  private projectControls() {
    Column({ space: 8 }) {
      Text('本机项目').fontSize(17).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_text'));
      Flex({ wrap: FlexWrap.Wrap }) {
        ForEach(this.projects, (project: StoredProject) => {
          this.smallAction(project.name, () => { this.switchProject(project.id); }, project.id !== this.projectId && !this.isBusy);
        }, (project: StoredProject) => project.id);
      }
      Row({ space: 6 }) {
        TextInput({ text: this.projectNameDraft, placeholder: '新项目名称' }).height(36).layoutWeight(1).maxLength(80)
          .fontSize(13).onChange((value: string) => { this.projectNameDraft = value; });
        this.smallAction('新建项目', () => { this.createProject(); }, !this.isBusy && !!this.projectNameDraft.trim());
      }.width('100%');
      this.smallAction('导入文件副本', () => { this.importDocuments(); }, !this.isBusy);
    }.width('100%').alignItems(HorizontalAlign.Start);
  }

  @Builder
  private projectCommandPanel() {
    Column({ space: 7 }) {
      this.smallAction(this.commandPanelOpen ? '收起项目命令' : '项目命令', () => { this.commandPanelOpen = !this.commandPanelOpen; });
      if (this.commandPanelOpen) {
        Text(LOCAL_COMMAND_HELP).fontFamily('monospace').fontSize(12).fontColor($r('app.color.wb_secondary'));
        Row({ space: 6 }) {
          TextInput({ text: this.commandInput, placeholder: '例如 wc -l "/项目说明.txt"' })
            .accessibilityText('本机项目命令').height(36).layoutWeight(1).fontSize(13).fontFamily('monospace')
            .maxLength(8192).enabled(!this.commandRunning).onChange((value: string) => { this.commandInput = value; })
            .onSubmit(() => { this.executeManualCommand(); });
          this.smallAction(this.commandRunning ? '运行中' : '运行', () => { this.executeManualCommand(); },
            !this.commandRunning && !!this.commandInput.trim());
        }.width('100%');
        if (this.commandResult) {
          Text('退出码 ' + this.commandResult.exitCode + (this.commandResult.truncated ? ' · 输出已截断' : ''))
            .fontSize(12).fontColor($r('app.color.wb_secondary'));
          if (this.commandResult.stdout || this.commandResult.stderr) {
            Scroll() {
              Text((this.commandResult.stdout ? 'stdout\n' + this.commandResult.stdout : '') +
                (this.commandResult.stderr ? 'stderr\n' + this.commandResult.stderr : '')).width('100%')
                .fontFamily('monospace').fontSize(12).copyOption(CopyOptions.LocalDevice)
                .fontColor(this.commandResult.stderr ? $r('app.color.wb_red') : $r('app.color.wb_text'));
            }.width('100%').constraintSize({ maxHeight: 200 }).padding(8).backgroundColor($r('app.color.wb_surface'));
          }
        }
      }
    }.width('100%').alignItems(HorizontalAlign.Start);
  }

  private async executeManualCommand(): Promise<void> {
    const workspace = this.workspace;
    if (!workspace || this.mode !== 'local' || this.commandRunning || this.switching) { return; }
    this.commandRunning = true;
    this.commandResult = undefined;
    try {
      const request = parseProjectCommand(this.commandInput);
      const result = await runProjectCommand(workspace, request.command, request.args);
      if (this.pageActive && this.mode === 'local' && this.workspace === workspace) { this.commandResult = result; }
    } catch (error) {
      if (this.workspace === workspace) {
        this.commandResult = { exitCode: 2, stdout: '', stderr: (error as Error).message, truncated: false };
      }
    } finally { if (this.workspace === workspace) { this.commandRunning = false; } }
  }

  @Builder
  private buildWorkspacePanel() {
    Column({ space: 12 }) {
      if (this.mode === 'local') {
        this.projectControls();
        this.projectCommandPanel();
      }
      if (this.fileNotice) { this.pageNotice(this.fileNotice); }
      Text('工作区').fontSize(10).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_muted'));
      Row({ space: 8 }) {
        Column({ space: 5 }) {
          Text(this.workspaceRoot).fontSize(20).fontWeight(FontWeight.Bold).fontColor($r('app.color.wb_text'));
          Text(this.workspacePath).fontSize(11).fontFamily('monospace').fontColor($r('app.color.wb_muted'))
            .copyOption(CopyOptions.InApp);
        }.alignItems(HorizontalAlign.Start).layoutWeight(1);
        if (this.parentDirectory() !== this.workspacePath) {
          Button({ type: ButtonType.Normal }) {
            this.icon('chevron-left', 16, $r('app.color.wb_secondary'));
          }.width(36).height(36).padding(0).borderRadius(6).backgroundColor($r('app.color.wb_surface'))
            .border({ width: 1, color: $r('app.color.wb_border') }).accessibilityText('返回上级')
            .onClick(() => {
              this.selectedFileContent = '';
              this.selectedFilePath = '';
              this.loadWorkspace(this.parentDirectory());
            });
        }
        Button({ type: ButtonType.Normal }) {
          this.icon('refresh', 16, $r('app.color.wb_secondary'));
        }.width(36).height(36).padding(0).borderRadius(6).backgroundColor($r('app.color.wb_surface'))
          .border({ width: 1, color: $r('app.color.wb_border') }).accessibilityText('刷新目录')
          .onClick(() => this.loadWorkspace(this.workspacePath));
      }.width('100%');
      Divider().color($r('app.color.wb_border'));
      Column({ space: 2 }) {
        if (this.workspaceEntries.length === 0) {
          Text(this.connectionState === ConnectionState.Connected ? '此目录为空' : this.statusText)
            .fontSize(12).fontColor($r('app.color.wb_muted')).padding(8);
        }
        ForEach(this.workspaceEntries, (entry: WorkspaceEntry) => {
          Button({ type: ButtonType.Normal }) {
            Row({ space: 8 }) {
              this.icon(entry.isDirectory ? 'folder' : 'file', 15, $r('app.color.wb_secondary'));
              Text(entry.fileName).layoutWeight(1).fontSize(13).fontColor($r('app.color.wb_text'))
                .maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
              if (entry.isDirectory) {
                this.icon('chevron-right', 14, $r('app.color.wb_muted'));
              }
            }.width('100%');
          }.width('100%').height(40).borderRadius(4).padding({ left: 8, right: 8 })
            .backgroundColor(this.selectedFilePath === entry.path ? $r('app.color.wb_selected') : Color.Transparent)
            .accessibilityText(entry.fileName).onClick(() => this.openWorkspaceEntry(entry));
        }, (entry: WorkspaceEntry) => entry.path);
      }.width('100%').alignItems(HorizontalAlign.Start);
      if (this.mode === 'local' && this.selectedFilePath) { this.smallAction('导出此文件', () => { this.exportContent(false); }); }
      if (this.selectedFilePath.length > 0) {
        Divider().color($r('app.color.wb_soft_border'));
        Column({ space: 8 }) {
          Text('只读预览').fontSize(10).fontColor($r('app.color.wb_muted')).fontWeight(FontWeight.Medium);
          Text(this.selectedFilePath).fontSize(13).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_text'));
          Text(this.selectedFileContent).width('100%').fontSize(12).fontColor($r('app.color.wb_text'))
            .fontFamily('monospace').lineHeight(19).copyOption(CopyOptions.InApp).padding(10)
            .backgroundColor($r('app.color.wb_canvas')).borderRadius(5)
            .border({ width: 1, color: $r('app.color.wb_soft_border') });
        }.width('100%').alignItems(HorizontalAlign.Start);
      }
    }.width('100%').alignItems(HorizontalAlign.Start);
  }

  @Builder
  private recoveryActions(state: LocalRunState) {
    Column({ space: 8 }) {
      Text('任务断点').fontSize(15).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_text'));
      Text('当前阶段 · ' + (state.phase === 'route' ? '角色分配' : state.phase === 'plan' ? '规划' :
        state.phase === 'review' ? '复核' : '执行') + '　已记录 ' + state.receipts.length + ' 项操作')
        .fontSize(13).fontColor($r('app.color.wb_secondary'));
      if (state.pending) {
        Text('上次写入的结果待核对。\n' + state.pending.tool + '　' + state.pending.path)
          .fontSize(13).fontColor($r('app.color.wb_text')).copyOption(CopyOptions.LocalDevice);
      }
      Flex({ wrap: FlexWrap.Wrap }) {
        if (state.pending) {
          if (state.pending.expectedHash) {
            this.smallAction('核对写入并继续', () => { this.updateCheckpoint(state, true); },
              !this.switching && !this.checkpointLoading);
          }
          this.smallAction('查看项目文件', () => this.openPanel('项目文件'));
        } else {
          this.smallAction('从断点继续', () => { this.sendPrompt(false, state); }, !this.switching && !this.checkpointLoading);
        }
        this.smallAction('放弃断点', () => { this.updateCheckpoint(state, false); }, !this.switching && !this.checkpointLoading);
      }
    }.width('100%').padding(12).alignItems(HorizontalAlign.Start).backgroundColor($r('app.color.wb_warning_bg'))
      .border({ width: 1, color: $r('app.color.wb_amber'), radius: 6 });
  }

  @Builder
  private buildTranscript() {
    Scroll() {
      Column({ space: 12 }) {
        if (this.mode === 'local' && !this.isBusy && this.checkpointState) {
          this.recoveryActions(this.checkpointState);
        } else if (this.mode === 'local' && this.checkpointError) {
          this.actionRow('重新读取任务断点', this.checkpointError, () => { this.refreshCheckpoint(!!this.activeRunId); });
        }
        if (this.hasApproval) {
          Text('审批与授权状态').fontSize(16).fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.wb_text'));
          this.buildApprovalCard();
        }
        if (this.mode === 'local' && !this.model && !this.switching && this.hydrated) {
          this.actionRow('配置模型', '连接自己的模型服务，开始本机任务', () => this.showSettings());
        } else if (this.mode === 'local' && !this.hydrated && !this.switching) {
          this.actionRow('重新加载本机工作台', this.statusText, () => { this.restoreLocalWorkbench(); });
        }
        if (this.messages.length > 0) {
          Column() {
            ForEach(this.messages, (message: ChatMessage) => {
              this.buildMessage(message);
            }, (message: ChatMessage) => message.id + ':' + message.text.length);
          }.width('100%').padding({ left: 15 });
        }
      }.width('100%').constraintSize({ maxWidth: 800 }).alignItems(HorizontalAlign.Start);
    }.layoutWeight(1).width('100%').align(Alignment.Top)
      .padding({ left: this.availableWidth <= 760 ? 12 : 20, right: this.availableWidth <= 760 ? 12 : 20,
        top: this.availableWidth <= 760 ? 18 : 25, bottom: 32 })
      .scrollBar(BarState.Auto).backgroundColor($r('app.color.wb_canvas'));
  }

  @Builder
  private buildMessage(message: ChatMessage) {
    Row({ space: this.availableWidth <= 760 ? 9 : 13 }) {
      Row() {
        this.icon(message.role === MessageRole.User ? 'user' : message.role === MessageRole.Tool ? 'terminal' :
          message.role === MessageRole.System ? 'alert' : 'bot', 16,
          message.role === MessageRole.User ? $r('app.color.wb_accent_text') :
          message.role === MessageRole.System ? $r('app.color.wb_red') : $r('app.color.wb_secondary'));
      }.width(31).height(31).justifyContent(FlexAlign.Center)
        .border({ width: 1, color: $r('app.color.wb_border'), radius: 16 })
        .backgroundColor(message.role === MessageRole.User ? $r('app.color.wb_user_bg') : $r('app.color.wb_surface'))
        .margin({ left: -16 });

      Column({ space: 7 }) {
        Text(message.role === MessageRole.User ? '你' :
          (message.title ?? (message.role === MessageRole.System ? '系统' : 'dda')))
          .fontSize(11).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_secondary'));
        if (message.images?.length) {
          ForEach(message.images, (attachment: ImageAttachment) => {
            Row({ space: 6 }) {
              Image(this.attachmentUri(attachment)).width(58).height(58).borderRadius(5).objectFit(ImageFit.Cover);
              Text(attachment.name).fontSize(12).fontColor($r('app.color.wb_accent_text')).layoutWeight(1);
            }.width('100%');
          }, (attachment: ImageAttachment) => attachment.id);
        }
        if (message.role === MessageRole.Tool) {
          Text(message.text).width('100%').padding(9).fontFamily('monospace')
            .fontSize(12).lineHeight(18).fontColor($r('app.color.wb_text')).copyOption(CopyOptions.LocalDevice)
            .backgroundColor($r('app.color.wb_surface'))
            .border({ width: 1, color: $r('app.color.wb_soft_border'), radius: 6 });
        } else {
          Text(message.text).fontSize(13).lineHeight(22).fontColor($r('app.color.wb_text'))
            .copyOption(CopyOptions.LocalDevice);
        }
      }.alignItems(HorizontalAlign.Start).layoutWeight(1).padding({ top: 2 });
    }.width('100%').alignItems(VerticalAlign.Top).padding({ top: 18, bottom: 18 })
      .border({ width: { left: 1 }, color: $r('app.color.wb_border') });
  }

  @Builder
  private buildApprovalCard() {
    Column({ space: 8 }) {
      Row({ space: 7 }) {
        this.icon('shield', 16, $r('app.color.wb_amber'));
        Text('需要你的确认').fontSize(13).fontWeight(FontWeight.Medium).fontColor($r('app.color.wb_text'));
      }
      Text(this.approval.reason).fontSize(13).lineHeight(20).fontColor($r('app.color.wb_secondary'));
      if (this.approval.command.length > 0) {
        Scroll() {
          Text(this.approval.command).fontSize(12).fontFamily('monospace').fontColor($r('app.color.wb_text'))
          .copyOption(CopyOptions.LocalDevice).width('100%').padding(9)
          .backgroundColor($r('app.color.wb_surface')).borderRadius(6);
        }.width('100%').constraintSize({ maxHeight: 240 }).scrollBar(BarState.Auto);
      }
      Row({ space: 6 }) {
        Button('拒绝操作', { type: ButtonType.Normal }).height(40).layoutWeight(1)
          .fontSize(12).fontColor($r('app.color.wb_text')).backgroundColor($r('app.color.wb_surface'))
          .border({ width: 1, color: $r('app.color.wb_border'), radius: 6 })
          .onClick(() => this.resolveApproval(false));
        Button('批准一次', { type: ButtonType.Normal }).height(40).layoutWeight(1)
          .fontSize(12).fontColor(Color.White).backgroundColor($r('app.color.wb_blue')).borderRadius(6)
          .onClick(() => this.resolveApproval(true));
      }.width('100%').margin({ top: 2 });
    }.width('100%').alignItems(HorizontalAlign.Start).padding(11)
      .backgroundColor($r('app.color.wb_warning_bg'))
      .border({ width: 1, color: $r('app.color.wb_amber'), radius: 6 });
  }

  @Builder
  private buildComposer() {
    Column({ space: 6 }) {
      Column() {
        if (this.mode === 'local' && this.queued.length) {
          Row({ space: 6 }) {
            Text('等待发送 ' + this.queued.length + ' 条 · ' + this.queued[0]).fontSize(12).layoutWeight(1)
              .fontColor($r('app.color.wb_secondary')).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis });
            if (!this.isBusy) {
              this.smallAction('发送下一条', () => { this.sendPrompt(true); },
                !this.checkpointState && !this.checkpointError && !this.checkpointLoading);
            }
            this.smallAction('取回', () => {
              this.composer = [this.queued[0], this.composer].filter((value: string) => !!value).join('\n');
              this.queued = this.queued.slice(1);
              this.queueSave();
            }, !this.preparingTurn);
          }.width('100%').padding(5);
        }
        if (this.draftImages.length) {
          Flex({ wrap: FlexWrap.Wrap }) {
            ForEach(this.draftImages, (attachment: ImageAttachment) => {
              Row({ space: 3 }) {
                Image(this.attachmentUri(attachment)).width(32).height(32).objectFit(ImageFit.Cover);
                this.smallAction(attachment.name.slice(0, 16) + ' ×', () => {
                this.draftImages = this.draftImages.filter((item: ImageAttachment) => item.id !== attachment.id);
                this.queueSave();
                }, !this.isBusy);
              }
            }, (attachment: ImageAttachment) => attachment.id);
          }.padding(6);
        }
        if (this.inputNotice) { Text(this.inputNotice).fontSize(12).fontColor($r('app.color.wb_red')); }
        TextArea({ placeholder: '描述你要完成的任务', text: this.composer })
          .id('task-input').enabled(!this.preparingTurn && !this.switching).width('100%').height(62)
          .padding({ left: 14, right: 14, top: 12, bottom: 4 })
          .fontSize(13).fontColor($r('app.color.wb_text')).placeholderColor($r('app.color.wb_muted'))
          .backgroundColor(Color.Transparent).borderRadius(8)
          .onChange((value: string) => { this.composer = value; this.queueSave(); });
        Row({ space: 8 }) {
          if (this.availableWidth > 760) {
            Text(this.workspaceRoot).layoutWeight(1).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
              .fontSize(11).fontColor($r('app.color.wb_muted'));
          }
          Button({ type: ButtonType.Normal }) {
            Row({ space: 4 }) {
              this.icon('cpu', 14, $r('app.color.wb_secondary'));
              Text(this.mode === 'local' ? (this.model || '配置模型') : this.mode === 'demo' ? '演示模式' : 'App Server').maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis }).fontSize(12).fontColor($r('app.color.wb_text'));
            }
          }.constraintSize({ maxWidth: this.availableWidth <= 760 ? 114 : 180 }).height(28).padding({ left: 8, right: 8 })
            .backgroundColor($r('app.color.wb_surface'))
            .border({ width: 1, color: $r('app.color.wb_border'), radius: 14 })
            .accessibilityText('打开连接设置').onClick(() => this.showSettings());
          if (this.availableWidth <= 760) {
            Blank();
          }
          if (this.mode === 'local' && !this.isBusy) {
            this.iconButton('image', '添加图片', () => { this.addImages(); });
          }
          if (this.mode === 'local' && this.isBusy) {
            if (this.composer.trim() && !this.preparingTurn) { this.smallAction('排队', () => this.queueFollowUp()); }
            this.smallAction('取消', () => this.cancelLocalTurn());
          } else {
            Button({ type: ButtonType.Normal }) {
            Row({ space: 6 }) {
              this.icon('send', 15, Color.White);
              Text(this.isBusy ? '处理中' : '发送').fontSize(12).fontWeight(FontWeight.Medium).fontColor(Color.White);
            }
          }.width(86).height(34).borderRadius(6).backgroundColor($r('app.color.wb_blue'))
            .accessibilityText('发送任务')
            .enabled(!this.switching && !this.isBusy && !this.checkpointState && !this.checkpointLoading &&
              !this.checkpointError && (this.composer.trim().length > 0 || this.draftImages.length > 0))
            .onClick(() => this.sendPrompt());
          }
        }.width('100%').padding({ left: 13, right: 7, top: 5, bottom: 7 });
      }.width('100%').constraintSize({ maxWidth: 800 }).backgroundColor($r('app.color.wb_surface'))
        .border({ width: 1, color: $r('app.color.wb_border'), radius: 8 });
      if (this.mode === 'local' && this.lastUsage) {
        Text('上一轮用量 · 输入 ' + this.lastUsage.inputTokens + ' / 输出 ' + this.lastUsage.outputTokens + ' token' +
          (this.lastUsage.cachedTokens !== undefined ? ' · 缓存 ' + this.lastUsage.cachedTokens : ''))
          .fontSize(11).fontColor($r('app.color.wb_secondary'));
      } else if (this.availableWidth > 760) {
        Text('需要授权时，可在对话中批准或拒绝操作。')
          .width('100%').constraintSize({ maxWidth: 800 }).textAlign(TextAlign.End)
          .fontSize(10).fontColor($r('app.color.wb_muted'));
      }
    }.width('100%').padding({ left: this.availableWidth <= 760 ? 10 : 20,
      right: this.availableWidth <= 760 ? 10 : 20, top: this.availableWidth <= 760 ? 9 : 12,
      bottom: this.availableWidth <= 760 ? 8 : 10 })
      .backgroundColor($r('app.color.wb_canvas')).border({ width: { top: 1 }, color: $r('app.color.wb_border') });
  }

  private async addImages(): Promise<void> {
    if (this.mode !== 'local' || this.switching || this.isBusy || this.draftImages.length >= 4) { return; }
    this.switching = true;
    try {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      const added = await chooseImages(context, 4 - this.draftImages.length);
      this.draftImages = this.draftImages.concat(added);
      this.inputNotice = '';
    } catch (error) { this.inputNotice = (error as Error).message; }
    finally { this.switching = false; this.queueSave(); }
  }

  private cancelLocalTurn(): void {
    if (this.preparingTurn) {
      this.sendSequence++;
      this.preparingTurn = false;
      this.isBusy = false;
      this.statusText = '任务已取消';
      this.queueSave();
    } else { this.localTransport?.cancelTurn(); }
  }

  private queueFollowUp(): void {
    const value = this.composer.trim();
    if (!value || !this.isBusy || this.mode !== 'local') { return; }
    this.queued = this.queued.concat([value]);
    this.composer = '';
    this.queueSave();
  }

  private async sendPrompt(fromQueue: boolean = false, resume?: LocalRunState): Promise<void> {
    if (this.isBusy || this.switching || !this.session || this.checkpointLoading || this.checkpointError) { return; }
    if (resume) {
      if (resume.pending || !this.checkpointState || resume.runId !== this.checkpointState.runId ||
        resume.revision !== this.checkpointState.revision) { return; }
    } else if (this.checkpointState) { return; }
    let history = this.messages.slice();
    let prompt = fromQueue ? (this.queued[0] ?? '') : this.composer.trim();
    let attachments: ImageAttachment[] = fromQueue ? [] : this.draftImages.slice();
    if (resume) {
      const input = restoreTurnInput(history);
      if (!input) { this.inputNotice = '未找到断点对应的原始任务消息。'; return; }
      prompt = input.prompt;
      attachments = input.images;
      history = input.history;
    }
    if (!prompt && !attachments.length) { return; }
    if (this.mode === 'local' && !this.model) {
      this.showSettings();
      this.settingsNotice = '保存服务地址和模型 ID 后即可发送，草稿已保留。';
      return;
    }
    this.openPanel('任务对话');
    const sendId = ++this.sendSequence;
    const session = this.session;
    const threadId = session.currentThread();
    const transport = this.localTransport;
    const endpoint = this.baseUrl;
    const model = this.model;
    this.isBusy = true;
    this.preparingTurn = true;
    let preparedRunId = '';
    try {
      if (this.mode === 'local') {
        if (!this.hydrated) { throw new Error('本机工作台尚未就绪'); }
        const key = this.hasSavedKey ? await this.store!.loadKey(endpoint) : '';
        let jev: LocalJevConfig | undefined = undefined;
        if (this.jevEnabled) {
          const jevKey = this.jevHasSavedKey ? await this.store!.loadKey(this.jevEndpoint, true) : '';
          if (!jevKey) { throw new Error('未找到 Jev 密钥，请在设置中重新填写'); }
          jev = { endpoint: this.jevEndpoint, model: this.jevModel, apiKey: jevKey };
        }
        if (sendId !== this.sendSequence || !this.pageActive || this.session !== session) { return; }
        if (this.hasSavedKey && !key) { throw new Error('未找到此服务的设备密钥，请在设置中重新填写'); }
        const instructions = [this.instructions].concat(this.memories).filter((item: string) => item.length > 0).join('\n');
        const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
        const images = await Promise.all(attachments.map((item: ImageAttachment) => readImageData(context, item.id)));
        if (sendId !== this.sendSequence || !this.pageActive || this.session !== session ||
          transport !== this.localTransport || endpoint !== this.baseUrl || threadId !== session.currentThread()) { return; }
        transport!.configure({ baseUrl: endpoint, model: model, apiKey: key, maxOutputTokens: this.maxOutputTokens || undefined,
          jev: jev });
        preparedRunId = transport!.prepareTurn(history, instructions, images);
      }
      this.inputNotice = '';
      this.resumingTurn = resume !== undefined;
      if (resume) {
        this.replaceAnswerId = resume.runId + '-answer-' + (resume.phase === 'review' ? resume.round : resume.round + 1);
        this.preparingTurn = false;
        await transport!.resumeTurn(threadId, prompt);
      } else {
        const title = this.messages.length ? this.currentTitle : prompt ? prompt.slice(0, 60) : '图片任务';
        const message: ChatMessage = { id: 'user-' + Date.now(), role: MessageRole.User, text: prompt, images: attachments };
        if (this.mode === 'local') {
          const task = this.snapshot();
          stageStoredTurn(task, message, title, preparedRunId, fromQueue);
          await this.persistNow(task);
        }
        if (sendId !== this.sendSequence || !this.pageActive || this.session !== session) { return; }
        this.activeRunId = preparedRunId;
        this.currentTitle = title;
        this.appendMessage(message);
        if (fromQueue) {
          this.queued = this.queued.slice(1);
        } else {
          this.draftImages = [];
          this.composer = '';
        }
        this.replaceAnswerId = '';
        this.preparingTurn = false;
        await session.sendPrompt(prompt);
      }
    } catch (error) {
      if (sendId !== this.sendSequence || !this.pageActive) { return; }
      this.preparingTurn = false;
      this.isBusy = false;
      this.hasApproval = false;
      this.statusText = '任务未完成';
      this.appendMessage({ id: 'request-error-' + Date.now(), role: MessageRole.System,
        text: '请求失败：' + (error as Error).message });
      if (this.mode === 'local') { await this.refreshCheckpoint(); }
      this.queueSave();
    }
  }

  private openWorkspaceEntry(entry: WorkspaceEntry): void {
    if (entry.isDirectory) {
      this.selectedFilePath = '';
      this.selectedFileContent = '';
      this.loadWorkspace(entry.path);
    } else { this.loadFile(entry); }
  }

  private async loadWorkspace(path: string): Promise<void> {
    const session = this.session;
    if (!session) { return; }
    const request = ++this.directoryRequest;
    ++this.fileRequest;
    try {
      const entries = await session.readDirectory(path);
      if (request !== this.directoryRequest || session !== this.session) { return; }
      this.workspacePath = path;
      this.workspaceEntries = entries;
      this.workspaceRoot = this.mode === 'local' ? this.projectTitle(this.projectId) :
        this.mode === 'demo' ? '演示工作区' : this.projectRoot;
    } catch (error) {
      if (request === this.directoryRequest && session === this.session) {
        this.fileNotice = '读取目录失败：' + (error as Error).message;
      }
    }
  }

  private async loadFile(entry: WorkspaceEntry): Promise<void> {
    const session = this.session;
    if (!session) { return; }
    const request = ++this.fileRequest;
    try {
      const content = await session.readFile(entry.path);
      if (request !== this.fileRequest || session !== this.session) { return; }
      this.selectedFilePath = entry.path;
      this.selectedFileContent = content;
      this.statusText = '已打开 ' + entry.fileName;
    } catch (error) {
      if (request === this.fileRequest && session === this.session) { this.fileNotice = '读取文件失败：' + (error as Error).message; }
    }
  }

  private async importDocuments(): Promise<void> {
    if (!this.workspace || this.switching || this.isBusy) { return; }
    this.switching = true;
    try {
      const count = await this.workspace.importFiles();
      if (count) {
        this.selectedFilePath = '';
        this.selectedFileContent = '';
        await this.loadWorkspace('/');
        this.fileNotice = '已导入 ' + count + ' 个文件副本';
      }
    } catch (error) {
      await this.loadWorkspace('/');
      this.fileNotice = (error as Error).message;
    } finally { this.switching = false; }
  }

  private async exportContent(chat: boolean): Promise<void> {
    if (!this.workspace || this.switching) { return; }
    this.switching = true;
    try {
      if (chat) {
        const body = '# ' + this.currentTitle + '\n\n' + this.messages.map((item: ChatMessage) => {
          const files = item.images?.map((image: ImageAttachment) => image.name).join('、');
          return '## ' + (item.title || item.role) + '\n\n' + (files ? '附图：' + files + '\n\n' : '') + item.text;
        }).join('\n\n');
        if (await this.workspace.exportText('dda-' + Date.now() + '.md', body)) { this.statusText = '会话已导出'; }
      } else if (await this.workspace.exportFile(this.selectedFilePath)) { this.fileNotice = '已导出选中文件'; }
    } catch (error) {
      this.statusText = '导出失败：' + (error as Error).message;
      this.fileNotice = this.statusText;
    } finally { this.switching = false; }
  }

  private resolveApproval(approved: boolean): void {
    if (!this.hasApproval) { return; }
    const request = this.approval;
    this.hasApproval = false;
    this.appendMessage({ id: 'decision-' + request.id, role: MessageRole.Tool,
      title: '操作审批', text: (approved ? '已批准一次' : '已拒绝') + ' · ' + request.command.split('\n')[0] + '\n' + request.reason });
    this.session?.resolveApproval(request.id, approved);
    this.queueSave();
  }

  private resetTranscript(): void {
    this.checkpointRequest++;
    this.checkpointState = undefined;
    this.checkpointError = '';
    this.checkpointLoading = false;
    this.activeRunId = '';
    this.replaceAnswerId = '';
    this.messages = [];
    this.composer = '';
    this.draftImages = [];
    this.queued = [];
    this.lastUsage = undefined;
    this.inputNotice = '';
    this.currentTitle = '新任务';
    this.taskFilter = '';
    this.activeAssistantId = '';
    this.activeToolId = '';
    this.hasApproval = false;
    this.isBusy = false;
  }

  private async switchMode(next: string): Promise<void> {
    if (this.switching || this.isBusy) { return; }
    if (next === 'remote' && !/^wss?:\/\/[^\s]+$/.test(this.endpoint.trim())) {
      this.settingsNotice = '请填写 ws:// 或 wss:// 开头的 App Server 地址';
      return;
    }
    this.switching = true;
    try {
      await this.persistNow();
      if (next === 'local') {
        await this.restoreLocalWorkbench();
        if (!this.hydrated) { this.settingsNotice = this.statusText; return; }
      } else {
        this.hydrated = false;
        this.mode = next;
            this.localTransport = undefined;
        this.tasks = [];
        this.resetTranscript();
        this.selectedFilePath = '';
        this.selectedFileContent = '';
        this.workspaceEntries = [];
        this.fileNotice = '';
        this.workspaceRoot = '未选择项目';
        this.projectRoot = this.projectRoot.trim() || '/workspace';
        const transport: CodexTransport = next === 'demo' ? new MockCodexTransport() :
          new AppServerWebSocketTransport(this.endpoint.trim(), this.projectRoot);
        await this.attach(transport);
        await this.loadWorkspace(next === 'demo' ? '/' : this.projectRoot);
      }
      this.openPanel('任务对话');
    } catch (error) {
      this.connectionState = ConnectionState.Error;
      this.settingsNotice = (error as Error).message;
      this.statusText = this.settingsNotice;
    } finally { this.switching = false; }
  }

  private handleSessionEvent(event: SessionEvent): void {
    switch (event.kind) {
      case SessionEventKind.ConnectionChanged:
        this.connectionState = event.state ?? ConnectionState.Disconnected;
        this.statusText = event.text ?? this.connectionState;
        if (this.connectionState === ConnectionState.Error || this.connectionState === ConnectionState.Disconnected) {
          this.isBusy = false; this.hasApproval = false;
        }
        break;
      case SessionEventKind.ThreadStarted:
        this.statusText = '会话已就绪';
        break;
      case SessionEventKind.TurnStarted:
        this.isBusy = true;
        this.statusText = event.text ?? 'dda 工作中';
        if (this.mode === 'local') {
          this.activeRunId = event.turnId ?? '';
          this.checkpointState = undefined;
          this.persistNow().catch((error: Error) => { this.inputNotice = '本机记录保存失败：' + error.message; });
        }
        this.activeAssistantId = '';
        this.activeToolId = '';
        break;
      case SessionEventKind.RoleActivity:
        this.statusText = event.text ?? '角色编排中';
        this.appendMessage({ id: 'role-' + Date.now() + '-' + this.messages.length, role: MessageRole.Tool,
          title: '角色编排', text: this.statusText });
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
        this.statusText = event.text || '工具执行完成';
        if (this.mode === 'local') { this.loadWorkspace(this.workspacePath); }
        break;
      case SessionEventKind.TurnCompleted:
        this.isBusy = false;
        this.hasApproval = false;
        this.statusText = event.text || '准备就绪';
        this.lastUsage = event.usage;
        if (event.text === '任务已取消') {
          this.appendMessage({ id: 'cancel-' + event.id, role: MessageRole.System, text: event.text });
        }
        if (this.mode === 'local') { this.settleLocalTurn(event.text !== '任务已取消'); }
        break;
      case SessionEventKind.Error:
        this.isBusy = false;
        this.hasApproval = false;
        this.appendMessage({
          id: `error-${Date.now()}`,
          role: MessageRole.System,
          text: event.text ?? '发生未知错误'
        });
        if (this.mode === 'local') { this.refreshCheckpoint(); }
        break;
      default:
        break;
    }
    this.queueSave();
  }

  private async settleLocalTurn(completed: boolean): Promise<void> {
    const session = this.session;
    const thread = session?.currentThread();
    const sequence = this.sendSequence;
    const sendQueued = completed && !this.resumingTurn;
    await this.refreshCheckpoint(completed);
    if (!this.pageActive || session !== this.session || thread !== this.session?.currentThread() ||
      sequence !== this.sendSequence) { return; }
    this.queueSave();
    if (sendQueued && !this.checkpointState && !this.checkpointError && !this.checkpointLoading &&
      !this.isBusy && !this.switching && this.queued.length) { await this.sendPrompt(true); }
  }

  private appendAssistantDelta(event: SessionEvent): void {
    const messageId: string = event.itemId || this.activeAssistantId || `assistant-${Date.now()}`;
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
        text: (messageId === this.replaceAnswerId ? '' : existing.text) + (event.text ?? ''),
        status: existing.status
      };
    }
    this.messages = next;
    if (messageId === this.replaceAnswerId) { this.replaceAnswerId = ''; }
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
