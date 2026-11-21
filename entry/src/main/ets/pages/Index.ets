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

// 24-unit outlines use the same visual vocabulary as the desktop toolbar.
const ICON_PATHS: Record<string, string> = {
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
  private readonly session: CodexSession = new CodexSession();
  private activeAssistantId: string = '';
  private activeToolId: string = '';
  private focusSearchOnAppear: boolean = false;

  @State messages: ChatMessage[] = [];
  @State tasks: TaskView[] = [];
  @State currentTitle: string = '新任务';
  @State panel: string = '任务对话';
  @State availableWidth: number = 1000;
  @State contextOpen: boolean = false;
  @State settingsOpen: boolean = false;
  @State taskFilter: string = '';
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
        dragBar: false, showClose: false, backgroundColor: $r('app.color.wb_surface')
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
            Text(this.demo ? '鸿蒙演示模式' : '鸿蒙 App Server').fontSize(11).fontColor($r('app.color.wb_muted'));
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
        .enabled(!this.isBusy && this.connectionState === ConnectionState.Connected).onClick(() => this.newTask());
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
              if (this.messages.length || this.composer.length) {
                this.taskRow(this.currentTitle, true, () => this.openPanel('任务对话'));
              } else if (!this.tasks.length) {
                Text('暂无会话').width('100%').padding({ left: 26, top: 8 }).fontSize(12).fontColor($r('app.color.wb_muted'));
              }
              ForEach(this.tasks, (task: TaskView) => {
                this.taskRow(task.title, false, () => this.restoreTask(task));
              }, (task: TaskView) => task.threadId);
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
        .accessibilityText('设置').onClick(() => { this.settingsOpen = true; });
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
      case ConnectionState.Connected: return this.demo ? '演示模式已连接' : 'App Server 已连接';
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
      if ((this.messages.length || this.composer.length) && this.matchesTask(this.currentTitle)) {
        this.actionRow(this.currentTitle, '当前会话', () => this.openPanel('任务对话'));
      }
      ForEach(this.tasks.filter((item: TaskView) => this.matchesTask(item.title)), (task: TaskView) => {
        Column() {
          this.actionRow(task.title, task.messages.length + ' 条消息', () => this.restoreTask(task));
        }.width('100%').enabled(!this.isBusy);
      }, (task: TaskView) => task.threadId);
      if ((!this.messages.length && !this.composer.length || !this.matchesTask(this.currentTitle)) &&
        !this.tasks.some((item: TaskView) => this.matchesTask(item.title))) {
        this.pageNotice(this.taskFilter.trim() ? '没有匹配的任务' : '暂无运行记录');
      }
    } else if (this.panel === '操作权限') {
      this.pageHeading('授权与审批', '操作权限');
      if (this.hasApproval) { this.buildApprovalCard(); }
      else { this.pageNotice('当前没有待审批操作'); }
    } else if (this.panel === '设置与排查') {
      this.pageHeading('设置与排查', '设置与诊断');
      this.pageNotice('运行时状态  ·  ' + this.connectionLabel() + '  ·  ' + this.statusText);
      this.actionRow('连接设置', this.demo ? '演示模式' : 'App Server', () => { this.settingsOpen = true; });
    } else {
      this.pageHeading('供后续任务参考', '技能与记忆');
      this.pageNotice('当前鸿蒙连接未提供技能与记忆数据');
    }
  }

  @Builder
  private settingsDialog() {
    Scroll() {
      Column({ space: 16 }) {
        Row() {
          Text('连接设置').fontSize(24).fontWeight(FontWeight.Bold).fontColor($r('app.color.wb_text')).layoutWeight(1);
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
      this.currentTitle = '新任务';
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
    Column({ space: 16 }) {
      Column() {
        this.connectionField('服务器地址', 'wss://your-codex-host/app-server', this.endpoint, (value: string) => {
          this.endpoint = value;
        });
        Divider().color($r('app.color.wb_soft_border'));
        this.connectionField('项目目录', '/workspace', this.projectRoot, (value: string) => {
          this.projectRoot = value;
        });
      }.width('100%').padding({ left: 16, right: 16 })
        .border({ width: 1, color: $r('app.color.wb_soft_border') }).borderRadius(16);
      Row({ space: 8 }) {
        Button('使用演示模式', { type: ButtonType.Normal }).fontSize(12).height(38).borderRadius(6)
          .padding({ left: 12, right: 12 }).fontColor($r('app.color.wb_text')).backgroundColor($r('app.color.wb_surface'))
          .border({ width: 1, color: $r('app.color.wb_border') }).enabled(!this.isBusy)
          .onClick(() => this.useDemoTransport());
        Button('连接 App Server', { type: ButtonType.Normal }).fontSize(12).height(38).borderRadius(6)
          .padding({ left: 12, right: 12 }).fontColor(Color.White).backgroundColor($r('app.color.wb_blue'))
          .enabled(!this.isBusy).onClick(() => this.connectAppServer());
      }.width('100%').justifyContent(FlexAlign.End);
      Text(this.statusText).fontSize(12).fontColor($r('app.color.wb_secondary'));
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
    const root: string = this.demo ? '/' : this.workspaceRoot;
    const path: string = this.workspacePath;
    if (path === root || !path.startsWith(root.endsWith('/') ? root : root + '/')) {
      return path;
    }
    const parent: string = path.substring(0, path.lastIndexOf('/'));
    return parent.length > root.length ? parent : root;
  }

  @Builder
  private buildWorkspacePanel() {
    Column({ space: 12 }) {
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
  private buildTranscript() {
    Scroll() {
      Column({ space: 12 }) {
        if (this.hasApproval) {
          Text('审批与授权状态').fontSize(16).fontWeight(FontWeight.Medium)
            .fontColor($r('app.color.wb_text'));
          this.buildApprovalCard();
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
        Text(this.approval.command).fontSize(12).fontFamily('monospace').fontColor($r('app.color.wb_text'))
          .copyOption(CopyOptions.LocalDevice).width('100%').padding(9)
          .backgroundColor($r('app.color.wb_surface')).borderRadius(6);
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
        TextArea({ placeholder: '描述你要完成的任务', text: this.composer })
          .id('task-input').width('100%').height(62)
          .padding({ left: 14, right: 14, top: 12, bottom: 4 })
          .fontSize(13).fontColor($r('app.color.wb_text')).placeholderColor($r('app.color.wb_muted'))
          .backgroundColor(Color.Transparent).borderRadius(8)
          .onChange((value: string) => { this.composer = value; });
        Row({ space: 8 }) {
          if (this.availableWidth > 760) {
            Text(this.workspaceRoot).layoutWeight(1).maxLines(1).textOverflow({ overflow: TextOverflow.Ellipsis })
              .fontSize(11).fontColor($r('app.color.wb_muted'));
          }
          Button({ type: ButtonType.Normal }) {
            Row({ space: 4 }) {
              this.icon('cpu', 14, $r('app.color.wb_secondary'));
              Text(this.demo ? '演示模式' : 'App Server').fontSize(12).fontColor($r('app.color.wb_text'));
            }
          }.height(28).padding({ left: 8, right: 8 })
            .backgroundColor($r('app.color.wb_surface'))
            .border({ width: 1, color: $r('app.color.wb_border'), radius: 14 })
            .accessibilityText('打开连接设置').onClick(() => { this.settingsOpen = true; });
          if (this.availableWidth <= 760) {
            Blank();
          }
          Button({ type: ButtonType.Normal }) {
            Row({ space: 6 }) {
              this.icon('send', 15, Color.White);
              Text(this.isBusy ? '处理中' : '发送').fontSize(12).fontWeight(FontWeight.Medium).fontColor(Color.White);
            }
          }.width(86).height(34).borderRadius(6).backgroundColor($r('app.color.wb_blue'))
            .accessibilityText('发送任务')
            .enabled(!this.isBusy && this.composer.trim().length > 0)
            .onClick(() => this.sendPrompt());
        }.width('100%').padding({ left: 13, right: 7, top: 5, bottom: 7 });
      }.width('100%').constraintSize({ maxWidth: 800 }).backgroundColor($r('app.color.wb_surface'))
        .border({ width: 1, color: $r('app.color.wb_border'), radius: 8 });
      if (this.availableWidth > 760) {
        Text('需要授权时，可在对话中批准或拒绝操作。')
          .width('100%').constraintSize({ maxWidth: 800 }).textAlign(TextAlign.End)
          .fontSize(10).fontColor($r('app.color.wb_muted'));
      }
    }.width('100%').padding({ left: this.availableWidth <= 760 ? 10 : 20,
      right: this.availableWidth <= 760 ? 10 : 20, top: this.availableWidth <= 760 ? 9 : 12,
      bottom: this.availableWidth <= 760 ? 8 : 10 })
      .backgroundColor($r('app.color.wb_canvas')).border({ width: { top: 1 }, color: $r('app.color.wb_border') });
  }

  private async sendPrompt(): Promise<void> {
    const prompt: string = this.composer.trim();
    if (prompt.length === 0 || this.isBusy) {
      return;
    }
    this.openPanel('任务对话');
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
    this.currentTitle = '新任务';
    this.taskFilter = '';
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
