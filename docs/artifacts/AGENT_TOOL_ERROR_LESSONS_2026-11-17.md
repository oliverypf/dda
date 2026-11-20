# Agent 工具错误经验（2026-11-17，full-local 构建恢复轮次）

## 背景

- 触发任务：用户要求“把过程中发生的错误总结成经验放到项目里，避免后面再重复犯相同的错误”。
- 上游上下文：原“编译 exe”任务（run-60158f32，计划 full-local-build-plan）在 `read-full-local-scripts` 步骤中断，恢复检查点记录 state=RECOVERING、blockers=`ACTION_FAILED` / `PATH_OUT_OF_SCOPE` / `JEV_BEHAVIOR_REJECTED`。
- 本轮恢复核验结论（2026-11-17T13:07Z）：`npm run build:windows:full-local` 从未执行。`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe` 仍为「第二十一次编译」产物（11,903,488 字节，文件时间 2026-11-17T07:49:36Z，PE X64 `WINDOWS_GUI`）；`desktop/dist/assets/` 仍为 `index-oh7Yskeg.js`（465,902 B）与 `index-Bjo6shPx.css`（72,556 B）；`desktop/BUILD-EXE-RECORD.md` 没有第二十一次之后的编译章节。
- 本文只记录本轮与恢复检查点中可核验的错误与教训，供后续 agent 避免重复。工具报错经验不放入 `offloop/experience/`（该目录 schema 只接受 `mvp-smoke-fixture` 来源样本），归档于 `docs/artifacts/` 符合本仓库惯例。

## 错误 → 教训

### 1. 路径必须与工作区快照精确一致（含大小写）

- 现象：`kernel.workspace_read docs/project_intro_video_script.md` 与 `workspace.read docs/PROJECT_INTRO_VIDEO_SCRIPT.md` 均返回 `WORKSPACE_NOT_FOUND`。
- 根因：`docs/` 目录实际列表中不存在该文件（大小写正确形式也不存在）；项目技能里记载的关键文件路径 `docs/PROJECT_INTRO_VIDEO_SCRIPT.md` 已与当前工作区不同步。另外，Windows 文件系统大小写不敏感，但工具的路径校验按快照精确匹配，大小写不同即失败。
- 避免方法：
  - 读文件前先 `workspace.list` 父目录确认文件存在，再按列表返回的精确路径（含大小写）访问；
  - 不要照搬项目技能、记忆或历史摘要里的路径，它们可能与当前工作区不一致。

### 2. 生成目录不在索引条目里，不等于磁盘上不存在

- 现象（2026-11-17）：工作区快照和父目录列表曾直接跳过 `node_modules`、`target`、`dist`。模型据此写成「`desktop/node_modules`、`desktop/src-tauri/target`、`desktop/dist` 全部不存在，必须先安装依赖」。这三处当时都在，且已有第二十一次编译的 `dda-desktop.exe`。
- 根因：快照为了不展开巨大目录，把目录名也藏掉了。模型把「没列出来」当成「缺失」。
- 当前契约：这些目录仍不展开内容，但只要存在就会出现在快照的 `omittedDirectories` 里，行文是 `exists; contents omitted`。`workspace.list` 父目录时，对应条目带 `contentsOmitted: true`。
- 避免方法：
  - `contents omitted` 是「目录在，子项未索引」，不是「目录不存在」，不要据此重装依赖或重跑构建；
  - 要看里面的某个文件，对那个相对路径再调用 `workspace.list` 或 `workspace.read`；
  - 同一 `WORKSPACE_NOT_FOUND` 失败一次后换路径或换方法，不要原样重试。

### 3. 一次性文件检查优先用简短的 shell 脚本

- 现象：在 `kernel.exec` 中运行多段文件系统脚本失败（`CELL_EXEC_ERROR`，无错误详情）；同一目的改为 `shell.execute` 的 `node -e '<简短脚本>'` 后成功（退出码 0，两轮新鲜度扫描均如此）。
- 避免方法：
  - 产物时间戳、目录扫描这类检查用简短、输出受限的 `node -e` 脚本执行，退出码与 stdout 可直接作为证据；
  - `kernel.exec` 失败时不要原样重试同一长脚本，先拆小或换 shell。

### 4. 大文件定位用唯一锚点，不要盲猜偏移

- 现象：对 62KB 的 `desktop/BUILD-EXE-RECORD.md` 用估算的 `offsetChars=56600` 读取返回空内容；该文件中英混排，`sizeBytes`（62159）远大于实际字符数（约 4.5 万）。
- 避免方法：
  - 读文件尾部或特定章节时用 `workspace.focus` 配唯一的字面量（本例用唯一 staged 目录名 `Icge8d`）；
  - `offsetChars` 按字符计，不能按字节数估算中文文档的偏移。

### 5. 中断任务恢复：先证据后行动，产物未过期不重放构建

- 现象：恢复检查点只说明 `read-full-local-scripts` 步骤 RUNNING、后续步骤 PENDING，无法从运行记录确认任何步骤已生效。
- 本轮做法：核实物证（exe 的 PE 头/大小/时间戳、dist chunk、构建记录章节、源码新鲜度）后确认 full-local 构建从未执行；同时发现源文件持续晚于 exe（13:07Z 扫描 22 个、13:37Z 复扫 24 个；13:07Z 扫描中最新为 `desktop/src/styles.css` 2026-11-17T12:54:55Z），说明源码仍在并行修改。
- 避免方法：
  - 恢复时先核产物 digest/时间戳/记录文档，再决定是否补做缺的步骤；
  - 源码仍在变化时，不要为“补跑中断的构建”而擅自重放编译——重编译决策留给下一次明确的构建请求（`BUILD-EXE-RECORD` 各次编译均由用户请求触发）。

### 6.（历史错误，已有处理约定）exe 被运行实例锁定 → os error 5

- 现象（`desktop/BUILD-EXE-RECORD.md` 第十二次编译）：链接阶段 `failed to remove file ...\release\dda-desktop.exe`（`拒绝访问。(os error 5)`），旧 exe 被运行中的实例锁定。
- 既有约定：编译前先做占用检查（进程 / 独占打开）；被锁定时按 `locked-before-*` 约定把旧二进制改名备份（不终止用户进程），再重跑构建。
- 避免方法：不要删除被锁定的文件或杀用户进程，走既有 `locked-before-*` 约定。
- 本轮关联观察（13:37Z）：裸 exe 独占 `r+` 打开失败、当前不可写，与该历史错误同类，印证编译前占用检查的必要性。

### 7. 安全租约过期（SAFETY_LEASE_EXPIRED）：当作「未发生」处理

- 现象：本轮首次 `file.write` 提交与并行批次中的一次 `shell.execute` 均返回 `SAFETY_LEASE_EXPIRED`——动作没有执行，只是审批等待期间租约过期。
- 避免方法：
  - 视同「未发生」，不是路径或代码错误；重试前先用只读检查确认目标确实未变（本轮先确认新文档未落盘，再重新写入成功）；
  - 所需证据已由其他调用取得时，不为补齐日志而重试失败的调用；
  - 需要审批的多个副作用尽量顺序提交，避免并行批次里一个获批使另一个租约过期。

### 8. 补丁过期（PATCH_STALE_DIGEST）：文件被并行修改，重读后重做小补丁

- 现象：对本文档的补丁被拒（`PATCH_STALE_DIGEST`）——首次写入成功后、补丁审批前，文件被改写（第 2 条内容变为 `omittedDirectories` / `contentsOmitted` 版本，与首次写入时不同）。
- 避免方法：
  - 过期不等于内容错误；按提示重读当前文件、用新 digest 重做小补丁；
  - 重做时保留其他写入者的改动，只改自己要改的部分；
  - 有并行进程改文件的工作区里，补丁要小、锚点要唯一，缩小冲突窗口。

## 2026-11-18 补记：JEV 要补证据，读取尚未执行

- 任务 `run-1988605a-7693-44af-8c4f-577e8cf8e02e` 的构建命令在 17:23 以退出码 0 完成。17:25 已成功读取 `desktop/src-tauri/src/main.rs`（事件 244），17:27 已检查新生成的 Debug exe（事件 286）。
- 17:28 在产物核验步骤中，Agent 先用 `kernel.workspace_read`（事件 290），又用 `workspace.read`（事件 295）请求同一个文件。两次都在读取前得到 `REQUEST_EVIDENCE`，检查点 355 记录了 `invocationAttempted: false`。当时的记录只有 `JEV_CHOICE`，无法追认究竟缺了哪条证据。
- 教训：先区分「工具未执行」和「执行后失败」。已经有适用的成功读取结果时，提供原结果和文件摘要。需要补证据时，先核对目标范围、当前步骤或前置结果，补上具体缺项后再考虑重试。换另一个读取工具并不会补齐证据。构建是否成功以实际退出码和产物核验为准。
- 新记录用 `ToolActionNotExecuted` 保存门禁决定、原因分类、目标、是否执行及下一步，与真实工具执行结果分开。若没有具体分类，记录为原因未说明，避免后续把猜测当经验。

## 关联

- 构建产物与各次编译状态：`desktop/BUILD-EXE-RECORD.md`（本轮恢复核验见其文末「恢复复核」一节）。
- 恢复核验时间：2026-11-17T13:07Z；13:37Z 复核产物仍未变化（exe 未重编译，独占 `r+` 打开失败、当前不可写）。
