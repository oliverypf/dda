# dda 运维、可观测性与隐私规范

版本：v1.1  
状态：Phase 1 实现基线

## 1. 目标

系统需要在不收集模型隐含思维、不泄露源代码和凭据的前提下可诊断、可恢复、可容量治理。Telemetry、审计和产品分析是三类不同数据，不能混用。

## 2. 可观测性分层

| 层 | 用途 | 内容 | 默认位置 |
| --- | --- | --- | --- |
| Trajectory | 用户可回放的任务事实 | 状态、结构化 Agent 决策、路由、动作、证据、审批、结果 | 本地数据库 |
| Security Audit | 安全与治理 | 拒绝、租约、越权、策略/插件/Profile 变化 | 本地；企业可有受控副本 |
| Diagnostic Log | 故障定位 | 错误码、component、trace、大小/耗时 | 本地滚动日志 |
| Metrics | 健康/性能 | 计数、分位数、容量、错误率 | 本地聚合；opt-in/企业上报 |
| Product Analytics | 产品改进 | 经同意的去标识行为 | 默认关闭或按发布政策 |

模型 chain-of-thought、reasoning token、系统提示、凭据原文和不必要的完整源代码不属于可观测性数据。Agent Decision Trace 只保存可校验的目标、候选、选择、证据引用、约束、置信度、预期和结果，不尝试复原隐藏推理。

## 3. 标准日志字段

每条结构化日志最多包含：timestamp、severity、component、eventCode、runId/threadId 的本地 pseudonymous ref、operationId、traceId、adapter/plugin 版本、state、error category/code、duration、byte/token count、retry count 和 redaction state。

禁止字段：Authorization/cookie、API key、PolicyLease token、完整命令环境、文件正文、用户输入原文、模型完整原文、prompt/系统提示、reasoning token/隐藏思维链、私钥、数据库 key、个人身份。需要定位内容时记录类型、长度、HMAC digest 和经用户选择的脱敏片段。

日志写入前执行同步 redaction；写入后扫描是补充，不是主防线。

## 4. Redaction Pipeline

```text
source classification
  → exact secret fields drop
  → token/key/credential pattern scan
  → path/user/host pseudonymization
  → source-code/content truncation
  → policy-specific redaction
  → size cap
  → persist/export
```

- 凭据字段直接 drop，不用 `***` 替换后保留长度特征。
- pseudonym 使用本地轮换 HMAC key；不同项目默认不可关联。
- redaction 失败按 `SECRET` 处理，拒绝持久化/导出。
- 用户手动查看原始源代码与自动上传是两件事；后者需要独立同意。
- Security Audit 保存 reason code 和 digest，不保存攻击 payload 全文，必要证据加密隔离。

## 5. 数据保留默认值

用户/企业可收紧；延长必须明确披露：

| 数据 | 默认保留 | 说明 |
| --- | --- | --- |
| 流式临时 delta | run 完成后 24 小时内聚合/清理 | 保留最终文本和摘要 |
| HOT Trajectory | 30 天 | UI 快速回放 |
| 结构化 Decision Record | 180 天 | 按项目可收紧；用于决策回放、评价和经治理的学习 |
| 决策特征快照/Outcome | 180 天 | 同 cohort 同步保留，禁止仅留结果造成偏差 |
| WARM Memory/Profile evidence | 180 天 | 可撤回、按项目 |
| Security Audit | 365 天 | 本地追加式；个人版可显式清除全部本地数据 |
| Diagnostic Log | 14 天或 50 MiB | 先到为准、滚动 |
| Support Bundle | 导出后 7 天临时副本 | 用户可立即删除 |
| SECRET | 0 | 不落普通存储 |

企业管理保留政策必须在 UI 可见，并区分本地删除与企业审计副本。法律/合规要求由部署方配置，不硬编码到 Core。

源证据因保留或用户删除而清理时，Decision Record 只保留不可逆 digest、类型和 `PURGED` tombstone；不得把已失去证据的样本继续标记为可训练。Provider reasoning summary 默认跟随最短相关内容保留期，且不进入学习导出。

## 6. 加密与密钥运维

- Asset Store 保存 master/data key reference 和远端 credential；数据库不保存明文 key。
- 每项目/数据分类可派生独立 data encryption key，降低单 key 影响面。
- key 有 keyId、created/activated/retired 状态；轮换时新写使用新 key，旧 Blob 后台渐进重加密。
- 删除 key 前验证没有活跃数据引用；遗失 key 的数据标记 `UNRECOVERABLE`，不能假装为空。
- 备份加密 key 与数据分离；导出包使用用户提供密码派生 key 或企业密钥，禁止固定密码。
- Crypto/Asset API 错误为 fail-closed；加密不可用时不降级明文。

## 7. 用户权利与控制

用户可以：

- 查看任务使用了哪些模型、Plugin、workspace、网络和审批；
- 导出单 run、项目或全部本地数据的脱敏/完整受保护包；
- 删除任务、项目、Memory、Profile 和全部本地数据；
- 撤回自动 Dream、模型遥测和产品分析同意；
- 查看并撤销 endpoint、token、Plugin 和 workspace grant；
- 查看企业策略阻止删除/导出的具体理由和管理方。

删除流程覆盖数据库、Blob、缓存、搜索索引、临时文件、备份轮换和 Asset Store 项。异步清理显示进度和失败；完成后保留不含原文的最小 tombstone，防止恢复重现。

## 8. 支持包

Support Bundle 默认只包含：版本/设备 capability、配置 schema（去秘密）、组件状态、错误码、trace/decision 关系元数据（ID、类型、状态、digest，不含摘要/证据正文）、性能/容量、插件 manifest digest、数据库完整性结果和脱敏日志。

- 创建前显示内容分类和估计大小；
- 默认不含源代码、用户输入、模型输出、命令正文和原始 Trajectory；
- 用户可逐项选择额外内容并预览；
- 包加密、带 manifest/digest、过期时间和 bundleId；
- 上传是独立外部副作用，需要明确目标和确认；
- 服务端接收后遵循其披露的保留政策。

## 9. 健康指标与 SLO

本地产品初始 SLO：

- Facade 接收命令并返回 receipt：p95 < 100 ms（不含外部调用）；
- 收到 Adapter 事件到 read model 可见：p95 < 250 ms；
- 关键事件持久化成功率：99.99%，失败时停止副作用；
- 非终态 run 启动扫描：目标设备 p95 < 2 s；完整恢复索引 p95 < 5 s；
- UI 关键交互保持目标帧率，无持续主线程阻塞 > 50 ms；
- 未授权副作用和秘密日志：0。

SLO 未达标可以降级 delta、并发和非关键分析，不能丢安全事件或绕过持久化。

## 10. 容量治理

监控：数据库/Blob/缓存大小、每日增长、事件 backlog、投影延迟、未终结 run、Decision 数量/存储、待关联 Outcome、不可训练样本比例、日志大小、Memory 数量、Profile evidence 窗口。

- 70% 软阈值：提示用户、停止非必要预取和自动 Dream。
- 85% 高阈值：压缩/清理过期 delta、限制新 Council、生成容量建议。
- 95% 硬阈值：停止新 run 和新大 Blob，只允许完成安全收尾、导出和删除。
- 磁盘 full 中断事务时，撤销 lease、暂停 run、保留内存最小诊断但不继续执行。

清理器幂等、可暂停、按 retention/index 处理，不扫描用户工作区删除文件。

## 11. 告警与事件响应

本地告警：连接持续失败、数据库损坏/空间不足、事件 backlog、非终态恢复失败、Plugin quarantine、credential 过期、安全事件、模型/成本异常。

企业告警使用去敏事件码和 correlation ID；默认不上传内容。SEV0/1 遵循 `SECURITY_MODEL.md` 的 containment 流程。

告警抑制必须有时间窗和上限；同类重复聚合但不丢首次、升级和恢复事件。

## 12. Runbook

### Adapter 无法连接

验证网络 → TLS/身份 → initialize/schema → capability → 过载。保持本地只读，不清除历史或自动更换不受信 endpoint。

### 数据库迁移失败

停止写入/执行 → 标记 migration failed → 保留原库与备份 → 输出无内容诊断 → 允许恢复/导出。禁止建空库覆盖。

### Outcome Unknown

撤销 lease → 查询远端 operation/thread → 比较 workspace/diff → RecoveryVerifier → 用户可见结果。不能重复发送原副作用。

### Plugin 异常

停止新调用 → settle/cancel operation → quarantine → 保存 manifest/hash/error → 回滚已知良好版本；不自动恢复权限。

### Credential 泄露疑似

断开相关 endpoint → 吊销/轮换 → 清理内存/缓存 → 扫描日志/Trajectory → 评估外部使用 → 通知用户/管理员。

## 13. Release 与回滚运维

- Release 包记录 SBOM、签名、SDK/hvigor、schema、policy、plugin lock 和 Codex fixture hash。
- 升级前检查存储空间、数据库备份和 key；升级后运行 smoke/self-check。
- 配置、policy、Plugin 和模型 registry 更新都可单独回滚并有版本。
- App rollback 若不支持当前 DB schema，应拒绝启动并提示安装兼容版本，不破坏数据。
- Kill switch 可关闭特定 Adapter、Plugin、Council、Dreaming、学习 Router 或全部副作用，不能关闭审计/用户数据导出。

## 14. 隐私与运维测试

- secret/PII/source fixture 贯穿日志、事件、导出、支持包和崩溃路径；
- Decision Trace 的保留、证据删除、不可训练标记、provider summary 排除和隐藏思维链扫描；
- key 轮换、Asset Store 不可用、加密失败、备份恢复；
- retention、删除、撤回、tombstone 和企业策略差异；
- 磁盘满、数据库损坏、日志爆量和 backlog；
- SLO/指标计算不读取内容；
- kill switch、rollback、旧 App 打开新 schema；
- 支持包内容清单和上传确认；
- 遥测默认值与用户同意状态升级后不被重置。
