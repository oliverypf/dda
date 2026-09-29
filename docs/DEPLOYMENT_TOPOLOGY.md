# hmCodex 多平台部署拓扑规范

版本：v1.0  
状态：Phase 0.5 基线

## 1. 设计结论

本规范首先描述“一个客户端内的本地运行时”拓扑，再描述可选的远程 Executor/Gateway 模式。HarmonyOS 的设备能力、后台和本地文件约束由 [HARMONYOS_PLATFORM.md](HARMONYOS_PLATFORM.md) 补充；Windows/Linux 的桌面能力由对应客户端 Adapter 和 capability 配置补充。

客户端是完整的本地 Agent 工作台，不只是控制面。真实代码执行、工作区访问、审批、轨迹、本地 Memory Journal 和 Jev Decision Plane 默认由客户端启动或管理的本地运行时完成。远程能力按设备、产品形态和安全策略协商，不能反向成为本地客户端的启动依赖。

推荐顺序：

1. 本地客户端运行时，启动本机 App Server 和受控 Executor；上下文使用本地 Memory Journal，Jev 通过受控决策端口接收证据；
2. 本地运行时通过 stdio、Unix socket 或 loopback 连接子进程；
3. 可选的单用户远程 Gateway/Executor，用于跨设备接续或高算力；
4. 可选的企业 Gateway，用于身份、策略、审计和多用户隔离。

## 2. 共同组件

```text
hmCodex Client
  ├── ArkUI/Tauri UI + HarnessFacade / ReadModel
  ├── Coordinator / AgentCore / Safety / Rule Verifier / Jev Decision Plane
  ├── Local Trajectory / Profiles / Policy
  └── Local Runtime
        ├── Codex App Server / Model Adapter
        ├── Workspace + Executor sandbox
        ├── Local Memory Journal / Evidence Store
        └── audit + health + capability service
```

UI、SafetyDecision、用户审批和本地审计属于客户端；本地 Executor 对实际路径、进程、网络和副作用结果拥有权威观察，必须重新验证 lease/scope。远程模式只是在 `Local Runtime` 位置替换一个远程 Adapter。

## 3. 拓扑 A：本地单客户端

适用：Windows/Linux 桌面客户端，以及通过设备能力验证的 HarmonyOS 客户端。

- 客户端启动并监督本地运行时、Codex/App Server 和受控 Executor；
- 子进程优先使用 stdio/Unix socket，或只监听 `127.0.0.1` 的随机端口；
- 工作区、Trajectory、上下文索引和凭据引用默认留在当前 OS 用户的数据目录；
- 每个子进程使用最小环境变量、最小路径 scope 和独立临时目录；
- 客户端记录 runtime fingerprint、版本和 capability snapshot；运行时变化需重新初始化；
- 崩溃恢复先做进程清理与 outcome reconciliation，再恢复可恢复的只读状态；未知副作用不自动重发。

优点是安装后即可工作、数据局部、延迟低；缺点是需要为各平台打包运行时、处理进程生命周期和权限差异。

## 4. 拓扑 B（可选）：单用户远程 Gateway/Executor

适用：个人服务器、云开发机或专用工作站。

```text
HarmonyOS ── WSS + bearer/capability token ── hmCodex Gateway
                                             ├── stdio/Unix socket → App Server
                                             └── isolated workspace/Executor
```

- 一位用户/设备获得独立 endpoint 身份、workspace 和进程权限。
- 使用短期 access token；长期 refresh/私钥保存在 Asset Store。
- TLS 校验服务器身份；可选证书 pin、设备绑定和 challenge/attestation。
- Gateway 对客户端暴露版本化 hmCodex Adapter protocol，并在同一主机通过 stdio/Unix socket 驱动固定版本 App Server；这样不把实验性 App Server WebSocket 直接暴露到生产网络。
- 直接连接 App Server WSS 仅用于开发、受控试点或官方将该 transport 标记为生产支持后的新 ADR；即使使用官方认证参数也不能把“可认证”误认为“生产稳定”。
- Adapter 不能信任客户端路径字符串，按 workspaceId 解析服务端 canonical root。
- 断线不自动迁移到另一 Executor；先 reconciliation，避免重复副作用。
- 服务端日志与本地 Trajectory 使用 correlationId，但不共享秘密。

## 5. 拓扑 C：企业 Gateway

```text
HarmonyOS Client
  │ WSS/OIDC/device identity
  ▼
Enterprise Gateway
  ├── authentication / policy / quotas / audit
  ├── user-workspace routing
  └── per-user or per-run isolated Executor
          └── Codex App Server / tools
```

强制要求：

- Gateway 验证用户、设备、客户端版本和企业策略；
- Executor 不共享可写 workspace、home、credential cache 或 process namespace；
- tenant/user/workspace identity 贯穿 token、channel、lease 和审计；
- 服务器策略只能收紧本地策略；冲突按更严格结果；
- 支持管理员吊销连接、插件、模型、网络和 workspace；
- 公开数据保留、审计和删除政策，区分本地与企业副本；
- rate limit、过载和维护状态通过标准错误/capability 返回。

共享单一 App Server 进程给多个不互信用户默认禁止。若供应商未来提供正式多租户隔离，需新的威胁评审和 ADR。

## 6. HarmonyOS 本地运行时能力门控

HarmonyOS 也属于同一个本地客户端产品，但完整本地 Executor 是否可用必须由设备能力验证决定。

启用条件：

- 目标 HarmonyOS PC/2in1 API 正式提供满足需求的进程、文件、沙箱和后台能力；
- 通过应用市场、签名、ACL 和企业部署约束验证；
- 本地 Executor 实现完整 `ExecutorPort`、lease、路径 realpath、资源限制和子进程清理；
- 与远程 Executor 使用同一契约测试和安全测试；
- 设备 capability probe 明确返回 supported，不能按型号猜测。

如果只能读取用户选择文件而不能安全运行进程，则只实现 `WorkspacePort`，明确降级为只读客户端，不伪装为完整 Executor。远程连接可以作为兼容模式，但不是默认部署拓扑。

## 7. 身份与连接

每次连接建立 `ConnectionIdentity`：

```ts
interface ConnectionIdentity {
  connectionId: string;
  endpointId: string;
  serverCertificateDigest?: string;
  authenticatedSubject: string;
  tenantId?: string;
  deviceBinding?: string;
  adapterVersion: string;
  wireSchemaHash: string;
  establishedAtMs: number;
  expiresAtMs: number;
}
```

RoleContext、operation 和 PolicyLease 引用 connection identity/channel binding。重新认证、证书变化、Gateway 路由变化或 Adapter 重启会创建新 identity，并撤销旧连接上的 active lease。

Codex 官方文档支持客户端连接本机 app-server，并建议本地优先使用 stdio、Unix socket 或 loopback；远程连接才需要 WebSocket 认证和 TLS。App Server WebSocket 目前仍标记为实验且不受生产支持，因此本地客户端不应把远程 WSS 当作启动前提；如启用远程模式，才由 Gateway 终止 WSS，并在远端本地使用 stdio/Unix socket 连接固定版本 App Server。参见 [Codex App Server](https://developers.openai.com/codex/app-server)。

## 8. Capability 与版本握手

连接顺序：

1. 网络/TLS/身份握手；
2. Adapter protocol initialize；
3. 获取 server、wire schema、stable/experimental capability；
4. 获取模型、workspace、sandbox、approval 和限额 capability；
5. 与客户端策略求交；
6. 保存 immutable capability snapshot；
7. 才允许创建 RoleContext/run。

未知 major、schema hash 不在兼容表、缺少安全能力或实验能力未批准时，端点只能进入 diagnostics/read-only，不开放副作用。

## 9. 数据位置

| 数据 | 本地 | 远端 | 规则 |
| --- | --- | --- | --- |
| UI/read model | 是 | 否 | 本地权威展示 |
| Task/Trajectory | 是 | 可有审计副本 | 明确披露与保留 |
| 源代码 | 可缓存最小范围 | workspace 权威 | 按 scope 读取 |
| Model context | 必要片段 | 是 | 最小化、脱敏 |
| Policy/Safety Profile | 本地权威 | 可下发更严策略 | 不允许远端放宽 |
| 凭据 | Asset Store reference | 服务端 secret store | 不跨层复制 |
| 执行日志/diff | 本地证据副本 | 远端权威原始结果 | digest 对账 |

跨区域、跨租户或跨项目传输默认禁止，必须由部署策略和用户/管理员明确配置。

## 10. 离线与降级

- 离线时可查看本地历史、编辑未提交任务、管理设置和 Memory；不能假装模型/Executor 可用。
- 已打开的只读 snapshot 若有完整缓存，可标为 `OFFLINE_SNAPSHOT` 查看；不用于安全敏感新验证。
- 未决 Approval 离线后过期；重连需要重新展示和确认。
- 断线中的副作用 operation 进入 outcome unknown，不自动重发。
- 模型不可用时 Router 可以选择已批准 fallback；Executor/安全能力缺失时只能降级为只读或暂停。

## 11. 可用性、背压与灾难恢复

- `/readyz`/`/healthz` 仅表示监听器状态，不代替认证后的 capability probe。
- 客户端对过载使用指数退避+jitter，并尊重 `retryAfterMs`；不并发重试同一 operation。
- Gateway/Executor 必须有每用户、workspace、模型和插件配额。
- 服务端升级使用 drain：停止新 run，等待或 checkpoint 已有 run，再切换。
- 恢复备份时 endpoint identity 和 workspace snapshot 变化，旧 lease 全部作废。
- 多区域 failover 默认只用于只读/model invocation；副作用 failover 必须先做外部结果 reconciliation。

## 12. 拓扑选择矩阵

| 条件 | 选择 |
| --- | --- |
| Windows/Linux 本机可运行受支持 App Server | A（本地单客户端） |
| HarmonyOS 设备通过完整本地能力验证 | A（本地单客户端） |
| 个人远程工作站、单用户 | B（可选 Gateway WSS；App Server 本地 stdio/Unix） |
| 企业身份、审计、多人隔离 | C（可选企业 Gateway） |
| 无安全本地 Executor | 本地只读 Harness，或用户明确开启远程兼容模式 |

用户选择只决定可用候选，不会覆盖 Security Model。发现拓扑能力与声明不一致时隔离 endpoint。

## 13. 部署验收

- TLS/auth failure、token rotation、证书变化和时钟偏差；
- endpoint spoofing、跨用户/工作区访问和 connection replay；
- capability/schema 升降级与实验能力协商；
- 断线/重连/服务端重启/过载/drain/failover；
- outcome unknown 不重复执行；
- 日志、header、URL、命令行无 token；
- 本地、远端和企业拓扑使用同一领域契约 fixture；
- 设备不支持本地 Executor 时明确降级而非启动失败；远程模式关闭时本地客户端仍可独立启动。
