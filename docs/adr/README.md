# dda Architecture Decision Records

ADR 记录长期、难以逆转或跨模块的设计选择。专项规范描述当前规则，ADR 说明为什么做出该选择以及替代方案为何没有采用。

## 状态

- `Proposed`：讨论中，不能作为实现依据。
- `Accepted`：已接受，专项规范和代码必须遵守。
- `Superseded`：被后续 ADR 取代，保留历史。
- `Deprecated`：仍兼容但不用于新实现。
- `Rejected`：明确不采用。

## 编号和模板

文件名：`NNNN-short-title.md`，编号只增不复用。

```md
# ADR-NNNN: 标题

- Status: Proposed
- Date: YYYY-MM-DD
- Deciders: ...
- Supersedes: none

## Context
## Decision
## Consequences
## Alternatives considered
## Verification
```

涉及信任边界、依赖方向、协议 major、Storage Schema、Plugin API major、后台执行或自动放权的改动必须新增 ADR。Accepted 前必须同步安全、兼容、迁移、评价和回滚影响。

## 已接受决策

| ADR | 决策 |
| --- | --- |
| [0001](0001-ports-and-adapters.md) | Core 只依赖领域 Port，供应商协议留在 Adapter |
| [0002](0002-event-driven-run-state.md) | TaskRun 使用追加事件和可重建投影 |
| [0003](0003-policy-lease-for-side-effects.md) | 所有副作用通过一次性 PolicyLease |
| [0004](0004-remote-executor-first.md) | HarmonyOS 本地运行时按设备能力、平台 POC 和安全契约门控 |
| [0005](0005-structured-agent-decision-trace.md) | 关键 Agent 决策使用结构化、先提交后行动、结果后挂的 Decision Trace，不保存隐藏思维链 |
| [0006](0006-multi-platform-clients.md) | HarmonyOS、Windows、Linux 是同一产品的不同客户端构建，共享协议并优先使用本地运行时；Gateway 仅为可选远程适配器 |
| [0007](0007-windows-dream-maintenance-supervisor.md) | Windows 由 Tauri 托管独立 Dream daemon，动态活动任务计数 fail-closed |
| [0021](0021-candidate-failed-egress.md) | 候选调用的出域审计不由选择结果决定；失败与取消同样记录有界完成事实，只保留 digest 与固定失败码 |
| [0022](0022-prompt-cache-stable-prefix.md) | Provider prompt cache 使用稳定前缀和 usage accounting，作为 Windows Phase 4 的缓存治理基线 |
| [0023](0023-linux-cli-client.md) | Linux 首期采用无界面 CLI，复用 Node/Cordis runtime，通过 Linux 平台适配层接入 |

## 编号缺口

现存 ADR 为 `0001`–`0007`、`0021`–`0023`，共 10 份。

- `0008`–`0020` 是**未分配编号（never allocated）**：这些文件从未存在，也没有任何文档、代码或测试引用它们。看到编号跳跃不表示记录丢失或被删除，不需要寻找或补写。
- `0021` 保持现有编号不变：`WINDOWS_PHASE2_PROGRESS.md` 已按该编号引用它，重编号会打断既有证据链。
- 编号只增不复用，因此下一份新 ADR 从 `0024` 开始；不要回填 `0008`–`0020`。
- `0021-candidate-failed-egress.md` 目前未使用本文件的标准模板（缺 `Status` / `Date` / `Deciders` 头，正文为英文契约说明）。内容有效，但后续修订时建议补齐头部字段以便与其他 ADR 一致。
