# DDA 内置任务 harness

2026-10-09：将归档设置迁移中形成的监督机制移入实际运行时。旧 `desktop/scripts/supervise-dda-task.mjs` 仅转发到内置模块，没有第二套实现。Tauri 的现有资源配置包含整个 `runtime/src`，这些模块会随桌面运行时分发。

## 日常任务实际接入点

| 机制 | 接入位置与行为 |
| --- | --- |
| 保留完整需求 | 桌面输入框保留粘贴全文；提交前、Rust 启动前、CLI 入口校验 1–8000 个 UTF-16 单元。超长明确拒绝，保留草稿。执行器和独立角色允许有界的内部组合提示，不再截掉原目标或步骤尾部。 |
| 控制重复实施 | 普通 runtime 与隔离监督默认只做一次实施和验证。`--max-recovery-attempts` / `HMCODEX_MAX_RECOVERY_ATTEMPTS` 可明确设为 1–8。每次尝试仍受原权限、租约、Jev 和预算控制。 |
| 验证服务故障 | 主机确认的 Jev 传输错误不会被当成实施错误重写代码。451 等永久错误保留 UNCERTAIN 并停止。符合既有条件的瞬时错误，仅在还有尝试预算时复用原执行结果重试验证；失败记录仍保留。 |
| 真实进度 | `task-harness.mjs` 统一统计心跳、工具结果、成功写入和写入后的读取。普通任务发出 `harness.progress`，桌面展示执行记录；最终摘要存入 `TaskHarnessProgress` 并可随会话历史恢复。心跳不增加工具或写入数。 |
| 定点补充源码 | 模型可调用 `workspace.focus({path,findText,maxChars})`。字面定位必须唯一，最多返回 6000 字符，带实际偏移和整个文件的 SHA-256。源码是数据；缺失或歧义直接报错。沿用授权工作区、敏感路径和运行时文件排除规则。 |
| 写入冲突 | `file.write` 可传 `expectedDigest`，新文件传 null。执行器自动附加已观察到的文件摘要，并在审批前、实际写入前检查。`file.patch` 保留原有审批后检查，并在底层写入复查。冲突提示重新读取并保留他人修改。 |
| 失败续做证据 | 实际成功的 file.write/file.patch 保存 `TaskFileWritten`（路径与摘要，不保存源码）。显式恢复 CONTROLLED 任务时，沿已验证检查点关系核对当前文件摘要，将成功动作放入续做上下文；有改动或文件缺失则报 `RECOVERY_WORKSPACE_CHANGED`。已有中断动作核对、权限和计划恢复规则仍适用。 |

`TaskFileWritten` 仅来自实际工具结果，失败或未执行的提案不能进入成功记录。恢复事实只证明历史动作；不替代验收，也不授予新的写入权限。语义门禁仍使用原有有界摘要，源码路径和写入摘要仅按需进入执行器的恢复上下文。

## 内置隔离监督入口

```powershell
node runtime/src/index.mjs supervise prepare task.json
node runtime/src/index.mjs supervise run task.json attempt-1 prompt.txt
node runtime/src/index.mjs supervise status task.json attempt-1
node runtime/src/index.mjs supervise recover task.json attempt-1 feedback.txt prompt-2.txt
node runtime/src/index.mjs supervise focus task.json focused-task.json prompt-3.txt
node runtime/src/index.mjs supervise adopt task.json acceptance.json
```

任务声明和验收 JSON 格式见 `desktop/scripts/SUPERVISE_DDA.md`。隔离监督使用当前安装的 runtime，不要求目标工程包含 DDA 源码。prepare 从声明的当前工作区复制并记录基线；run 仅审批允许清单中的既有文件写入；recover 核对前次候选未被改动并附真实反馈；adopt 在写入前检查所有候选验收摘要及目标基线，并保存备份。

普通任务自动使用上表保护。隔离复制、独立验收和采用通过显式 `supervise` 命令操作，目前没有新设置开关或桌面隔离任务表单。独立验收结果必须由实际检查提供；runtime 退出成功不等于独立验收通过。

## 边界

- 写入恢复摘要覆盖 DDA 文件工具，不宣称覆盖任意外部命令改动或旧版本未记录的历史写入。
- 文件摘要核对和替换不是操作系统级跨进程事务；它能发现已观察到的并发改动，不能承诺消除全部文件系统竞态。隔离采用也不是跨文件事务。
- 编译结果、行为测试与真实模型验收分别记录，不沿用归档迁移旧运行来冒充本次验证。

## 本次构建记录

记录目录：`.decision/harness-integration/`。最终完成情况以该目录构建输出和集成记录为准。

- 17 个 JavaScript 模块语法编译、TypeScript 和 Vite 构建通过。
- 原输出目录构建遇到运行中的 `dda-desktop.exe` 文件占用，原始错误保留在 `native-build.log`。
- 独立输出目录 Windows FULL_LOCAL debug 构建通过（退出码 0，7 分 14 秒）；产物位于 `.decision/harness-integration/target/x86_64-pc-windows-msvc/debug/dda-desktop.exe`。
- 产物与源码哈希记录于 `integration.json`。本轮未运行行为测试、真实模型验收，未重启当前运行中的旧程序。
