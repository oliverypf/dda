# hmCodex Desktop

Windows/Linux 桌面客户端预留目录，目标运行时为 Tauri 2 + TypeScript 前端 + 本地运行时。

桌面客户端是独立安装、独立启动的本地产品。首期范围是本地 Thread/Turn、流式输出、审批、只读 workspace、本地 Trajectory 和统一 `ContextSummary`；任务、工具、审批、验证、恢复和本地 Memory Journal 由自研 Node/Cordis runtime 承载。Jev Decision Plane 负责候选选择、工具门禁和行为判断。

设置使用左侧分类、右侧内容的布局，提供“模型配置”“个性化”“连续验证”和设置搜索。进入“设置 → 个性化 → 自定义指令”，可以填写“每次回复都使用中文”等长期偏好，支持多行、最多 8000 字符。保存后从下一次任务开始作为系统级提示发送到模型（包括多轮工具调用和各模型角色）；已有会话的后续任务也会采用新配置。清空并保存可停用。切换分类不会丢失未保存的编辑。

自定义指令保存在模型配置的 `customInstructions` 字段，保留既有高级模型和角色绑定。回归：`npm run build` 后执行 `npm run test:ui:settings`（需 Playwright，可用 `NODE_PATH` 指定安装位置）。运行时测试为 `node --test runtime/test/custom-instructions.test.mjs`（从仓库根目录执行）。

本地 shell、任意路径访问和网络调用不会因为是桌面应用就默认开放，必须经过 Tauri capability、工作区 scope、PolicyLease、审批和审计。Windows 不接入 App Server，直接通过自研 runtime 调用模型 provider；远程 Gateway 不在当前开发范围。

当前已落地：

- Windows 优先的 Tauri 2 桌面骨架与 TypeScript/Vite 工作台；
- 默认 `READ_ONLY`，支持用户授权目录、目录浏览、限量文本预览、二进制屏蔽和 SHA-256 摘要；
- Mock 任务、流式时间线、取消和响应式上下文面板；
- 独立 Node/Cordis runtime，模型 provider 可配置，默认使用 OpenAI Responses，DeepSeek Harness 作为显式选项；
- Native 任务取消会终止当前 Cordis Node 子进程及其子进程树；任务期间由 JSONL 心跳和 30 秒 watchdog 监督失联进程；
- 桌面启动时会执行一次只读 recovery，对账上次异常退出遗留的 Approval、Lease、Intent、角色上下文和 Dream run；关闭窗口也会清理当前 runtime 进程树，不会自动重放任务；
- 治理面板支持显式启动/停止 Dream 后台维护；Tauri 托管独立 daemon、转发脱敏 JSONL 状态，并按活动 runtime 任务数动态阻断高优先级运行期间的 Dream；
- Tauri capability 仅保留核心窗口权限，不开放 shell、写入或网络权限。
- Thread 重新打开时会按已保存 Turn 回放脱敏运行事件；受控审批会展示风险、快照 scope、策略版本和过期时间；子 Agent 面板消费 runtime 的真实角色和 checkpoint 事件。

## Cordis runtime

### 会话与工作区切换

会话绑定创建时的工作区根目录。任务完成或取消后，“更换项目”切换到不同根目录时会清除当前会话及 checkpoint 绑定，下一次发送创建新会话；原会话仍保留在历史列表中。重复选择同一目录或浏览其子目录不会重置会话。任务运行和目录切换期间不允许再次更换项目；目录选择期间暂时禁止发送，取消选择不改变当前会话。

历史列表可以跨工作区查看；若当前授权目录与历史会话目录不同，发送时会在当前目录创建新会话，不复用旧目录的 checkpoint。要续接原会话，请先打开其原目录，再从历史列表选择该会话。runtime 继续保留 `THREAD_WORKSPACE_MISMATCH` 校验，防止跨目录复用执行上下文。

回归验证：先执行 `npm run build`，再执行 `node scripts/ui-workspace-test.mjs`。UI 测试使用 Playwright 和模拟 native bridge，不调用真实模型或访问真实项目目录；可通过 `NODE_PATH` 指定 Playwright 安装位置，通过 `HMCODEX_BROWSER_CHANNEL=msedge` 使用本机 Edge。

Windows 原生任务由 `runtime/` 中的独立 Cordis 进程执行。
桌面侧栏的“设置”可编辑默认模型的 Provider、协议、模型名称、Base URL、完整 Endpoint、API Key 环境变量名称与会话 Header。保存后下一次任务使用新配置；运行中的任务不变。已有的高级模型列表和角色绑定会保留，独立角色绑定仍优先于默认模型。Web 预览仅展示表单，不保存本地配置。

首次运行
`npm run dev` 或 Tauri 开发命令时会自动安装 runtime 依赖；也可以手动执行
`npm run runtime:install`。模型配置从 `%LOCALAPPDATA%\hmCodex\model-config.json` 读取。
复制 `runtime/model-config.example.json` 作为起点；配置文件只保存 provider、协议、模型和
endpoint 等非敏感字段，API key 仍只从启动 hmCodex 的环境变量读取：

Windows MVP 需要本机安装 Node.js 22+，因为 Cordis runtime 以 Node 子进程运行。
打包配置会把 runtime 源码和依赖放进安装包；后续迭代再替换为随应用发布的
Node sidecar，去掉这一项系统前置条件。

```powershell
$env:DENGJIUWANLE_API_KEY = '...'
# 可选：不使用默认路径时指定配置文件
$env:HMCODEX_MODEL_CONFIG = 'C:\path\model-config.json'
```

也可以在启动 runtime 时传入 `--config PATH`。命令行模型参数优先级最高，其次是
JSON 配置文件，再其次是兼容旧版本的 `HMCODEX_MODEL_*` 环境变量，最后使用内置默认值。
桌面端启动时会自动执行一次不联网的 runtime health 检查；它只验证 Node/runtime 入口和
配置格式，不会读取或上传 API key。

当前 Cordis 组合包含只读 workspace、可配置的 model-provider（OpenAI Responses、
Chat Completions、兼容网关或显式 DeepSeek Harness）、task runner 和 evolution
proposal registry。每次任务会把脱敏的 run 生命周期、模型路由、workspace snapshot
摘要和结果摘要追加到 `%LOCALAPPDATA%\hmCodex\trajectory.jsonl`，下一次任务最多恢复
最近三个 run 的结构化摘要作为有限 context；不会恢复原始 prompt、模型全文、隐藏思维链或
凭据。受控模式下模型工具调用仍需 workspace scope、一次性 Lease 和逐项审批；拒绝、
过期、崩溃恢复和未知副作用都会 fail closed。演化注册表会在 Windows 用户数据目录中
持久化候选，evaluator 提供 replay、shadow、canary、promotion 和 rollback 的显式治理
命令；在线任务结果只记录为脱敏 outcome，不会自动晋级插件或提案。可用
`evolution cohort` 按 task class、provider、protocol、model 和时间窗口生成稳定的
baseline cohort，再用 `fixturesFromOutcomes` 进入离线 replay；cohort 只包含 outcome
摘要和 digest，不包含 prompt、模型全文或 reasoning。Memory proposal 也必须保留来源
事件；没有 source event 的记录可以保持 `PROPOSED`，但不能被 accepted 或激活为 `ACTIVE`。

runtime 现在还提供 provider-neutral 的 Tool Registry，内置
`workspace.list`、`workspace.read` 以及受控 `shell.execute`、`file.write`、`test.execute`。
工具输入经过严格 JSON schema 校验，输出有大小上限，敏感文件、二进制文件、超出授权范围
的符号链接和未授权路径都会被拒绝。Responses 与 Chat Completions 的 function-call
解析器支持有界多轮调用；副作用工具始终经过 RuntimeSafetyMonitor、Lease、审批和审计。

Dream 后台维护默认关闭。在治理面板点击“启动后台”后，桌面端会托管
`dream --operation daemon` 子进程；每轮维护都会重新读取活动任务计数，状态文件缺失或
异常时按繁忙处理。它只生成 `PROPOSED` memory，不会自动激活记忆、修改安全策略或晋级
Evolution proposal。应用退出时会清理 daemon 进程树。

Windows 后续工作统一见 [阶段四实施计划](../docs/WINDOWS_PHASE4_IMPLEMENTATION_PLAN.md)和[阶段四验收矩阵](../docs/WINDOWS_PHASE4_ACCEPTANCE_MATRIX.md)。当前重点：

1. 完成 Windows 命令契约、durable facade 与剩余事实源入口收敛；
2. 补齐任务运行时长期驻留、随包 Node、Windows capability/路径/凭据适配；
3. 补齐候选/角色、审批与 Diff、运行记录、反馈归因、治理诊断和恢复交互；
4. 完成 Git 互验、Bayesian F4/F5、性能、无障碍及真实 Windows 发布观察。

阶段四继续验收本地 runtime、Jev 决策证据、长期运行和最终安装包集成。Linux、HarmonyOS、跨平台协议抽取和远程 Gateway 暂不纳入阶段四。

## Windows MVP 构建

本地 Windows 开发副本位于 `C:\Users\User\hmCodex-local`，请从本机目录进入项目后执行命令。
不要把本地路径与原始映射盘或 UNC 路径混用。桌面端的
Vite、Vitest、runtime 安装、静态预览和构建脚本都通过 `desktop/scripts/windows-path.mjs`
解析项目根，会优先使用 `HMCODEX_DESKTOP_ROOT`、npm 的 `INIT_CWD` 和当前映射盘目录，
因此不会再分别推导出不一致的 `desktop`、`runtime` 或 `dist` 路径。需要从 IDE 或快捷方式
启动时，可显式设置：

```powershell
$env:HMCODEX_DESKTOP_ROOT = 'C:\Users\User\hmCodex-local\desktop'
```

若只能通过 UNC 路径访问，仍然可以运行；只需保持该终端内所有命令都使用 UNC 路径。

当前 Windows 打包命令固定使用 `x86_64-pc-windows-msvc`，因为部分 Windows ARM64 主机只安装了 x64 MSVC 目标库；ARM64 Windows 可通过系统 x64 兼容层运行该安装包。执行：

请在 Visual Studio Developer PowerShell 中运行以下命令，以确保 `link.exe` 和 Windows SDK 环境变量已加载：

```powershell
npm install
npm run build:windows
```

如需生成 ARM64 原生包，先安装 Visual Studio 的 ARM64 C++ 目标组件，并将 Rust ARM64 工具链设为默认，然后把命令改为 `tauri build --target aarch64-pc-windows-msvc`。
