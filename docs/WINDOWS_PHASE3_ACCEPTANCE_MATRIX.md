# Windows 阶段三：可审计工作台验收矩阵

版本：v1.0
日期：2026-09-12
> **历史验收矩阵**：本表保留当时的实现/证据状态。旧的 OpenViking、LLM-as-a-Verifier、语义 Verifier 和 Candidate Judge 术语不构成当前需求；当前设计以 [Jev Decision Plane 设计](JEV_DECISION_PLANE_DESIGN.md) 为准。

依据：[WINDOWS_PHASE3_PRODUCT_EXPERIENCE_PLAN.md](WINDOWS_PHASE3_PRODUCT_EXPERIENCE_PLAN.md)、[UI_UX_SPEC.md](UI_UX_SPEC.md)

说明：状态取值 `实现` = 源码/构建可见证据存在；`部分` = 有界面或契约但尚未完整体验闭环或实机验收；`待实机` = 已实现可启动性边界，需要真实 Windows 安装包、触控、键盘、屏幕阅读器、高对比或字体缩放验收。

## S3-01 信息架构、路由与页面状态骨架

| UI_UX_SPEC | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 2 信息架构 | 工作台、工作区、运行记录、记忆、能力与安全、设置与诊断六个一级页面 | 实现 | `desktop/src/main.ts` 导航项与 `primaryPages` 页面映射 |
| 2 信息架构 | 本地导航状态保存页面、threadId、runId、workspace 路径、时间线 cursor 和滚动锚点 | 实现 | `hmcodex.nav` 持久化与启动恢复 |
| 18 交互验收 | 页面切换不会跳到错误任务 | 部分 | 页面本地持久化已接，未覆盖所有线程/run 乱序切换场景 |
| 14 错误、断线与恢复 | loading、empty、error、stale snapshot 状态组件 | 实现 | `renderPageStatus` 与 `page-status-*` 样式 |
| 17 UI 性能与一致性 | 每页消费版本化 ReadModel 投影，过期版本显示安全暂停 | 部分 | 已有 projectionVersion；过期 UI 提示尚未完全覆盖每页 |

## S3-02 工作台、Composer 与运行状态闭环

| UI_UX_SPEC | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 6 Composer 与任务授权 | Composer 显示 workspace、endpoint/模型、模式摘要 | 实现 | Composer 模板中新增 `composer-summary` 与执行模式、工作区 |
| 6 Composer 与任务授权 | Enter/Ctrl+Enter 可配置 | 实现 | `hmcodex.composerSubmit` 与键盘事件 |
| 6 Composer 与任务授权 | 每个提交展示 pending/accepted/rejected receipt，重复点击一致 | 实现 | `lastSubmitReceipt` 生命周期 |
| 4 Run 状态呈现 | 覆盖运行中状态与合法下一步 | 部分 | `runStateLabel`/`runStateNextStep` 覆盖主要状态，QUARANTINED/PAUSED_UNSUPPORTED 等仍以字符串回落 |
| 5 时间线 | 时间线项可展开 event/operation/digest 等技术详情 | 实现 | `timeline-details` 与事件回放字段 |

## S3-03 Route、角色、模型与候选选择面板

| UI_UX_SPEC | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 8 Route、角色与模型 | Route/候选摘要面板 | 实现 | `renderRoutePanel` |
| 8.1 Agent 决策轨迹 | 候选选中/淘汰/未执行状态可见 | 实现 | `decisionOptionLabel` 复用 |
| 8 Route、角色与模型 | 角色/阶段模型摘要 | 部分 | `modelEgress.byPhase`，但模型/角色 binding 明细仍缺 |
| 8 Route、角色与模型 | 用户固定模型集合；模型不可用暂停选择 | 部分 | Route 面板 `pinned-model` 选择并透传新 run；完整多候选集合 UI 仍待补 |

## S3-04 Approval、Safety 与受控执行详情

| UI_UX_SPEC | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 7 Approval Card | 审批卡片展示 command/diff/path/cwd/scope/digest/有效期 | 部分 | `renderApprovalCard` 展示现有字段；diff 暂缺 |
| 7 Approval Card | 批准/拒绝/取消/过期回执 | 实现 | `resolve-approval` 与 `pendingApprovalResolutions` |
| 7 Approval Card | 工作台主时间线保留 Approval 入口 | 实现 | `workbench-approvals` |
| 9 Safety 与 Profile | Safety/PolicyLease 可见 | 部分 | 右侧执行状态和审批有展示；完整 lease 生命周期页仍待验证 |

## S3-05 Verifier、证据、Diff 与 Terminal 工作区

| UI_UX_SPEC | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 10 Verifier 与证据 | 连续验证/过程验证证据展示 | 实现 | `renderContinuousVerification` |
| 10 Verifier 与证据 | Verifier UNKNOWN/FAIL/PASS 不误显示成功 | 实现 | 时间线回放 UNKNOWN/ABSTAIN 标为 PENDING，过程验证行加 `data-verification-unknown` 非成功样式 |
| 11 Workspace、Diff 与 Terminal | 文件预览与 digest 展示 | 实现 | 右侧 `renderSelectedFile` |
| 11 Workspace、Diff 与 Terminal | Diff/Terminal 证据工作区 | 部分 | 工作台已新增 Terminal 证据面板；文件块级 Diff 详情仍待补 |

## S3-06 运行记录、Decision DAG 与 Council 审议

| UI_UX_SPEC | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 2 信息架构 | 运行记录一级页面 | 实现 | `renderRunsPage` + `projectionRuns` |
| 8/12 多 Agent 审议 | 工作台主区 Decision DAG 摘要 | 实现 | `renderDecisionTrace` 复用至工作台 transcript |
| 8/12 多 Agent 审议 | Decision DAG 与 Council 摘要 | 部分 | 右侧决策图和工作台决策图、Council 时间线事件存在；完整审议详情待补 |
| 18 交互验收 | 历史 run 分页/恢复/导出 | 部分 | 运行记录页已本地分页并支持查看单 run 时间线；导出/删除仍待补 |

## S3-07 Memory、Dream、Plugin、Evolution 与诊断管理

| UI_UX_SPEC | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 13 Dreaming 与 Memory | Memory/Plugin/Evolution 治理入口 | 实现 | 右侧 `renderGovernance`，记忆页 Dream 运行一次/后台开关可操作 |
| 15 设置与管理 | 设置与诊断一级页面 | 实现 | `renderDiagnosticsPage` |
| 15 设置与管理 | Support Bundle 就绪度 | 部分 | 已有 Support Bundle 状态展示；导出进度/删除/备份操作待验证 |

## S3-08 断线、恢复、容量与故障体验

| UI_UX_SPEC | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 14 错误、断线与恢复 | Recovery 页面/恢复检查 | 实现 | `runRecoveryCheck` 与诊断页按钮 |
| 14 错误、断线与恢复 | 断线/timeline 保留 | 部分 | 滚动/导航持久化有；真实断线重连需实机 |
| 17 UI 性能与一致性 | 未知执行结果不假定未执行 | 部分 | 已有 reconcile/UNKNOWN 时间线语义，实机场景待验收 |

## S3-09 无障碍、响应式与性能收敛

| UI_UX_SPEC | 项 | 状态 | 证据 |
| --- | --- | --- | --- |
| 16 无障碍与输入 | 减少动画、触控目标、safe-area、高对比、焦点环 | 部分 | CSS 已补媒体查询；键盘/screen reader 矩阵待实机 |
| 17 UI 性能与一致性 | timeliness/diff/file 分页或虚拟化 | 部分 | 时间线分页已有；diff/超大文件仍需验证 |
| 17 UI 性能与一致性 | 高频事件不卡顿 | 未验证 | 需要性能压测记录 |

## S3-10 发布验收与体验观察

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 验收矩阵 | 实现 | 本文件 |
| 可执行阶段三标记检查 | 实现 | `npm run test:phase3-evidence`（`desktop/scripts/phase3-evidence.mjs`，覆盖 19 项源码实现标记） |
| 桌面端端到端测试记录 | 未完成 | 需真实 Windows 安装包与场景矩阵 |
| 无障碍/安装包/触控实机验收 | 未完成 | 需真实设备与人工观察 |

## 2026-09-15 遗留项移交

本矩阵未关闭的 Windows 项目由 [阶段四实施计划](WINDOWS_PHASE4_IMPLEMENTATION_PLAN.md) 与 [阶段四验收矩阵](WINDOWS_PHASE4_ACCEPTANCE_MATRIX.md)继续跟踪，原 G5 标准不变。当前源码已补齐 QUARANTINED / PAUSED_UNSUPPORTED 的文案和下一步，本文 S3-02 的字符串回落描述属于历史状态；其余项仍须按当前候选验证，不能因移交而视为完成。

## 结论

当前源码层已验证 `desktop npm run build` 通过，S3-01 至 S3-09 已有可审计实现或部分实现。G5 完整发布仍需：真实 Windows 安装包场景矩阵、键盘/屏幕阅读器/高对比/字体放大验收、断线/恢复/未知结果端到端观察，以及既有 G2/G3/G4 指标回归记录。

- 验收产物：`npm run test:phase3-evidence` 会生成 `docs/artifacts/WINDOWS_PHASE3_EVIDENCE.json`。
| 18 交互验收 | 单 run 时间线筛选可持久化 | 实现 | `hmcodex.focusedRunId` 写入并在启动恢复 |
