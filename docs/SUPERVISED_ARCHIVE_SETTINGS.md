# dda 归档界面迁入设置：监督记录（2026-10-09）

## 交付与归属

用户要求由 dda 实现，而不是由监督者代写功能。真实 dda runtime 使用当前配置的 `mimo-v2.6-pro`，保持 Jev 开启并执行校验；功能修改全部来自其受控 `file.patch`。

归档入口已移至“设置 → 已归档”。主侧栏保留归档操作后的撤销提示；设置内分别显示归档项目、归档会话、数量、空状态与恢复按钮。查看会话会退出设置并显示历史，不自动恢复。模型配置读取失败或等待时仍可管理本机归档；设置草稿、持久化、跨窗口更新及运行中保护保留。

独立验收还复现并由 dda 修复了两个提示问题：恢复失败的提示被设置页遮挡，以及已归档项目禁止新任务时提示未在可见区域显示。后一问题在原基线上也复现，未归因于本次迁移。

最终仅采用 dda 对 `desktop/src/main.ts` 的修改；`styles.css` 无需改动。采用前检查了主工作区的原始哈希和已验收候选哈希，保留采用前副本。最终 main.ts SHA-256：

`00888c7322497c9ef8655033e60a53692ba3a8ea6e5ca32b4fb98c61574474a2`

## 真实运行结果

| 轮次 | 约耗时 | 实际结果 |
| --- | --- | --- |
| 1 | 427 秒 | 保存部分界面迁移后 `fetch failed`，退出 1；源码保留，编译发现旧函数引用未迁完 |
| 2 | 666 秒 | 补全迁移，TypeScript 通过；模型连接 `terminated`，退出 1；独立交互验收继续检查已写入代码 |
| 3 | 239 秒 | 修复两处提示，独立验收全部通过；Jev 验证返回 `JEV_HTTP_451`，内部恢复后最终仍为 `PLAN_STEP_FAILED:execute:UNCERTAIN`，退出 1 |

这三轮都不是 runtime 自报成功。监督者没有关闭 Jev、替换失败状态或伪造验证证据；独立验收结果与 runtime 原终态分别保存。第三轮较早开始写入只是本次观察，不能据此声称整体效率或成功率提升。

## 固化为 harness 的处理

可复用入口：[监督 harness 使用说明](../desktop/scripts/SUPERVISE_DDA.md)。实现为 `desktop/scripts/supervise-dda-task.mjs`，检查为同目录的 `supervise-dda-task.test.mjs`。

- `prepare`：复制当前工作区文件，保留未提交内容，记录原始哈希；拒绝覆盖已有运行。
- `run`：真实 runtime、限定文件审批、隔离数据存储、保存每轮源码哈希和原始结果。默认一次实施和验证，失败由监督者分析后再续做。
- `status`：区分心跳、读取、成功写入、工具失败、验证服务错误和最终终态。
- `recover`：核对候选文件未被另改，将原目标、已保存改动、真实失败及监督反馈组成后续任务。
- `focus`：从当前文件提取唯一匹配的源码片段、字符位置和 SHA-256，供剩余缺陷的定点任务使用。
- `adopt`：检查独立验收报告、候选哈希及主工作区冲突，保留原文件后采用。

超出 runtime 8000 字符上限的需求会被拒绝，避免静默丢失尾部要求。隔离桌面任务的复制模板加入 `contracts`，修正本次第一次编译时缺失契约 JSON 的监督环境问题。

Jev 服务返回 451 后反复收集源码不会修复该服务错误，因此监督入口将默认尝试次数从 2 调为 1，并单列服务错误。原三个运行仍使用 2；新默认值只做了本地参数和解析检查，未补造真实模型效果证据。运行时通用恢复代码本次未修改。

## 验收与构建

候选及采用后的主工作区均已通过：

- TypeScript 和 Vite 构建。
- 归档设置：33 项，涵盖搜索、项目/会话恢复、历史查看、草稿、模型配置失败/等待、存储失败反馈、跨窗口刷新、45 项长列表和 780px 视口。
- 原项目归档回归：19 项，涵盖持久化、项目顺序、单独归档的会话、存储错误、运行中保护及禁止归档项目新任务。
- 完整设置回归：键盘焦点、关闭恢复、分类草稿、搜索、自定义指令、保存失败、窄屏和深色模式。
- 监督 harness：12 项本地检查。

第一次新测试误等待旧的 `get_thread`，对照实际历史加载流程后改为检查 `list_thread_events` 和历史界面。反馈提示加入后，测试定位细化到归档行，避免与“撤销归档”按钮混淆。一次键盘焦点失败未在后续候选及主工作区复验中再现；原失败日志保留。

界面检查使用真实编译的前端、隔离浏览器及模拟 native bridge，不访问用户真实归档数据，也不等同于完整原生端到端测试。

Windows 程序已通过 `node desktop/scripts/build-full-local.mjs --fast` 编译：

`desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/dda-desktop.exe`

复验命令（从仓库根目录）：

```powershell
node --test desktop/scripts/supervise-dda-task.test.mjs
node desktop/scripts/build.mjs
node desktop/scripts/ui-archive-settings-test.mjs
node desktop/scripts/ui-project-archive-test.mjs
node desktop/scripts/ui-settings-test.mjs
```

本机完整证据位于 `.decision/archive-settings-supervision/`，包括三轮提示、运行输出、SQLite、哈希、原始失败、`validation-4` 候选验收、`validation-merged` 主工作区验收、`adoption.json` 和 `native-build.log`。本地证据不补写为成功运行。
