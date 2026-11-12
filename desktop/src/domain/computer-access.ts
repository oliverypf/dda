// Global machine-user access mode. One persisted grant — not per project —
// covering any file location the current OS account can reach. Default OFF.

export type AccessMode = 'REQUIRE_APPROVAL' | 'FULL_ACCESS';

export interface AccessStatus {
  mode: AccessMode;
  scope: 'USER_FILESYSTEM';
  updatedAtMs?: number;
}

export interface AccessModeState {
  status?: AccessStatus;
  loading: boolean;
  saving: boolean;
  error?: string;
}

export const initialAccessModeState = (): AccessModeState => ({ loading: false, saving: false });

export const ACCESS_MODAL_TITLE = '确认允许完全访问？';
export const ACCESS_MODAL_INTRO = '开启完全访问后，任务将减少确认步骤，并可操作当前系统用户有权限访问的任意位置的文件。请谨慎操作。';
export const ACCESS_CAPABILITY_CARDS = [
  { icon: 'file', title: '文件操作', body: '读取、创建和修改此计算机上当前用户有权限访问的任意位置的文件。' },
  { icon: 'terminal', title: '终端命令', body: '运行已开放的命令、安装软件依赖并执行构建；不会自动获取管理员权限。' },
  { icon: 'globe', title: '访问互联网', body: '按已配置的网络权限访问网站、发送数据和使用连接器。' }
] as const;
export const ACCESS_MODAL_BOUNDARY = '删除工作区外文件、破坏性清理、提权及结果不确定的操作仍需人工确认或核对。系统权限、敏感文件和应用自身安全配置的保护不会关闭。完全访问不是系统沙箱，也不能识别项目脚本内部的所有危险行为。';
export const ACCESS_MODAL_CHECKBOX = '我已了解风险，并对自己的数据安全负责';
export const ACCESS_POPOVER_HEADING = '当前电脑的访问权限';
export const ACCESS_POPOVER_SCOPE = '当前系统用户可访问的文件位置，不限工作区目录';
export const ACCESS_PILL_ON = '允许完全访问';
export const ACCESS_PILL_OFF = '逐项确认';
export const ACCESS_COMPOSER_NOTE_ON = '允许完全访问 · 极高危操作仍需确认';
