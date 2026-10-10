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
- Node.js 24 或更新版本。当前仓库也可以在 Node.js 22 上做本地验证
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

`--data-dir` 和 `HMCODEX_DATA_DIR` 会覆盖数据根目录，所有 store 都从这一次解析结果派生。新建目录使用 `0700`。没有配置文件时，runtime 默认的 `OPENCODE_GO_API_KEY` 和 Jev 默认的 `JEV_API_KEY` 仍会传给子进程；配置文件里声明的其它 `apiKeyEnv` 也会传递。未声明的密钥环境变量会被去掉。API key 不会写入配置、事件或支持信息。

Windows CLI 使用上面表格里的 `%LOCALAPPDATA%\hmCodex`。未设置 `HMCODEX_PLATFORM` 的 runtime 仍保持原来的 Windows 目录规则，避免在 Linux 上跑 Windows 测试时改掉路径。

## Jev 决策（OpenRouter）

Jev 默认开启，走官方 System One 接口。用 OpenRouter 时在 `model-config.json` 里写 `decision` 块，不需要额外适配层：

```json
{
  "apiKeyEnv": "OPENCODE_GO_API_KEY",
  "decision": {
    "enabled": true,
    "endpoint": "https://openrouter.ai/api/v1/systemone",
    "model": "jev-latest",
    "apiKeyEnv": "OPENROUTER_API_KEY"
  }
}
```

- 路径是 `systemone`，写成 `system_one` 会 404。
- `model` 用 `jev-latest` 或 `typesafe/jev-1.13`。`typesafe/jev-router` 是聊天路由模型，System One 接口会返回 400，不要用在这里。
- 直连 TypeSafe 时 endpoint 为 `https://api.typesafe.ai/v1/systemone`，密钥变量为 `JEV_API_KEY`。
- 只设环境变量不够：CLI 只传配置里声明的密钥变量（外加上面两个默认值），`HMCODEX_JEV_API_KEY_ENV` 不会传给子进程。要切到 OpenRouter，请写 `decision` 块。完整示例见 `runtime/model-config.example.json`。

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

没有 TTY 时，`CONTROLLED` 只能使用 `--approval-mode jsonl` 或 `deny`。`jsonl` 从 stdin 读取：

```json
{"type":"approval_response","requestId":"approval-123","approved":true,"displayedDigest":"sha256:..."}
```

digest 不一致会拒绝。CLI 不保存“以后自动批准”。

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

## 还未做

- deb、AppImage、ARM64、musl、Node SEA
- 把受控执行变成默认能力。现在默认仍是只读，受控动作要显式打开，并经过 runtime 原有的 Lease、审批和审计
