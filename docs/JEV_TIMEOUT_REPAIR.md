# 基线回归与 JEV 验证超时修复（2026-10-09）

## 问题归属

这两项问题不能归因于 dda 本次生成的项目归档补丁。

- **基线回归失败**：`thread-history-reader.test.mjs` 在归档修改前的 `7e0e5f4` 上也失败。恢复逻辑已将空计划归类为 `INVALID`，旧测试仍期待可恢复，且没有更新列表摘要的 `resumeMode` 断言。这次修正测试并补齐四种恢复状态的持久化覆盖，没有放宽运行时对无效计划的限制。
- **JEV 验证超时**：第 8 轮的两次实际验证在约 5,027 / 5,016 ms 失败，当时配置期限为 5,000 ms。客户端原先让快速决策和语义验证共用同一期限，默认 1,200 ms、最大 10,000 ms。这是已有的验证路径限制。历史请求为何没在期限内返回，现有记录不足以区分服务延迟、网络延迟或请求内容影响；不能断言延长时间就能使原任务通过。

## 已修复的机制

语义验证现在有独立的 `decision.verificationTimeoutMs`：默认 **15,000 ms**，允许 **100–60,000 ms**。配置文件优先于环境变量 `HMCODEX_JEV_VERIFICATION_TIMEOUT_MS`。未设置该字段时自动使用新默认值，不需要修改用户的模型配置。

快速决策继续使用原有 `decision.timeoutMs`。调用者取消明确记录为 `JEV_CANCELLED`，自身期限耗尽记录为 `JEV_TIMEOUT`；错误和语义验证事件保存实际耗时与所用期限。超时仍是 `UNCERTAIN`，真实否定仍是失败。既有的运输故障恢复只重试验证，复用同次实际执行证据，不因此重复写文件或执行测试命令。

## 验证结果与限制

| 检查 | 结果 |
| --- | --- |
| 历史读取、配置、决策、协议检查 | 34 项通过 |
| 新期限与真实子进程验证恢复检查 | 13 项通过；包含 200 ms 快速期限、650 ms 本地验证响应、独立 5,000 ms 验证期限，并确认执行器只运行一次 |
| 完整 runtime 回归，第一次 | 687 通过、1 失败、1 跳过；旧失败已消失，另一个计划恢复用例遇到 `WORKSPACE_SNAPSHOT_FAILED`，未进入它预期的执行阶段 |
| 计划恢复文件单独复跑 | 4 项通过；未修改该文件或工作区快照实现，首次偶发失败原因尚未确定 |
| 完整 runtime 回归，第二次 | **688 通过、0 失败、1 跳过** |
| 真实模型与 JEV | `mimo-v2.6-pro` 实际调用一次 `workspace.read`；JEV 启用且强制执行，语义验证 `PASS`，任务 `SUCCESS`，约 16.3 秒 |
| Windows 桌面编译 | TypeScript、Vite 和原生 debug 编译成功 |

真实成功任务是隔离目录中的标记读取，运行 ID 为 `run-f681527e-8201-4e5a-965f-d7a6fb66397b`。此前另一条含额外否定措辞的探测任务在路由阶段报 `ROUTE_BLOCKED:READ_ONLY_MODE`，尚未调用工具或语义验证；该失败也保留。本次成功只能证明当前真实调用链可用，不能替代原归档任务的验收，不能证明外部 JEV 服务永不超时。

当前端点的四次独立探测均收到 HTTP 200，耗时约 313–892 ms，回答包含 `PASS` 和 `UNCERTAIN`；探测不是原历史请求的精确重放。归档任务第 4、7、8 轮原有超时及未通过终态保持原样，长提示裁剪问题仍是独立待办。

## 复现与证据

```powershell
node --test runtime/test/thread-history-reader.test.mjs runtime/test/model-config.test.mjs runtime/test/decision-layer.test.mjs runtime/test/jev-official-contract.test.mjs
node --test runtime/test/jev-timeout.test.mjs runtime/test/verification-only-recovery-runtime.test.mjs
# 以下命令在 runtime 目录执行
node --test --test-concurrency=6
```

本机证据保存在 `.decision/jev-timeout-repair/`：`targeted.log`、两次 `full-runtime*.log`、`live-probe.json`、`live/`、`live-2/` 和 `native-build.log`。原归档记录仍在 `.decision/project-archive-supervision/`。

新程序为 `desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/dda-desktop.exe`。没有强制结束用户原有窗口；需重新启动 dda 才会载入本次编译结果。
