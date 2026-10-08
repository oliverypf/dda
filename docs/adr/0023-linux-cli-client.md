# ADR-0023: Linux 采用无界面 CLI 客户端

- Status: Accepted
- Date: 2026-09-29
- Deciders: dda architecture
- Related: [ADR-0006](0006-multi-platform-clients.md), [Linux CLI 实施计划](../LINUX_CLI_IMPLEMENTATION_PLAN.md)

## Context

dda 当前包含 HarmonyOS ArkUI 客户端、Windows Tauri 客户端和 Node/Cordis 本地 runtime。现有多平台基线曾将 Linux 描述为 Tauri 桌面客户端，但产品目标已经明确：Linux 端首期只提供无界面 CLI，供服务器、开发机、CI 和远程终端使用。

现有 runtime 已具备独立命令入口、JSONL runtime event、health、task、thread、recovery、tools 和诊断命令。Linux 如果重新实现一套 Agent 或桌面壳，会重复任务编排、安全、审批、Memory 和事件逻辑，造成跨平台语义漂移。

## Decision

1. Linux 首期采用 `linux-cli` 应用形态，不引入 Tauri、Web UI 或 ArkUI。
2. Linux CLI 复用现有 Node/Cordis runtime 和 `contracts/v1`，通过应用层 bridge 调用 runtime command。
3. CLI 负责 argv、终端输出、JSONL、stdin Approval、退出码和进程生命周期。
4. Linux 平台适配负责 XDG 路径、POSIX process group、环境变量策略、路径 canonicalization 和 Linux Executor。
5. `TaskRun`、Safety、Approval、PolicyLease、Jev、Memory、事件和持久化语义保持不变。
6. 平台身份与策略 channel 分离；Windows 旧 channel 继续兼容，Linux 使用 `linux-cli` identity。
7. Linux 先交付 `READ_ONLY`，受控 shell/file/test/network 能力必须在 Linux Executor、Approval 和进程清理验收后开启。
8. Gateway、App Server 和外部 context sidecar 都是可选适配，不属于 Linux CLI 启动依赖。

## Architecture

```text
Linux terminal
  → CLI Application Layer
  → Linux Platform Adapter
  → Existing Harness/Cordis Runtime
  → contracts/v1 and local stores
```

## Alternatives considered

### Linux Tauri desktop client

拒绝。Linux 首期没有图形界面需求，Tauri 会引入 WebView、窗口生命周期、桌面权限和额外打包链路，不能改善 CLI 目标。

### Rust CLI 重写核心

拒绝。Rust 只适合在进程监督或发布包装层出现。重写任务核心会复制状态机和安全逻辑，增加协议漂移风险。

### 直接复制 Windows CLI

拒绝。当前 runtime 包名、发布通道、数据目录、executor 名称和部分进程清理逻辑仍带 Windows 假设，需要通过平台适配层解决。

### Linux 独立 Agent runtime

拒绝。会产生不同的审批、Lease、Memory、Jev 和事件语义，破坏同一产品的可回放性。

## Consequences

### 正面结果

- Linux 可以在无桌面环境运行；
- 复用现有 runtime 和安全链；
- CLI、Windows UI 和 HarmonyOS UI 可以消费同一事件与状态语义；
- 首期实现面小，适合先交付只读闭环；
- 脚本、CI 和远程终端可以使用稳定 JSONL 接口。

### 工程代价

- 需要集中处理 XDG 路径；
- 需要 Linux process group 和信号清理；
- 需要把 Windows-specific executor 和 release channel 从核心入口抽到兼容适配层；
- 需要定义人类模式、机器模式和非交互 Approval 行为；
- 需要独立 Linux 发布、安装和诊断流程。

## Security constraints

- CLI 默认 `READ_ONLY`；
- 没有 TTY 时不能自动批准受控动作；
- stdout 的 JSONL 不得混入日志；
- API key 只从用户指定环境变量读取；
- CLI 不执行模型文本中的命令；
- 所有副作用继续经过 Runtime Safety、ActionIntent、PolicyLease、Approval、Rule Verifier 和 Executor；
- 取消后无法确认动作状态时，必须标记 unknown，禁止复用 Lease 重试。

## Verification

实现完成后至少验证：

1. 无 DISPLAY/Wayland 环境下执行 `health`；
2. 只读 `task` 的 JSONL 事件和最终结果可以逐行解析；
3. XDG 和显式 `HMCODEX_DATA_DIR` 路径一致；
4. Ctrl+C、SIGTERM、超时不会留下 runtime 子进程；
5. Approval digest 不一致、过期、拒绝和无 TTY 场景均 fail-closed；
6. Windows 现有 Tauri/runtime 回归不受 Linux 适配影响；
7. 同一 contracts fixture 在 Linux CLI 和 Windows runtime 得到一致状态语义；
8. `support-info` 能报告 CLI、runtime、protocol、platform 和 policy channel。

