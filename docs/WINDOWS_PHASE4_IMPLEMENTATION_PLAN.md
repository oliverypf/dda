# Windows 阶段四：功能补齐、运行时收敛与发布验收实施计划

版本：v1.3  
制定日期：2026-09-15  
修订日期：2026-09-15（加入 Prompt Cache 降 Token 专项）  
状态：计划已整理，工作包尚未按本阶段验收关闭  
适用范围：Windows 桌面客户端、Tauri bridge、自研 Node/Cordis runtime、本地 Memory Journal 与 Jev Decision Plane  
上位计划：[Windows 全功能优先实施计划](WINDOWS_ALL_FEATURES_IMPLEMENTATION_PLAN.md)  
配套：[阶段四验收矩阵](WINDOWS_PHASE4_ACCEPTANCE_MATRIX.md)

## 1. 阶段目标与范围

阶段四接收阶段二和阶段三仍未关闭的 Windows 工作，以及旧 durable、反馈、Git 专项计划中的真实缺口。完成用户可以操作的功能、运行时迁移和当前候选版本的验收证据，使 Windows 版本达到完整本地工作台的交付条件。

“阶段四”是实施阶段名称，继续使用现有发布标识 `WINDOWS_FULL_LOCAL`，不新增同名 release channel，不重编号或降低原 G2/G3/G4/G5 发布门。阶段四可以在长期观察期间开发；代码、自动化、实机验收、日历观察和发布签署分别判定，任何一项完成都不能替代其他项。

本阶段只做 Windows：

- 保留 Windows 所需的领域契约、schema、fixture、迁移和版本协商；不开展跨平台协议抽取或三端一致性项目。
- 不纳入 Linux 客户端/打包、HarmonyOS ArkUI/Facade 迁移、Gateway、跨设备接续、远程工作区或企业策略产品化。
- Windows 使用自研 Node/Cordis runtime 直接调用模型 provider，任务、工具、审批、验证和恢复继续由本项目管理。按用户明确要求取消 App Server 接入，不作为开发任务、安装依赖或发布条件；自研 runtime 的长期驻留继续保留。
- 桌面、Windows 触控设备与 Windows 辅助功能属于验收范围；手机 companion 不属于本阶段。
- 沿用已有权限上限、审批、一次性 lease、隐私和失败关闭规则。涉及长期后台拓扑、信任边界或自动路由策略的变更，按既有 ADR 流程形成具体设计后实施。

## 2. 核对基线与证据口径

### 2.1 本次核对基线

核对日期为 2026-09-15；Git HEAD 为 `0589d1b28e703b4bda11ec384b9ea36298fa414b`，工作区另有未提交改动。本文件根据当前工作区源码、验收矩阵与历史产物整理，不能将所有工作区代码视为已经进入该 HEAD、已安装包或已发布版本。

主要来源：

- [Phase 1 验收矩阵](WINDOWS_PHASE1_ACCEPTANCE_MATRIX.md)：Event Store、提交顺序、回放、W5/W6 和只读发布证据。
- [阶段二验收审计](WINDOWS_PHASE2_ACCEPTANCE_AUDIT.md)与[阶段二进度](WINDOWS_PHASE2_PROGRESS.md)：受控链路、集成、安装候选和 G4 阻断；审计内的 build-4 待 UAC、86 分钟描述已有后续记录。
- [阶段三计划](WINDOWS_PHASE3_PRODUCT_EXPERIENCE_PLAN.md)、[阶段三验收矩阵](WINDOWS_PHASE3_ACCEPTANCE_MATRIX.md)和[体验报告](WINDOWS_PHASE3_EXPERIENCE_REPORT.md)：尚未闭合的 UI 与实机要求。
- [Git 审计计划](WINDOWS_GIT_AUDIT_DESIGN_PLAN.md)、[Bayesian 反馈计划](WINDOWS_BAYESIAN_FEEDBACK_DESIGN_PLAN.md)：Git-G2/G3、Feedback-F4/F5 的已有定义。
- [.pi durable 旧待办](../.pi/todos/76d69a40.md)：用于追溯遗漏，不以其整体 `in_progress` 状态判定每个子项未完成。

冲突时，按候选版本、采样时间、证据范围逐项核对源码和真实产物；不能仅因文档更新较晚就覆盖更严格的契约或宣告通过。此计划不改写原始历史证据。

### 2.2 已有基础，不重新列为从零开发

| 能力 | 核对结果 | 阶段四处理 |
| --- | --- | --- |
| 默认 Harness Event Store、durable 提交、投影回放 | M1/M2/M3 已有通过记录；dashboard 关键治理摘要已有事件源读取 | S4-01 只清点和收敛剩余入口，保留已通过回归 |
| W5 故障注入与容量 | 崩溃、锁竞争、阈值、万条回放分页已有测试；超过 100,000 事件另有显式规模测试 | S4-15 在新候选上回归并补 UI 性能，不能写成 W5 未实现 |
| W6 删除治理 | retention index、异步 purge、进度持久化、重试、tombstone、防缓存复活已有实现 | S4-08 补桌面操作；S4-16 完成 30 天观察 |
| Jev Decision Plane / Memory Journal | 已有 runtime 决策接口、证据轨迹和保守降级基础 | S4-03/05/09/11 验收候选选择、工具门禁、行为判断和不可用降级 |
| 安装生命周期 | 2026-09-11 build-5 已有真实提权 NSIS install/upgrade/migration/rollback/uninstall 证据 | S4-16 对最终候选重验，不再把 build-4 待 UAC 作为当前动作 |
| 状态标签 | 源码已覆盖 QUARANTINED、PAUSED_UNSUPPORTED 的中文与下一步 | S4-02 补全状态行为和剩余乱序场景，更新过时矩阵 |
| 历史切换与流式 UI | 历史 UI 10 项、执行 UI 8 项已有通过产物；包含旧响应隔离、增量渲染、审批响应、草稿/展开/阅读位置保留 | S4-02/06/15 保留模拟测试基线；S4-16 补当前安装候选验证 |
| 审批反馈 | 已有“处理中…”、防重复提交和审批事件更新 | S4-04 补完整授权阶段、Lease 生命周期和实机覆盖，不重做已有交互 |
| 故障恢复 | 崩溃、断线、取消、UNKNOWN 和防重复副作用已有后端及部分安装包测试 | S4-09 补角色失败收尾、完整可见状态及剩余实机场景 |
| 反馈、Git、Bayesian | 已有只读反馈摘要、动作前后 Git 观察、scope 对照、签名/序列/事件摘要校验、REBUILT 标记和 Bayesian 基础 | S4-07/13/14 完成未闭合的交互、互验与治理 |

2026-09-15 定向回归：durable facade、retention、删除防复活、read-model、容量、数据库崩溃、dashboard 事件源共 48/48 通过。该结果不包含完整安装包、无障碍或全量性能验收。

### 2.3 仍有效的发布阻断

| 阻断 | 核对时证据 | 完成条件 |
| --- | --- | --- |
| LONG_RUN_WINDOW_INCOMPLETE | [独立采样文件](artifacts/WINDOWS_PHASE2_W10_EVIDENCE.json.longrun.json)为 1315/1440 分钟，最后更新 2026-09-12 13:28:32 +08:00；查询计划任务未显示下次运行。聚合 W10 报告仍为 151 分钟 | 排查采样调度并恢复真实采样，核对物理 store/候选身份；累计有效观察达标后刷新聚合报告 |
| RETENTION_PARTIAL | 日历窗口为 2026-09-09 00:00 至 2026-10-09 00:00 +08:00；核对时计划任务最近于 2026-09-14 12:00:01 成功运行 | 窗口结束且进度、失败/重试、删除结果均有有效证据；到日期本身不等于通过 |
| RELEASE_DECISION_REPORT_MISSING | [W10 证据](artifacts/WINDOWS_PHASE2_W10_EVIDENCE.json)中 decisionReport.ok=false | 具名运维/发布责任人审阅真实证据并签署；自动生成报告不替代签署 |
| REAL_WORKSPACE_OBSERVATION_MISSING | W10 证据中 workspaceObservation.ok=false | 在真实 Windows 工作区完成只读、批准执行、安全拒绝、取消/恢复、治理/删除等记录 |

观察中断期间不补算时间。1315 分钟是历史采样状态，尚未确认适用于最终候选：不得直接算入新候选，也不得未经身份与变更影响核对就全部作废。代码、候选或物理数据库身份变化后，记录可复用与需重采的证据范围，不能混用旧安装版和 MSIX 重定向副本。采样调度是可修复的工程问题；真实工作区使用是待执行验收；只有真实计时、具名签署或缺少所需设备等具体子项单列外部阻断。原 G4 维持 NOT_READY，阶段三 G5 也未完成。

### 2.4 两轮检视意见的采纳与证据边界

本次修订把“执行证据报告对照”和“阶段四特征缺口总览复核”两轮意见写入原有工作包。当前 16 包均为 PARTIAL、零 VERIFIED；这描述整个包尚未关闭，不等于包内所有功能未实现。后续报告统一使用“剩余实现／集成／验收缺口”，不得把已有代码、模拟测试和待实机项混为一类。

| 意见 | 本计划处理 | 落点 |
| --- | --- | --- |
| 角色失败/取消后仍可能停在 BUSY | 列为优先复现和修复的一致性缺口；检查合法终态提交、UI、重启恢复与常驻进程资源释放 | S4-01/03/09/10 |
| 执行/历史 UI 测试缺正式接入 | 明确两套脚本、构建前提、顺序入口、失败阻断和证据归档；历史 npm 入口属于待实现 | S4-15/16、第 6 节 |
| 慢健康/恢复/审计读取拖住交互 | 将现有模拟测试纳为不退化基线，补真实 bridge 的对应场景 | S4-02/06/15 |
| 配置跨层往返细则不足 | 覆盖 Rule Verifier、Jev 决策配置、网络目标、高级模型字段、默认/清空/非法输入和生效范围 | S4-03/08/11 |
| 只列 runtime 大入口拆分 | 增加前端 main.ts 与 Rust lib.rs 的按职责拆分；属于维护性工作，不因文件大小自动升级为安全阻断 | S4-01/02/11 |
| Git-G2/G3 被误归 P2 | 保持 S4-13 为 P1；已有签名/序列/REBUILT 不列为从零实现 | S4-13 |
| 常驻 runtime 被与当前缺陷并列最高优先 | S4-10 保持 P2；角色收尾与已有进程取消隔离先修，不等待常驻改造 | 第 5 节 |
| 观察证据一概“非当前候选”或“外部阻断” | 逐项核实证据适用性，将工程修复、待执行试用、计时及签署分开 | S4-00/16 |
| Reasonix 宣称 99% 缓存即可直接照搬 | 采用稳定前缀、角色隔离、append-only 和 provider usage 观测；历史命中率标为 UNKNOWN，不承诺固定 99%，以真实 Windows provider A/B 数据验收 | S4-03/10/15，ADR-0022 |

证据补记（以下为已读取的历史产物，本次文档修订未重跑）：

- [历史 UI 结果](../.codex-tmp/history-ui/results.json)为 10 项，[执行 UI 结果](../.codex-tmp/execution-ui/results.json)为 8 项，均报告通过；[历史脚本](../desktop/scripts/ui-history-test.mjs)和[执行脚本](../desktop/scripts/ui-execution-test.mjs)使用隔离浏览器及模拟 native bridge，不能作为真实 Tauri/安装包的端到端验收。
- [角色只读记录](../.codex-tmp/debug-role-events.out.json)使用[本地模拟 provider 脚本](../.codex-tmp/debug-role-events.mjs)，executionMode=READ_ONLY、toolRounds=0，证明该成功场景的角色生命周期，不能证明真实模型、受控工具链或所有失败分支。[受控角色记录](../.codex-tmp/debug-role-events-controlled.out.json)以 run.failed 结束、六个角色最后为 BUSY；当前 [runtime](../runtime/src/index.mjs) 成功路径有角色关闭，失败 finally 主要 flush。列为待定向复现、修复和回归项，不将调试产物冒充当前候选完整测试。
- 2026-09-14 的 [runtime 日志](../.codex-tmp/runtime-tests-final.log)记录 551 项、550 通过、1 跳过；旧报告的 418/417、Desktop 26 不能作为当前全量数字。2026-09-11 的[阶段二进度](WINDOWS_PHASE2_PROGRESS.md)已有 Desktop 41/41 与 build-5 构建/安装记录，2026-09-09 不是最新安装证据日期。
- “durable 约 70% 完成”没有逐项分母或计算依据，不纳入本计划。W5/W6、W7–W10 按具体剩余项判断；功能完整、全量通过等结论必须附适用候选与覆盖范围。
- 临时目录中的 JSON/日志可能被后续运行覆盖。S4-00 需按时间、源码/构建摘要、环境、命令、退出码和证据类别固化到验收目录后再用于关闭工作包；不能靠文件名或修改时间推断候选版本。

## 3. 工作包总览

2026-09-15 范围修订：原 S4-12（App Server 接入）已取消，编号保留不复用；本阶段现有 16 个工作包，依赖与验收均排除该项。

优先级：P0 为安全、一致性与发布阻断；P1 为 Windows 核心交互与专项集成（含 S4-13 Git 互验）；P2 为本阶段后段的运行时/演进收敛（S4-10、S4-14）。同包内维护性拆分不自动继承安全缺陷的最高优先级。P2 仍是阶段四范围，不等于可静默省略。状态与逐项证据由[验收矩阵](WINDOWS_PHASE4_ACCEPTANCE_MATRIX.md)维护。

| 编号 | 工作包 | 优先级 | 主要依赖 | 遗留来源 |
| --- | --- | --- | --- | --- |
| S4-00 | 差异清单、证据身份与验收基线 | P0 | 无 | 旧 TODO、README、阶段二/三矩阵冲突 |
| S4-01 | durable facade、事实源与 Windows 契约收敛 | P0 | S4-00 | W1–W3 收尾、facade 全链路 |
| S4-02 | 导航、运行状态与 Composer 完整行为 | P1 | S4-00；新增契约经 S4-01 | S3-01/02 |
| S4-03 | 角色绑定、模型集合与候选详情 | P1 | S4-01/02 | S3-03、S2-12 UI 缺口 |
| S4-04 | 审批详情与 Lease 生命周期 | P0 | S4-01/02；复用 S4-05 Diff | S3-04 |
| S4-05 | Diff、Terminal、Verifier 与证据跳转 | P1 | S4-01/02 | S3-05 |
| S4-06 | 运行记录、Decision DAG 与 Council | P1 | S4-02/03/05 | S3-06 |
| S4-07 | 用户反馈与角色归因 | P1 | S4-01/06 | Feedback F1/F2、反馈 UI |
| S4-08 | 治理管理、诊断、导出删除与备份 | P1 | S4-01/02；与 S4-06 共验 | S3-07、W6 UI 缺口 |
| S4-09 | 断线、未知结果与故障恢复体验 | P0 | S4-01/02/04/05/08 | S3-08 |
| S4-10 | Windows 任务运行时长期驻留 | P2 | S4-01；与 S4-09 共验 | desktop 长期驻留待办 |
| S4-11 | Windows 安装、路径、凭据与 capability 适配 | P1 | S4-00；与 S4-10 共验 | desktop 平台适配待办的 Windows 部分 |
| S4-13 | Git 审计 G2/G3 全链路互验 | P1 | S4-01/04/05/06 | Git 专项 G2/G3 |
| S4-14 | Bayesian F4/F5 路由与 Evolution 安全门 | P2 | S4-03/07；已有 Controlled 安全门 | Feedback F4/F5 |
| S4-15 | Windows 无障碍、大数据与高频事件性能 | P1 | 各用户流程完成；可提前建立基线 | S3-09/10、W10 |
| S4-16 | 最终候选、实机观察与发布证据结项 | P0 | S4-00–11、S4-13–15；观察可提前启动 | S2-13/G4、S3-10/G5 |

## 4. 工作包与完成标准

### S4-00 差异清单、证据身份与验收基线

交付：

- 清点当前源码、未提交改动、已安装版本、构建产物、W10 聚合报告与独立采样文件，分别记录时间、版本及摘要。
- 将旧待办逐项映射到本表；已完成项保留来源，部分项明确到接口、场景或证据缺口；对照第 2.4 节保留已有 UI 18 项、审批、Git 和恢复基础，逐项区分实现、集成、模拟验证及实机证据。
- 复核 sampler 的触发器/结束时间/下次运行及退出码；区分调度故障和有效观察不足。
- 记录真实用户数据目录和 MSIX LocalCache 的物理身份；只读核对身份，不自动合并数据库。
- 建立阶段四场景编号、候选版本、测试输出与证据目录约定；固化已采用临时产物的原始内容摘要及来源，未掌握的运行/构建身份明确标为未知，不补造元数据。

验收：每个未完成项都有唯一工作包与完成条件；旧 86 分钟、build-4 待 UAC、特殊状态字符串回落不再作为当前结论；未知项显式保留未验证状态。

### S4-01 durable facade、事实源与 Windows 契约收敛

现状：已有 commit-before-effect 链路；`createDurableCommitFacade` 当前仅被测试引用。统一模块未接入不等于现有链路没有持久化。

交付：

- 按 TaskRun、工具、Approval/Lease、Thread、Decision/Outcome、Memory、Dream、Plugin、Evolution、Feedback、Credit/Blame 建立命令/写入/读取清单。
- 将仍分散的关键提交通过统一 facade 接入，复用现有已验证原语；动作前等待 intent/decision/approval/lease 提交，动作后等待 outcome 再推进终态或通知 UI。
- Windows 发布入口和治理命令明确绑定同一个 Harness Store；缓存缺失可重建，损坏/陈旧缓存不能成为权限或执行事实。
- 旧 JSON/JSONL 入口明确作为显式导入/兼容边界，按现有弃用政策退役；不以删除全部兼容文件为完成标准。
- 收敛 Windows desktop → bridge → runtime 的命令入口和 DTO，区分 UI HarnessFacade 与内部 durable facade；补 commandId、版本检查、receipt、错误和过期拒绝的 Windows fixture。
- 优先复现并修复失败/取消的角色收尾：按角色状态机提交合法 FAILED/CLOSED 或明确的恢复对账状态，保留原始任务失败原因；提交失败不伪造“所有角色已关闭”，重复清理不重复事件或副作用。成功、失败、取消、超时与进程异常均验证事件事实、投影及恢复一致。
- 按命令分发、任务装配、执行链、查询/治理拆出 `runtime/src/index.mjs` 的剩余职责；同一职责清单覆盖前端 `desktop/src/main.ts`（S4-02）和 Rust `desktop/src-tauri/src/lib.rs`（S4-11）。保持 CLI、IPC、事件语义与运行行为兼容；按职责和可测试边界拆分，不设文件大小发布门槛。

验收：清单中的每条生产链路有调用点与回归证据；intent 提交失败无副作用，outcome 提交失败不报成功，重复命令不重做，推送不早于提交；清空派生缓存重建后 checksum 和页面状态一致；角色失败收尾先于常驻改造验证，不能以 flush 队列代替生命周期状态提交。

### S4-02 导航、运行状态与 Composer 完整行为

现状：已有六页骨架、历史旧响应隔离、草稿/展开/阅读位置保留及模拟回归。此包补剩余跨页面状态、命令和实机覆盖，不把已覆盖乱序保护重新记为未实现。

交付：

- 补页面/thread/run/workspace 快速切换、异步响应乱序、重启恢复和滚动锚点场景；旧任务回包不能覆盖新任务页面，启动恢复不得覆盖用户更早的主动导航。
- 保留非阻塞交互基线：历史摘要/首屏允许在慢 health/recovery 期间读取；已提交的任务终态在非关键审计查询尚未完成时可见；流式及非流式任务跨页完成不被当前页面阻塞。后台查询未完成不阻塞浏览，不得据此提前放开执行或绕过 recovery 安全门。
- 按导航、设置/Composer、运行事件与页面渲染拆出前端 main.ts 的职责，复用 keyed-list/live-timeline，保留 DOM 行身份、焦点、展开状态和阅读锚点。
- 区分 schema/projection 格式版本与快照进度/序列；按实际契约拒收旧数据，发现缺口重新读取。
- 六页统一 loading/empty/error/permission/stale/unsupported 状态；过期数据下禁止依赖旧状态执行命令。
- 对照状态机补每个状态的文案、操作和终态行为，复用现有隔离/不兼容标签。
- 核对并补齐提交、重复提交、新 run、steer、取消、暂停/恢复的命令回执；尚未接通时明确禁用，不能用本地改状态模拟执行；原计划要求的操作必须接通后才能关闭对应验收项。

验收：乱序和重复响应不会跳错 run 或重复任务；失败/取消/UNKNOWN 不显示成功；页面重启恢复和每个可用操作都有命令到投影的证据。逐条记录 command → durable event → projection → UI，已有取消闭环保留回归，steer/暂停/恢复按实际缺口补齐；模拟测试和真实安装包分别出证据。

### S4-03 角色绑定、模型集合与候选详情

交付：完整展示实际角色/provider/model/binding/版本/预算；支持配置允许模型集合；逐候选展示过滤、截断、Jev 选择、fallback、出域及可知成本、选中/未执行；模型不可用时给出合法暂停或选择路径。模型请求按 workspace/model/role 隔离稳定缓存路由，工具 schema 确定性排序，稳定 workspace 前缀置于动态 history/prompt 之前；candidate、planner、executor、Jev decision 不共用缓存身份。

补充：角色分配不等于实际参与执行；失败/取消/超时后按 S4-01 的已提交状态更新角色视图，不能长期显示 BUSY，也不能把未执行角色显示为已完成工作。模型集合和 roleBindings 的表单、bridge、Rust 配置、runtime 解析与新任务生效须往返一致；与 S4-08/11 共用配置验收矩阵。

验收：配置仅按声明的范围生效，运行中变更需新 snapshot/决策；未选候选不显示为执行者；默认单候选没有额外模型调用，硬淘汰不可被评分复活，缺失实际费用显示未知。缓存路由不得包含路径、prompt、源码、凭据或模型正文；不同角色/模型/工作区不得错误复用前缀。

### S4-04 审批详情与 Lease 生命周期

现状：已有“处理中…”、防重复提交和审批事件处理；尚需完整授权阶段、租约生命周期、Diff 与当前安装候选实机验证。

交付：将 command/path/cwd/scope/digest/有效期和可用 Diff 接到审批；展示 intent、approval、lease、operation、outcome 的关联和全生命周期；补拒绝、过期、替代、重复、跨 run、已消费、断线重现、策略收紧和撤销的可见回执。

验收：批准按钮提交不代表授权成功；只有已提交的权威事件可推进显示。卡片内容或版本变化后旧批准被拒绝；拒绝与批准均键盘可达；大 Diff 截断不隐藏授权范围或伪装成完整预览。

### S4-05 Diff、Terminal、Rule Verifier/Jev 与证据跳转

交付：

- 文件/块级 Diff、分页或虚拟化；分别标记 proposed/executed/verified，并绑定文件 snapshot/digest。
- Terminal 命令证据显示 cwd、exit code、耗时、截断、脱敏与 operation 关联；输出解析失败仍保留允许展示的有界证据与执行结论，不新增原始敏感输出持久化。
- Rule Verifier 每项 PASS/FAIL/UNKNOWN/SKIPPED 可检查；Jev 展示 decision、reason codes、证据摘要、fallback 和延迟，不再展示独立语义 Verifier 模型身份。
- 统一 evidence ref 跳转到文件快照、Diff、命令、事件或报告；过期、缺失、已删除证据有明确状态。

验收：从成功/失败结论可以跳回对应证据；旧文件内容不能冒充本次执行结果；UNKNOWN、无证据或已删除证据不标为 PASS。

### S4-06 运行记录、Decision DAG 与 Council

现状：历史分页、迟到响应隔离、错误/空页恢复和草稿保留已有模拟验证。保留启动历史先于 health/recovery、恢复中切换线程、所有旧页可达、延迟详情、连续切换及新任务使旧请求失效等回归；补真实 bridge 场景和下列管理功能。

交付：历史筛选与 cursor 分页、单 run 查看/允许的恢复、脱敏导出和删除入口；Decision 的候选、证据、parent/supersedes/critiques/selects/outcome 关系可导航；Council 展示 claim/critique/Jev/probe、预算、停止原因及已有协议允许的停止/降级操作。

验收：历史导出有 scope 与结果回执；删除后保留最小 tombstone 并拒收迟到事件；恢复走权威对账而非重放副作用；模型自述、系统判断和事实来源分明。导出/删除的共享协议先在 S4-01 冻结，与 S4-08 共用长操作进度及删除实现，两个页面不各自实现后端动作。

### S4-07 用户反馈与角色归因

现状：已有只读反馈摘要和 runtime 记录能力，用户可操作的反馈与精确归因未闭环。

交付：反馈提交、追加修订、撤回与失败重试；分别保存主观满意度、客观 outcome、Rule Verifier 和 Jev 判断；关联 run/decision/role/model/binding/plugin 版本及真实 evidence；Credit/Blame 展示依据和不确定性，无依据时显示不可归因。

验收：重复反馈不重复计权，修改不覆盖原事实；UNKNOWN/CANCELLED/NOT_EXECUTED 不计成功样本；提交失败不改变 TaskRun 结果；删除/撤回后统计投影重建一致，不把参与模型都归为执行者。

### S4-08 治理管理、诊断、导出删除与备份

交付：

- 补 Memory 版本/来源/撤回、Dream 门控/进度、Plugin 签名/权限/隔离/升级回滚、Evolution 评估/monitor/kill switch 的详情与回执；已实现按钮只补缺失链路。
- Support Bundle、按 run/thread/project/all 脱敏导出、删除/retention、备份恢复统一展示范围、进度、失败重试和完成结果。
- 复用 retention worker 与 tombstone，不另建 UI 权威删除状态；重启后从持久进度恢复显示。
- 备份恢复校验 schema、摘要和 store 身份；旧备份中的已删除数据不得通过恢复流程复活。
- 补设置配置全链往返矩阵：Jev 的判定标准、证据预算、超时、fallback 及种子，受控网络目标，高级 models/roleBindings 均覆盖默认值、部分填写、清空、非法输入、保存失败和重启读取。持久化配置须保存后重读一致；每次任务的网络 scope 按声明仅对该任务生效，不强制改成持久化授权。修改普通模型字段不得丢失高级字段；运行中任务保持原 snapshot，新任务按声明使用新配置。已有 Rule Verifier/Rust 往返测试作为基础，补安装包 UI→bridge→runtime 闭环。

验收：上述管理动作至少有成功、拒绝/失败、重启后续看三类场景；隐私扫描无敏感正文/凭据泄露；恢复默认不隐式删数据；清除派生缓存不丢治理状态。

### S4-09 断线、未知结果与故障恢复体验

现状：已有后端 recovery、故障注入和防重复副作用基础，主要补剩余用户可见状态与当前候选实机覆盖。角色失败/取消收尾是本包优先复现项，不等待全部管理页面或 S4-10 完成。

交付：Recovery 详情列出工作区变化、未决审批、撤销 lease、未知 operation 与允许动作；任务/模型/执行器断线、崩溃、休眠恢复、迟到事件、数据库锁/损坏/容量耗尽和版本不兼容都有可见状态；存储故障进入只读维护且可查询诊断/允许的导出。

验收：在真实 Windows 安装包上区分“未执行”“已执行但结果未知”“验证失败”；重复 recovery 不重做副作用、不重复 outcome；恢复按钮只提交允许的命令；故障不以空白项目覆盖旧状态。成功、失败、取消、超时、审批拒绝、进程被杀各有角色终态检查；原进程退出与同一常驻进程继续运行分别验证，重复 recovery 不把合法终态恢复为 BUSY。

### S4-10 Windows 任务运行时长期驻留

现状：任务 Node 仍按任务启动；已有 Dream daemon 和 sidecar supervisor 不等于任务运行时已长期驻留。

交付：按 ADR 固定本机长期运行时的所有权、IPC/握手、版本、认证边界、空闲/退出策略和日志位置；桌面多个任务复用服务，支持取消隔离、workspace 互斥、有限队列、心跳、退避重启、崩溃后对账和升级时有序停止。复用已有 sidecar 健康/重启/降级能力，避免重复拉起实例。服务复用后继续保持 ADR-0022 的稳定缓存 scope，升级或配置变化必须有意使旧前缀失效，不得跨工作区或角色串用。

验收：连续任务复用同一受监督服务；一个任务取消不误杀其他任务；桌面/服务异常退出、用户注销/休眠唤醒/版本升级符合生命周期规则；无孤儿进程、重启风暴、跨工作区上下文串用或自动副作用重放。CLI 仍可独立诊断。一个任务失败/取消后，其角色上下文、provider 资源、监听器、计时器和队列占用按生命周期释放或进入可对账状态，其他任务不受误清理影响；S4-01/09 的角色收尾回归必须在服务复用场景重验。

### S4-11 Windows 安装、路径、凭据与 capability 适配

交付：

- 随安装包提供可验证版本的 Node runtime，解决现有系统 Node 前置依赖；将 runtime、sidecar、依赖、许可证、digest 与 SBOM 纳入发布链。
- 收敛 Windows capability 与命令权限映射，保持最小窗口/bridge 权限；不通过开放通用 shell/任意文件权限实现 UI 功能。
- 覆盖本地盘、空格/中文/长路径、UNC/映射盘、junction/symlink、用户目录重定向和安装目录只读；配置与数据不落 Program Files。
- 明确凭据适配接口与现有环境变量模式；需要安全持久化的凭据使用 Windows 受保护存储并只显示状态/指纹，遵循用户明确配置，不自动迁移或复制密钥。
- 将 Rust lib.rs 中的配置持久化、workspace 授权、runtime 进程/查询、历史与治理 IPC 按职责拆分，保持命令名、参数与拒绝语义兼容；与 S4-03/08 验证配置序列化、合并、高级字段保留、非法输入拒绝和设置生效范围。该拆分属于维护性收尾，不能因文件尺寸单独判定安全不合格。

验收：干净 Windows 标准用户会话可从已安装包启动，无系统 Node 也能运行；敏感值不进入配置明文、事件、日志、UI 或 Support Bundle；提升安装进程权限不会改变普通任务权限；MSI/NSIS 的保留数据和清理范围符合声明。

### S4-13 Git 审计 G2/G3 全链路互验

现状：Git-G2 已有动作前后观察、scope 对照及越界撤销；Git-G3 已有查询、签名、事件序列/摘要关联校验及 REBUILT 重建标记。此处 Git-G2/G3 与阶段二发布门 G2/G3 分别跟踪。

交付：将动作 observation、intent/approval/lease/outcome、scope violation checkpoint 串成可导航证据；补独立 audit ref 或专项设计允许的独立审计仓库、manifest digest、签名、Event Store sequence 和 projection checksum 的完整互验；保留并回归已有 REBUILT 标记，删除/导出遵循现有隐私和 tombstone 规则。

验收：篡改签名/digest、跨 run 引用、序列错误、projection 不一致、缺失 key/证据均有明确状态；Git 不可用时按只读/受控契约降级或阻断，不伪装验证成功；越界撤销 lease 并停止/隔离；不自动提交用户业务文件。

### S4-14 Bayesian F4/F5 路由与 Evolution 安全门

现状：F4/F5 已在专项设计中定义；已有 posterior、safe rank 和 Evolution 基础，不能据此宣告线上路由和演进验收完成。

交付：F4 在确定性过滤后仅排序安全候选，版本/snapshot/模型/plugin 变化触发新过滤和 Decision；数据不足、损坏或模块不可用回退静态 Router。F5 将 router/config/posterior 版本作为 Evolution candidate，关联 baseline、dataset digest、holdout 与 replay/shadow/canary/monitor，提供明确开关和 rollback。

验收：排序不扩权、不跳 Approval/Lease/Verifier；重复/撤回样本和 cohort 隔离正确；安全回归、泄露、校准漂移、成本失控、恢复失败可阻止晋级或回滚；固定基线与真实观察证据齐全。自动晋级、路由策略变更不得因 UI 或评分自发启用。

### S4-15 Windows 无障碍、大数据与高频事件性能

现状：隔离浏览器中执行 UI 8 项、历史 UI 10 项已有通过产物，覆盖 1024 个混合 delta、600 个折叠事件及反复历史切换等；这些固定 fixture 无 long task 的结果不能推广为最终安装包的完整 SLO。

交付：在 Windows 键鼠及触控设备上验证关键流程、屏幕阅读器、焦点顺序、live region、高对比、字体缩放、减少动画和窗口缩放；补 timeline/DAG/diff/文件/日志分页或虚拟化、滚动锚点与后台刷新；对最终候选保存高频事件、超大 Diff、长输出、并发任务及恢复数据。

回归接入：保留 `desktop/scripts/ui-execution-test.mjs` 与 `desktop/scripts/ui-history-test.mjs`；已有 `test:ui:execution`，计划新增 `test:ui:history` 和明确的 UI 汇总入口，不能将尚未新增的命令写作已可用。对本次冻结构建先运行历史 UI，再运行执行 UI，其他安装版套件按隔离/共享资源顺序执行；全部必需结果进入发布判定，缺结果、脚本失败、漏跑或过期构建均不能宣告全量通过。

负载与阈值：沿用已有万条回放与显式超过 100,000 事件规模用例；记录目标设备、事件速率、单事件/文件大小、并发、时长和样本数，负载基线在测量前固定。按[运维 SLO](OPERATIONS_AND_PRIVACY.md#9-健康指标与-slo)验证 receipt p95 < 100 ms（不含外部调用）、事件到 ReadModel p95 < 250 ms、非终态扫描 p95 < 2 s、完整恢复索引 p95 < 5 s、无持续主线程阻塞 > 50 ms。单次演练耗时不能冒充 p95，W10 脚本宽松预算不替代规范 SLO。

Prompt Cache 与 Token 基线：在相同 provider/model、相同工作区快照和相同角色前缀下执行冷启动与暖缓存对照，记录总调用、usage 上报调用、cache usage 上报调用、input/cached/uncached/output tokens、prefix 变化原因和任务结果。命中率只按 `cachedInputTokens / cacheEligibleInputTokens` 计算，同时报告 `cacheCoverage`；未上报缓存字段保持 UNKNOWN。先取得真实基线再设优化阈值，不以 99% 宣传数字作发布门，也不得通过发送无用大上下文提高命中率。比较开启/关闭 `HMCODEX_PROMPT_CACHE` 的 uncached input tokens，并验证输出质量、安全门、工具行为和延迟无回归。

验收：发布支持的输入/显示方式均能完成关键操作，无关键事件丢失或错误跳转；保留原始测量和不达标项；规模测试默认 skip 时必须显式运行并记录；不能只凭 CSS、源码标记或 mock DOM 通过宣告实机/性能通过。

### S4-16 最终候选、实机观察与发布证据结项

交付：

- 先恢复并验证长期采样调度，继续 retention；固定候选后确认哪些旧证据仍适用，受影响证据重采，保留原始记录。
- 对最终 Windows 候选执行全量基础回归、S4-15 明确的模拟 UI 与安装版 UI/安全套件，记录真实模型/模拟 provider 的区别；再完成 MSI/NSIS 干净安装、升级、数据迁移、回滚、卸载/重装和无系统 Node 启动。UI 基础模拟测试缺结果不能关闭本包，模拟测试通过也不能替代安装版验证。
- 真实工作区完成只读、批准的受控任务、安全拒绝、取消/超时、断线/恢复、模型切换、Plugin/Memory/Dream/Evolution 治理、反馈、导出/删除和支持包场景。
- 长运行累计有效观察不少于 1440 分钟，相邻计入采样间隔不超过 120 秒；30 天 retention 完成窗口与数据结果检查；另记录真实工作区和发布后的使用观察，不将四者合并为一个计时器。
- 刷新 W10 evidence、release-check、SBOM、plugin/model lock、manifest、阶段三/四矩阵；发布责任人基于实际候选作出具名决策，记录回滚版本、已知限制和观察结果。

验收：S4-00–11、S4-13–15 均有适用当前候选的 VERIFIED 证据；原 G2/G3 无退化，G4 四项阻断解除，G5 体验矩阵通过，安装包身份一致且发布/观察记录完整。单纯构建成功、源码标记 19/19、历史 build-5 生命周期或模型生成总结均不能关闭本包。

## 5. 执行顺序

1. **先处理安全与一致性**：S4-00 固定证据基线；优先完成 S4-01/09 的角色失败收尾、durable 提交边界和命令幂等，以及 S4-04 的授权状态、Lease 与未知结果闭环。这些修复不等待常驻 runtime 或全页面完成；表中页面依赖只限制完整体验验收。
2. **同时恢复真实观察**：在 S4-00/16 排查并修复采样调度，检查 retention。工程修复与日历等待分别记录，开发期间继续有效采样；最终候选确定后核对历史样本适用性。
3. **先固定回归再扩展交互**：S4-15/16 接入已有执行/历史 UI，S4-02/06 固定非阻塞历史和跨页完成场景，S4-03/08/11 固定配置往返。已有取消、审批和恢复行为必须保留。
4. **补核心用户流程与专项互验**：依照已冻结契约完成 S4-02/03/04/05 → S4-06/07/08，汇合到 S4-09；S4-13 Git 互验按 P1 推进。复用 Diff、证据导航、长操作和投影组件。
5. **完成运行时与安装收敛**：接口稳定后推进 S4-10 常驻与 S4-11 随包 Node/平台适配，S4-14 演进门按依赖收敛；S4-10 保持 P2，不排在现有安全缺陷之前。前端/Rust/runtime 职责拆分配合各包进行，不以大重构阻塞必要修复。
6. **最终验收**：S4-15 完整性能/无障碍 → S4-16 当前安装候选、真实工作区、签署与观察结项。

可以提前编写与前置模块无关的 fixture 和测试场景；这不意味着绕过契约、ADR 或安全依赖，也不要求采用多 agent。阶段四是本次文档规划范围，不自动启动代码改造、安装、后台调度变更或发布。

## 6. 证据与完成规则

- 状态采用 PENDING、PARTIAL、BLOCKED_EXTERNAL、VERIFIED；完成条件见配套矩阵。有实现但缺实机证据保持 PARTIAL；纯日历/签署缺口与可修复代码/调度故障分开列出。
- 每份证据包含工作包/场景、时间与时区、源码 commit 及工作区差异摘要、候选 EXE/runtime/installer 或静态 dist digest、渠道与 schema/protocol/policy 版本、主机/存储身份、命令、退出码、产物路径、已知限制；另标明静态检查、单元/fixture、模拟 bridge UI、真实安装包、真实模型/模拟 provider、人工观察的类别。
- 同一份模拟 UI 产物可以支持导航/增量渲染结论，不能同时冒充原生 IPC、真实工作区副作用和实机辅助功能证据。报告测试计数必须来自同一次适用运行并分别列 total/pass/fail/skip，不拼接旧数据或给出无分母完成百分比。
- 推荐目录 `docs/artifacts/WINDOWS_PHASE4_<PACKAGE>_<DATE>/`，实际生成后再从矩阵链接。当前不创建虚假产物或预填成功状态。
- 按[Windows 测试执行约定](WINDOWS_TESTING_WORKFLOW.md)在 `desktop` 目录运行 `npm run test:all:parallel` 对应的基础套件；所有 suite 完成并记录结果后，顺序运行共享已安装进程/store 的 UI 测试。
- 安全门保持未授权副作用和秘密日志为 0，Decision Trace 指标沿用上位计划；有意跳过的规模/设备测试明确列出，不能计入通过。
- 已有验收因新代码/协议/候选变化失去适用性时，矩阵回退为 PARTIAL 并说明受影响场景；不擦除历史记录。
- 所有包闭合且原发布门满足，才可声明“Windows 阶段四完成”。多平台后续是否启动另行决策。

## 7. 参考规范

- [协议](PROTOCOL_SPEC.md)、[状态机](STATE_MACHINE.md)、[数据模型](DATA_MODEL.md)、[Decision Trace](DECISION_TRACE_SPEC.md)
- [安全模型](SECURITY_MODEL.md)、[运维与隐私](OPERATIONS_AND_PRIVACY.md)、[UI/UX](UI_UX_SPEC.md)
- [Git 审计专项](WINDOWS_GIT_AUDIT_DESIGN_PLAN.md)、[反馈与 Bayesian 专项](WINDOWS_BAYESIAN_FEEDBACK_DESIGN_PLAN.md)
- [ADR 流程](adr/README.md)、[Prompt Cache ADR](adr/0022-prompt-cache-stable-prefix.md)、[Windows 测试执行约定](WINDOWS_TESTING_WORKFLOW.md)
