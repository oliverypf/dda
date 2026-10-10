# Linux CLI 命令与输出契约

版本：v1.0
状态：已实现
前提：Linux 终端程序、无图形界面、复用现有 runtime

## 1. 契约原则

1. CLI 是应用层接口，不重新实现 Harness 核心。
2. 机器模式必须可脚本消费，stdout 只输出契约内容。
3. 人类模式允许终端格式化，但最终状态必须能从 runtime event 判断。
4. stderr 用于诊断、日志和不属于机器协议的提示。
5. 无 TTY 时不得隐式批准受控动作。
6. 未识别事件必须保留并以通用事件显示，不得静默丢弃影响状态和安全的事件。

## 2. 命令形式

通用形式：

```bash
dda <command> [subcommand] [options]
```

公共选项：

| 选项 | 说明 |
| --- | --- |
| `--format human|jsonl` | 输出格式；默认 TTY 为 `human`，非 TTY 为 `jsonl` |
| `--config PATH` | 指定模型配置文件 |
| `--data-dir PATH` | 指定 dda 数据根目录，优先级高于 XDG 默认值 |
| `--workspace PATH` | 指定工作区根目录 |
| `--timeout-ms N` | CLI 等待 runtime 的最大时间 |
| `--events stdout` | 直接启用 runtime JSONL 事件流 |
| `--quiet` | 人类模式隐藏非错误进度 |
| `--verbose` | 将更多诊断信息写入 stderr |
| `--help` | 显示命令帮助 |
| `--version` | 显示 CLI、runtime、protocol 和 platform 版本 |

## 3. 命令清单

### 3.1 `health`

```bash
dda health
dda health --format jsonl
```

用途：验证 Node、runtime 入口、配置格式、存储路径和 provider 路由可解析性。

约束：

- 默认不读取 API key 内容；
- 默认不发起模型请求；
- 不启动受控 Executor；
- 不改变任务、Approval、Lease 或 Memory 状态。

### 3.2 `task`

```bash
dda task --workspace /path/to/project --prompt "检查项目结构"
dda task --workspace /path/to/project --prompt "检查项目结构" --format jsonl
```

常用选项：

| 选项 | 说明 |
| --- | --- |
| `--prompt TEXT` | 用户请求；必须是非空文本 |
| `--workspace PATH` | 授权工作区 |
| `--resume` | 续接当前可恢复 Thread |
| `--execution-mode READ_ONLY|CONTROLLED` | 执行模式；Linux 首期默认 `READ_ONLY` |
| `--agent-mode single|multi` | 单 Agent 或受限多 Agent |
| `--approval-mode prompt|deny|jsonl` | 受控动作审批方式 |
| `--model MODEL` | 临时覆盖模型配置 |
| `--events stdout` | 输出 runtime event JSONL |

Linux CLI 不得默认将 `CONTROLLED` 映射为自动批准。无 TTY 的 `CONTROLLED` 任务必须使用 `jsonl` 审批输入，或直接返回 `APPROVAL_UNAVAILABLE`。

### 3.3 `thread`

```bash
dda thread list
dda thread get --thread-id THREAD_ID
dda thread create --title "项目检查"
dda thread fork --thread-id THREAD_ID --title "实验分支"
```

线程数据继续由 runtime 的 Thread Store 和 Harness Event Store 管理。CLI 不维护第二份线程事实源。

### 3.4 `thread-events`

```bash
dda thread-events --thread-id THREAD_ID
```

输出线程历史事件。分页、cursor、未知事件和脱敏规则复用现有 runtime 命令。

### 3.5 `recovery`

```bash
dda recovery
dda recovery --workspace /path/to/project
```

只对账孤立的 Approval、Lease、Intent、RoleContext 和 Dream 状态，不自动重放任务，不自动执行副作用。

### 3.6 `tools`

```bash
dda tools --workspace /path/to/project
dda tools --workspace /path/to/project --tool workspace.read
```

只读阶段允许列出工具和调用只读 workspace 工具。受控工具必须经过原有 Runtime Safety 链。

### 3.7 诊断命令

```bash
dda support-info
dda support-bundle --output PATH
dda dashboard
dda metrics
dda capacity
```

诊断输出默认脱敏，不包含原始 prompt、模型全文、hidden reasoning、API key、完整源代码和未过滤命令输出。

## 4. 输出契约

### 4.1 Human 模式

- 进度、heartbeat、诊断写入 stderr；
- 最终用户结果写入 stdout；
- 终端提示不得改变 runtime event 的顺序；
- 状态名称使用 runtime 原值，显示层可以增加中文解释；
- 错误显示错误码、简短说明和建议动作，不显示凭据或完整敏感输入。

示例：

```text
运行中  run-123  workspace=/work/demo
阶段    READING_WORKSPACE
阶段    PLANNING
完成    SUCCEEDED
```

### 4.2 JSONL 模式

stdout 每行必须是一个完整 JSON 对象。runtime event 使用现有 `runtime-event.schema.json`，示意：

```json
{"type":"runtime_event","schemaVersion":"1.0","runId":"run-123","sequence":1,"kind":"run.started","payload":{"executionMode":"READ_ONLY"},"emittedAtMs":0}
```

最终结果是单独的一行：

```json
{"ok":true,"runId":"run-123","threadId":"thread-123","state":"SUCCEEDED","text":"..."}
```

错误结果：

```json
{"ok":false,"runId":"run-123","error":{"code":"WORKSPACE_NOT_FOUND","message":"工作区不存在"}}
```

规则：

- stdout 不允许出现普通日志、进度文本或调试堆栈；
- stderr 可以有日志，但不能被 JSONL 解析器当作协议输入；
- `sequence` 只在同一个 run 内递增；
- 重连、重放或重复读取时使用 `runId + sequence + eventId` 去重；
- 不认识的 `kind` 必须原样保留。

### 4.3 事件到人类显示的最小映射

| Event kind | Human 显示 |
| --- | --- |
| `run.started` | 任务开始 |
| `runtime.phase` | 当前阶段 |
| `runtime.heartbeat` | 可选活动指示 |
| `approval.requested` | 展示动作和审批信息 |
| `approval.resolved` | 展示批准或拒绝 |
| `action_intent.created` | 展示已建立受控动作 |
| `tool.started` / `tool.completed` | 展示工具调用摘要 |
| `runtime.error` | 展示错误码和脱敏信息 |
| terminal event | 展示成功、失败、取消或暂停 |

## 5. 退出码

CLI 退出码必须稳定，具体 shell 映射如下：

| 退出码 | 常量 | 说明 |
| ---: | --- | --- |
| `0` | `SUCCESS` | 命令完成，任务成功或查询成功 |
| `1` | `RUNTIME_ERROR` | 未分类 runtime 错误 |
| `2` | `USAGE_ERROR` | 参数、子命令或格式错误 |
| `3` | `CONFIG_ERROR` | 配置不存在、格式错误或 provider 不可用 |
| `4` | `WORKSPACE_ERROR` | 工作区不存在、越权、敏感路径或读取失败 |
| `5` | `APPROVAL_DENIED` | 用户拒绝、审批过期或无可用审批通道 |
| `6` | `SAFETY_BLOCKED` | Runtime Safety、Lease、Verifier 或策略拒绝 |
| `7` | `CANCELLED` | 用户取消、SIGTERM 或任务取消 |
| `8` | `PROTOCOL_ERROR` | event/result 不符合契约 |
| `9` | `STORAGE_ERROR` | 数据库、迁移、容量或持久化失败 |
| `10` | `DEPENDENCY_ERROR` | Node、runtime 依赖或 provider 依赖缺失 |
| `130` | `SIGINT` | 默认对应 Ctrl+C；任务记录仍须有取消终态 |

## 6. 配置与路径

### 6.1 优先级

从高到低：

1. 命令行参数；
2. `HMCODEX_*` 显式环境变量；
3. 配置文件；
4. Linux XDG 默认路径；
5. 内置安全默认值。

### 6.2 默认路径

| 用途 | 默认路径 |
| --- | --- |
| 配置 | `${XDG_CONFIG_HOME:-$HOME/.config}/hmcodex/model-config.json` |
| 数据 | `${XDG_DATA_HOME:-$HOME/.local/share}/hmcodex/` |
| 状态 | `${XDG_STATE_HOME:-$HOME/.local/state}/hmcodex/` |
| 缓存 | `${XDG_CACHE_HOME:-$HOME/.cache}/hmcodex/` |
| 日志 | `${XDG_STATE_HOME:-$HOME/.local/state}/hmcodex/logs/` |
| 插件 | `${XDG_DATA_HOME:-$HOME/.local/share}/hmcodex/plugins/` |

`HMCODEX_DATA_DIR` 指定数据根目录时，所有 runtime store 必须从同一个解析结果派生，不能一部分落到 XDG、一部分落到当前目录。

### 6.3 权限

- 新建目录默认 `0700`；
- 配置和包含模型连接信息的文件默认 `0600`；
- 不把 API key 写入配置、事件、日志或支持包；
- 发现权限过宽时可以告警或拒绝加载敏感配置；
- 路径变更必须输出旧路径、目标路径、迁移状态和失败原因。

## 7. 信号、取消和生命周期

### 7.1 `SIGINT`

1. CLI 首次收到 SIGINT，向 runtime 发出取消请求；
2. 继续读取有限时间内的终态事件；
3. runtime 进入 `CANCELLED` 或明确失败终态后退出；
4. 第二次 SIGINT 允许强制终止，但 CLI 必须在 stderr 给出提示。

### 7.2 `SIGTERM`

- 转发到 runtime 进程组；
- 停止接受新的 Approval 输入；
- 清理子进程和临时文件；
- 下一次 `recovery` 必须能够对账遗留状态。

### 7.3 超时

- CLI 超时不等于动作已取消；
- 无法确认动作是否执行时，结果标记为 unknown；
- 不使用同一个 Lease 自动重试；
- recovery 负责收敛孤立状态。

## 8. Approval 输入契约

JSONL 审批输入格式：

```json
{"type":"approval_response","requestId":"approval-123","approved":true,"displayedDigest":"sha256:..."}
```

规则：

- `requestId` 必须匹配当前等待中的请求；
- `displayedDigest` 必须等于 runtime 发出的 digest；
- 缺字段、JSON 无效或 digest 不一致直接拒绝；
- Approval 只针对当前动作和当前 Lease；
- CLI 不得缓存“以后自动批准”状态。

TTY 模式可以把 `y/N` 转换成同一 JSONL 消息，但不能绕过 digest、过期时间和 runtime 状态机。

## 9. 安全和隐私

- 默认 `READ_ONLY`；
- shell、file.write、test.execute、network.request 默认关闭；
- 工具输入由 runtime schema 校验；
- CLI 不解析模型文本中的命令并直接执行；
- stdout、stderr、日志和支持包都要经过敏感信息过滤；
- Workspace scope、PolicyLease、Approval、Rule Verifier 和 Executor 是最终权威；
- CLI 只展示事实，不把自然语言提示当成权限。

## 10. 兼容与版本

CLI 自身版本、Harness Protocol、Storage Schema、Plugin API 和 Decision Trace 版本分别记录。

JSONL 客户端必须：

- 忽略自己不理解的可选字段；
- 保留不理解的事件 envelope；
- 对不理解且影响状态的事件返回 `PROTOCOL_ERROR` 或进入 `PAUSED_UNSUPPORTED`；
- 不假设事件顺序之外的隐含状态；
- 不修改 runtime event 的字段名和 digest。

