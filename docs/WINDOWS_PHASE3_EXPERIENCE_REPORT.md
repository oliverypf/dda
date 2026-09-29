# Windows 阶段三：产品体验观察与发布报告

版本：v1.0
日期：2026-09-12
> **历史报告说明**：本文只用于追溯当时候选版本的体验证据。文中旧的 OpenViking、LLM-as-a-Verifier、语义 Verifier 或 Candidate Judge 描述已被 [Jev Decision Plane 设计](JEV_DECISION_PLANE_DESIGN.md) 取代。

状态：阶段三源码实现已可构建验证；真实安装包与设备验收待执行
依据：[WINDOWS_PHASE3_PRODUCT_EXPERIENCE_PLAN.md](WINDOWS_PHASE3_PRODUCT_EXPERIENCE_PLAN.md)、[UI_UX_SPEC.md](UI_UX_SPEC.md)、[WINDOWS_PHASE3_ACCEPTANCE_MATRIX.md](WINDOWS_PHASE3_ACCEPTANCE_MATRIX.md)

## 1. 已满足项

- 六个一级页面已升级为真实页面：工作台、运行记录、工作区、记忆、能力与安全、设置与诊断，导航切换和页面状态恢复可用。
- Composer 提交有稳定 receipt，展示 pending/accepted/rejected；运行状态有标签和下一步提示。
- Route/候选摘要面板消费现有 decisions 与 modelEgress，不新增运行时契约。
- Approval/Safety 卡片抽成复用渲染，在工作台主区展示待确认审批。
- Verifier 连续验证/过程验证证据和工作台时间线技术详情已接入，事件回放携带 eventId/sequence/operationId/digest。
- 运行记录页面从占位升级为真实 run 列表。
- 设置与诊断页面展示运行时状态、Support Bundle 摘要和恢复检查入口。
- 无障碍/响应式已补 reduced-motion、触控目标、safe-area、高对比与焦点环。
- `desktop npm run build` 通过，`npm run test:phase3-evidence` 通过（17 项标记检查），并生成 `docs/artifacts/WINDOWS_PHASE3_EVIDENCE.json`。

## 2. 豁免项与已知限制

- Terminal 证据工作区已落地；文件块级 Diff 详情仍待补。
- Route 面板已支持用户固定模型或自动路由，选择持久化并透传给新 run。
- 运行记录页已实现本地分页、单 run 时间线查看，并将单 run 筛选持久化（`hmcodex.focusedRunId`）；Decision DAG 已复用到工作台主区；恢复、导出和删除 tombstone 仍待补。
- Memory/Dream/Plugin/Evolution 管理仍以右侧治理面板展示，独立管理页面未完整实现。
- Recovery 视图只做了只读恢复检查，未完全覆盖断线后重连、未知外部结果、版本不兼容等场景。
- 可访问性和性能相关项大部分是 CSS/CSS 媒体查询级实现，需真实设备与辅助技术验收。
- 部分验收项依赖真实 Windows 安装包，当前未执行实机场景矩阵。

## 3. 性能数据

- 最近一次 `desktop npm run build`：Vite 产物约 107.54 KB JS、25.23 KB CSS，构建约 2 秒。
- 时间线已有分页 cursor；尚未做高频事件压测、超大 diff 和诊断列表的虚拟化/性能记录。

## 4. 回归风险

- 本次改动集中在 `desktop/src/main.ts` 与 `desktop/src/styles.css`，需要回归现有 Phase 1/2 的受控执行、Approval、Verifier、ReadModel 与安装包流程。
- 新增 `TimelineItem` 可选字段为向后兼容，但需确认 runtime projection 的旧事件不会因展开详情缺失而改变行为。
- route/approval/runs/diagnostics 等新增面板均消费已有模型字段，仍需在真实 runtime dashboard 上验证无重复渲染或错误跳转。

## 5. 下一步发布动作

1. 运行真实 Windows 安装包场景矩阵（只读、批准、阻断、断线恢复、治理撤回/删除）。
2. 完成键盘、屏幕阅读器、高对比、字体放大、窄屏和 2in1 触控验收。
3. 补齐 Diff/Terminal 独立证据视图与 Route 模型固定交互。
4. 将既有 G2/G3/G4 指标回归记录追加到本报告后作为 G5 发布证据。
