# dda CLI

`dda`（兼容别名 `hmcodex`）是无界面终端程序，同一套 Node 入口可以在 Linux、Windows 和鸿蒙 PC 上运行。它不包含 Tauri、Web UI 或 ArkUI，只负责参数、JSONL、审批输入、退出码和进程生命周期。任务、安全、模型和事件仍由 `runtime/` 执行。

启动时按当前系统选择平台：

| 系统 | 平台标识 | 数据目录 |
| --- | --- | --- |
| Linux | `linux-cli` | XDG，默认 `~/.local/share/hmcodex` |
| Windows | `windows-cli` | `%LOCALAPPDATA%\hmCodex`，与桌面端共用 |
| 鸿蒙 PC | `harmonyos-cli` | 有 XDG 或 `HOME` 时使用同一套家目录布局 |

鸿蒙 PC 如果 Node 把 `process.platform` 报成 `linux`，只要系统描述、`OHOS_SDK_HOME` 或 `HARMONYOS_SDK_HOME` 能看出鸿蒙，仍会使用 `harmonyos-cli`。也可以显式设置 `HMCODEX_PLATFORM`。鸿蒙上的 ArkUI 应用仍是独立客户端；这个 CLI 只在该机器提供 Node.js 24 或更新版本时运行。

## 要求

- Linux x86_64、glibc
- Node.js 24 或更新版本（`package.json` 的 `engines` 要求 `>=24.0.0`）
- 不需要桌面会话、`DISPLAY` 或 Wayland

## 安装

在仓库根目录：

```bash
chmod +x linux-cli/bin/dda.mjs
node linux-cli/bin/dda.mjs --version
```

也可以把 `linux-cli/bin` 加入 `PATH`，之后直接运行 `dda`。Windows 可以使用 `linux-cli/bin/dda.cmd`。发布形态目前是仓库内的 Node 入口；deb、AppImage、ARM64、musl 和单文件打包还没有做。

## 数据目录

未指定路径时使用 XDG：

| 用途 | 默认路径 |
| --- | --- |
| 配置 | `${XDG_CONFIG_HOME:-$HOME/.config}/hmcodex/model-config.json` |
| 数据 | `${XDG_DATA_HOME:-$HOME/.local/share}/hmcodex/` |
| 状态 | `${XDG_STATE_HOME:-$HOME/.local/state}/hmcodex/` |
| 缓存 | `${XDG_CACHE_HOME:-$HOME/.cache}/hmcodex/` |
| 日志 | `${XDG_STATE_HOME:-$HOME/.local/state}/hmcodex/logs/` |

`--data-dir` 和 `HMCODEX_DATA_DIR` 会覆盖数据根目录，所有 store 都从这一次解析结果派生。新建目录使用 `0700`。密钥只在对应平面仍指向默认主机时才自动传递：模型平面默认传 `OPENCODE_GO_API_KEY`，Jev 平面默认传 `JEV_API_KEY`。一旦用配置或 `HMCODEX_MODEL_ENDPOINT` / `HMCODEX_JEV_ENDPOINT` 改写了端点，就必须用 `apiKeyEnv`（或 `HMCODEX_MODEL_API_KEY_ENV` / `HMCODEX_JEV_API_KEY_ENV`）为该主机显式命名密钥变量——默认密钥不会被发到被改写的主机。被命名的密钥变量会传给子进程，未声明的密钥环境变量会被去掉。API key 不会写入配置、事件或支持信息。

Windows CLI 使用上面表格里的 `%LOCALAPPDATA%\hmCodex`。未设置 `HMCODEX_PLATFORM` 的 runtime 仍保持原来的 Windows 目录规则，避免在 Linux 上跑 Windows 测试时改掉路径。

## Jev 决策

Jev 需要每个部署显式开启，满足下面任一条件才算“已配置”：

- 部署本地的 `model-config.json` 里有 `decision` 块；
- 环境里设置了任意 `HMCODEX_JEV_*` 变量，例如 `HMCODEX_JEV_ENABLED=1`，或 `HMCODEX_JEV_ENDPOINT` + `HMCODEX_JEV_API_KEY_ENV`。

已配置后 `enabled` 默认为 true，再加上对应密钥变量有值，runtime 才会真正调用 Jev。只设置 `JEV_API_KEY` 不会开启 Jev。`HMCODEX_JEV_ENABLED=0` 或 `decision.enabled: false` 可以在已配置的部署里关掉它。没开启、缺密钥、超时或返回无效时，决策层记为规则兜底（`source: rule`），保持保守：只读工具可以继续，副作用仍走审批，行为判定为 `UNCERTAIN`。任务结果里的 `decisionLayer.enabled` / `configured` 反映实际状态。

未改写端点时，默认直连 TypeSafe 官方 System One 接口（`https://api.typesafe.ai/v1/systemone`，密钥变量 `JEV_API_KEY`）。密钥和端点由各自部署的环境在本地提供，仓库不预置具体部署的密钥配置。

如需换到别的 System One 主机（例如 OpenRouter），在部署本地的 `model-config.json` 里写 `decision` 块，为新端点命名 `apiKeyEnv`；完整的文件示例见 `runtime/model-config.example.json`。

- 路径是 `systemone`，写成 `system_one` 会 404。
- `model` 用 `jev-latest` 或 `typesafe/jev-1.13`。`typesafe/jev-router` 是聊天路由模型，System One 接口会返回 400，不要用在这里。
- 改写端点后，默认的 `JEV_API_KEY` 不会被发到新主机；用 `decision.apiKeyEnv` 或 `HMCODEX_JEV_API_KEY_ENV` 命名该主机要用的密钥变量。

## 命令

```bash
dda health
dda task --workspace /path/to/project --prompt "检查项目结构"
dda thread list
dda thread get --thread-id THREAD_ID
dda recovery
dda tools --workspace /path/to/project
dda support-info
```

默认 `--format` 在终端上是 `human`，在管道里是 `jsonl`。默认执行模式是 `READ_ONLY`。

受控模式必须显式写出，并且不能自动批准：

```bash
dda task --workspace /path/to/project --prompt "运行测试" \
  --execution-mode CONTROLLED --approval-mode deny
```

受控动作还需要部署环境授予租约范围，例如 `HMCODEX_LEASE_CAPABILITIES=shell.execute`、`HMCODEX_LEASE_COMMANDS=node`；没授予的能力直接返回 `SAFETY_LEASE_REQUIRED`，不会进入审批。

三种审批方式：

- `prompt`：stdin 和 stderr 都是终端时才可用，也是这种情况下的默认值。CLI 在 stderr 显示 requestId、digest、风险、命令/路径和过期时间，然后问 `[y/N]`。只有 `y` / `yes` 批准；其他输入、Ctrl-D 或 stdin 关闭都算拒绝。多个请求按顺序逐个询问。
- `jsonl`：从 stdin 逐行读取下面的消息，按 `requestId` 匹配等待中的请求。stdin 结束时，所有还在等待的请求立即拒绝，不会一直等到过期。
- `deny`：每个请求都立即拒绝。

```json
{"type":"approval_response","requestId":"approval-123","approved":true,"displayedDigest":"sha256:..."}
```

digest 不一致、JSON 无效或字段缺失都会作为拒绝回给 runtime。没有 TTY 又没指定 `jsonl` / `deny` 时直接返回 `APPROVAL_UNAVAILABLE`（退出码 5）。审批被拒绝或过期后任务失败，退出码是 5，jsonl 结果带 `"approval":"DECLINED"`。CLI 不保存“以后自动批准”。

当前限制：`CONTROLLED` 在 Linux 上映射到 Phase 1.5 受控通道 `WINDOWS_PHASE1_5_CONTROLLED`（受 lease、审批和审计约束的受控策略），不再继承 Phase 2 的 `WINDOWS_FULL_LOCAL` 全本地发布门；端到端审批测试只在 Linux 上跑过，Windows / 鸿蒙真机还没验证。

## 退出码

| 码 | 含义 |
| ---: | --- |
| 0 | 成功 |
| 1 | 未分类 runtime 错误 |
| 2 | 参数错误 |
| 3 | 配置错误 |
| 4 | 工作区错误 |
| 5 | 审批拒绝或没有审批通道 |
| 6 | 安全策略拒绝 |
| 7 | 取消 |
| 8 | 协议错误 |
| 9 | 存储错误 |
| 10 | 依赖缺失 |
| 130 | SIGINT |

## 验证

```bash
node --test linux-cli/test/*.test.mjs runtime/test/platform.test.mjs runtime/test/release-channel.test.mjs
```

`linux-cli/test/controlled-approval.test.mjs` 用假模型服务端到端覆盖 deny、jsonl 批准、digest 不一致、stdin 结束、终端 y/n，以及通过 `bin/dda.mjs` 的 stdin 审批。`linux-cli/test/jev-opt-in.test.mjs` 覆盖 Jev 的显式开启规则。

## 还未做

- deb、AppImage、ARM64、musl、Node SEA
- 把受控执行变成默认能力。现在默认仍是只读，受控动作要显式打开，并经过 runtime 原有的 Lease、审批和审计
