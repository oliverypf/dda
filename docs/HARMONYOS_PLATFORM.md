# hmCodex HarmonyOS PC 平台规范

版本：v1.0  
状态：API 24 平台基线

## 1. 平台定位

hmCodex 是 HarmonyOS PC/2in1 原生 ArkTS + ArkUI Agent Harness。当前工程 `targetSdkVersion` 和 `compatibleSdkVersion` 均为 HarmonyOS 6.1.1 API 24，Stage 模型，模块声明 `phone`、`tablet`、`2in1`。

产品能力分级：

| 设备 | 产品定位 | 默认能力 |
| --- | --- | --- |
| `2in1` | 完整 PC 工作台 | 多面板 UI、远程 App Server、工作区、审批、回放 |
| `tablet` | 远程控制/轻量工作台 | 会话、审批、只读 workspace；复杂布局降级 |
| `phone` | Companion | 监控、消息、审批和历史；不承诺本地 Executor |

本地进程执行、后台常驻和企业扩展均通过 runtime capability gate；设备类型本身不构成能力证明。

## 2. 应用模型与模块

首版保持单 Entry HAP + 分层 ArkTS 包：

```text
entry
  ├── UIAbility / ArkUI pages
  ├── facade + read models
  ├── core + routing + safety + verifier
  ├── ports + adapters
  └── storage + platform services
```

当模块稳定后拆为：

- `harness-core.har`：纯领域类型、状态机、策略和 Port；不得依赖 ArkUI/网络/数据库具体 API。
- `harness-platform.har`：ArkData、Network、Asset、Background、File 等实现。
- `codex-adapter.har`：Codex wire/schema 与 transport。
- `entry`：UI、Facade、composition root。
- 可选签名 HSP：大体积或企业共享能力；拆分需 ADR 和启动性能测试。

依赖方向始终指向 Core；Entry 在 composition root 组装实现。

## 3. Kit 选择

| 能力 | HarmonyOS Kit/API | 使用方式 |
| --- | --- | --- |
| UI/窗口 | ArkUI、UIAbility、Navigation | PC 响应式工作台、系统生命周期 |
| 网络 | Network Kit `@ohos.net.webSocket` | WSS App Server 连接；一帧一消息 |
| 结构化存储 | ArkData `relationalStore` | Trajectory、投影、Profile、配置版本 |
| 偏好 | ArkData `preferences` | 非敏感、小型 UI 偏好 |
| 凭据 | Asset Store Kit | token、数据密钥、证书/密钥引用 |
| 加密 | Crypto Architecture Kit | 随机数、hash/HMAC、加解密、签名验证 |
| 文件 | Core File Kit、应用沙箱、系统 Picker | 用户授权 workspace/导入导出 |
| 并发 | ArkTS TaskPool、Worker、async/await | CPU 任务、解析、隔离 actor；UI 不阻塞 |
| 后台 | Background Tasks Kit | 有界 checkpoint/传输；不假设永久运行 |
| 企业后台 | AppServiceExtensionAbility | 仅 2in1 企业 flavor，ACL 后可选 |

官方平台目录将 ArkData、ArkUI、Background Tasks、Core File、Asset Store 等作为相应能力入口，参见 [HarmonyOS 文档中心](https://developer.huawei.com/consumer/cn/doc/)。

## 4. 并发模型

- ArkUI 主线程只处理输入、渲染和轻量 read model 变更。
- `HarnessCoordinator` 使用串行 mailbox；每个 run 的事件顺序在单 writer 中确定。
- JSON schema 校验、diff 解析、秘密扫描、索引和压缩等 CPU 任务放 TaskPool。
- 长连接收发可在平台允许的 Worker/异步任务中处理，跨线程对象使用 Sendable/序列化 DTO；不传递 UI Context、RdbStore 或不可共享对象。
- `HarnessStoreWriter` 独占数据库写入，其他线程通过消息提交事务；读取使用受控 repository。
- EventSink 有界队列，关键事件不可丢；UI delta 可以合并。

Worker/TaskPool 只是并发隔离，不是安全沙箱。任何 Plugin/模型数据仍按不可信处理。

## 5. 生命周期与恢复

### UIAbility 前台

- `onCreate`：加载最小配置、数据库 schema、恢复索引，不连接不必要端点。
- `onWindowStageCreate`：构建 UI 与只读投影，异步启动 Adapter capability probe。
- 进入后台/窗口销毁：checkpoint UI/read model 游标，暂停新高风险动作，按策略处理中运行。
- 应用退出：撤销未消费 lease、使 Approval 过期、flush 关键事件、发送有界 cancel；不能假设远端动作已停止。
- 下次启动：按 `STATE_MACHINE.md` 进入 `RECOVERING`。

### 后台限制

消费者版本不依赖永久后台。短时任务只用于保存状态、完成有限 flush 或明确允许的传输；到期前主动 checkpoint。Dreaming 默认用户手动触发且前台可见，自动 Dream 仅在平台能力、预算和用户设置满足时运行。

`AppServiceExtensionAbility` 从 API 20 起可为 2in1 企业应用提供后台服务，但需要受限 ACL，不能成为商店消费者版本的必要条件。参见 [AppServiceExtensionAbility 约束](https://developer.huawei.com/consumer/cn/doc/doccenter-capabilities/app-service-extension-ability)。

远端 Executor 可在客户端不前台时继续运行，但重新打开应用时必须 reconciliation；是否允许“离开后继续”由用户在任务级明确选择，并在系统通知中可见。

## 6. 网络实现

- 生产远程 endpoint 只接受 `wss://`；`ws://` 仅 loopback/明确开发 profile。
- WebSocket 每个 text frame 交给 Codex wire decoder；禁止跨帧拼接 JSONL 或按换行拆帧。
- 在握手前从 Asset Store 读取短期 credential，注入 header 后立即清理临时字符串引用。
- 实现 connect/initialize/capability/ready 状态，未 ready 不发送业务 RPC。
- 心跳、idle timeout、网络切换和应用后台切换产生显式连接事件。
- 请求表有上限，id 防碰撞；断线时所有 pending request 分类结算。
- 遵守 Network Kit 网络权限，错误码映射到 HarnessError。

## 7. 文件与 Workspace

- 应用自身配置、数据库、Blob 在应用沙箱内；用户项目通过系统 Picker/平台授权或远端 workspaceId 访问。
- 用户选择的 URI/path 转为 `WorkspaceGrant`，记录授权来源、scope、有效期和 canonical digest；不能把最近路径字符串当作永久权限。
- 本地 WorkspacePort 只暴露授权 root；工作区外读取也要进入 Safety 检查。
- 大文件范围读取，二进制默认只显示 metadata/hex 摘要，文本进行编码和行尾识别。
- 文件监听事件只使 snapshot stale，不直接触发模型/执行；重新读取后产生新 snapshot。
- 导出 Trajectory/支持包使用系统 Picker 和显式用户动作。

本地文件写入在 Phase 1.5 且平台安全实现验证前关闭；远端文件 API 仍受本地 ActionIntent/PolicyLease 控制。

## 8. 本地进程与终端

Core 不调用本地 shell。实现本地 Executor 前必须通过 POC 证明：

- API/产品签名允许启动和管理目标进程；
- 能限制 cwd、环境、文件、网络、CPU、内存、时间和子进程；
- 能可靠取消、回收、读取输出和判定退出；
- 能在应用异常、后台和设备睡眠时给出确定恢复语义；
- 符合应用市场和企业部署规则。

不满足任一条件时，终端 UI 连接远端 PTY/Executor，不在 HarmonyOS 端模拟安全性。终端渲染与 Executor 安全是两个模块，不能因“能显示终端”推断“能安全运行命令”。

## 9. ArkUI PC 信息架构实现

- 2in1 宽屏使用 NavigationSplit/响应式三栏：任务导航、主时间线/编辑区、上下文侧栏。
- 窄屏把工作区、审批、路由和验证面板降级为可导航页面/Sheet，不压缩关键信息。
- 窗口尺寸、主题和面板宽度只存 preferences；审批/状态来自 read model。
- 流式 delta 合并到帧级/固定时间窗口更新，避免每 token 触发全树重绘。
- 长列表使用懒加载、游标分页和稳定 key；runId/eventId 不用数组位置替代。
- 键盘、鼠标、触控、焦点、快捷键、无障碍朗读和高对比模式同等支持。

详细交互见 `UI_UX_SPEC.md`。

## 10. 凭据与本地数据

- Asset Store 保存短敏感 token 和数据库 key reference；preferences 禁止敏感数据。
- 数据库和 Blob 按数据分类加密；日志先脱敏。
- 应用切后台、截屏/最近任务预览时，可按敏感模式遮挡 token、命令和源代码区域。
- 剪贴板复制敏感内容需要用户动作，可配置自动清除；不自动复制模型输出中的秘密。
- 清除项目数据同时清理数据库引用、Blob、缓存、搜索索引和 Asset Store 项；审计保留按显式策略处理。

## 11. Runtime Capability Matrix

启动时生成不可变 `PlatformCapabilitySnapshot`：

```ts
interface PlatformCapabilitySnapshot {
  harmonyApi: number;
  deviceType: string;
  appFlavor: string;
  websocket: boolean;
  secureAssetStore: boolean;
  relationalStore: boolean;
  systemFilePicker: boolean;
  backgroundMode: string;
  localExecutor: string; // UNSUPPORTED | READ_ONLY | CONTROLLED
  enterpriseAppService: boolean;
  capturedAtMs: number;
}
```

功能开关只从 snapshot 和策略求交。API 存在但权限/ACL/设备不支持时仍为 false。Snapshot 变化使相关 route stale，重新路由而不是继续原绑定。

## 12. 构建、测试与发布

必须提供可复现命令，不能只依赖某台 DevEco Studio 的 GUI 状态：

- 固定 DevEco Studio、HarmonyOS SDK、hvigor、ohpm 和 Node 兼容版本；
- 仓库提供可调用的 hvigor wrapper 或清晰的 SDK 工具路径 bootstrap；
- CI 执行 ArkTS 编译、lint、unit、ohosTest、schema/依赖检查和 release build；
- Debug/Release/Enterprise flavor 的权限和 feature flag 分离；
- release 开启签名、混淆评估、敏感字符串扫描和 SBOM；
- 2in1 为主验收设备，tablet/phone 做 companion 回归。

当前仓库没有可直接调用的 `hvigorw`，因此补齐 wrapper/CI 是 Phase 0.5 的工程就绪项。

## 13. 平台 POC 门槛

Phase 0.5 必须在真实目标设备或官方模拟环境验证：

1. WSS header/auth、单帧消息、网络切换和后台恢复；
2. relationalStore 事务、迁移、加密、容量和异常恢复；
3. Asset Store 写入、读取、更新、删除和设备锁定行为；
4. Picker/文件授权、路径 canonicalization 和权限撤销；
5. TaskPool/Worker 消息、取消、内存和主线程帧率；
6. UIAbility 退出、异常退出、重启和非终态 run 恢复；
7. 2in1 窗口缩放、键鼠、触控和无障碍；
8. 企业 flavor 的 AppServiceExtensionAbility（若计划发布）。

POC 失败时降级 capability，不修改 Core 契约或绕过 Security Model。
