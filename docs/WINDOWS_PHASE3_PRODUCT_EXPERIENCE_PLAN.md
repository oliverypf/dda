# Windows 阶段三：产品体验与可审计工作台实施计划

版本：v1.0  
制定日期：2026-09-10  
状态：待阶段二发布门确认后启动  
上位计划：[Windows 全功能优先实施计划](WINDOWS_ALL_FEATURES_IMPLEMENTATION_PLAN.md)  
设计依据：[UI/UX 规范](UI_UX_SPEC.md)

## 1. 阶段目标

阶段三将现有 Windows runtime、Tauri bridge 和 desktop read model 已具备的事实，收敛为完整、可操作、可审计的桌面产品体验。重点不是重写 Event Store、Safety Monitor、Approval、PolicyLease、Verifier、Decision Trace 或治理模块，而是补齐其桌面信息架构、交互闭环、证据导航、恢复体验和无障碍验收。

本阶段的完成定义是：用户能在不依赖日志、命令行或开发者工具的情况下，理解一个任务正在做什么、基于什么证据、是否需要授权、是否发生副作用、验证是否完成，以及在失败、断线或恢复时可以采取什么操作。

阶段三以 `WINDOWS_FULL_LOCAL` 的既有安全和发布要求为前提，不降低 Phase 1.5 的受控执行门槛。任何 UI 操作仍只发送命令；Core 和 Executor 继续重新校验版本、策略、scope、approval display digest 与 lease。

## 2. 前置条件与边界

启动条件：

- G2 `WINDOWS_PHASE1_5_CONTROLLED` 已通过，或每个受控页面都有明确的只读降级和 feature gate；
- S2-06 定义的 `intent → safety → approval → lease → execute → outcome → verifier` 事件链已稳定；
- Dashboard/ReadModel 已提供版本化、可分页的 run、timeline、approval、execution、verifier、decision、workspace、recovery 和治理投影；
- desktop 不得直接从 JSON store、日志文本或模型输出推断安全、执行或验证状态。

不属于阶段三的内容：

- 新增或放宽文件写入、命令、测试、网络或插件权限；
- 改变 Event Store、状态机、PolicyLease、模型出域或安全策略的权威语义；
- HarmonyOS、Linux、Gateway 和跨设备产品实现；
- 用 UI 展示模型隐藏思维链，或用展示层结论替代 Verifier/Safety 判定。

## 3. 工作包

### S3-01 信息架构、路由与页面状态骨架

目标：把现有左侧“视觉导航”变成真实、可恢复的产品导航。

交付：

- 建立 `工作台`、`工作区`、`运行记录`、`记忆`、`能力与安全`、`设置与诊断` 六个一级页面；
- URL/本地导航状态保存当前页面、threadId、runId、eventId、工作区路径、时间线 cursor 和滚动锚点；重启后恢复最后可用视图；
- 窄屏采用页面或抽屉切换，保留 Approval、Safety、Verifier 和取消入口；
- 每页只消费版本化 `HarnessReadModel` 投影；projection gap、过期版本、未知关键事件显示安全暂停或重新读取状态；
- 建立统一的 loading、empty、permission denied、unsupported、error 和 stale snapshot 状态组件。

验收：所有导航项可打开实际页面；刷新、重启和线程切换不会把用户带回错误任务，也不会因数组索引变化跳到错误事件。

### S3-02 工作台、Composer 与运行状态闭环

目标：让提交、steer、取消、暂停、恢复和终态均有明确动作和可见边界。

交付：

- Composer 显示目标、workspace、当前 endpoint、模式、角色/模型配置摘要、附件入口和预算摘要；
- 将“steer 当前 run”和“创建新 run”做成明确、不同的命令和按钮状态；
- 固定 Enter/Ctrl+Enter 行为并在设置中配置；每个提交展示 pending/accepted/rejected receipt，重复点击返回同一 command receipt；
- 扩展 run 状态展示，覆盖 CLASSIFYING、ROUTING、PLANNING、WAITING_APPROVAL、EXECUTING、VERIFYING、DIAGNOSING、PAUSED、RECOVERING、FAILED、QUARANTINED；
- 终态页面显示验收结果、可查看证据/diff/导出和剩余非阻断风险；失败页面显示保护措施、潜在副作用和下一步建议；
- 时间线项支持展开技术详情、来源角色、event ID、operation ID、版本与 digest；高频流按窗口合并但完成后稳定化。

验收：每个 TaskRun 状态都有文字、图标和至少一个合法的下一步；失败、取消和未知结果不丢失已有时间线或误显示成功。

### S3-03 Route、角色、模型与候选选择面板

目标：把路由和候选选择从零散 timeline 摘要升级为可审阅的结构化页面。

交付：

- Route 面板展示 task class、risk、能力需求、候选数量、硬淘汰原因、最终 topology、fallback 和 capability snapshot；
- 展示 Planner、Executor、Verifier、Council/Judge 的实际 provider、model、effort、role binding、plugin/skill 版本和预算；
- 支持用户固定允许的模型或模型集合；配置变更只影响新 run，运行中变更触发新 snapshot 和重新路由；
- `CANDIDATE_SET` 视图显示每个候选的安全过滤、预算截断、评分分量、judge/确定性降级原因、出域次数、成本范围、选中与未执行状态；
- 模型不可用、binding 不兼容或 fallback 失败时显示明确暂停和恢复选择，不静默换模型。

验收：同角色多候选时，用户可分辨候选、淘汰、评分、选择与真实执行者；未选中候选不被渲染为已执行或已验证。

### S3-04 Approval、Safety 与受控执行详情

目标：将受控执行的安全链路变成可核对、可恢复、不能误操作的 UI。

交付：

- Approval 主卡片同时出现在任务时间线和待确认队列；展示目的、完整或安全格式化的 command/diff/target、cwd、path/host、读写删执行上传范围、sandbox、资源限制、风险代码、请求角色/plugin/executor、有效期和 display digest；
- 实现批准一次、拒绝、取消任务、过期、被替代、断线后重现和请求已处理状态；批准后先显示“正在重新检查策略”，仅收到 `PolicyLeaseIssued` 后显示“已授权执行”；
- Safety 页面分开呈现当前动作判定、required controls、scope、policy version、长期治理等级、最近安全证据和权限上限来源；
- Execution 详情按 intent、approval、lease、operation、outcome 关联展示；未知结果、高风险阻断、策略收紧、lease 撤销和 double-spend 都显示可理解状态；
- 高风险批准加入明确焦点、二次确认和键盘防误触；拒绝始终与批准同等可达。

验收：审批内容被替换、过期、跨 run、重复提交、策略收紧或 lease 已消费时，UI 刷新为不可执行状态；UI 不把“发送了批准命令”显示为“已授权执行”。

### S3-05 Verifier、证据、Diff 与 Terminal 工作区

目标：提供从验证结论回到可检查证据的完整路径。

交付：

- Verifier 页面按检查项展示 `PASS`、`FAIL`、`UNKNOWN`、`SKIPPED`，覆盖编译、测试、静态检查、diff、目标覆盖、安全、过程进展与语义评估；
- 将确定性检查和 LLM semantic verdict 分开标记，显示模型身份、独立性、ABSTAIN/降级原因和证据引用；UNKNOWN 不使用成功视觉语义，高风险 UNKNOWN 阻止最终成功；
- Workspace 页面显示授权 root、snapshot/digest、stale、文件编码和大文件/二进制降级；
- Diff 支持文件/块级浏览，明确 proposed、executed、verified 三种状态，模型建议不得显示为已写入；
- Terminal 显示 Executor 事件、cwd、exit code、duration、输出截断与脱敏状态；PTY/ANSI 失败时仍保留原始流和语义结果；
- 所有 evidence ref 可跳转到对应文件、diff、命令输出、timeline item 或 verifier report；复制内容时提示截断与脱敏状态。

验收：任意成功或失败结论都能从 UI 跳转到对应证据；无证据、被删除证据和 UNKNOWN 不会被渲染为 PASS。

### S3-06 运行记录、Decision DAG 与 Council 审议

目标：让历史任务和 Agent 决策可回放、筛选和审计，而不模拟隐藏思维。

交付：

- 运行记录页面支持按 thread、run、时间、状态、角色、模型、风险、结果和事件类型筛选，支持 cursor 分页、恢复、导出和删除后的 tombstone 状态；
- Decision Trace 页面支持按 Agent、类型、状态、step、outcome 筛选；默认显示结构化摘要、选择和结果，展开显示候选、证据、假设、不确定项、reason codes 和检查预期；
- 渲染 `parent`、`supersedes`、`critiques`、`selects`、`outcome` 关系，并跳转到 ActionIntent、Verifier、Memory Proposal、用户反馈和 Credit/Blame；
- 清楚标记 FACT、MODEL_REPORTED、SYSTEM_JUDGMENT，及 PROPOSED、REJECTED、ABSTAINED、INVALIDATED、尚未验证、已被替代；
- Council 页面展示 proposal claim/evidence、critique 对应 claim、Jev 决策、选中 probe、预算、轮数和停止原因；用户可以停止审议并回退单 Agent；
- provider reasoning summary 保持默认折叠、独立隐私开关、不可作为授权或证据。

验收：用户可以从任意决策追溯其下游结果，且未执行、未验证、已替代和已失败决策不会被误显示为成功。

### S3-07 Memory、Dream、Plugin、Evolution 与诊断管理

目标：将治理摘要改造成有来源、可恢复、可撤回的管理体验。

交付：

- Memory 页面按 active/proposed/conflict/revoked 分组，展示来源 run/event、置信度、有效期、scope、敏感性、替代关系、删除状态和不可训练标记；支持验证、激活、编辑新版本、拒绝、撤回、删除；
- Dream 页面展示只读状态、空闲/预算/锁/后台能力门控、收集范围、进度、失败原因和取消操作；默认自动 Dream 关闭；
- Plugin 页面展示来源、签名、版本、权限、health、evidence、quarantine 原因、升级/回滚和企业锁定状态；
- Evolution 页面展示 shadow、canary、promotion、monitor、kill switch、rollback、版本漂移和关联评估证据；
- 设置与诊断分区覆盖连接与身份、workspace grants、角色模型、Plugin、Safety/Approval、Memory/Dream、隐私/保留、存储、无障碍、开发诊断；敏感值只显示状态和指纹；
- Support Bundle、导出、删除、retention、备份与恢复操作提供范围预览、进度、tombstone/失败重试和审计事件。

验收：删除、撤回、隔离、回滚和企业锁定在重启及 ReadModel 重建后保持一致；管理界面不提供绕过硬规则的操作。

### S3-08 断线、恢复、容量与故障体验

目标：把 runtime 已有恢复语义变成用户可以决定下一步的界面。

交付：

- 建立 Recovery 页面，显示远端状态、workspace 差异、未决 approval、已撤销 lease、未知 operation、证据缺口和允许的恢复命令；
- 断线时保留 timeline、取消入口和最后已确认状态；未知外部结果以高可见警示显示，不能因错误而假定未执行；
- 存储/数据库故障进入只读维护模式，展示错误码、可导出范围、备份、恢复和磁盘容量等级，不以空白项目覆盖原状态；
- endpoint/app/schema/protocol 不兼容展示版本、影响范围和升级路径；
- 支持任务、模型和执行器的超时、取消、重试与迟到事件的关联显示。

验收：模拟断线、崩溃、存储故障、未知结果和版本不兼容后，用户能看到真实状态和合法下一步；恢复 UI 不触发自动重放副作用。

### S3-09 无障碍、响应式与性能收敛

目标：完成规范要求的 PC、触控、键盘和窄屏验收。

交付：

- 审核全部图标按钮、动态 live region、焦点顺序、快捷键、菜单、弹窗与 Approval 焦点；
- 支持字体缩放、高对比、深浅色、减少动画和色觉差异；
- 适配 2in1 宽屏、tablet、phone companion、触控目标和键鼠 hover/right-click 增强；
- 对 timeline、Decision DAG、diff、文件列表、日志和诊断列表实施分页或虚拟化；
- 保持 scroll anchor，后台降低刷新频率，不丢失关键 Approval、Safety、Verifier、Recovery 事件；
- 建立可访问性、键盘、缩放、长输出、超大 diff、窗口缩放和高事件速率的自动化与手工验收矩阵。

验收：在支持的视口、输入方式和辅助功能配置中，文本不溢出或遮挡，所有关键操作可完成，且高频事件不导致界面卡顿或错误跳转。

### S3-10 发布验收与体验观察

交付：

- 对 S3-01 至 S3-09 编制可追溯到 UI_UX_SPEC 章节的验收矩阵；
- 增加桌面端端到端测试：提交/重复提交/steer/新 run、全部 TaskRun 状态、Approval 生命周期、Route fallback、Verifier UNKNOWN、Decision DAG、Diff/Terminal、删除/导出、断线/恢复和企业锁定；
- 进行真实 Windows 安装包、触控设备、键盘、屏幕阅读器、高对比和字体放大验收；
- 进行至少一个真实只读任务、一个批准的受控任务、一个被安全阻断任务、一个断线恢复任务和一个治理撤回/删除任务的观察记录；
- 发布体验报告，记录已满足项、豁免项、已知限制、性能数据和回归风险。

验收结果：`WINDOWS_FULL_LOCAL` 只有在既有 G4 与本阶段体验矩阵同时通过时，才能作为完整可审计工作台发布。

## 4. 推荐执行顺序

```text
S3-01 信息架构
  ├─ S3-02 工作台与 Composer
  ├─ S3-03 Route 与候选
  ├─ S3-04 Approval 与 Safety
  └─ S3-05 Verifier、Diff、Terminal
       ├─ S3-06 运行记录与 Decision/Council
       ├─ S3-07 治理与设置
       └─ S3-08 Recovery 与故障体验
            └─ S3-09 无障碍、响应式、性能
                 └─ S3-10 发布验收
```

S3-02 至 S3-05 可以在 S3-01 的 ReadModel DTO、路由状态和证据跳转契约冻结后并行。S3-06 至 S3-08 依赖相同的详情抽屉、证据导航和事件分页组件，应共享实现而不是各自复制。

## 5. 跨层契约与测试规则

- 先更新 contracts、DTO fixture 和 UI state mapping，再修改 runtime bridge 或页面；新字段必须向后兼容并有 unknown/stale 降级；
- 每个页面操作携带 `commandId`、`expectedRunVersion`，审批还携带 display digest；Core 的拒绝必须回显为可见 receipt；
- 所有安全和执行展示以 durable event/read model 为准，禁止根据按钮点击、流文本或本地乐观状态宣告成功；
- 每个 evidence link 使用稳定 event ID、decision ID、operation ID、file snapshot/digest 或 report ID，删除后必须显示证据已删除；
- UI 测试不得只验证 DOM 文案，必须覆盖 command 发出、runtime 拒绝、投影刷新、重启恢复和过期状态；
- 每次合并运行现有并行基础回归，再顺序运行受影响的 UI、受控安全和安装包测试。

## 6. 阶段门

### G5：可审计工作台体验门

- 六个一级页面均可用，导航、重启恢复、分页和未知事件降级通过；
- Route、Approval/Safety、Verifier、Diff/Terminal、Decision Trace、Recovery 均有可操作详情页和证据跳转；
- 所有关键状态与副作用结果只来自 versioned ReadModel；
- Approval、lease、UNKNOWN、FAILED、CANCELLED、QUARANTINED、RECOVERING 不被误显示为成功；
- 可访问性、键盘、触控、字体、高对比和窄屏验收通过；
- 真实 Windows 安装包完成 S3-10 的场景矩阵，且既有 G2/G3/G4 指标没有退化。

## 7. 参考文件

- [UI/UX 规范](UI_UX_SPEC.md)
- [Windows Phase 2 实施计划](WINDOWS_PHASE2_IMPLEMENTATION_PLAN.md)
- [Windows 全功能优先实施计划](WINDOWS_ALL_FEATURES_IMPLEMENTATION_PLAN.md)
- [协议规范](PROTOCOL_SPEC.md)
- [状态机](STATE_MACHINE.md)
- [Agent Decision Trace 规范](DECISION_TRACE_SPEC.md)
- [安全模型](SECURITY_MODEL.md)
- [运维与隐私](OPERATIONS_AND_PRIVACY.md)
- [Windows 测试执行约定](WINDOWS_TESTING_WORKFLOW.md)
