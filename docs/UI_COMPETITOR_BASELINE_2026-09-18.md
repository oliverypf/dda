# UI/UX 竞品基线（2026-09-18）

范围：只记录官方公开文档明确描述的能力，用来检查 dda 的界面和功能缺口；不把竞品能力当作 dda 必须一比一复制的需求。

| 维度 | ChatGPT Desktop | Claude Artifacts / Desktop | Cursor Agent | dda 当前验收结论 |
|---|---|---|---|---|
| 工作空间/项目 | Desktop 将 Chat、Work、Codex 放在同一应用，Recents 可排序、筛选、置顶，Projects 可复用项目上下文 | Claude 可从桌面链接直接跳到 project/chat/code session | Agent 围绕代码仓库、规则、MCP 和会话工作 | dda 有六页导航、线程/运行记录和 workspace grant；项目级上下文、Recents 筛选/置顶仍不完整 |
| 产物与结果 | Work 支持文档、表格、演示、报告和 Sites 工作流 | Artifact 在主聊天右侧独立窗口展示，可继续交互 | Agent 对代码修改提供专门 Review changes 入口 | dda 有工作区预览、Terminal/Verifier 摘要；独立产物面板仍缺 |
| Diff / 回退 | 公开桌面文档强调跨页面/文件工作，但未把代码 Diff 作为该页面的核心说明 | Artifact 版本/交互能力强调产物本身 | Review changes 显示完整 Diff；Checkpoints 可预览并恢复之前的代码状态 | dda 当前没有 proposed/executed/verified 文件/块 Diff，也没有面向用户的 checkpoint restore；这是 §11 的明确缺口 |
| 权限与安全 | 内置浏览器和 Site tools 有显式权限提示，可在设置中关闭 | 桌面/本地文件能力按产品权限运行 | Run modes、Auto-review 和安全设置说明 Agent 命令执行边界 | dda 的 READ_ONLY/CONTROLLED、Approval、PolicyLease、Verifier 证据更细；但 purpose、影响范围、requester/plugin/executor、superseded/revoked 字段仍不足 |
| 记忆与可编辑上下文 | Memory summary 可查看、编辑、删除，支持关闭和 Temporary Chat | Artifacts 更偏产物持久化与交互 | Checkpoints 保存代码状态，规则/MCP 可定制 Agent 上下文 | dda 有 active/proposed/revoked Memory 页面和删除操作；新版本、替代关系、冲突/敏感性分类仍缺 |
| 验收重点 | 关注跨应用/浏览器工作流和权限提示 | 关注右侧产物可见性与交互 | 关注 Diff、Checkpoint、Review、命令安全 | dda 的差异化强项是可审计 runtime event、逐项 Verifier、审批和证据导航；近期仍应优先补 Diff 分层、Checkpoint/恢复入口和真实 provider 流式反馈 |

## 当前优先级

1. **P0：Diff 数据和 UI**。至少建立文件/块级 `proposed`、`executed`、`verified` 三态，并让时间线、workspace 和 Verifier 证据互相跳转。
2. **P0：真实流式反馈**。当前真实 provider 任务约 68 秒后结束且未出现可观察 `STREAMING` 行；需要确认 provider SSE、Rust stdout 转发和 WebView 事件订阅链路。
3. **P1：Checkpoint/恢复**。把 run/event/workspace snapshot 绑定成可恢复节点，展示恢复前后差异和未决审批。
4. **P1：设置完整性**。规格要求 10 类设置，目前 UI 只覆盖模型、个性化、连续验证 3 类。
5. **P1：Memory 版本治理与 Council UI**。补版本、替代、冲突、敏感性，以及 Proposal/Critique/Judge/Probe 的可审计展示。

## 官方来源

- OpenAI Help Center：Moving to the new ChatGPT desktop app；Using the built-in browser in the ChatGPT desktop app；Memory FAQ。
- Anthropic Help Center：What are artifacts and how do I use them?
- Cursor Docs：Agent overview；Diffs & Review；Checkpoints；Run Modes / Agent Security。
