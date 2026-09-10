# Windows Phase 1 手工验收清单

状态：MSI/NSIS 安装、升级、卸载 2.1–2.4 已 PASS（2026-09-09，证据见 2.5）；UI 场景 3.1–3.9 已 PASS（证据见 3.10）。

## 1. 前置条件

- 使用第十次构建产物（2026-09-09 14:01，最终 Phase 1 候选：常驻取消按钮、stdout EPIPE 守卫、release-check/metrics 语义修正、NSIS perMachine 安装目录分离、独立 cancel 和 >100k 事件分页）：
  - `C:\work\hmCodex\desktop\src-tauri\target\x86_64-pc-windows-msvc\release\hmcodex-desktop.exe` SHA-256 `91C5CEA8CAD6D945B84313562AB1EB462D165034C114B9660ACAC9D9CD3C00A4`
  - `...\bundle\msi\hmCodex_0.1.0_x64_en-US.msi` SHA-256 `AA0B9EEBE611829C06F702094B48938A2497528D24D978FE9073A07FC4A04FAB`
  - `...\bundle\nsis\hmCodex_0.1.0_x64-setup.exe` SHA-256 `7AB3630F212335167792258C3D947A220CB0FD6150B9649538D60E847B34C2D9`
- 安装、升级、卸载会修改本机系统，已获得用户明确授权后执行。
- 桌面 UI 场景需要人工观察；每一步记录时间、截图或命令输出。

## 2. MSI 安装 / 升级 / 卸载

### 2.1 首次安装

1. 记录安装前状态：`Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object DisplayName -like '*hmCodex*'`。
2. 双击 MSI 或执行 `msiexec /i "hmCodex_0.1.0_x64_en-US.msi" /qb`。
3. 期望：安装成功；开始菜单/桌面快捷方式存在；`hmcodex-desktop.exe` 可从安装目录启动。
4. 启动后执行 `health`（或查看 UI 的关于/状态区），期望 `releaseChannel=WINDOWS_PHASE1_READ_ONLY`，不出现 `WINDOWS_MVP_PRE_PHASE1`。
5. 记录：安装路径、快捷方式、首次启动结果、渠道字符串。

### 2.2 升级

1. 在已安装 0.1.0 的基础上再次安装同一 MSI（或更高版本 MSI）。
2. 期望：升级成功，无重复卸载项；用户数据目录（`%LOCALAPPDATA%\hmCodex` 或 `HMCODEX_DATA_DIR`）保留。
3. 期望：升级后首个任务能读取升级前线程/事件；`dashboard` 仍返回 `ok:true`。
4. 记录：升级前后版本、数据目录文件数量、线程可见性。

### 2.3 卸载

1. 通过“应用和功能”或 `msiexec /x "hmCodex_0.1.0_x64_en-US.msi" /qb` 卸载。
2. 期望：程序文件、快捷方式、开始菜单项移除；进程已退出。
3. 期望：用户数据按产品策略保留还是删除必须在卸载确认中可见；如保留，重新安装后线程仍可见；如删除，重新安装后为干净状态。
4. 记录：卸载后残留路径、进程、卸载项。

### 2.4 NSIS 安装 / 升级 / 卸载

1. 对 `hmCodex_0.1.0_x64-setup.exe` 重复 2.1–2.3。
2. 额外检查：安装向导默认路径、是否可选安装目录、静默安装参数、卸载项显示名称。
3. 记录：每一步结果与 MSI 是否一致；差异单独列出。

### 2.5 安装/升级/卸载验收结果（2026-09-09）

| 安装包 | 场景 | 结果 | 证据 |
| --- | --- | --- | --- |
| MSI（perMachine） | 首次安装 | PASS | 提权 `msiexec /i ... /qn /norestart` exit=0；卸载项 `hmCodex 0.1.0` 在 HKLM，安装目录 `C:\Program Files\hmCodex\`，含 `hmcodex-desktop.exe`、`hmcodex_desktop_lib.dll`、`runtime\` 资源；开始菜单 `ProgramData\...\hmCodex\hmCodex.lnk` + 公共桌面 `hmCodex.lnk`；安装后可启动 |
| MSI | 升级 | PASS | 再次提权安装 exit=0；卸载项仍为 1 个；`%LOCALAPPDATA%\hmCodex` 文件数 32、`hmcodex.db`/`threads.json` 哈希完全不变 |
| MSI | 卸载 | PASS | 提权 `msiexec /x {D2027F7A-BD09-43C7-BB32-0E26A9433287} /qn` exit=0；`C:\Program Files\hmCodex` 已移除、快捷方式移除、卸载项 0；用户数据目录保留 32 文件、`hmcodex.db` 哈希不变；无残留进程 |
| NSIS（perMachine） | 首次安装 | PASS | 提权 `hmCodex_0.1.0_x64-setup.exe /S` exit=0；卸载项在 HKLM，安装目录 `C:\Program Files\hmCodex`，含 `uninstall.exe` 和 `runtime\` 资源；开始菜单 + 公共桌面快捷方式；安装后可启动 |
| NSIS | 升级 | PASS | 再次提权安装 exit=0；卸载项仍为 1 个；用户数据目录哈希完全不变 |
| NSIS | 卸载 | PASS | 提权 `C:\Program Files\hmCodex\uninstall.exe /S` exit=0；安装目录移除、快捷方式移除、卸载项 0；用户数据目录保留 32 文件、`hmcodex.db` 哈希不变；无残留进程 |

安装期发现并修复：NSIS 默认 `currentUser` 会把程序文件安装到 `%LOCALAPPDATA%\hmCodex`，与 runtime 数据目录相同。第十次构建将 `bundle.windows.nsis.installMode` 改为 `perMachine`，安装目录改为 `C:\Program Files\hmCodex`，与 MSI 一致；安装/升级/卸载已在第十次构建产物上重新验证通过。两种安装包卸载后都保留用户数据，重新安装后原有线程/事件仍可见（`threads.json` 哈希全程不变）。

补充证据：未提权的 MSI 安装返回 `1603`，日志为 `Error 1925: You do not have sufficient privileges...`，确认 perMachine 安装必须提权；提权后同一 MSI 安装 exit=0。

## 3. 桌面 UI 手工场景

每个场景记录：开始时间、结束时间、操作步骤、截图、`dashboard`/`metrics`/`release-check` 输出、最终 run 状态和错误码。

自动化执行（推荐优先）：`cd desktop && npm run test:ui`（只读交互 11 项）或 `npm run test:ui:task`（含真实任务取消/终态，13 项）。脚本 `desktop/scripts/ui-functional-test.mjs` 通过 WebView2 DevTools Protocol 驱动真实安装 App，输出逐项 PASS/FAIL/SKIP 和汇总；下列手工步骤保留用于人工复核和补充观察。

### 3.1 新建线程

- 步骤：新建线程，发送一条只读任务（例如“读取 README 并总结”）。
- 期望：线程出现在侧栏；标题不落原始 prompt 全文（事件库只存 `titleDigest`）；任务完成后 `dashboard.threads` 可见。

### 3.2 连续任务

- 步骤：在同一线程连续发送至少 3 条只读任务，其中一条触发工具读取。
- 期望：每个任务有独立 runId；`dashboard.projection.runs` 状态正确；timeline 分页可加载更多；无重复执行。

### 3.3 模型断线

- 步骤：把模型 base URL 指向不可达地址（或断网），发送任务。
- 期望：任务失败并显示可读错误；`dashboard` 出现 `TaskRunFailed`；事件库不含 prompt 原文；恢复网络后可继续新任务。

### 3.4 取消

- 步骤：发送一个会挂起的任务，点击“取消任务”（桌面终止子进程）；另用 CLI `runtime cancel --run-id <id>` 对另一个挂起任务发起取消。
- 期望：桌面取消后 UI 进入 `CANCELLED`，不回归 `FAILED`；CLI 取消后 run 写入 `TaskRunFailed.outcomeStatus=CANCELLED`，错误码 `TASK_CANCELLED`；取消请求 sidecar 只含 reason digest。

### 3.5 超时

- 步骤：用 `--task-timeout-ms 500`（或 UI 配置）发送一个挂起任务。
- 期望：超时后 run 失败，错误码 `TASK_TIMEOUT`；`TaskRunFailed` 落库；prompt 不落事件。

### 3.6 进程重启

- 步骤：任务执行中强制结束桌面进程，重新打开应用。
- 期望：未完成 run 被恢复为明确状态（失败/未知/可恢复），不会错误标为成功；重复恢复不重复写 outcome、不重复激活 memory。

### 3.7 重建 projection

- 步骤：执行 `runtime rebuild-read-model --harness-event-store <db> --read-model <json>`，再打开 dashboard。
- 期望：重建成功，checksum 与重建前一致（同一事件集）；未知关键事件标记 `PAUSED_UNSUPPORTED`；timeline 分页总数正确。

### 3.8 导出

- 步骤：执行 `runtime export-data --scope run|thread|all` 到临时文件。
- 期望：导出成功；不包含 prompt 原文、reasoning、凭据、命令正文和完整源码；Support Bundle 扫描通过。

### 3.9 删除

- 步骤：对一个 run 执行删除/retention purge，刷新 dashboard，再尝试导出该 run。
- 期望：run 事件和回执清空，只留最小 tombstone；late append 返回 `HARNESS_RUN_TOMBSTONED`；dashboard 不再显示该 run；导出为空；缓存/旧 projection 不能复活原文。

### 3.10 验收结果记录（2026-09-09）

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 3.1 新建线程 | PASS | UI 新建线程 + `hello` 返回真实模型结果，工作区识别正确 |
| 3.2 连续任务 | PASS | 同一线程 `thread-e644cbc3-a15f-472d-b4e7-b02493adc147` `turnCount=3`，UI run `run-ab9993c6-427b-48e9-a1ac-db5bb86d426c` 17.4s 完成 |
| 3.3 模型断线 | PASS | UI 任务显示“任务未完成”+`fetch failed`；CLI `run-0936837f-58ad-4f1e-903e-c2e7882008a2` exit=1、63 事件含 `TaskRunFailed`、prompt 未落事件；恢复真实配置后 `run-730a59fb-e7e8-4b1e-803f-a60ba7cbb26e` exit=0 |
| 3.4 取消 | PASS | UI 点击常驻“取消任务”后状态进入 `CANCELLED`，按钮恢复禁用；原生日志 `cancel_runtime_process invoked` / `killing pid=5756`；CLI 独立 cancel 由 `task-cancel-registry.test.mjs` 4/4 和 `runtime.test.mjs` 覆盖 |
| 3.5 超时 | PASS | `run-a89478b4-1ce8-4c4c-b66a-2c0718988aaf` exit=1、错误 `TASK_TIMEOUT:500`、63 事件含 `TaskRunFailed`（payload `code=TASK_TIMEOUT`）、prompt 未落事件 |
| 3.6 进程重启 | PASS | 任务中强杀桌面进程：无 `EPIPE` FATAL、无孤儿 node 进程；重启后 recovery 取消陈旧 run。修复见 `runtime/src/index.mjs` 的 `writeStdout` / `process.stdout.on('error')` |
| 3.7 重建 projection | PASS | `projection-check` expected=actual=`sha256:162aecff16aadec178bd307409e6f323de824f6928418fb3b9ba6b9c3052ac6c`；全量 rebuild 同 checksum；timeline 总数 4016、hasMore=true；dashboard runs=165、threads=7 |
| 3.8 导出 | PASS | `export-data` run=1 事件、thread=383、all=4016，三次 privacy scan 均 ok；未出现 prompt/messages/reasoning/api_key/command/content/code/output 等字段，也未出现 prompt 原文和 API key 名 |
| 3.9 删除 | PASS | 默认库临时副本：purge `run-593f73fd` 后事件 1→0、tombstone `tombstone-2c60834a-34b6-45fa-bffc-8956b91f8538`、导出 eventCount=0、late append 返回 `HARNESS_RUN_TOMBSTONED`、旧 projection `projection-check=false`，重建后 true（`sha256:aaf3a2ea151b8a9a6b3c451ceef52244d04db0167dbff1661aeaf891003a70e3`）；dashboard runs 165→164、timeline 4016→4015、`deletedRunIds` 含该 run |

证据目录：`%TEMP%\hmcodex-acceptance`（projection-check / rebuild / dashboard / export / delete / disconnect / timeout 的命令输出 JSON）。UI 场景通过 WebView2 调试协议直读 DOM 验证，未修改用户事件库；删除场景只在默认库副本上执行。

### 3.11 自动化 UI 功能测试结果（2026-09-09）

命令：`npm run test:ui:task`（`node desktop/scripts/ui-functional-test.mjs --task`），真实安装 App `C:\Program Files\hmCodex\hmcodex-desktop.exe` + WebView2 CDP，结果 **13 passed / 0 failed / 0 skipped**。

| 用例 | 结果 | 断言 |
| --- | --- | --- |
| T01 初始渲染与只读门控 | PASS | title、connection、run-state、composer、READ ONLY、取消按钮常驻且空闲禁用 |
| T02 上下文面板开关 | PASS | `context-open` 类打开/关闭 |
| T03 工作区目录导航 | PASS | 进入 `dist` 并返回 |
| T04 文件只读预览 | PASS | `index.html` 预览 + `sha256:e6e7185f026…` digest |
| T05 READ ONLY 模式不可切换 | PASS | 按钮禁用、点击不改变模式 |
| T06 新建任务重置 | PASS | 回到“等待任务”、发送可用、取消禁用 |
| T07 线程选择与时间线恢复 | PASS | 选中线程后 19+ timeline items |
| T08 时间线分页 | PASS | 19 → 219 items |
| T09 治理面板刷新 | PASS | 5 个 governance groups |
| T10 执行状态刷新 | PASS | 刷新成功、无错误项 |
| T11 无界面渲染错误 | PASS | 无“界面渲染出错” |
| T12 真实任务取消流程 | PASS | running → cancelled → idle |
| T13 真实任务终态与时间线渲染 | PASS | `只读检查完成` · 236 timeline items · 8 threads（模型先读不支持文件、换路径重试后成功；UI 正确渲染终态、模型输出与时间线） |

说明：T13 第一次运行曾因工具读取失败以 `任务未完成` 结束，从而暴露出“可恢复工具错误被 verifier 当硬失败”的问题；修复后模型换路径重试并成功完成（`只读检查完成`）。UI 自动化断言的是“终态正确渲染、时间线/线程持久化”，不强制某一次模型成功。只读套件可用 `npm run test:ui` 快速回归。

## 4. 记录模板

```text
场景：
开始时间：
结束时间：
产物/版本：
步骤：
实际结果：
期望结果：
截图/命令输出：
是否通过：PASS / FAIL
问题编号（如失败）：
```

## 5. 通过标准

- 2.1–2.4 全部 PASS；
- 3.1–3.9 全部 PASS，且失败场景有明确错误码和恢复动作；
- 所有记录附在本文档或构建记录中；
- 未通过项必须修复后重新执行对应场景，不能用“代码存在”替代。
