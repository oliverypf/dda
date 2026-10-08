# dda 安全模型

版本：v1.1  
状态：Phase 1.5 发布阻断规范

## 1. 安全目标

1. 未经授权的文件写入、命令执行、网络访问和外部系统变更为零。
2. 模型、仓库、插件、工具输出和其他 Agent 均不能自行扩大权限。
3. 用户确认必须对应其实际看到的动作、scope 和风险，不能被替换或复用。
4. 凭据、个人数据、源代码和审计数据按最小化原则处理。
5. 所有拒绝、批准、租约、执行和治理变化可追溯、可回放、可撤销或隔离。

Safety 是硬约束，不参与可被质量、成本或速度抵消的加权总分。

## 2. 资产与信任边界

受保护资产：

- 用户项目、Git 状态、构建产物和工作区外文件；
- API token、WebSocket bearer token、cookie、SSH key、证书和环境秘密；
- 用户身份、任务文本、Trajectory、Profile、Memory 和审批历史；
- Router/Policy/Profile 完整性；
- HarmonyOS 应用签名、插件包和更新通道；
- Executor 主机、App Server 会话和企业网关。

信任分区：

| 分区 | 默认信任 | 规则 |
| --- | --- | --- |
| HarmonyOS Core/Policy | 高但可出错 | 通过签名、版本和不变量测试保护 |
| UI | 展示可信，授权不可信 | UI 状态不能直接授权，命令需版本/digest |
| 模型输出 | 不可信 | 只能生成建议/intent，不能生成权限 |
| 项目内容/工具输出 | 不可信数据 | 可能包含 prompt injection、秘密和恶意文件 |
| Plugin | 按签名与来源分级 | 权限是 manifest 与策略交集 |
| Codex/Executor Adapter | 受控外部边界 | 必须认证、能力协商和本地转换 |
| 远程 Executor/网关 | 独立信任域 | TLS、身份、workspace 隔离、权威校验 |
| Trajectory/Profile/Memory | 完整性敏感 | 追加事实、证据化更新、抗投毒 |

## 3. 攻击者与假设

考虑以下攻击者：恶意仓库作者、恶意/被攻陷插件、网络中间人、被污染模型输出、同机低权限进程、误操作用户、共享 Executor 上的其他租户，以及利用历史数据投毒 Router/Profile/Dreaming 的输入。

不假设模型会稳定遵守自然语言安全提示；不假设客户端路径检查能约束远端文件系统；不假设“审批过一次”可以授权未来动作；不假设远端断线代表动作没有执行。

## 4. 策略判定顺序

每次 Task、Candidate 和 Action 按固定顺序求值：

1. 产品不可覆盖硬规则；
2. 企业/设备管理策略；
3. 工作区与项目策略；
4. Plugin/Executor capability 与 PermissionCeiling；
5. Safety Profile 的动态收紧；
6. 用户本次明确确认；
7. 用户偏好。

上层只可收紧下层。`DENY` 和 `QUARANTINE` 优先于任何 allow；缺失、未知或冲突按更严格结果处理。

判定分为：

- `decision`: `ALLOW | DENY | QUARANTINE`
- `requiredControls`: `MONITOR | CONFIRM | SANDBOX | READ_ONLY | NETWORK_ALLOWLIST | RESOURCE_LIMIT | ...`
- `governanceStage`: `ALLOW | MONITOR | CONFIRM | SANDBOX | DENY | QUARANTINE`

治理阶段用于长期画像；实时 decision 仍针对当前对象。不能把历史 `ALLOW` 当作当前动作授权。

## 5. ActionIntent

每个副作用先形成不可变 intent：

```ts
interface ActionIntent {
  intentId: string;
  runId: string;
  stepId: string;
  routeId: string;
  subjectContextId: string;
  executorId: string;
  workspaceId: string;
  workspaceSnapshotId: string;
  actionClass: string; // READ_ONLY | SIDE_EFFECT
  actionType: string;
  normalizedScope: Array<ResourceScope>;
  argumentsCanonicalJson: string;
  argumentsDigest: string;
  expectedEffects: Array<ExpectedEffect>;
  rollbackPlan?: RollbackPlan;
  createdAtMs: number;
}
```

```ts
interface ResourceScope {
  resourceType: string; // FILE | DIRECTORY | PROCESS | NETWORK | EXTERNAL_SERVICE
  canonicalResource: string;
  allowedOperations: Array<string>;
  constraintsDigest: string;
}

interface ExpectedEffect {
  effectType: string;
  targetDigest: string;
  reversible: boolean;
}

interface RollbackPlan {
  strategy: string; // COMPENSATE | RESTORE_SNAPSHOT | NONE
  preconditionDigest: string;
  stepsDigest: string;
}
```

模型只生成候选参数。Core 负责 schema 校验、规范化和 digest；Safety/Executor 使用同一 canonical representation。任何参数、cwd、环境、scope 或 snapshot 改变都会创建新 intent。`READ_ONLY` 不等于绝对安全：读取秘密、越权路径或敏感外传仍可被拒绝；它只表示该操作不应改变外部状态且不签发副作用 lease。

## 6. PolicyLease

```ts
interface PolicyLease {
  leaseId: string;
  runId: string;
  intentId: string;
  intentDigest: string;
  subjectContextId: string;
  executorId: string;
  workspaceId: string;
  workspaceSnapshotId: string;
  actionType: string;
  normalizedScope: Array<ResourceScope>;
  requiredControls: Array<string>;
  approvalId?: string;
  policyVersion: string;
  capabilitySnapshotHash: string;
  channelBindingDigest?: string;
  issuedAtMs: number;
  notBeforeMs: number;
  expiresAtMs: number;
  maxUses: number; // v1 固定为 1
  nonce: string;
  token: string;   // 只在短期内存/安全通道中存在
}
```

租约规则：

- token 由不可预测随机数和本地/网关密钥签发，数据库只存 token HMAC digest；
- token 绑定 intent、主体、Executor、workspace snapshot、policy version、有效期和连接 channel；
- Executor Adapter 在发送动作的最后一刻 compare-and-set 消费 lease；远端 Executor 可验证时必须再次验证；
- 如果 Codex App Server 不理解 dda lease，`CodexAppServerAdapter` 必须在自身受信边界内原子验证并将 lease 与唯一 RPC request/turn item 绑定；
- lease 不可转让、扩 scope、延长、复活或复用；
- Pause/Cancel/断线身份变化/策略收紧/Profile 隔离立即撤销；
- 不能确认是否执行时标记 outcome unknown，禁止用同一 lease 重试。

## 7. 审批安全

Approval UI 必须显示：动作类型、规范化目标、cwd/workspace、命令或 diff 摘要、网络目标、风险原因、沙箱状态、有效期和“仅本次”语义。

- `displayDigest` 覆盖全部可见关键字段；回传 digest 不一致则拒绝。
- 审批期间 intent 或策略变化会 supersede 原请求。
- 禁止默认选中批准、倒计时自动批准、模糊按钮、隐藏风险或把多个无关动作打包批准。
- 高风险动作不能仅靠通用“信任此项目”放行。
- 服务端 `acceptForSession` 等决定也受本地 PermissionCeiling 限制；客户端不得将本地一次确认升级为服务端会话级永久允许。

## 8. 文件系统安全

权威检查在实际访问文件的 Executor 侧执行：

1. 输入路径解析为目标平台 canonical absolute path/URI；
2. 拒绝 NUL、非法编码、保留设备名、路径穿越和不支持 scheme；
3. 逐段解析 symlink/junction/mount，得到 real path；
4. 使用文件标识符或安全句柄验证访问前后目标未替换；
5. 验证 real path 位于租约 scope 根内；
6. 校验 workspace snapshot/version 与 intent；
7. 写入使用临时文件、fsync/原子替换（平台支持时）并记录前后 digest；
8. 避免跟随新创建链接，失败时拒绝而不是放宽。

默认拒绝：工作区外路径、凭据目录、系统目录、其他应用沙箱、设备文件、未批准网络挂载和由仓库内容指向外部的链接。读取秘密文件也属于高风险，不能因“只读”自动允许。

删除、批量覆盖、权限更改、Git history 改写和超过阈值的变更需要独立 action type 与更严格控制。

## 9. 命令执行安全

- 优先使用结构化 `executable + argv + cwd + envDelta`，避免 shell 字符串。
- 需要 shell 时 action 明确标记 `SHELL_INTERPRETED`，展示完整规范化命令并提高风险等级。
- 环境变量采用 allowlist；默认剥离 token、代理凭据、SSH agent、云凭据和调试注入变量。
- 对 executable real path、脚本文件 digest、cwd、argv、env digest 和资源限制整体签发 lease。
- 管道、重定向、命令替换、后台进程、提权、包管理安装、远程下载执行和递归删除单独分类。
- 子进程树继承资源/网络/文件限制；父进程结束后清理或隔离遗留进程。
- stdout/stderr 先过秘密扫描与大小限制，再进入 Trajectory/UI。

命令 denylist 仅作最后防线，不能替代 sandbox、scope 和结构化策略。

## 10. 网络安全

- 默认无网络；每个 host、端口、scheme、方法、DNS/IP 范围和数据分类显式授权。
- DNS 解析后再次检查 IP，防止 rebinding；重定向逐跳重新授权。
- 默认拒绝 loopback 管理端口、link-local、私网元数据服务和未声明内网目标，除非部署策略明确允许。
- 只允许 TLS 的远程执行和模型连接；localhost/SSH 隧道可按部署规范例外。
- 上传内容按 source/sensitive 分类，显示目标和摘要；秘密永不由模型决定上传。
- 响应大小、时间、重定向、并发和带宽有硬上限。
- 网络代理和企业网关不能在客户端日志中泄露认证头。

## 11. Prompt Injection 与跨 Agent 消息

- 仓库、网页、日志、编译错误、插件输出和 Agent 提案都标记为 untrusted content。
- Policy、角色权限和工具列表来自不可被内容覆盖的控制层，不拼接到同一可编辑文本中。
- 模型提出“忽略规则”“启用插件”“读取密钥”等仅成为待评估 intent。
- Council 只交换结构化 claim、evidence refs、critique 和 probe；不能传播权限 token、秘密或隐藏系统提示。
- Verifier 不以多数投票替代确定性证据；Security Critic 的通过不能放权。

## 12. Plugin 与供应链

- Plugin 包必须校验来源、hash、签名、manifest schema、API 兼容和权限；未签名开发插件仅在显式开发模式运行。
- 动态下载的 ArkTS/Native 代码默认不能进入生产应用进程；远程能力作为受认证 Adapter/Executor 使用。
- Plugin 权限是 manifest、管理员策略、用户配置、角色 PermissionCeiling 和 Safety Profile 的交集。
- Plugin 更新先 shadow/self-test，再原子切换；保留上一版本回滚。
- 检测 hash 变化、签名撤销、异常调用或越权时立即 quarantine。

## 13. Profile、Router 与 Dreaming 投毒防护

- Profile 更新只能引用不可变 Trajectory/Verifier evidence；模型自评不作为唯一证据。
- Safety 负面事件实时收紧；正向放权使用更长窗口、最低样本数、衰减和人工门槛。
- 新模型/插件/版本使用独立 profile key，不能继承同名旧版本信用。
- Router 学习只在 Safety 过滤后的候选内；安全事件不允许被成本收益抵消。
- Dreaming 只产生 `MemoryProposal`，来源、有效期、冲突和敏感性校验后才激活；不能修改 Safety Policy 或清除安全事实。
- Profile/Memory 批量异常、单一来源支配或分布漂移会暂停学习并回滚到规则基线。

### 13.1 Agent Decision Trace 安全边界

当前决策顺序固定为：

```text
有界证据收集 → Jev Decision Plane → Runtime Safety / Scope / Approval / PolicyLease → Executor
                         └→ Rule Verifier 事实约束
```

Jev 负责在有限候选中选择、判断工具是否合适以及判断行为/结果是否足够；它不能生成新的工具或权限，也不能覆盖 Runtime Safety、workspace scope、Approval、PolicyLease 或 Rule Verifier 的硬失败。当前不存在独立的 LLM Verifier、语义 Verifier 角色或 Candidate Judge。

- Agent Decision Record 是不可信的“决策提案/解释”，不是权限凭证、事实证明或 Verifier 通过证明；其内容无论多有说服力都不能跳过 Safety Gate、审批或 PolicyLease。
- Coordinator 校验 `agentInstanceId`、RoleContext、binding snapshot、operationId 和 run/step scope，Plugin/模型不得自报或冒充其他 Agent 身份。
- 每个 evidence ref 必须指向决策发生前已存在且该 RoleContext 当时有权读取的证据；禁止事后证据伪装成事前依据。
- Agent 自报 confidence、reasoning summary 和候选评分均标记为 model-claimed；学习标签只能来自后续 Rule Verifier、Jev 之外的真实执行结果或明确用户反馈。
- 决策摘要、Council critique 和 Memory proposal 均按 untrusted content 处理；渲染时转义，送入其他 Agent 时保留来源边界并重新经过 injection 检查。
- 普通决策记录不保存 prompt、系统提示、reasoning token、隐藏思维链、凭据或 lease presentation。Provider 提供的 reasoning summary 若经策略允许，仅作为加密、可删除的 `UNVERIFIED_PROVIDER_SUMMARY` 附件。
- Decision DAG、record digest、feature snapshot 和 outcome link 出现篡改、跨 run 引用、非法环或 identity mismatch 时，暂停 run、拒绝学习样本并产生安全审计事件。

## 14. 身份、凭据与加密

- 短 token/密钥使用 HarmonyOS Asset Store；代码、preferences、数据库和普通日志不保存明文凭据。
- 数据库/Blob 使用应用生成的数据加密密钥，密钥由 Asset Store 保护；支持密钥轮换和旧数据渐进重加密。
- 使用 Crypto Architecture Kit 的受支持算法和安全随机数，不自建密码算法。
- 远程 WebSocket 使用 `wss://`、服务器身份校验和官方支持的 capability token/signed bearer token；plain `ws://` 仅限 localhost 或受控 SSH 转发。
- bearer token 不放命令行、URL、Trajectory 或支持包；优先从安全存储注入握手 header。
- 企业场景可增加 mTLS、工作负载身份、设备证明和证书 pinning；pin 轮换必须可恢复。

HarmonyOS Asset Store 适合保存短敏感数据（如 token），参见 [Asset Store Kit 概览](https://developer.huawei.com/consumer/cn/app/planning)。Codex 远程认证与 WebSocket 限制见 [官方 App Server 文档](https://developers.openai.com/codex/app-server)。

## 15. 安全反向治理

收紧顺序：`ALLOW → MONITOR → CONFIRM → SANDBOX → DENY → QUARANTINE`。

触发示例：

- 新/低置信主体从 `CONFIRM` 或 `SANDBOX` 开始；
- 重复拒绝、验证失败、越界尝试、秘密输出、异常成本先收紧；
- 已确认越权、签名失效、审计篡改或恶意外传直接 `QUARANTINE`。

放开规则：

- 一次只下降一级；
- 需要最小样本、连续无事件窗口、确定性成功证据和最新版本；
- `QUARANTINE` 恢复必须人工审查；
- 放开不会超过 manifest、企业策略和 Role PermissionCeiling；
- 每次 transition 有 policy version、evidence、审批者和可回滚点。

## 16. 事件响应

安全事件级别：

- `SEV0`：正在发生的秘密外传、未授权高危执行、审计/签名失陷。立即终止连接、撤销所有相关 lease、隔离主体、保护证据并通知用户/管理员。
- `SEV1`：已执行越界写入、插件供应链异常、跨租户数据风险。暂停 workspace，禁止自动恢复。
- `SEV2`：被阻止的越权、重复策略规避、Profile 投毒信号。收紧画像并进入监控。
- `SEV3`：低风险异常或误配置。记录、提示、修复。

处置流程：detect → contain → preserve evidence → assess external effects → recover in clean context → rotate credentials if needed → postmortem → add regression fixture。安全日志不保存不必要的秘密内容。

## 17. 发布安全测试

Phase 1.5 前必须自动覆盖：

- `../`、编码绕过、symlink/junction、挂载和 TOCTOU；
- shell 元字符、命令替换、环境泄密、子进程逃逸和资源耗尽；
- DNS rebinding、重定向、内网/metadata 访问和上传秘密；
- approval 内容替换、过期、重复、跨 run 使用；
- lease 伪造、过期、撤销、double spend、scope/identity/channel mismatch；
- prompt injection、跨 Agent 权限指令、恶意插件 manifest；
- Trajectory/Profile/Memory 投毒和事件篡改；
- Decision Record 身份伪造、事后证据回填、outcome leakage、DAG 非法环和自评充当学习标签；
- 断线/崩溃后无授权重放；
- 日志、数据库、导出和支持包秘密扫描。

所有已知 P0/P1 用例必须 100% 阻断；发现未经授权副作用时停止发布，不以“低概率”接受。
