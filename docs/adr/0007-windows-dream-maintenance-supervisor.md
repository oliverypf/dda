# ADR-0007: Windows 由 Tauri 托管 Dream 维护进程

- Status: Accepted
- Date: 2026-09-04
- Deciders: hmCodex architecture
- Supersedes: none

## Context

Dreaming 需要在桌面端可见、可停止、可恢复地运行，但 Windows 客户端不应把
“自动维护”变成无边界的常驻 Agent。仅提供 runtime CLI 会让用户无法从桌面确认
当前状态，也无法保证应用退出时清理进程树。另一方面，把 Dream 逻辑复制到 Rust
会造成状态机和门控语义漂移。

## Decision

1. DreamScheduler 和 DreamMaintenanceSupervisor 继续只在 Node runtime 中实现；Tauri
   只负责启停、状态投影、进程树清理和 UI 事件转发。
2. Tauri 启动一个独立的 `dream --operation daemon` 子进程，stdout 只输出脱敏的
   `dream_maintenance` JSONL 状态事件；不转发轨迹、提示词、模型输出或凭据。
3. Tauri 每 250ms 将当前受控 runtime 活动数写入临时状态文件。Dream daemon 在每一轮
   读取该文件；文件缺失、不可读或越界时按 `activeRuns=1` fail-closed。
4. Dream daemon 仍只能生成 `PROPOSED` memory，不能自动激活记忆、修改安全策略或
   晋级 Evolution proposal。应用退出时必须终止 Dream 进程树。
5. 该能力默认关闭，由用户在治理面板显式启动；状态包含 PID、轮次、失败计数和错误码。

## Consequences

- Windows 用户可以在治理面板看到 Dream 后台维护是否运行，并显式停止它。
- 任务运行期间，下一轮 Dream 会因活动计数而保持阻断；不会依赖启动时一次性的
  `activeRuns=0` 假设。
- 需要维护 Windows `taskkill /T /F` 清理、临时状态文件和 daemon stdout 消费线程。
- 这是进程级托管而非完整常驻 runtime supervisor；跨重启恢复仍依赖持久化 Dream 状态
  与启动恢复扫描。

## Alternatives considered

- **在 Tauri Rust 中重写 Dream 生命周期**：拒绝，会复制 Node 状态机并产生语义漂移。
- **桌面端静态传入 `activeRuns=0`**：拒绝，任务开始后无法反映真实繁忙状态。
- **无 UI 的后台自启动服务**：拒绝，默认后台执行不符合用户可见和显式启用要求。

## Verification

- runtime Dream supervisor 单测覆盖边界、取消和连续失败 fail-closed；
- runtime 全量测试通过，daemon 实跑会输出脱敏 JSONL 事件；
- Windows Rust target 单测、check、fmt 和安装包构建通过；
- UI 通过状态事件显示启停状态，退出路径调用进程树清理。
