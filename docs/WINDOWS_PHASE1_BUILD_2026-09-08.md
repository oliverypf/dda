# Phase 1 Windows 构建记录（2026-09-08）

本次构建在本地 NTFS 副本 `C:\work\hmCodex` 完成。共享盘路径（`Z:` / UNC）上 Tauri CLI 原生程序无法加载并以 `-1073741818` 静默退出，因此采用“源码在 `Z:\DevEcoStudioProjects\hmCodex`、构建在本地副本”的方式。构建脚本已清除 `NAPI_RS_NATIVE_LIBRARY_PATH` / `NAPI_RS_FORCE_WASI`，避免污染前端构建。

## 构建方式与环境

| 项 | 值 |
| --- | --- |
| 构建目录 | `C:\work\hmCodex` |
| 依赖安装 | 旧 `node_modules` 移到 `node_modules.incomplete` 后执行 `npm ci --include=dev` |
| 构建命令 | `npm run build:windows:phase1` |
| 发布渠道 | `WINDOWS_PHASE1_READ_ONLY` |
| 操作系统 | Microsoft Windows NT 10.0.26200.0 |
| Node | v24.19.0 |
| npm | 11.17.0 |
| Rust | rustc 1.98.0 (88d9e12ae 2026-08-18) |
| Cargo | cargo 1.98.0 (797e8a9bc 2026-08-05) |
| 目标 | `x86_64-pc-windows-msvc` |

## 产物（2026-09-08 19:32 +08:00）

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9560576 | `B7BA14A0D3DDBA985959999B7D9D58ED8076F3AF8F55CAF5A3B7FBEA12D95D5E` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3784976 | `FFAC1ECECC435F78D5481BF6ADD5EE3E87CB8E36014E0E49B231A60AFD0FD763` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2424312 | `E89D494CB571B0BDF83FAF8BBE83A4956D306A745C01DFB61AC9E64F39710103` |

EXE 与 NSIS 版本信息为 `0.1.0`；MSI 无文件版本资源。

## 渠道与运行时校验

- `hmcodex-desktop.exe` 内含字符串 `WINDOWS_PHASE1_READ_ONLY`，不含 `WINDOWS_MVP_PRE_PHASE1`，渠道在构建期烘焙进程序。
- 未安装 MSI/NSIS，直接启动 release EXE（PID 19960），窗口标题 `hmCodex` 且响应正常。
- 启动序列 `health → recovery → dashboard` 均正常执行；`dashboard` 返回 `ok:true`。
- Tauri 在本地副本的 `release\runtime\src\index.mjs` 解析到捆绑 runtime，不依赖 Z 盘。

## 启动时发现的历史数据清零事件

启动时间线曾出现 `EVOLUTION_EVALUATION_READ_FAILED`。只读排查确认 5 个旧 JSON 存储文件在 `2026-09-04 17:39:06` 被整体清零（内容为全 NUL 字节，不可恢复）：

`credit-blame.json`、`decision-trace.json`、`evolution-evaluations.json`、`memory.json`、`profiles.json`。

处理：将这些文件按可回滚方式改名为 `*.zeroed-20260904T173906` 留档；运行时随后重新生成 schema 合法的存储。重建后的记录数为：decision-trace 740 决策 / 551 结果 / 2031 事件，credit-blame 551 条，evolution-evaluations 19 条 outcome，profiles 4 个画像 / 23 条证据，memory 5 条。默认 Harness Event Store `hmcodex.db` 校验为 `ok:true`（44 事件 / 44 回执 / 0 墓碑）。

这是磁盘/断电类数据未落盘事件，不是写入路径 bug；现有 store 的 fail-closed 行为与测试要求一致，本次未放宽该语义。

## 模型路由更新与重建（2026-09-08 20:49 +08:00）

项目默认模型改为 OpenCode Go：`provider=openai-chat`、`protocol=chat-completions`、`model=mimo-v2.5-pro`、`baseURL=https://opencode.ai/zen/go/v1`、`apiKeyEnv=OPENCODE_GO_API_KEY`，并按网关要求注入 `x-opencode-session` 请求头。这是 hmCodex 项目自身的模型配置，未修改 Codex 应用配置。

实现要点：

- `model-config.mjs` 新增 `headers` / `sessionHeader` 配置项及校验；默认路由改为 OpenCode Go；`sessionHeader` 每个 provider 实例生成一次 UUID，用于网关路由与缓存亲和；显式切换 provider 时不再携带旧网关的 endpoint/header。
- `plugins/model-openai.mjs` 将配置头合并进请求；修正流式 tool-call 分片中后置 `id: null` / `function.name: null` 覆盖首个合法值的问题（OpenCode Go 会这样分片）。
- `model-registry.mjs` 同步支持 `headers` / `sessionHeader`，角色模型记录可保留网关路由头。
- 外部运行时配置 `%LOCALAPPDATA%\hmCodex\model-config.json` 与 `runtime/model-config.example.json` 同步改为 OpenCode Go。
- 新增 `npm run test:parallel`（`--test-concurrency=6`），保留串行 `test` 作为确定性入口。

真实链路验证（2026-09-08）：

- `GET https://opencode.ai/zen/go/v1/models` 200；`POST /chat/completions` 无 `x-opencode-session` 返回 400 `MissingSessionID`，带 UUID 头返回 200。
- CLI 真实任务 `run-d160d14d-58b3-467c-924c-3d03ee228cae` `ok:true`，`mimo-v2.5-pro` 返回文本；工具轮次任务 `run-583aa328-e4de-4b7e-bf45-470522183e40` `toolRounds=1`、`toolCallCount=1`，正确读取 `README.md` 首行。
- runtime 全量并行测试 385/385 通过（`--test-concurrency=6`，约 178s）。

产物（2026-09-08 20:49 +08:00）：

| 产物 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `hmcodex-desktop.exe` | 9560576 | `6E8680E63A655E914C859AA62029A6455229AA566A623E2687861280C17C1E19` |
| `bundle/msi/hmCodex_0.1.0_x64_en-US.msi` | 3817992 | `036317200871CD359FA5311BB6E6B2BB243328931D5F4BB7DC7ECB60ACB888E0` |
| `bundle/nsis/hmCodex_0.1.0_x64-setup.exe` | 2432775 | `C3623CFF89E40509A6FB73B3D889156C806F98B5D5A2523158600E86C932AADB` |

release EXE 已直接启动（PID 6020），窗口响应正常。本结果仍不替代 MSI/NSIS 安装卸载与 M7 手工验收。

## 验证边界

本记录证明：本地副本干净安装、Phase 1 固定渠道构建、MSI/NSIS 打包、release EXE 直接启动和 dashboard 读取成功。尚未证明：MSI/NSIS 安装与卸载、安装后渠道展示、M7 全部手工场景（新线程、连续任务、模型断线/凭证缺失、取消、超时、进程重启恢复、ReadModel 重建、导出/删除、迟到事件/墓碑拦截）、完整故障注入与容量验收。不得据此宣称 Phase 1 通过。
