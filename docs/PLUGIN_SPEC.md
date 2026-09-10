# hmCodex Plugin 规范

版本：Plugin API 1.0  
状态：Phase 2 实现基线

## 1. 目标与边界

Plugin 用于扩展 Agent、Skill、Verifier、Model Provider、Executor、Workspace 和 UI contribution，但不能改变 Harness Core 状态机、安全优先级或事件事实。插件化的目标是可替换和可治理，不是任意代码执行。

HarmonyOS 客户端生产版默认只运行随应用签名发布、编译期注册的 ArkTS/HAR/HSP 插件。在线发现的第三方能力作为远端 Adapter/Executor 接入；除非目标 HarmonyOS 版本、签名和商店政策明确支持，否则禁止下载并在应用进程中执行新 ArkTS/Native 代码。

## 2. Plugin 类型

| 类型 | 职责 | 默认权限 |
| --- | --- | --- |
| `agent` | 角色策略、提示和计划转换 | 只读，无 I/O |
| `skill` | 领域说明、模板、资源和受控工作流 | 只读，调用声明 Port |
| `verifier` | 确定性或语义验证 | 只读证据 |
| `model-provider` | 实现 ModelInvocationPort | 外部模型连接 |
| `executor` | 实现 ExecutorPort | 仅租约范围内副作用 |
| `workspace` | 实现 WorkspacePort | scope 内读取/snapshot |
| `approval` | 实现外部审批桥 | 仅审批状态，不签发 lease |
| `ui-contribution` | 增加只读面板/renderer | 只消费经脱敏 read model |

一个包可以声明多个 contribution，但每个 contribution 独立声明 capability 和 permission。

## 3. 包与 manifest

包必须包含 `plugin.json`，最低 schema：

```json
{
  "schemaVersion": "1.0",
  "id": "com.example.hmcodex.my-plugin",
  "name": "My Plugin",
  "version": "1.2.3",
  "publisher": {
    "id": "com.example",
    "displayName": "Example",
    "keyId": "sha256:..."
  },
  "pluginApi": ">=1.0 <2.0",
  "harnessProtocol": ">=1.0 <2.0",
  "platform": {
    "kind": "bundled-har",
    "minHarmonyApi": 20,
    "deviceTypes": ["2in1"]
  },
  "contributions": [
    {
      "id": "security-verifier",
      "type": "verifier",
      "entrypoint": "SecurityVerifier",
      "capabilities": ["verify.diff", "verify.secrets"],
      "permissions": ["trajectory.read.redacted", "workspace.read.snapshot"],
      "permissionCeiling": "READ_ONLY"
    }
  ],
  "dependencies": [],
  "resources": [],
  "configSchema": "schemas/config.schema.json",
  "integrity": {
    "algorithm": "sha256",
    "packageDigest": "sha256:...",
    "signature": "..."
  }
}
```

规则：

- `id` 使用反向域名且不可因版本改变；contribution ID 在包内唯一。
- `version` 使用 SemVer；API 范围必须有上界。
- manifest 中未知的权限、可执行 contribution 或 major schema 默认拒绝。
- `entrypoint` 只引用包内注册符号，不接受任意文件路径或 URL。
- 配置必须通过 JSON Schema 校验，秘密字段只保存 Asset Store reference。
- integrity 覆盖 manifest、代码、资源和 schema 的 canonical package digest。

## 4. 来源与信任等级

| 等级 | 来源 | 生产默认 |
| --- | --- | --- |
| `CORE` | 与 hmCodex 同签名、同发布 | 启用 |
| `BUNDLED_SIGNED` | 随 App 发布的签名 HAR/HSP | 按产品配置 |
| `ENTERPRISE_SIGNED` | 企业白名单与可信签名 | 管理员启用 |
| `REMOTE_ATTESTED` | 认证远端服务/Executor | 按连接策略 |
| `LOCAL_DEVELOPMENT` | 开发构建、未签名 | 仅开发模式，醒目标记 |
| `UNTRUSTED` | 未知/签名失败/来源变化 | 禁用或隔离 |

信任等级不直接授予 action 权限，只决定最大 permission ceiling 和审核流程。

## 5. 生命周期

```text
DISCOVERED → VALIDATING → INSTALLED → DISABLED → ENABLED → ACTIVE
                       └→ REJECTED      ├→ DEGRADED
ACTIVE/ENABLED/DEGRADED → QUARANTINED
任意非 ACTIVE 操作安全结束后 → REMOVED
```

- Discover 只读取 manifest，不加载代码。
- Validate 校验 schema、API 范围、签名、hash、平台、依赖、权限和策略。
- Install 写入不可变版本目录并登记 registry；不自动 Enable。
- Enable 需要满足管理员/用户策略；新增高风险权限需要再次确认。
- Activate 前执行 self-test 和 capability probe；失败进入 DEGRADED。
- Quarantine 立即阻止新调用、取消可取消 operation、撤销关联 lease，并保留诊断证据。
- Remove 前等待 operation 结算；不能删除仍用于历史回放的 manifest/version metadata。

## 6. Capability 与 Permission

Plugin 实际能力是以下集合交集：

```text
manifest 声明
∩ 当前设备/Adapter capability
∩ 系统与企业策略
∩ 用户/项目配置
∩ Role PermissionCeiling
∩ Safety Profile 当前上限
∩ 当前 PolicyLease scope（副作用时）
```

权限命名使用分层字符串：

- `workspace.read.metadata`
- `workspace.read.content`
- `workspace.write.patch`
- `process.execute.argv`
- `process.execute.shell`
- `network.connect.host`
- `trajectory.read.redacted`
- `profile.propose-update`
- `ui.render.timeline-item`

Plugin 不得自行请求不存在于 manifest 的权限；运行时发现需要新权限时返回 `CAPABILITY_NOT_DECLARED`，通过更新 manifest/版本重新审核。

## 7. ABI 与调用边界

所有 contribution 通过 `PROTOCOL_SPEC.md` 的领域 Port 和 `PortResult` 工作：

- 调用必须有 operationId、deadline、cancellation 和 trace；
- 输入/输出通过 schema 校验，大小有上限；
- Plugin 不能获得 Store、Policy、UI Context 或其他 Plugin 实例的裸引用；
- Plugin 只能发布允许的领域事件，Coordinator 再验证并持久化；
- 参与分类、路由、规划、执行选择、验证、诊断、审议或记忆整理的 contribution 必须返回符合 [Agent Decision Trace 规范](./DECISION_TRACE_SPEC.md) 的 `AgentDecisionProposal`；只有 Coordinator 可以提交 `AgentDecisionCommitted`，Plugin 不能绕过 decision-before-effect 顺序。
- 未捕获异常映射为 `PLUGIN_FAILURE`，不能崩溃 Harness 主循环；
- Plugin 不能生成/解析 PolicyLease token，Executor contribution 只能验证并消费由 Safety 签发的 presentation。

首版使用静态 ArkTS interface + registry factory；如果未来引入 IPC/远端插件，wire schema 独立版本化，但仍映射相同领域 ABI。

## 8. 隔离与资源

- Agent/Skill/Verifier 默认无系统 API 访问，只接收最小输入。
- CPU 密集型可信插件可使用 TaskPool；常驻隔离逻辑可使用 Worker，并遵守 Sendable/消息复制限制。
- 远端插件使用独立认证连接、请求大小、并发、deadline 和速率限制。
- Executor 按 workspace/run 隔离进程、容器或沙箱；禁止多个不可信租户共享可写目录。
- 每个插件有 token、CPU、内存、输出、事件、网络和 operation 配额；超限先取消，再降低状态或隔离。
- UI contribution 只能声明允许的 renderer，不运行任意 HTML/JS；外部内容统一转义。

## 9. 依赖解析

- 依赖必须使用精确或有上界的 SemVer 范围，禁止未固定的远程 URL。
- 同一 Plugin ID 同时只有一个 ACTIVE 版本；历史 run 引用其原版本 metadata。
- 依赖图必须无环；可选依赖缺失只关闭对应 capability。
- 核心 API 不能依赖第三方 Plugin。
- 冲突按管理员锁定 → 项目锁定 → 用户选择 → 产品默认的顺序解决；不得由安装时间随机决定。
- 生成 `plugin-lock.json` 快照，记录 id/version/digest/source/API，随 run 的 capability snapshot 引用。

## 10. 升级、回滚与配置迁移

升级流程：下载/取得候选 → 验签/hash → 静态验证 → 安装 side-by-side → 配置 dry-run 迁移 → self-test → shadow → 等待旧 operation 结算 → 原子激活。

- 权限扩大、publisher key 变化、source 变化或 major API 变化视为新信任决定，不能静默升级。
- 保留至少一个已知良好版本和旧配置备份。
- Plugin 配置 migration 只访问自己的 namespaced 数据，必须幂等并有验证。
- 回滚不回滚已发生的外部副作用；相关 run 进入验证。
- 安全撤销列表优先于版本锁定，命中后立即 quarantine。

## 11. Plugin Registry

Registry 记录：manifest canonical JSON、package/source digest、签名链、trust level、lifecycle、能力/权限、API compatibility、安装/激活时间、self-test 结果、profile key、quarantine reason 和历史版本。

Router 只读取 registry 生成的 capability snapshot，不扫描文件系统发现实时状态。registry 与实际包 digest 不一致时 fail-closed。

## 12. 插件测试与认证

每个插件提供：

- manifest/schema 与 API compatibility 测试；
- 无网络/无凭据的确定性 self-test；
- cancel、timeout、oversize、malformed input 和异常测试；
- 权限边界与未声明能力拒绝测试；
- 输出秘密扫描与 prompt injection 测试；
- Agent Decision schema、身份/scope、候选与证据引用、隐藏思维链排除及 commit-before-effect 契约测试；
- 升级、配置迁移、回滚和签名变化测试；
- 对 Executor 的 lease、scope 和 double-spend 契约测试。

生产启用要求签名/完整性、契约测试、安全扫描和目标设备 smoke test 全部通过。性能或质量不达标可 DEGRADED；权限越界必须 QUARANTINED。

## 多版本生命周期

运行时通过 PluginGovernance.versionLifecycle 管理 side-by-side 版本。新版本必须先完成配置迁移 dry-run、self-test 和 shadow；任一步失败都保持旧 active 版本，失败版本进入 DEGRADED。激活后保留 previous-version，可显式 rollback。
