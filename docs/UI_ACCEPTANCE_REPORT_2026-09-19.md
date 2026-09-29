# UI/UX 规格验收报告（2026-09-19）

本报告依据当前工作区源码、当前 Vite 前端、Tauri debug bridge、Runtime 测试和现有规格/竞品基线生成。验收目标是判断界面是否达到开发规格，不把“有入口”当作“功能已完成”。

> **架构口径**：本文是历史验收报告；当前 UI 应展示 Jev Decision Plane 的候选选择、工具门禁和行为判断，以及 Rule Verifier 的确定性事实。旧的独立语义 Verifier、Candidate Judge 和 OpenViking 描述不再是验收目标。

## 判定

当前结论：**PARTIAL（部分符合，不能签收为规格完成）**。

主界面、六页导航、工作区浏览、历史、设置、Memory 基础操作、Recovery 基础操作、只读/受控门控、审批安全、断线恢复、流式渲染和自动化无障碍检查均有通过证据。规格仍未完整覆盖 Diff 三态、Council 四阶段 UI、Memory 版本治理、Recovery 远端字段、Verifier 元数据和真实设备/屏幕阅读器等要求。

## 当前构建的通过证据

| 区域 | 当前结果 | 证据 |
|---|---|---|
| Runtime | 587 passed / 1 skipped / 0 failed | `runtime/npm test`，共 588 项 |
| Desktop Vitest | 60/60 | `desktop/npm test` |
| Desktop scripts | 23/23 | `desktop/npm run test:scripts` |
| Vite 构建 | 通过 | `desktop/npm run build` |
| 原生基础 UI | 18 passed / 0 failed / 2 skipped | `ui-functional-test.mjs`，使用当前 debug bridge + 当前 Vite |
| 设置 | 通过 | `ui-settings-test.mjs` |
| 历史 | 全部通过 | `ui-history-test.mjs`，包含分页、恢复、迟到响应和移动端溢出检查 |
| Memory | 通过 | `ui-memory-test.mjs` |
| Workspace | 7 项通过 | `ui-workspace-test.mjs` |
| Execution / Verifier | `ok: true` | `ui-execution-test.mjs`，包含审批、终态、证据、DOM 稳定性和取消竞态 |
| 无障碍自动化 | 9/9 | `ui-accessibility-test.mjs`：控件命名、表单提示、390px、200% 字体、减动效、高对比度 2px 边框 |
| 流式渲染 | 通过 | 当前构建 `samples=124`、`maxStreamingLength=575`、`markerKeptWhileGrowing=124`，最终“只读检查完成” |
| 断线恢复 | 2/2 | `ui-disconnect-test.mjs`：失败可见、重启后可继续 |
| 受控安全 | 7/7 | `ui-security-test.mjs`：门控、非法网络配置、审批拒绝、卡片取消、批准一次、超时、断线恢复 |
| Recovery 诊断 | 通过 | `ui-diagnostics-test.mjs`：Recovery 详情、逐项操作和导出完成反馈 |

本轮原生验证使用：

```text
Z:\DevEcoStudioProjects\hmCodex\desktop\src-tauri\target\x86_64-pc-windows-msvc\debug\hmcodex-desktop.exe
```

并由当前源码 Vite 服务提供 `http://127.0.0.1:1420/`。安装目录中的 `C:\Program Files\hmCodex\hmcodex-desktop.exe` 文件时间为 2026-09-11，是旧安装包；它导致过一次导航假失败，不能代表当前源码。

## 仍未达到规格的项目

| 规格区域 | 判定 | 需要补齐的证据或能力 |
|---|---|---|
| Diff / Workspace | 未完成 | 真实文件级和块级 `proposed / executed / verified` 三态数据流、时间线/Workspace/Verifier 之间的跳转 |
| Council | 未完成 | Proposal、Critique、Judge、Probe 的真实运行样本、Probe 选择/执行入口、停止原因和回退入口 |
| Memory 治理 | 未完成 | 敏感性编辑、版本生成、替代关系、冲突处理和完整分类 |
| Recovery | 部分完成 | 远端状态字段、workspace 差异、逐项审批和 Lease 恢复证据的完整呈现；基础“查看状态/安全取消/撤销 Lease”已经有 fixture 和源码入口 |
| Verifier | 部分完成 | 每项检查时间、影响等级、阻断规则和证据到文件/Diff/命令的可解析跳转 |
| Settings | 部分完成 | 已有 10 类入口，但多数是状态面板；权限、导出、恢复、策略和副作用配置流程仍未闭合 |
| 无障碍/设备 | 部分完成 | 自动化媒体查询通过；真实屏幕阅读器、Windows 系统高对比度、触控、2-in-1/tablet/phone companion 未验证 |
| 性能/SLO | 部分完成 | 单次流式和局部 long-task 检查通过；多 Provider、高频长期 p95、超大输出、长期恢复仍无证据 |
| 竞品差距 | 部分完成 | Cursor 风格 Diff/Checkpoint、项目级 Recents 筛选/置顶、独立产物面板和 Memory 版本治理仍缺 |

## 规格审计结果

最新 `ui-spec-gap-audit.mjs`（2026-09-19 07:29）仍为 `PARTIAL`，明确列出：

- Diff 三态的真实块级 UI 和 Runtime 数据流缺失；
- Council 四阶段真实样本和 Probe 入口缺失；
- Memory 敏感性、版本替代、冲突操作缺失；
- Recovery 远端字段和完整逐项恢复操作证据缺失；
- 导出动作与完成反馈已通过。

该审计是源码启发式检查，不能替代真实运行证据；本报告同时保留了真实 Tauri/WebView 测试结果。

## 验收结论

当前版本可以作为**基础界面和安全交互候选**继续使用，不能作为**完整规格验收通过版本**。要达到完整签收，优先级应为：先补 Diff 三态和 Checkpoint/恢复展示，再补 Council Probe、Memory 版本治理、Verifier 元数据/证据跳转，最后补真实设备、屏幕阅读器、长期性能和重新打包后的安装包回归。
