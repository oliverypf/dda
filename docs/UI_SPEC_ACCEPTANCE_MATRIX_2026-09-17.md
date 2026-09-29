# UI/UX 规格验收矩阵（2026-09-17）

范围：Windows Tauri + Node/Cordis runtime 当前工作区。状态按“证据是否覆盖规格”判定，不把基础入口当作整节通过。

> **历史矩阵说明**：本表中的旧 Verifier、语义 Verifier 或 OpenViking 需求描述仅用于追溯，不是当前实现目标；当前设计以 Jev Decision Plane 和本地 Memory Journal 为准。

| 规格 | 状态 | 当前证据 | 主要缺口 |
|---|---|---|---|
| 1 体验原则 | PARTIAL | 只读/受控模式、状态壳、错误保护 UI 已在原生和模拟测试覆盖 | 完整视觉一致性与竞品基线未完成 |
| 2 信息架构 | PARTIAL | 六页导航、workspace 专项 7/7、移动端无溢出、历史切换通过 | 2in1/tablet/phone companion 实机未测 |
| 3 HarnessReadModel | PARTIAL | Phase 3 evidence 19/19；projection/version 相关测试通过 | 缺口重读和所有命令映射仍需逐项记录 |
| 4 Run 状态呈现 | PARTIAL | 当前候选真实任务取消/终态 20/20、断线 T14/T15、真实流式单次 297 采样通过 | 休眠、升级、极端故障和长期恢复未测 |
| 5 时间线 | PARTIAL | 流式 224 采样、历史分页/迟到响应/大事件切换通过 | 超大单行、长期运行和真实 PTY 未测 |
| 6 Composer 与授权 | PARTIAL | 回执、只读门控、取消恢复、重复提交相关测试通过 | steer、完整授权阶段和跨 run 对账不足 |
| 7 Approval Card | PARTIAL | approve/decline、lease/timeout 摘要、断线安全测试通过 | expire/supersede/revoke 的完整 UI 链路未闭合 |
| 8 Route/角色/模型 | PARTIAL | Route 摘要、候选 runtime 和配置测试通过 | 完整候选详情、真实 provider/cache 基线、角色失败视图不足 |
| 9 Safety/Profile | PARTIAL | Safety 6/6；模式、审批、受控记录可见 | decision、required controls、权限来源字段缺失或未提供 |
| 10 Verifier/证据 | PARTIAL | PASS/UNKNOWN/quarantine、逐项检查、未解析引用和可解析引用点击定位 fixture 通过 | 原生候选未单独验证；完整验收项时间/影响等级、块级 Diff 证据不足 |
| 11 Workspace/Diff/Terminal | PARTIAL | 工作区专项 7/7、只读文件预览、Terminal 摘要和 workspace snapshot 通过 | proposed/executed/verified 块级 Diff 未实现 |
| 12 Council | PARTIAL | 多候选 runtime 后端测试通过 | Proposal/Critique/Judge/Probe 完整 UI、停止原因和回退入口不足 |
| 13 Dream/Memory | PARTIAL | Memory/Dream 页面、治理操作、来源/有效期展示已验证部分 | 编辑生成新版本、替代关系、敏感性和完整分类未实现 |
| 14 错误/断线/恢复 | PARTIAL | 断线安全测试、取消、恢复检查通过 | 完整恢复页、workspace 差异、未决审批/撤销 lease 未呈现 |
| 15 设置/管理 | PARTIAL | 设置 UI 通过布局、搜索、保存、重试、移动端和深色模式；当前已提供 10 类设置入口（连接与身份、角色与模型、Workspace grants、Plugin、Safety/审批与连续验证、Memory/Dream、隐私/保留与个性化、存储、无障碍、开发诊断） | 10 类入口中多数仍是只读状态面板；完整的权限、导出、恢复、策略和副作用配置流程仍未闭合 |
| 16 无障碍/输入 | PARTIAL | `ui-accessibility-test.mjs` 真实 Tauri WebView 通过 9/9：可见按钮/表单命名、桌面/移动端无横向溢出、200% 字体、prefers-reduced-motion、prefers-contrast 2px 边框；基础 aria、键盘入口也通过 | screen reader 播报、真实系统高对比度、实机触控/2in1/tablet/phone companion 仍未验证 |
| 17 性能/一致性 | PARTIAL | fixture 流式合并、真实 provider 单次 297 采样、历史切换、取消竞态通过；当前执行回归 22/22 且 longTasks=[] | 多 provider、高频长期 p95/SLO、超大输出和断线中途恢复未测 |
| 18 交互验收 | PARTIAL | 原生功能/安全/流式/历史/设置定向回归通过 | 多设备、完整 Diff/Council、导出删除、重启恢复和实机无障碍未完成 |

## 证据索引

- 原生功能：`.codex-tmp/fix-20260916/functional-final.log`（20/20）。
- 原生流式：本轮 224 samples，最大 3054 字符。
- 桌面 Vitest：55/55；桌面脚本：23/23。
- Phase 3：`docs/artifacts/WINDOWS_PHASE3_EVIDENCE.json`（19/19）。
- 详细续测记录：`docs/WINDOWS_ACCEPTANCE_CONTINUATION_2026-09-17.md`。
- 无障碍专项：`node desktop/scripts/ui-accessibility-test.mjs`，当前原生候选配合静态 dist 服务 9/9 通过；减动效实际计算值为 `1e-06s`，高对比度实际控件边框为 `2px`。


## 第 7 节证据细化

以 `UI_APPROVAL_REQUIREMENTS_AUDIT_2026-09-17.md` 的逐条记录为准。原上表“lease/timeout 摘要、断线安全测试通过”不足以证明第7节或当前原生候选已通过；旧安全测试不得替代当前构建验证。审批章节仍为 PARTIAL。


## 当前原生候选补充

`WINDOWS_NATIVE_APPROVAL_AUDIT_2026-09-17.md` 记录本次重建候选SHA256及原生6项证据；这替代旧安装版安全测试作为当前审批定向证据。包括真实写入/拒绝、授权消费、超时错误与模型连接失败恢复，不代表全项目或第7节全条目通过。


## 第10/17节本轮结果

新增验证终态场景发现并修复ok:true覆盖FAIL的问题，四种负向场景在浏览器通过；详情见续测报告。当前执行回归整体**未通过**，原因是流式回放采样出现52–127ms长任务，不能继续沿用旧性能通过结论作为当前保证。原始结果保存在`.codex-tmp/verifier-terminal-20260917/execution-results.json`；原生候选尚未包含此次终态修复。


## 最新审批确认与验证范围更新

§7 HIGH 二次确认已实现，默认返回/明确批准/直接拒绝/过期关闭有浏览器定向证据；新原生候选首次点击不写文件、第二次批准后写入及 Verifier PASS，安全7/7。最终按钮外边距修正仅已在最终 dist 验证，原生 exe 尚未嵌入该 CSS；详见审批逐项表。

§10 终态修复已包含于本次原生构建，但四个负向验证组合仍只有浏览器 fixture 证据；原生安全测试不能替代这些场景。§17 最新回放 longTasks=[]，此前52–151ms失败仍有效，未形成稳定/长期SLO结论。


## 第10节逐项验收更新

以 UI_VERIFIER_REQUIREMENTS_AUDIT_2026-09-17.md 为准：已修复当前成功桥响应中 checks 未显示的问题，四种检查状态有浏览器截图和断言；实际检查时间、影响、证据导航、历史恢复等仍缺。当前20条浏览器结果不能升级为第10节或全项目通过。


## 2026-09-18 续验

- 当前候选 `ui-functional-test.mjs --task`：20/20 通过；`ui-disconnect-test.mjs`：2/2 通过；`ui-security-test.mjs`：7/7 通过。
- `npm.cmd run build`、`npm.cmd test`（7 文件/60 测试）、`npm.cmd run test:scripts`（23/23）通过；`ui-execution-test.mjs` 证据导航专项 22/22 通过且 `longTasks=[]`。
- 真实 provider 流式专项在扩大启动窗口后通过：297 个采样、最大流式正文 2897 字符、根节点保持不变；长期 p95/SLO 仍未证明。
- 原生候选已重新编译，覆盖本轮时间线事件合并和证据导航修复；完整规格仍为 PARTIAL。


## 真实 provider 流式续验补充

`ui-streaming-test.mjs` 的首行等待已改为可配置，默认 120 秒，以覆盖当前 runtime 启动阶段。当前原生候选实测 `samples=297`、`maxStreamingLength=2897`、`markerKeptWhileGrowing=297`，最终终态为“只读检查完成”。这只证明一次真实 provider 流式回放通过，不改变完整规格仍为 PARTIAL。

## 2026-09-18 无障碍专项续验

`ui-accessibility-test.mjs` 通过真实 Tauri WebView/CDP 检查 9/9：可见按钮都有可访问名称，表单控件有标签或提示，桌面 1440px、移动 390px、根字体 200% 均无横向溢出；`prefers-reduced-motion` 命中且计算动画/过渡为 `1e-06s`、滚动为 `auto`；`prefers-contrast: more` 命中且按钮等控件实际边框为 `2px`。为使高对比度边框覆盖原有 `.send-button { border: 0 }`，补充了带 `!important` 的 2px 实线规则，并重建 dist。

这批结果只覆盖浏览器自动化和媒体查询模拟；屏幕阅读器真实播报、Windows 系统高对比度主题、触控实机以及 2in1/tablet/phone companion 仍未验证，所以第16节与总体验收继续保持 PARTIAL。



## 2026-09-18 续测（本轮）

- 原生候选重新编译：`cargo build --target x86_64-pc-windows-msvc --bin hmcodex-desktop` 通过；静态 dist 服务使用 `http://127.0.0.1:1420/`。
- 原生 UI 功能：`test:ui` 18/18 基础项通过；`test:ui:task` 20/20（含真实任务取消与终态）通过。
- 原生 UI 专项：历史 12/12、记忆通过、工作区 7/7、执行/证据 22/22 且 `longTasks=[]`、断线 2/2、真实流式 1/1（119 samples，本轮短回放）、安全 7/7、设置通过、无障碍 9/9。
- 工程回归：桌面 Vitest 7 文件/60 测试通过；脚本 23/23 通过；`npm run build` 通过；`git diff --check` 通过。
- 修复的验收基础设施：UI CDP 目标匹配支持 `127.0.0.1`；安全专项首次启动前清理残留 detached 进程，避免旧只读实例抢占受控测试；补充 `test:ui:workspace` npm 入口。
- 设置页规格状态已更新为 10 类入口；其中只有角色与模型、隐私/保留与个性化、连续验证包含编辑保存，其他分类目前用于展示状态，因此第 15 节仍为 `PARTIAL`。
- 未改变总体判定：proposed/executed/verified 块级 Diff、Council Proposal/Critique/Judge/Probe、Memory 版本/替代/冲突/敏感性、Approval 完整 purpose/副作用/资源限制/requester/executor/superseded/revoked、屏幕阅读器/系统高对比度/触控实机、多 provider 长期 p95/SLO、重启恢复、导出/删除流程仍缺少完整证据。

## 2026-09-18 sidecar 构建复核

- 并行回归中的 `tauri-rust` 失败可稳定归因于正在运行的 `openviking-server.exe` 占用 `desktop/src-tauri/binaries/openviking-server.exe`，触发 Windows `os error 32`。
- 结束 sidecar 的父级测试进程后，单独执行 `node desktop/scripts/build-openviking-sidecar.mjs --debug --test` 成功；原生 Rust 单测 28/28 通过。
- 这不改变规格状态：构建与单测证据已恢复，但运行中的 sidecar 仍不能被原地覆盖，发布/升级流程需要先停止受管进程。

## 2026-09-18 续测（恢复与导出）

- 诊断页新增“导出全部数据”动作，调用 Tauri `export_data`，运行时执行 `export-data --scope all`，页面显示进行中、完成路径或错误原因；规格启发式审计中的 export flow 已由 `PARTIAL` 变为 `PASS`。
- 恢复命令现在返回并持久化展示 workspace Git 观察摘要（可用性、HEAD 摘要、差异计数、暂存/未暂存/未跟踪/冲突计数）、执行/角色/Dream 恢复计数、待审批数量和撤销 Lease 数量；启动恢复与手动“恢复检查”共用同一展示状态。
- `runtime/test/runtime-recovery.test.mjs` 2/2 通过，覆盖 workspace 观察摘要和异常所有者记录回收；桌面构建、Vitest 7 文件/60 测试、`git diff --check` 通过。
- Memory 行现在显示 sensitivity、version、supersedes 和 conflicts 元数据（当运行时提供）；版本替代和冲突编辑动作仍未实现。

## 2026-09-18 规格缺口源码核对

对照 `docs/UI_UX_SPEC.md` 第 11、12、13、14、18 节，检查 `desktop/src/main.ts` 当前渲染入口和动作绑定：

- 第 11 节 Diff：未发现 `proposed`、`executed`、`verified` 分层 Diff 渲染或对应 UI action；当前只显示 workspace 文件预览和运行摘要。
- 第 12 节 Council：未发现 `Critique`、`Judge`、`Probe` 的 UI 渲染/筛选/操作入口；现有 `CouncilPlanReviewCompleted` 只映射为时间线摘要。
- 第 13 节 Memory：当前有 `PROPOSED`、`ACTIVE`、`REVOKED` 状态统计和治理按钮，并会显示 sensitivity、版本、替代和冲突元数据；版本替代/冲突编辑和敏感性修改动作仍缺失。
- 第 14/18 节导出恢复：导出全部数据动作与完成路径反馈已实现并有测试；恢复页现在展示 workspace Git 差异摘要、待审批和撤销 Lease 计数，但仍缺少远端状态与逐项恢复/撤销操作。

因此这些项目是**已确认的实现缺口**，不是单纯缺少测试；矩阵相应条目继续保持 `PARTIAL`。
## 2026-09-18 Council 面板续验

- 工作台 Context 新增结构化 Council 面板，按 Proposal、Critique、Judge、Probe 四列展示持久化决策事实、状态、选中项和理由；无对应事实时显示“暂无记录”。
- 面板不展示隐藏思维过程，仅消费 `RuntimeDecisionNode`，因此审计关键词命中不等同于运行时已有四类事实。
- `npm run build`、Vitest 7 文件/60 测试、诊断 UI、Memory UI 和 `git diff --check` 通过。
- Council 仍需真实运行时 Proposal/Critique/Judge/Probe 样本、筛选/跳转和 Probe 操作证据，整体验收保持 `PARTIAL`。
## 2026-09-18 恢复逐项详情续验

- 恢复响应现在保留执行记录，并在诊断页显示 recordId、类型、能力、状态和更新时间。
- Git 观察摘要增加状态码和路径摘要数量（路径内容不直接泄露）；页面显示截断提示。
- `npm run build`、Vitest 7 文件/60 测试、runtime recovery 2/2、诊断 UI 和 `git diff --check` 通过。
- 当前 fixture 没有执行记录，因此真实 UI 显示“暂无可恢复执行记录”；需要在受控恢复场景补充有记录的端到端样本，整体仍为 `PARTIAL`。
## 2026-09-18 全量并行回归

- `npm run test:all:parallel` 完成，6/6 子任务通过：runtime、desktop、desktop-scripts、phase3-evidence、TypeScript、tauri-rust。
- runtime 汇总 584 项：583 通过、1 项按设计跳过、0 失败；桌面 Vitest 7 文件/60 测试；脚本 23/23；Phase 3 evidence 19/19；Rust 28/28。
- 全量工程回归通过不改变规格覆盖结论：真实 UI 的 Council 样本、恢复逐项操作、Memory 治理编辑、重启/长期性能/实机辅助技术证据仍需补齐。
## 2026-09-18 真实 UI 专项续验

- 使用当前工作区 debug exe `desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/hmcodex-desktop.exe` 复测；旧安装版导航失败不计入当前构建结论。
- 基础 UI：18/18；真实任务：20/20；工作区：7/7；执行/证据：修复后通过，事件回放与 1024 条混合 delta 的 `longTasks=[]`。
- 历史、Memory、设置、无障碍、安全均通过；断线恢复 T14/T15 2/2；真实流式回放 186 samples，最大正文 78 字符，根节点保持不变；诊断恢复/导出通过。
- 修复一项性能回归：隐藏 Context drawer 时不再在每个流式 delta 重建治理面板；LiveTimeline 每帧批量从 16 调小到 8，并缩短单帧预算，执行专项恢复到无长任务。
- 为断线和流式脚本增加 `HMCODEX_UI_WORKSPACE_ROOT`（默认当前工作区），避免默认落到 `C:\Windows` 导致 `WORKSPACE_SNAPSHOT_FAILED` 的假失败。
- 规格审计仍为 `PARTIAL`：恢复逐项操作/远端状态、Memory 治理编辑、真实 Council 四阶段样本与 Probe 操作、长期性能/重启/实机辅助技术证据未全部覆盖。
## 2026-09-18 规格审计器收紧

- `ui-spec-gap-audit.mjs` 现在要求关键词之外还必须存在对应 UI surface marker；不再把 Diff 三层关键词和 Memory 元数据展示误判为完整操作。
- 当前审计结果：Diff `PARTIAL`、Council `PASS`（结构化面板存在，但真实四阶段事实仍未证明）、Memory `PARTIAL`、Export `PASS`、Recovery `PARTIAL`；overall `PARTIAL`。
## 2026-09-18 缺口证据清单

- 规格审计器现在对 `PARTIAL` 项输出具体缺口证据：
  - Diff：真实文件块级 diff UI、三种状态对应的 runtime 数据流。
  - Memory：敏感性编辑、版本替代、冲突处理。
  - Recovery：远端状态字段、逐项 Approval 操作、逐项 Lease 操作。
- Council 当前结构化面板源码证据为 PASS，但真实四阶段运行样本和 Probe 选择/执行仍需端到端验证。
- 审计脚本测试 23/23 通过；整体规格状态仍为 `PARTIAL`。



## 2026-09-18 本轮修复后的验收证据

- 原生 UI 测试脚本在 UNC/npm 场景下改为从脚本位置推导工作区根目录；功能、断连、流式脚本均不再依赖手工设置 `HMCODEX_UI_WORKSPACE_ROOT`。
- 当前 debug exe 真实任务回归 `20 passed, 0 failed, 0 skipped`；包含线程历史、工作区目录/文件预览、取消流程和真实模型任务，任务终态为“只读检查完成”。
- 原生流式回归通过：123 次采样，最大流式正文 842 字符，应用根节点在全部增长样本中保持不变，终态为“只读检查完成”。
- 断连恢复回归通过：T14/T15 `2 passed, 0 failed`；断连断言限定为 transport/model 错误，避免把 workspace snapshot 错误当作模型断线。
- Recovery 响应新增待审批和已撤销 Lease 的逐项摘要；诊断 UI fixture 已验证 recordId、operation、状态和撤销原因的渲染。
- Council 面板不再把任意多选项决策冒充 Proposal；`REVIEW_PLAN` 按 Judge 展示候选排序，缺少的 Critique/Probe/claim/evidence/预算/轮数明确显示为未提供。

- 诊断 UI fixture 现在同时注入 Judge 决策和候选排序；断言 `REVIEW_PLAN` 进入 Judge、候选排序可见、没有伪造 Proposal、Critique 缺失明确呈现。
- `npm run build`、TypeScript `tsc --noEmit`、脚本测试 `23/23`、Recovery runtime `7/7`、诊断 UI、Memory UI、`git diff --check` 通过。

本轮仍不能把规格判为完成：真实文件块级 Diff 与三态数据流、Council 四阶段真实事实及 Probe 操作、Memory 编辑/敏感性/冲突治理、Recovery 远端状态和逐项操作、重启/长期性能/实机辅助技术证据仍缺失或未验证。

- 本轮全量工程回归 `npm run test:all:parallel`：6/6 子任务通过；runtime 584（583 通过、1 跳过），desktop 60，脚本 23，Phase 3 19，TypeScript 和 Rust 通过。

## 2026-09-19 当前构建续验

本轮完整结果与逐项缺口见 `docs/UI_ACCEPTANCE_REPORT_2026-09-19.md`。当前 debug bridge + 当前 Vite 下：原生基础 UI 18/18 通过；受控安全 7/7；断线 2/2；无障碍 9/9；真实流式 `samples=124`、`markerKeptWhileGrowing=124`；Runtime 587 passed / 1 skipped / 0 failed；Desktop Vitest 60/60；脚本 23/23；构建通过。此前由旧安装包产生的导航失败已复核为环境版本问题。

规格审计仍为 PARTIAL：Diff 三态、Council Probe、Memory 版本/敏感性/冲突、Recovery 远端字段与完整逐项恢复证据、Verifier 时间/影响/证据跳转，以及真实设备和长期 SLO 仍缺。
