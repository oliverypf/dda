# ADR-0004: HarmonyOS 本地运行时能力门控

- Status: Accepted
- Date: 2026-08-29
- Deciders: dda architecture
- Supersedes: none

## Context

HarmonyOS PC 应用可以实现原生 UI、网络、存储和凭据管理，但普通消费者应用是否能稳定、安全地运行任意开发命令、限制子进程和长期后台执行，需要按目标 API、设备和分发政策验证。直接假设本地 shell 会把平台不确定性带入核心。

## Decision

HarmonyOS 端属于独立客户端产品。其本地 Executor 仅在 runtime capability、平台 POC、安全契约和发布政策全部通过后启用；在能力未验证前，客户端可以先实现本地 WorkspacePort、只读运行时或明确标注的远程兼容 Adapter。该门控只约束 HarmonyOS 的平台能力，不改变 Windows/Linux 本地运行时优先的产品定位。

## Consequences

- 可以先交付可靠 GUI 和 Harness，不被 HarmonyOS 本地进程能力阻塞。
- 若启用远程兼容模式，需要额外设计身份、TLS、数据位置和断线恢复。
- 消费者版不依赖企业 ACL 后台扩展。
- 未来本地 Executor 可作为 Adapter 加入，无需改 Core。

## Alternatives considered

- 先实现本地 shell 再补沙箱：拒绝，违反安全随可写能力同时落地。
- 只做远端 Web UI：拒绝，无法发挥 HarmonyOS 原生 UI、凭据、文件授权和系统体验。

## Verification

按 `HARMONYOS_PLATFORM.md` 完成真实设备 POC；本地 Executor 必须通过与远端 Executor 相同的 Port、lease、路径、命令、资源和恢复测试。
