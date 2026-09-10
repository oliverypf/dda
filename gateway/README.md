# hmCodex Gateway（可选远程适配器）

Gateway 不是 hmCodex 本地客户端的必需服务，也不是默认产品拓扑。它只为跨设备接续、企业身份/策略、远程工作区或高算力场景提供可选的远程适配器。

本地客户端默认由自己的运行时负责 Harness、Codex/App Server、本地 Executor、OpenViking 和审计。Gateway 若启用，必须通过与本地运行时相同的领域契约接入，不得把核心状态机、安全语义或 OpenViking 生命周期改造成服务端专属逻辑。

远程模式至少需要覆盖：

- `prepareContext`：Turn 前按预算召回上下文；
- `startTurn` / event stream：统一 Codex 事件；
- `recordTurn`：记录 user、assistant、tool 消息和实际使用的 URI；
- `commitContext`：触发 OpenViking session commit；
- capability、健康状态、降级和审计事件。

OpenViking 的 REST/MCP/SDK 细节仍只应存在于 Context Adapter；客户端与本地运行时依赖的是 `ContextPort`。远程 Gateway 不应成为本地功能的单点依赖。
