# Linux 平台适配设计

版本：v1.0
状态：已实现
范围：路径、进程、环境、执行器、平台身份和发布策略

## 1. 目标

把 Linux 差异集中在应用层和平台适配层，让现有 Harness/Cordis runtime 继续使用同一套领域 Port、事件和安全语义。

Linux 适配层不拥有任务状态，不决定模型候选，不创建权限，不替代 Runtime Safety，也不维护第二份 Thread、Memory 或 Trajectory 数据。

## 2. 适配接口

下面是职责示意。实现 agent 可以使用 TypeScript、JavaScript 或 Rust wrapper，但接口语义必须保持一致。

```ts
interface PlatformPaths {
  configDir(): string;
  dataDir(): string;
  stateDir(): string;
  cacheDir(): string;
  logDir(): string;
  pluginDir(): string;
  modelConfigPath(): string;
  resolveStore(name: string): string;
}

interface ProcessSupervisor {
  spawn(spec: SpawnSpec): Promise<ManagedProcess>;
  cancel(processId: string, reason: string): Promise<CancelResult>;
  terminateGroup(processId: string, graceMs: number): Promise<void>;
  wait(processId: string): Promise<ProcessResult>;
}

interface EnvironmentPolicy {
  buildRuntimeEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  buildChildEnv(input: Record<string, string>): Record<string, string>;
}

interface PlatformIdentity {
  platform: 'linux-cli' | 'windows-desktop' | 'harmonyos';
  architecture: string;
  runtime: string;
  policyChannel: string;
}

interface LinuxExecutorPort {
  shell(request: ShellRequest, options: ExecuteOptions): Promise<ExecuteResult>;
  writeFile(request: WriteFileRequest, options: ExecuteOptions): Promise<WriteResult>;
  test(request: TestRequest, options: ExecuteOptions): Promise<TestResult>;
}
```

## 3. XDG 路径策略

### 3.1 默认值

```text
config: $XDG_CONFIG_HOME/hmcodex
data:   $XDG_DATA_HOME/hmcodex
state:  $XDG_STATE_HOME/hmcodex
cache:  $XDG_CACHE_HOME/hmcodex
```

当环境变量缺失时使用：

```text
config: $HOME/.config/hmcodex
data:   $HOME/.local/share/hmcodex
state:  $HOME/.local/state/hmcodex
cache:  $HOME/.cache/hmcodex
```

### 3.2 覆盖规则

优先级：

1. 命令行 `--config`、`--data-dir`、store 专用参数；
2. `HMCODEX_MODEL_CONFIG`、`HMCODEX_DATA_DIR` 和各 store 环境变量；
3. XDG 默认路径；
4. 内置默认值。

所有默认 store 必须经过同一个 `PlatformPaths` 实例解析。禁止在不同模块中分别拼接 `LOCALAPPDATA`、`APPDATA`、`XDG_CONFIG_HOME` 或当前工作目录。

### 3.3 目录和文件权限

- 目录创建使用 `0700`；
- 配置、token 引用、审计和本地数据库使用 `0600`；
- 日志不能因为权限失败而回退到工作区根目录；
- 只读健康检查可以报告权限问题，但不能自动 chmod 用户目录；
- 移动或迁移数据先复制、校验 digest，再原子替换索引；
- 失败时保留旧数据，不执行破坏性清理。

### 3.4 迁移

迁移命令必须输出：

```json
{
  "sourceRoot": "/old/path",
  "targetRoot": "/home/user/.local/share/hmcodex",
  "filesConsidered": 12,
  "filesCopied": 12,
  "digestVerified": true,
  "status": "COMPLETED"
}
```

旧路径存在且目标已有内容时，默认停止并要求显式选择合并或回滚策略。

## 4. 进程监督

### 4.1 创建

Linux runtime 和受控子进程应进入独立 process group。Supervisor 记录：

- pid、pgid；
- 启动时间；
- workspace；
- runId/operationId；
- command digest；
- 超时时间；
- 当前取消状态。

不使用 shell 字符串拼接。优先传递 `executable + argv + cwd + envDelta`。

### 4.2 取消顺序

```text
SIGINT / SIGTERM
  → runtime cancel request
  → 等待终态事件
  → SIGTERM process group
  → 等待 grace period
  → SIGKILL process group
  → 写入 cleanup outcome
```

无法确认子进程是否已经执行动作时，结果必须标记 unknown，禁止使用同一 PolicyLease 自动重试。

### 4.3 孤儿进程

Supervisor 启动时扫描本应用自己记录的活动 pid/pgid，不扫描并终止全系统进程。只有同时匹配应用标识、记录的 pid、run scope 和启动时间窗口时，才允许回收。

恢复流程继续由 runtime 的 `recovery` 命令负责，Supervisor 不自动重放任务。

## 5. 环境变量策略

### 5.1 Runtime 环境

允许传递：

- `PATH`、`HOME`、`USER`、`LANG`、`LC_*`；
- XDG 目录变量；
- `HMCODEX_*` 非秘密配置变量；
- 用户明确声明的 provider key 环境变量名，但不记录对应值。

默认不把以下内容写入事件或日志：

- API key、Bearer token、Authorization；
- SSH agent、云厂商凭据、密码管理器环境变量；
- 完整代理认证信息；
- 与 workspace 无关的秘密文件路径。

### 5.2 受控子进程

子进程只获得声明的环境 delta。不得把父进程完整 `process.env` 作为执行参数传入。环境 digest 可以进入 ActionIntent 和审计，原始值不得进入 Trajectory。

## 6. 路径和工作区

- 所有用户路径先转为绝对 canonical path；
- 拒绝 NUL、路径穿越、越过 workspace root 的 symlink 和不支持的 scheme；
- Linux 区分大小写，不能复用 Windows 的大小写折叠逻辑；
- `/proc`、`/sys`、`/dev`、用户凭据目录和系统目录默认拒绝；
- workspace snapshot、realpath 和文件标识必须在 Executor 权威侧再次校验；
- CLI 展示相对路径时使用 `/`，事件中的 canonical path 仍保留平台真实形式。

## 7. Linux Executor

### 7.1 只读阶段

L1 只读阶段只需要：

- workspace list；
- workspace read；
- metadata/stat；
- Git observation；
- 模型 provider 请求。

受控 shell、写文件、测试和网络能力保持关闭。

### 7.2 受控阶段

Linux Executor 必须复用以下安全输入：

- canonical workspace root；
- workspace snapshot digest；
- ActionIntent digest；
- PolicyLease id、scope 和过期时间；
- Approval id、display digest；
- command allowlist；
- network target allowlist；
- 输出字节数、超时和资源限制。

Executor 不接受模型直接给出的命令字符串作为授权凭证。模型只能提出结构化候选，最终参数由 Core、Safety 和 Executor 共同校验。

### 7.3 Shell 语义

默认使用 `shell: false`。需要 shell 时，动作类型必须显式标记 `SHELL_INTERPRETED`，并提高风险等级、展示完整命令、记录 shell path 和 argv digest。

禁止通过 shell 隐式启用：

- 后台进程；
- 命令替换；
- 重定向到未授权路径；
- 提权；
- 远程下载并执行；
- 递归删除；
- 修改系统服务或用户权限。

## 8. 平台身份与发布通道

平台身份和策略通道分开：

```text
platform: linux-cli
policy:   READ_ONLY | CONTROLLED
```

兼容旧 Windows channel 时使用映射层，不在业务逻辑中复制 `WINDOWS_*` 判断。新 Linux channel 不得改变 `READ_ONLY`、`CONTROLLED` 的安全含义。

建议的支持信息：

```json
{
  "platform": "linux-cli",
  "architecture": "x64",
  "node": "v24.x",
  "runtimeVersion": "0.1.0",
  "protocolVersion": "1.0",
  "policyChannel": "READ_ONLY",
  "executor": "linux-posix",
  "dataRoot": "/home/user/.local/share/hmcodex"
}
```

## 9. 与现有模块的衔接

当前需要重点检查的边界：

| 现状 | Linux 处理 |
| --- | --- |
| `runtime/src/index.mjs` 集中拼接多个 store 路径 | 统一委托 `PlatformPaths` |
| `model-config.mjs` 部分使用 XDG | 调整为平台适配结果 |
| `RestrictedWindowsExecutor` 名称和实现 | 抽出通用 ExecutorPort，保留兼容别名 |
| `windows-path.mjs` 调用 `net.exe` | Linux 不加载 Windows mapping 逻辑 |
| `release-channel.mjs` 只有 `WINDOWS_*` | 增加平台身份映射，保留旧值兼容 |
| `plugins/executor.mjs` manifest 为 `executor-windows` | manifest identity 平台化或增加 Linux manifest |
| `desktopBridge.ts` | Linux CLI 不依赖，直接消费 runtime command/event |

## 10. 失败关闭要求

出现以下任一情况时，Linux CLI 必须保持只读或停止：

- 无法解析 workspace canonical path；
- 无法确认 process group 归属；
- PolicyLease 不存在、过期或 digest 不一致；
- Approval 输入无法确认对应请求；
- 平台路径解析出现冲突；
- store 迁移或事件持久化失败；
- runtime 与 CLI protocol version 不兼容；
- 取消后无法确认副作用是否执行。

