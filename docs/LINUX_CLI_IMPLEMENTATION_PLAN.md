# Linux CLI 实施计划

版本：v1.0
状态：L1、L2 基线已实现；L3 终端审批已接入 `dda` 入口并有 Linux 端到端测试，`CONTROLLED` 映射到 Phase 1.5 受控通道 `WINDOWS_PHASE1_5_CONTROLLED`（不再继承 Phase 2 的 `WINDOWS_FULL_LOCAL` 全本地发布门）；L4 只有从仓库运行的入口，安装包（tar.gz / npm 等）尚未交付
目标平台：Linux 无界面 CLI
适用实现：现有 Node/Cordis runtime、`contracts/v1`、Linux CLI 应用层和 Linux 平台适配层

## 1. 文档用途

本文档是 Linux CLI 实现 agent 的执行基线。实现 agent 应先阅读本文件、[Linux CLI 命令契约](LINUX_CLI_CONTRACT.md)、[Linux 平台适配设计](LINUX_PLATFORM_ADAPTER_DESIGN.md)、[协议规范](PROTOCOL_SPEC.md)和[安全模型](SECURITY_MODEL.md)，再开始编码。

本计划只增加 Linux 的应用层接口和平台适配。任务编排、安全判定、模型路由、Jev Decision Plane、Memory Journal、事件模型和持久化事实继续由现有 runtime 负责。

## 2. 产品结论

Linux 版本是终端程序，使用本地 runtime 完成任务运行、工作区读取、模型调用、事件持久化和恢复。

Linux 首期不包含：

- Tauri、Web UI、ArkUI 或桌面窗口；
- Linux 桌面托盘、通知中心和图形设置页面；
- Gateway、远程 App Server 或外部 context sidecar 作为启动依赖；
- 为 Linux 重新实现一套 Agent、Safety、Memory 或 Decision 逻辑。

Windows Tauri 和 HarmonyOS ArkUI 保持现有路线。三端共享协议、事件、状态和安全语义，展示层分别采用 Tauri、ArkUI 和终端输出。

## 3. 架构边界

```text
Linux terminal
    │ argv / stdin / signals / stdout / stderr
    ▼
Linux CLI Application Layer
    │ command mapping / rendering / approval UX / exit codes
    ▼
Linux Platform Adapter
    │ XDG paths / POSIX process groups / environment / filesystem metadata
    ▼
Existing Harness/Cordis Runtime
    │ task coordinator / model / Jev / safety / memory / stores
    ▼
contracts/v1 + local stores + provider adapters
```

### 3.1 核心冻结范围

以下行为在 Linux 项目中必须保持与现有 runtime 一致：

- `TaskRun`、`Thread`、`Turn` 和 `RoleContext` 状态迁移；
- `ActionIntent → RuntimeSafetyMonitor → PolicyLease → ExecutorPort` 副作用链；
- Approval 的展示摘要、digest 校验、过期和拒绝语义；
- Jev 的有限候选选择、保守降级和 Decision Trace；
- Memory Journal 的来源、冲突、验证和激活约束；
- `runtime-event`、`harness-event`、Trajectory 和 read model 的 schema；
- Provider 路由、工具输入校验、输出大小限制和敏感信息过滤；
- 崩溃恢复、取消、未知副作用和 fail-closed 规则。

### 3.2 允许调整的边界

实现可以做以下边界调整，但不能改变上述语义：

- 新增 `dda` CLI 启动器和命令别名；
- 把 argv、终端输入和 runtime JSONL 事件转换成 CLI 交互；
- 新增 Linux/XDG 路径解析；
- 新增 POSIX 进程组创建、取消和清理；
- 把 Windows-specific executor 名称和平台元数据抽到兼容适配层；
- 增加平台中立的 release channel 和 CLI package metadata；
- 增加 Linux 专用文档、契约测试、构建脚本和发布产物。

## 4. 交付阶段

### Phase L0：基线和接口冻结

目标：让实现 agent 在不修改核心语义的前提下有明确边界。

工作项：

1. 记录当前 runtime 支持的命令、参数、事件和错误；
2. 确认 `contracts/v1` 中 CLI 需要消费的 event envelope；
3. 确认 Windows 现有测试和未提交改动不被 Linux 分支覆盖；
4. 建立 Linux CLI 的包名、版本号和发布标识；
5. 将本计划和 CLI 契约加入文档索引。

完成条件：

- 实现 agent 能指出每个 CLI 命令对应的现有 runtime command；
- 未经 ADR 不得修改领域状态、权限链或 schema；
- Linux CLI 的输出和退出码契约已固定。

### Phase L1：Linux CLI 只读闭环

目标：Linux 无桌面环境可以执行健康检查、只读任务、线程查询和恢复扫描。

实现范围：

- `dda health`；
- `dda task --workspace PATH --prompt TEXT`；
- `dda thread list/get`；
- `dda recovery`；
- `dda support-info`；
- `--format human` 和 `--format jsonl`；
- stdout/stderr 分流；
- `SIGINT` 和 `SIGTERM` 传递；
- XDG 配置、数据、日志和状态目录。

只读阶段默认执行模式为 `READ_ONLY`。CLI 不应因为没有图形审批页面而自动放开 shell、写文件或网络能力。

完成条件：

- 没有 DISPLAY、Wayland 或桌面 session 时可运行；
- JSONL 模式输出可以被脚本逐行解析；
- Ctrl+C 后任务进入明确终态，且不会遗留 runtime 子进程；
- 未配置模型、工作区不存在、runtime 崩溃均有稳定错误码。

### Phase L2：平台边界抽取

目标：让 Linux 适配集中在 platform layer，避免 Linux 条件散落到任务核心。

实现范围：

- `PlatformPaths`：XDG 路径与显式覆盖；
- `ProcessSupervisor`：进程组、超时、取消和回收；
- `EnvironmentPolicy`：传给 runtime/子进程的环境变量 allowlist；
- `PlatformIdentity`：`linux-cli`、`windows-desktop`、`harmonyos`；
- `ReleasePolicy`：平台身份与 read-only/controlled channel 分离；
- `ExecutorPort` 的 Linux 实现和 Windows 兼容实现。

完成条件：

- `runtime/src/index.mjs` 不再需要通过 CLI 名称推断平台；
- Windows 现有 channel 仍可解析；
- Linux 不再依赖 `LOCALAPPDATA`、`APPDATA` 或 `net.exe`；
- 平台差异可以通过 adapter 注入或明确的边界模块表达。

### Phase L3：终端 Approval 和受控能力

目标：在 Linux CLI 中安全支持受控 shell、文件、测试和网络动作。

实现范围：

- TTY Approval 提示；
- `requestId`、`requestDigest`、风险、路径、命令、网络目标和过期时间展示；
- 用户输入转换为现有 `approval_response` JSONL；
- 非交互模式默认拒绝或暂停；
- `--approval-mode prompt|deny|jsonl`；
- Linux 进程组清理和资源限制；
- 现有 Lease、Verifier、审计和 outcome 复用。

完成条件：

- 任何受控动作都有 ActionIntent、Approval、Lease 和 Outcome；
- digest 不匹配时拒绝；
- 无 TTY 的流水线不会隐式批准动作；
- 取消、超时、断线和无法确认执行结果时保持 fail-closed。

### Phase L4：Linux 发布和运维

目标：交付可安装、可诊断、可升级的 CLI 产物。

首期建议：

- Node.js 24+；
- x86_64 Linux、glibc 环境；
- tar.gz 或 npm 安装方式；
- `dda` 可执行入口；
- 版本、runtime、provider 和 platform 信息可通过 `support-info` 查询。

后续再评估 deb、AppImage、ARM64、musl 和 Node SEA。发布形式不能先于行为契约稳定化。

## 5. 工作包清单

| 编号 | 工作包 | 主要内容 | 依赖 | 交付物 |
| --- | --- | --- | --- | --- |
| L-CLI-01 | 命令路由 | argv 解析、子命令、帮助和别名 | L0 | `dda` CLI 入口 |
| L-CLI-02 | runtime bridge | 启动 runtime、传参数、读取 JSONL、转发 stdin | L-CLI-01 | 可重用 bridge |
| L-CLI-03 | 终端渲染 | phase、heartbeat、审批、结果和错误展示 | L-CLI-02 | human formatter |
| L-CLI-04 | 机器输出 | JSONL 原样 envelope、最终结果、stdout 约束 | L-CLI-02 | jsonl formatter |
| L-CLI-05 | 路径适配 | XDG、显式路径、目录创建和权限 | L-CLI-01 | `PlatformPaths` |
| L-CLI-06 | 信号与进程 | SIGINT、SIGTERM、超时、进程组清理 | L-CLI-02 | `ProcessSupervisor` |
| L-CLI-07 | Linux executor | POSIX 命令执行、文件写入和取消 | L-CLI-06 | `ExecutorPort` adapter |
| L-CLI-08 | Approval | TTY 和非交互审批策略 | L-CLI-03、L-CLI-07 | approval adapter |
| L-CLI-09 | 契约测试 | command、event、path、signal、approval 回放 | L-CLI-01～08 | Linux CLI test suite |
| L-CLI-10 | 发布 | tarball/npm、版本、校验、安装说明 | L-CLI-09 | Linux artifact |

## 6. 推荐代码边界

具体目录名可以由实现 agent 决定，但职责应保持如下关系：

```text
linux-cli/
  bin/hmcodex
  src/cli-command-router
  src/cli-runtime-bridge
  src/cli-human-renderer
  src/cli-jsonl-renderer
  src/cli-approval
  src/linux-platform

runtime/src/platform/
  paths
  process-supervisor
  environment-policy
  platform-identity
  executor
```

CLI 可以调用现有 `runtime/src/index.mjs`，但不要从 `desktop/src/main.ts` 或 `desktop/src/services/desktopBridge.ts` 复用 UI state。CLI 的事实源是 runtime command result 和 `runtime-event`。

## 7. 兼容策略

### 7.1 Windows

- 保留现有 Tauri bridge 和 Windows runtime 启动路径；
- 保留旧命令和旧环境变量；
- Windows 的 channel 名称可以继续存在，通过兼容映射连接到新的平台中立策略；
- Linux 的路径和信号实现不能通过修改 Windows 路径测试来实现。

### 7.2 HarmonyOS

- 保留现有 ArkUI 页面和迁移期服务；
- 不要求 Linux CLI 直接复用 ArkTS UI；
- 通过 `contracts/v1` 和行为 fixture 保持事件语义一致。

### 7.3 旧数据

- 继续使用现有 harness event、thread、memory、trajectory 和 migration guard；
- Linux 首次启动不得静默覆盖已有数据；
- 数据目录迁移必须输出明确计划、旧路径、目标路径和迁移结果；
- 迁移失败时保持只读或停止，不删除旧数据。

## 8. 验收矩阵

| 类别 | 必须验证的场景 | 通过标准 |
| --- | --- | --- |
| 启动 | 无配置、有效配置、错误配置 | 退出码稳定，错误不泄露 key |
| 只读任务 | workspace snapshot、模型流、完成、失败 | 状态和事件符合既有契约 |
| 输出 | human、jsonl、日志、stdout/stderr | JSONL 无混入日志，顺序稳定 |
| 线程 | list、get、resume、workspace mismatch | 复用现有 thread 语义 |
| 恢复 | orphan approval、lease、role context、dream | 不自动重放任务或副作用 |
| 取消 | Ctrl+C、SIGTERM、超时 | 任务终态明确，无孤儿进程 |
| 安全 | 越权路径、敏感文件、未授权命令、网络 | fail-closed，生成审计事实 |
| 审批 | digest 一致、不一致、过期、拒绝、无 TTY | 没有隐式批准 |
| 数据 | XDG、显式路径、权限、磁盘不足 | 使用正确目录并给出明确错误 |
| 兼容 | Windows 回归、旧 fixture、未知事件 | 既有行为不退化 |
| 发布 | 新机安装、升级、卸载、版本查询 | 可重复安装和诊断 |

## 9. 实现 agent 交接清单

开始编码前：

1. 阅读本文和三个配套文档；
2. 记录当前工作区未提交修改，不覆盖其他 agent 的工作；
3. 先实现 L1 只读 CLI，再实现 L2 平台边界；
4. 每个工作包单独提交，提交信息带 `LINUX-CLI` 前缀；
5. 不把 Linux GUI、Tauri 或桌面依赖加入 Linux CLI；
6. 每个新接口先补文档和契约测试，再接入 runtime；
7. 受控能力必须等 Approval、Lease、进程清理和审计验收后再开启；
8. 最终提交实现、测试结果、安装说明和未完成项清单。

## 10. 风险和处理顺序

1. **平台名散落在 runtime**：先建立平台身份和 release policy，再移除硬编码引用。
2. **Linux 进程树无法清理**：先完成进程组模型，再开放受控命令。
3. **非交互运行时误批准**：默认拒绝，没有 TTY 时禁止自动批准。
4. **XDG 路径与旧 Windows 路径混用**：集中由 `PlatformPaths` 解析，所有 store 使用同一结果。
5. **CLI 自己复制核心逻辑**：CLI 只做命令转换、显示和生命周期管理，禁止复制 task 状态机。
6. **发布包过早固化**：先完成行为和契约验收，再决定 deb、AppImage 或单文件方案。

