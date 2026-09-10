# ADR-0006: 多平台单客户端与本地运行时

- Status: Accepted
- Date: 2026-08-31
- Deciders: hmCodex architecture
- Supersedes: none

## Context

当前仓库是 HarmonyOS ArkTS/HAP 工程，UI、网络和存储实现依赖 HarmonyOS。产品需要扩展到 Windows 和 Linux，同时保留 HarmonyOS 客户端，并接入 OpenViking 上下文能力。

目标产品不是“端侧控制云侧”，而是一个像 Codex 一样可以独立安装、独立启动和独立工作的客户端。每个平台只需要提供对应的 UI、系统集成和运行时适配；本地会话、工作区、审批、执行和上下文是同一个产品闭环。

## Decision

1. 保留 `entry/` 作为 HarmonyOS 客户端，并新增 Tauri 2 桌面客户端，首期支持 Windows/Linux。
2. 以版本化 `contracts/`、Harness Protocol、领域事件和 read model 作为跨平台事实源。
3. Windows/Linux 客户端随包启动或内置本地运行时；运行时负责 Codex/App Server 适配、受控工作区、Executor、审批、轨迹和模型连接。
4. OpenViking 通过本地运行时的 `ContextPort` 接入。首期采用受监管的本地 sidecar + loopback HTTP，数据写入当前用户的应用数据目录；不要求先部署 Gateway。
5. 任何平台的本地副作用都必须经过同一套 `ActionIntent`、Safety、PolicyLease、Approval 和 Verifier 语义；桌面平台不自动获得无限权限。
6. 远程 App Server、Gateway、Executor 和远程 OpenViking 只作为后续可选 Adapter，用于跨设备接续、企业策略或高算力场景，不进入本地核心依赖图。
7. 采用渐进迁移：先抽协议和本地只读能力，再接入本地 OpenViking，最后按平台验证写入、命令和后台能力。

## Consequences

- 用户安装客户端即可使用本地闭环；Windows/Linux 不依赖云侧 Gateway 才能启动。
- HarmonyOS 与桌面端可以分别使用 ArkUI/Tauri，同时共享会话语义、安全规则和 OpenViking 生命周期。
- 需要维护本地运行时监督、sidecar 打包、崩溃恢复和跨平台路径/凭据适配。
- Tauri 桌面端需要 Rust、Windows WebView2 和 Linux WebKitGTK 等构建依赖。
- 远程模式可以后加，但必须通过 Adapter 接入，不能把本地代码重新改造成云端控制面。

## Alternatives considered

- **云侧 Gateway + 轻客户端作为默认架构**：拒绝；这不符合独立客户端目标。Gateway 仅保留为可选远程/企业模式。
- **把 ArkTS 直接移植到 Windows/Linux**：拒绝，ArkUI 和 HarmonyOS Kit 不是目标桌面运行时。
- **每个平台独立实现完整 Agent 与 OpenViking 接入**：拒绝，会产生协议漂移、重复安全实现和不同的记忆语义。
- **Electron 作为首期桌面壳**：暂不采用；Tauri 已覆盖 Windows/Linux，且 Rust 后端适合承载受限系统能力和本地运行时监督。
- **让客户端直接连接 OpenViking `/mcp`**：暂不采用；MCP 适合作为工具面，Turn 级 recall/capture/commit 仍应由本地 `ContextPort` 统一编排。

## Verification

- Windows/Linux 在没有 Gateway 的情况下启动本地运行时并完成 Thread/Turn、只读工作区和本地 Trajectory 闭环；
- `contracts/` 为每个协议版本提供握手、Turn、审批、未知事件、断线和上下文降级 fixture；
- Windows/Linux/HarmonyOS 三端运行同一组状态机和事件映射测试；
- OpenViking sidecar 的启动、重启、数据目录、索引损坏和不可用降级有自动化测试；
- 远程 Adapter 关闭时，本地功能仍可用；本地能力未通过平台安全测试时保持只读。
