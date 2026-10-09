# 让 dda 执行并独立验收

`supervise-dda-task.mjs` 启动真实 dda runtime。监督者提供需求、批准限定文件的写入、反馈失败和独立验收；功能代码由 dda 的工具写入。使用当前模型配置，Jev 保持开启并执行校验。

## 来自实际问题的机制

| 证据 | 机制 |
| --- | --- |
| 之前项目归档监督脚本写死目录和文件名 | 用任务 JSON 声明源目录、隔离目录、证据目录、复制范围和允许文件 |
| 本次开始时主工作区已有未提交改动，另一个聊天仍在工作 | 从当前文件复制；记录原始哈希；验收候选的哈希必须匹配；采用前所有目标文件必须仍与原始哈希相同 |
| runtime 的 task-runner 把需求静默截到 8000 字符；前次监督记录已发生长提示问题 | 启动前拒绝空提示和超过 8000 字符的提示，要求拆分任务，不截掉尾部需求 |
| 前次出现文件已改但运行验证超时 | 保存进程退出、runtime 最终结果和实际文件变化；它们不自动变成独立验收通过 |
| 旧监督脚本允许任意 Node 测试命令 | 默认仅授权白名单中已存在的文件写入，拒绝命令、越界和链接路径；测试由监督者独立执行 |
| 本次首轮四次补丁已写入后网络返回 `fetch failed`，编译发现残留旧函数引用 | `recover` 保留失败终态，核对隔离文件未被另改，将原目标、已改文件和真实编译反馈组成下一轮需求，不从零重复写入 |
| 本次隔离副本首轮编译缺少契约 JSON | 桌面任务复制范围加入 `contracts`；依赖缺失属于监督环境问题，与 dda 源码错误分别记录 |

## 任务声明

```json
{
  "sourceRoot": "C:/work/dda",
  "workspace": "C:/runs/archive-settings/workspace",
  "evidenceRoot": "C:/runs/archive-settings",
  "configPath": "C:/Users/your-user/AppData/Local/hmCodex/model-config.json",
  "copyPaths": ["contracts", "desktop/src", "desktop/scripts", "desktop/index.html", "desktop/package.json", "desktop/tsconfig.json", "desktop/vite.config.ts", "runtime/src/windows-path.mjs"],
  "allowedFiles": ["desktop/src/main.ts", "desktop/src/styles.css"],
  "maxToolRounds": 48,
  "timeoutMs": 900000
}
```

先创建证据目录。隔离工作区和每轮名称必须是新的；harness 拒绝覆盖已有运行。

```powershell
node desktop/scripts/supervise-dda-task.mjs prepare task.json
node desktop/scripts/supervise-dda-task.mjs run task.json attempt-1 prompt.txt
```

工具读写、审批、runtime 源码哈希、改动前后文件哈希、原始 stdout/stderr 和最终结果保存在每轮目录。配置文件只记录摘要和模型名称，不打印凭据。runtime 实际使用主工作区的源码，因此每轮还保存运行前后源码哈希以发现并发变动。

测试失败时，将复现步骤、真实输出和有限修改范围写入下轮 prompt，以新的 attempt 名继续同一隔离工作区。不要用监督者自己写的功能补丁替代 dda 的实现，也不要关闭 Jev 来改变原运行结果。

```powershell
node desktop/scripts/supervise-dda-task.mjs recover task.json attempt-1 feedback.txt prompt-2.txt
node desktop/scripts/supervise-dda-task.mjs run task.json attempt-2 prompt-2.txt
```

恢复命令只生成需求文件。它会拒绝已被别处改动的候选文件、空反馈、超长合并提示和已存在的输出文件。新的运行仍逐次经过相同的审批与 Jev 门禁。

## 验收与采用

在隔离目录编译并运行适合任务的独立检查。归档迁移使用 `ui-archive-settings-test.mjs`，并继续运行项目归档和设置回归。界面脚本允许通过 `HMCODEX_UI_DIST` 指向候选构建；使用模拟 native bridge，不访问用户的真实数据。

检查实际通过后才生成验收 JSON：

```json
{
  "status": "passed",
  "checks": [{ "name": "TypeScript and Vite build", "passed": true, "evidence": "build.log" }],
  "hashes": { "desktop/src/main.ts": "实际已验收文件的 SHA-256" }
}
```

```powershell
node desktop/scripts/supervise-dda-task.mjs adopt task.json acceptance.json
node --test desktop/scripts/supervise-dda-task.test.mjs
```

采用前会检查全部候选哈希和主工作区冲突，并保留原始文件副本。冲突会停止采用，需要基于新文件重新交给 dda 处理；不会自动覆盖其他工作。文件系统写入不是跨文件事务，备份用于发生 I/O 故障时人工恢复。验收报告由监督者生成，应保存真实检查输出，不能只写一条自述通过。
