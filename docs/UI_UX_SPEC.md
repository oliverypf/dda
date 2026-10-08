# dda HarmonyOS PC UI/UX 规范

版本：v1.1  
状态：Phase 1 交互基线

## 1. 体验原则

- 用户始终知道 Agent 正在做什么、为什么选择该路径、是否产生副作用。
- 安全确认必须清晰且可拒绝，不能用“自动化感”掩盖权限变化。
- UI 展示结构化事件、证据和简短理由，不展示或要求模型隐含思维过程。
- 流式更新可打断、可取消、可恢复；错误不清空已有结果。
- PC 键鼠效率与触控/无障碍同等重要。

## 2. 信息架构

2in1 宽屏默认三栏：

```text
┌──────────────┬──────────────────────────────┬─────────────────────┐
│ Projects     │ Task / Conversation Timeline │ Context             │
│ Threads/Runs │ Composer / Diff / Terminal    │ Route / Safety      │
│ Search       │ Active approval / Evidence    │ Workspace / Verify  │
└──────────────┴──────────────────────────────┴─────────────────────┘
```

主导航：

1. **工作台**：任务、时间线、输入和当前产物。
2. **工作区**：授权 root、目录、文件、diff 和 snapshot。
3. **运行记录**：Trajectory 回放、筛选、导出和恢复。
4. **记忆**：active/proposed/revoked Memory 与来源。
5. **能力与安全**：模型/角色、Plugin、Profile、策略和 endpoint。
6. **设置/诊断**：连接、存储、隐私、支持包和平台能力。

窄屏按相同信息层级拆成页面，不删除 Approval/Safety/Rule Verifier/Jev 关键信息。

## 3. HarnessReadModel

UI 只消费稳定投影：

```ts
interface HarnessReadModel {
  projectionVersion: number;
  lastEventSequence: number;
  connection: ConnectionReadModel;
  activeRun?: RunSummaryReadModel;
  timeline: PagedTimelineReadModel;
  composer: ComposerReadModel;
  approvals: Array<ApprovalReadModel>;
  route: RouteExplanationReadModel;
  decisionTrace: PagedDecisionTraceReadModel;
  safety: SafetyReadModel;
  verifier: VerifierReadModel;
  workspace: WorkspaceReadModel;
  budgets: BudgetReadModel;
  recoverability: RecoverabilityReadModel;
}
```

Read model 字段只用于展示。UI 命令携带 `expectedRunVersion`、approval display digest 和 commandId，Core 重新校验。

## 4. Run 状态呈现

每个状态使用“动词 + 对象 + 可执行下一步”：

| 状态 | 主文案 | 用户操作 |
| --- | --- | --- |
| CLASSIFYING/PRECHECKING | 正在识别任务与风险 | 取消 |
| ROUTING | 正在选择角色、模型和能力 | 查看候选、取消 |
| PLANNING | 正在制定下一步 | 查看计划摘要、暂停/取消 |
| WAITING_APPROVAL | 需要你的确认 | 审阅、批准一次、拒绝、取消任务 |
| EXECUTING | 正在读取/执行已批准动作 | 查看输出、暂停/取消 |
| VERIFYING | 正在核验证据 | 查看检查项 |
| DIAGNOSING | 发现停滞，正在比较假设 | 查看假设/最小 Probe |
| PAUSED/RECOVERING | 已暂停/正在确认外部结果 | 恢复、取消、查看原因 |
| SUCCEEDED | 已验证完成 | 查看证据、diff、导出 |
| FAILED | 未达到验收条件 | 查看失败与建议 |
| QUARANTINED | 因安全原因已隔离 | 查看事件、导出、人工恢复流程 |

颜色不是唯一状态编码；同时使用文本、图标和可访问标签。

## 5. 时间线

标准时间线项：用户消息、Agent 结果、结构化 Agent 决策、计划摘要、模型/角色选择、workspace 读取、候选选择、ActionIntent、Jev 工具门禁、安全判定、Approval、执行、命令输出、diff、Rule Verifier、Jev 行为判断、诊断、Profile/Policy 变化和系统错误。

- 高频 token/output delta 在 UI 合并更新，完成后变为稳定 item。
- 每项有 stable event/item ID、时间、状态、来源角色和可展开证据。
- 默认展示人类可读摘要；“技术详情”显示 event code、operationId、版本和 digest。
- 失败 item 不消失；重试作为关联新 item。
- 未知显示事件用通用卡片；未知关键事件显示“版本不兼容，已安全暂停”。
- 长时间线游标分页，回到页面保持滚动锚点；新事件不会强制把正在阅读历史的用户拉到底部。

## 6. Composer 与任务授权

输入区包含目标文本、workspace、模式（只读/受控写入）、角色配置、附件和预算摘要。

- 默认模式为 `READ_ONLY`；切换受控写入只改变候选权限上限，不预先批准任何动作。
- 提交前显示当前 workspace 和 endpoint，防止发往错误环境。
- `Enter`/`Ctrl+Enter` 行为可配置但必须一致；发送后使用 commandId 防双击重复。
- 活动 run 中的新文本由产品明确区分“steer 当前 run”和“创建新 run”，按钮/快捷键不混用。
- 无法支持的能力在提交前解释，不在运行中静默回退。

## 7. Approval Card

Approval 是主时间线内的高优先级卡片，并同步出现在右侧“待确认”区域。卡片必须展示：

- 请求动作和目的；
- 完整或安全格式化的 command/目标/diff；
- workspace、cwd、规范化路径或网络 host；
- 会读/写/删/执行/上传什么；
- sandbox、资源限制、风险 reason codes；
- 请求者角色/Plugin/Executor；
- 有效期和“只批准这一次”；
- 展示内容 digest 的技术详情。

按钮：`批准一次`、`拒绝`、`取消任务`。高风险操作不提供模糊的“总是允许”。键盘操作需要明确焦点和二次防误触，但不能让拒绝更困难。

批准后显示“正在重新检查策略”，只有 `PolicyLeaseIssued` 后才显示“已授权执行”。过期/被替换的卡片不可再点击。

## 8. Route、角色与模型

右侧 Route 面板显示：Task class/risk、候选数量、被安全排除的原因、最终拓扑、Planner/Executor 的实际 provider/model/effort/Agent/Skill、Jev 决策源/模型/版本、fallback、预算和 capability snapshot 时间。

- Luna/Sol 只作为用户可选 preset label，不作为固定角色。
- 默认展示简短原因码和分数分量，不伪造自然语言“内心推理”。
- 用户可以固定模型或批准集合；改配置只影响后续 resolution，运行中改变需新 snapshot/重新路由。
- 模型不可用显示明确 fallback 或暂停选择，不静默换模型。

### 8.1 Agent 决策轨迹

运行记录和右侧 Context 提供“决策轨迹”视图，以 step 为主轴、Agent 为泳道，展示 Decision DAG，而不是模拟群聊或思维直播。每张决策卡至少显示：

- 决策类型、Agent/角色、模型与 binding snapshot、发生时间和状态；
- 当时目标、硬约束、可见 evidence refs、已声明假设和不确定项；
- 候选方案、预测能力/成本/风险、被选方案和可枚举 reason codes；
- 可检验预期，以及后挂的执行、Verifier、用户反馈和 Credit/Blame；
- `parent`、`supersedes`、`critiques`、`selects` 和 `outcome` 关系。

默认层只显示一句结构化摘要、选择和结果；展开后显示候选比较和证据。事实、模型自报和系统判定使用不同视觉标签。`PROPOSED`、`REJECTED`、`ABSTAINED`、`INVALIDATED` 不得渲染成已执行；存在 `supersedes` 关系时显示“已被新决策替代”，但仍如实保留旧决策已经发生的 Outcome。缺少 outcome 显示“尚未验证”，不能显示成功。

UI 明确说明“这里是可审计的决策摘要，不是模型隐藏思维”。Provider reasoning summary 若存在，默认折叠并标记“供应商生成、未验证、不可作为授权或证据”，且受独立隐私开关控制。用户可以按 Agent、Jev、类型、状态、step 和结果筛选，并从决策跳转到对应证据、ActionIntent、Rule Verifier 报告、Jev 判断和 Memory Proposal。

## 9. Safety 与 Profile

Safety 面板分开显示：

- 当前动作判定：decision、required controls、scope、policy version；
- 长期治理阶段：ALLOW/MONITOR/CONFIRM/SANDBOX/DENY/QUARANTINE；
- 最近证据：成功、拒绝、近失误、安全事件；
- 权限上限来源：系统/企业/项目/角色/Plugin/Profile。

收紧即时可见；放开显示样本窗口、人工门槛和不会超过的上限。用户不能通过 UI 单击绕过硬规则；可提交审查/恢复操作。

## 10. Rule Verifier、Jev 与证据

验证面板按检查项展示 `PASS/FAIL/UNKNOWN/SKIPPED`、证据来源、时间和影响：编译/测试、静态检查、diff、目标覆盖、安全、过程进展和语义检查。确定性检查标记为 Rule Verifier；语义判断显示 Jev 的 decision、reason codes、证据摘要、fallback 和延迟，不显示独立语义模型身份。

- `UNKNOWN` 不使用绿色或“完成”；高风险 unknown 阻止成功。
- 模型式判断明确标记“语义评估”，与确定性检查区分。
- 点击证据跳转到对应文件/diff/命令输出/事件，不展示隐藏推理。
- 最终成功页列出满足的验收项和仍存在的非阻断风险。

## 11. Workspace、Diff 与 Terminal

- Workspace 面板显示授权 root、snapshot/stale 状态和来源（本地 Picker/远端）。
- 打开文件显示路径、encoding、digest/snapshot，超大/二进制文件安全降级。
- Diff 以文件/块呈现，区分 proposed、executed、verified；不能把模型建议误标为已写入。
- Terminal/命令输出是 Executor event renderer；显示 cwd、exit、duration、截断和 redaction 状态。
- ANSI/PTY 渲染故障不影响 operation 状态；原始流与语义事件分层处理。
- 用户复制命令/输出时提示被脱敏或截断。

## 12. 多 Agent 审议

Council UI 展示：问题、各 Proposal 的 claim/evidence、Critique 指向的具体 claim、Jev 决策、选择的 Probe、预算/轮数和 `ABSTAIN`。不展示 chain-of-thought，不用拟人化聊天气泡制造虚假独立性。

- 角色/模型是否真正不同清楚标注。
- 多数同意不是通过证据；最终仍回到 Safety/Executor/Rule Verifier/Jev。
- 用户可停止审议并回退单 Agent。
- 达到预算、无收敛或错误共识风险时显示停止原因。

## 13. Dreaming 与 Memory

Memory 页面分 `已启用`、`待确认`、`冲突`、`已撤回`：

- 每条显示结论、来源 run/event、置信度、有效期、适用 scope、敏感性和替代关系；
- 用户可批准、编辑（生成新版本）、拒绝、撤回和删除；
- 安全事实与普通偏好区分，不能通过普通清理隐式放权；
- Dream 运行中显示只读、预算、收集范围和进度；
- 自动 Dream 默认关闭，设备/后台不满足时解释原因。

## 14. 错误、断线与恢复

错误文案包含：发生了什么、是否有副作用可能、系统已采取什么保护、用户下一步。隐藏 provider stack，仅在技术详情给错误码。

- 断线保留时间线和取消入口；未知外部结果用高可见警示，不显示“失败所以没执行”。
- 恢复页列出远端状态、workspace 差异、未决审批和被撤销 lease。
- 数据库/存储故障时进入只读维护，提供导出/恢复，不显示空白新项目覆盖旧数据。
- 版本不兼容显示 endpoint/app/schema 版本和安全升级路径。

## 15. 设置与管理

设置分区：连接与身份、workspace grants、角色与模型、Plugin、Safety/审批、Memory/Dream、隐私/保留、存储、无障碍、开发诊断。

- 敏感值只显示状态/末尾指纹，不提供明文回显。
- 危险设置有影响说明、当前策略上限和重启/新 run 生效范围。
- 企业锁定项只读并显示来源。
- 恢复默认不会删除数据；删除/重置是独立流程并列出范围。

## 16. 无障碍与输入

- 所有图标按钮有 label/description，动态进度使用适度 live region，避免 token delta 持续打断朗读。
- 焦点顺序遵循视觉结构；Approval 出现不抢走正在输入的焦点，但有可感知通知和快捷跳转。
- 完整键盘可达：导航、发送、暂停、取消、打开详情、切换面板；批准不使用易误触的单键全局快捷键。
- 支持字体缩放、高对比、深浅色、减少动画和色觉差异。
- 触控目标满足平台尺寸；鼠标提供 hover/右键但无关键功能只藏在 hover。

## 17. UI 性能与一致性

- Store/read model 更新按 projectionVersion 应用；旧版本丢弃，新版本缺口触发重新读取。
- 每个 command 有 pending/accepted/rejected 状态，重复点击返回原 receipt。
- 流式文本按 16–100 ms 窗口合并；后台页面降低刷新频率但不丢关键事件。
- 列表、diff、文件和日志分页/虚拟化；不把完整 Trajectory 放入组件状态。
- 页面恢复使用 runId/eventId/scroll anchor，不依赖数组索引。

## 18. 交互验收

必须在 2in1、tablet、phone companion 和键盘/触控下覆盖：

- 提交/重复提交/steer/新 run；
- 每个 TaskRun 状态和所有终态；
- Approval approve/decline/expire/supersede/断线；
- 只读与受控写入不会混淆；
- Route fallback、Verifier unknown、outcome unknown 和 quarantine；
- Decision Trace 的候选/选择/证据/outcome 展开、DAG 跳转、筛选、修订、abstain 和来源标签；
- 决策缺少 outcome、证据已删除或 provider summary 关闭时，UI 不伪造解释、不错误显示成功；
- 长时间线、超大输出、diff、窗口缩放和重启恢复；
- Screen reader、键盘、字体放大、高对比；
- Support bundle/导出/删除/企业锁定；
- UI 显示状态延迟时，过期命令被 Core 拒绝且界面正确刷新。
