# Windows 验收续测记录（2026-09-17）

本轮针对上一轮原生验收的两个失败项继续测试并修复。

> **架构口径**：本文是历史验收记录；其中若出现旧 Verifier/OpenViking 术语，只表示当时构建或规格，不代表当前要求。当前决策基线见 [Jev Decision Plane 设计](JEV_DECISION_PLANE_DESIGN.md)。

## 本轮结果

- Rust 原生库：28/28 通过。
- 原生功能 UI：20/20 通过。
  - 包含真实只读任务终态、取消流程 `running -> cancelled -> idle`、六页导航、工作区只读预览、治理面板刷新。
- 原生流式 UI：通过。
  - 224 个采样点，最大流式正文 3054 字符；输出增长期间 `.app-shell` 保持同一 DOM 节点。
- 前端生产构建：通过；随后重新构建当前 Tauri debug 可执行文件。

## 修复

- `desktop/src-tauri/src/lib.rs`：运行时命令锁改为可中断轮询等待。任务在等待 dashboard/task 锁时能够观察取消标记，不再因不可中断的 Mutex lock 导致取消后发送按钮长期禁用；已取消的预留任务不会启动 runtime 子进程。
- `desktop/scripts/ui-streaming-test.mjs`：在真正出现 STREAMING 时间线行后固定 DOM 锚点，并保持对中途根节点重建的严格检查，消除启动阶段历史视图切换造成的误报。

## 尚未闭合

本记录不等同于阶段四最终通过。`docs/WINDOWS_PHASE4_ACCEPTANCE_MATRIX.md` 中的 16 个工作包仍需逐项补齐证据。当前仍缺少或未完成实机证据的重点包括：完整 Approval/Lease 生命周期、块级 Diff 与证据导航、DAG/Council、反馈归因、故障注入与恢复对账、安装包生命周期、真实模型/网络候选基线、长时间运行与辅助功能/多分辨率观察。竞品对比也尚未形成有来源的逐项矩阵。

## 并发回归复核

- 桌面 Vitest 串行复测：7 个测试文件、55 个测试全部通过。
- Tauri Rust 串行构建：结束残留原生进程后成功完成。
- 上一轮并行总回归的 2 个失败项归类为测试资源竞争/进程锁，不构成当前已复现的产品功能失败；并行入口仍不作为发布验收依据。

## 规格界面差异核对

源码核对发现，`UI_UX_SPEC.md` 第 15 节要求的设置分区为：连接与身份、workspace grants、角色与模型、Plugin、Safety/审批、Memory/Dream、隐私/保留、存储、无障碍、开发诊断；当前 `desktop/src/main.ts` 的 `settingsSections` 只有：模型配置、个性化、连续验证。

结论：模型配置、个性化和连续验证已有入口与保存逻辑；其余设置分区没有独立设置入口，部分信息分散在诊断/安全/记忆页面，不能视为满足“设置分区”要求。这是当前明确的界面缺口，需要后续实现或在规格中正式裁剪。

另外，规格第 11、12、18 节要求的块级 Diff、完整 Council Proposal/Critique/Judge/Probe 交互、证据跳转与多设备/屏幕阅读器实测，当前证据仍不足；现有页面只能证明摘要和基础导航存在。


进一步源码对照：

- 记忆页当前只渲染 statement、scope、confidence、status 和部分操作；规格要求的来源 run/event、有效期、敏感性、替代关系、冲突分类及编辑生成新版本没有对应可见字段或操作。
- 能力与安全页当前渲染执行模式、命令/写入/网络开关和受控记录；规格要求的当前动作 decision、required controls、scope、policy version、权限上限来源以及收紧/放开说明没有完整呈现。
- 设置与诊断页提供运行时、Support Bundle、Prompt Cache 和恢复检查摘要，但没有规格要求的完整恢复页（远端状态、workspace 差异、未决 Approval、撤销 Lease）。

这些属于界面功能差异，不是测试脚本缺失；后续应优先补齐数据字段与交互，再重新做原生验收。


## 竞品基线（官方公开资料，2026-09-17）

- OpenAI Codex CLI 明确提供 Suggest、Auto Edit、Full Auto 三种批准模式，并在执行前展示待批准的编辑和命令；dda 已有 READ ONLY/CONTROLLED 与 Approval 基础，但当前界面尚未把“待批准动作清单、影响范围、执行前后 diff”做成完整可审阅流程。
- GitHub Copilot cloud agent 会展示会话进度、读取的文件和变更，并通过 Pull Request 进入人工 review；Copilot code review 支持评论、建议修改和一键应用。dda 有时间线、Verifier、Approval 摘要，但缺少同等完整的变更 review/评论/逐块应用闭环。

竞品对比结论：dda 的安全状态、运行事件和本地只读边界是已有差异化基础；相对成熟竞品，当前最大短板是“可审阅变更界面”和“从提案到执行再到验证的连续证据链”没有完整落到 UI。


## 本轮修复

- 修复记忆治理 UI 的删除入口：`PROPOSED`、`VERIFIED`、`ACTIVE` 状态原先被前置分支遮蔽，删除按钮实际不可达；现在保留验证/激活/撤回操作，并同时显示删除操作。
- 前端构建通过；桌面串行回归 7 个文件、55/55 测试通过。


## 本轮补齐

- 记忆页现在显示来源 event IDs、有效期（未设置时明确显示“未设置”）和可训练/不可训练状态，补上了数据层已有但 UI 未呈现的规格字段。
- 前端生产构建通过。


## Safety 展示修正与证据限制

新增待审批动作摘要，只选取 REQUESTED 审批，展示 capability、审批状态、记录的风险、snapshot digest 和 policyVersion。审批模型没有实际 decision、requiredControls、权限来源字段，因此这些项显示“未提供”，不能用 capability 冒充 decision、风险推导控制项或固定字符串冒充权限来源。该项仍为 PARTIAL，并未完成规格第 9 节。

纠正记忆页：untrainable 缺失显示“训练限制：未提供”；false 只表示禁止训练标记为否，不代表训练授权，也不等同于敏感性分类。前文“补齐规格字段”只适用于已记录的来源/有效期，不能据此宣称敏感性已经实现。

最终前端生产构建通过；此前 55/55 单元测试不覆盖本轮新增 Safety DOM，尚需定向浏览器测试和原生验证。


## 本轮可达性修复

- 修复记忆删除操作的事件类型遗漏：删除按钮虽已渲染，但 `runGovernanceAction` 的 operation 联合类型未包含 `delete`，点击不会调用 bridge；现已加入并完成构建。
- 增加 `test:ui:history` npm 入口，避免已有历史 UI 测试只能直接运行脚本。
- 桌面单元回归：7 个文件、55/55 通过。


## 定向 UI 复测

- 安全 UI：6/6 通过。
- 设置 UI：通过，覆盖布局、分区草稿、搜索、中文指令、校验、重试、移动端和深色模式。
- 历史 UI：12/12 通过；重复 100 事件切换期间记录到 78ms 长任务和一次 50ms 边界任务，仍在规格允许的 16–100ms 合并窗口内。
- 修正 `package.json`，补齐 `npm run test:ui:history` 入口，命令现可直接运行。


## 跨层未实现项确认

- “编辑记忆并生成新版本”目前在 runtime `runMemoryCommand`、Tauri `memory_action` 和 desktop bridge 均无对应操作；UI 不能通过增加按钮单独满足该规格。
- runtime 已有 `support-bundle --output <path>` CLI、隐私扫描和输出冲突保护，并有 runtime 测试；当前 Tauri/前端没有导出/下载命令入口，因此 UI 第 18 节的 Support bundle/导出验收仍未通过。


## 规格证据回归

- 桌面脚本回归：23/23 通过。
- Phase 3 证据检查：19/19 检查通过，产物已重写。
- 这些结果证明已有 Phase 3 页面入口、状态壳、回执、Approval、Timeline、Verifier、Runs、Workspace、Memory、Safety、Diagnostics 和基础无障碍标记仍未回归；不代表 Phase 4 完整规格已满足。


## 证据纠正与记忆定向 UI（最终以本段为准）

- 前文“TypeScript 联合类型遗漏 delete 导致点击不调用 bridge”的因果结论错误：类型断言会在编译时移除。该修改仅完善类型声明。真正的按钮不可达问题是先前的分支遮蔽。
- 78ms 主线程长任务不等于 16–100ms 流式合并窗口内合格，前文的性能合格解释撤回；性能门槛需要独立验证。
- 先前安全 6/6 来自默认 Program Files 安装版，不能支持当前工作区修改。Phase 3 字符串检查仅证明源码标记存在，不能证明行为没有回归。
- 新增 `desktop/scripts/ui-memory-test.mjs`：当前 dist + 模拟原生传输，通过来源/有效期/训练限制未知语义、三种状态删除命令参数和刷新验证。该测试不证明真实 runtime 删除持久化。
- 亲自检查 `.codex-tmp/memory-ui/memory-desktop.png`，发现记录标题与元数据挤在一行以及日期只显示时分。已增加结构化记录布局并显示完整日期/时区；重建后定向测试与截图复核通过。
- JSON 结果位于 `.codex-tmp/memory-ui/results.json`。失败请求反馈、原生持久化和窄屏仍待验证。


## 记忆失败恢复补测

- 删除 bridge 失败时，记忆页现在显示“操作未完成”，明确结果尚未确认，并保留原记录；提供刷新治理状态入口。
- 失败后重试成功会清除当前页错误提示，记录从页面移除。
- `npm run test:ui:memory` 通过；覆盖字段语义、三种状态删除 dispatch、失败保留/不确定提示和成功重试。
- 这仍是模拟原生传输测试，真实 runtime 的持久化删除与进程崩溃恢复尚未验证。


## Support Bundle 当前边界

Rust 已有通用 `run_runtime_json`，runtime CLI 的 `support-bundle` 也已验证；但 Tauri invoke handler 没有 `support_bundle`/`export_support_bundle` 命令，前端没有选择输出路径、触发导出、展示完成路径或下载结果的流程。故当前只能确认后端 CLI 能力，不能确认 UI 规格要求的导出交互。

## 当前原生候选重建与回归

- cargo build --bin hmcodex-desktop --features tauri/custom-protocol 成功，当前 dist 已嵌入 debug 可执行程序。
- 隔离测试目录下原生功能回归：20 passed / 0 failed / 0 skipped，含六页导航、真实只读任务终态、取消后恢复输入。日志：`.codex-tmp/fix-20260916/functional-final.log`；程序摘要：同目录 `current-native-identity.json`。这些路径会被后续运行覆盖，不是不可变发布证据。
- `npm --prefix desktop run test:ui:memory` 成功；这是 Chromium + 模拟原生接口测试，只证明当前前端字段、请求及失败重试行为，不证明 Tauri/runtime 删除持久化。
- 本轮不将页面导航通过扩展为页面完整规格通过。Support Bundle 桌面导出、完整恢复详情和其他已列缺口仍未关闭。

## 记忆重复操作实测

定向浏览器测试先复现主页面/右侧面板对同一记忆提交两次 delete（断言 2 != 1）。现在按 memoryId 在前端锁定所有操作，保持到治理刷新完成；两个入口按钮显示处理中并禁用。测试验证重复 delete、并发 verify 被抑制，并保持失败后可重试。生产构建及 test:ui:memory 通过。

范围限制：这是前端在途去重，不等于 runtime 的持久化 command receipt/跨进程幂等；规格第 17 节仍为 PARTIAL。本次 dist 尚未重新嵌入原生候选。

## 记忆列表完整性验收

本轮使用 19 条模拟记忆复现最近 8 条以外无入口的问题；现增加每页 8 条的有界 DOM 分页、总数与页码，并在删除末页记录后收敛页码。生产构建与 test:ui:memory 通过。测试覆盖三页访问及末页三条全部删除后回到第 2/2 页；截图 memory-pagination.png 和结果位于 .codex-tmp/memory-ui。

本次只验证 dashboard 已返回记录的前端分页，不是服务端分页，也不证明真实 runtime 删除。原生候选未包含本轮改动，记忆分类/编辑/替代关系依然未完成。

## 记忆治理读取失败

新增故障注入先复现“读取失败仍显示旧列表且当前页无提示”。修复后显示刷新未完成、旧数据说明和重新读取按钮；保持旧记录，不显示假空列表。读取成功后清除提示。生产构建及 test:ui:memory 通过，覆盖失败与重试。测试范围为浏览器模拟接口，原生持久化未据此验收。

## 键盘可达性证据范围

记忆 UI 测试现从导航焦点实际连续按 Tab，到达主页面 ACTIVE 记忆的删除按钮，断言 :focus-visible 和 solid outline。test:ui:memory 通过。此前程序化 focus + Enter 只能证明激活行为；此次补充 Tab 可达证据。仍不等同于完整焦点顺序、原生屏幕阅读器或触屏验收。

## 设置键盘焦点

实际 Tab 到达模型输入框，复现组件 outline:0 覆盖全局 focus-visible（none != solid）。原有 focus 边框/阴影仍存在，不能称为完全没有焦点反馈。现补充设置 input/select/textarea 与 Composer 的 2px 键盘轮廓；生产构建和设置浏览器回归通过。新增断言覆盖模型字段 Tab 可达、focus-visible、轮廓样式/宽度；不替代真实屏幕阅读器与整页对比度验收。


### 设置弹窗键盘焦点续验
- 新增真实键盘 Tab / Shift+Tab 完整循环断言，检查每一步焦点留在弹窗内，并回到起始控件。
- 复现：点击“返回应用”关闭后 activeElement 未回到设置入口。统一关闭处理，返回、关闭、取消、Escape 均恢复设置入口焦点。
- 验证：npm.cmd run build 通过；node scripts/ui-settings-test.mjs 通过，包含原有保存、重载、校验、失败重试、窄屏与暗色测试。
- 设置为全屏布局，没有外部遮罩可点击区域，故不把背景点击当作用户路径的覆盖证据。
- 范围：Chromium + 模拟 Tauri 传输，当前 dist；本轮未重建原生 exe，未验证屏幕阅读器或全项目验收通过。


### Approval 批准与策略检查阶段续验
- 按 UI_UX_SPEC 第7节新增事件驱动浏览器断言。修复前：approval.resolved(APPROVED) 后卡片消失，等待策略检查断言超时。
- 修复：主区域和侧栏复用审批卡片；批准后显示“正在重新检查策略”，仅 lease.issued 提供 leaseId 后显示“已授权执行”；已批准不渲染重复审批按钮，事件处理器也限制 REQUESTED 才可提交。
- ui-execution-test.mjs 12项通过，包括过期事件后无操作按钮、拒绝、策略检查到授权阶段，以及流式/取消/设置期间更新回归。本轮 longTasks=[]，不作为普遍性能保证。
- 查看 desktop.png 后发现已授权卡片仍在“待确认安全详情”标题下，调整为“审批与授权状态”。
- 边界：测试为模拟原生事件的 Chromium 当前 dist，未验证真实 Core 的 lease 撤销、审批替代、客户端时钟超时与断线重连；授权终态与历史展示仍需继续验收。不能据此宣布第7节完整符合。


### 授权消费与执行结果不确定续验
- 当前运行时 index.mjs 确认发送 lease.claimed、lease.consumed（含 ok）和 lease.failed（含 intentId，可不含 leaseId）。此前 UI 对 consumed 仅追加时间线，未更新审批卡片，且未处理 failed。
- 新增 leaseState / executionOk 投影：领取、消费、结果不确定均更新主区域和侧栏；失败不继续显示“已授权执行”，不开放重复审批。完成文案区分执行器报告与独立验证结论。
- 修复测试等待方式：事件投影会异步绘制，必须等待目标文本再断言，避免读取上一帧。
- 验证：构建成功；执行界面浏览器测试12项通过（新增领取、消费失败、无 leaseId 的 failed 路径）；真实 runtime approval-events.test.mjs 1/1通过，证明该测试覆盖的一次性审批到消费链路。查看本轮 desktop.png，双处失败状态显示一致。
- 未证明：真实原生界面全链路、撤销/替代独立事件、授权本地计时过期、断线后重建，以及所有规格要求。未将全规格标为完成。


### 审批截止期限、终态和新任务隔离
- 本地截止时间调度关闭 REQUESTED 操作，点击入口同步再检查期限，避免迟到过期事件/休眠后旧按钮继续发送审批。过期卡片保留解释。
- setRunState 在 SUCCEEDED/FAILED/CANCELLED 时取消未决 UI 审批；新任务清空旧审批卡片，避免继承旧任务授权。
- 补齐上一轮新增 leaseState/executionOk 对应的正式 schema 以及正反契约测试。首次单测因测试摘要不符合 sha256 格式失败，修正测试数据后 60/60 通过。
- 构建通过；浏览器执行测试13项通过；读模型/契约7文件60用例通过。新增第7节逐项验收表，明确大量仍缺实现或原生证据的要求。


### 原生候选重建与实际截图修复
- 最终候选 SHA256 E46CC67B2E564ACD8BE0FBFCD2CE7386C8F8BD7A4D9B08C251D2E72BA36C688A；原生安全6/6通过，浏览器执行14/14通过。原生测试使用独立fixture模型、用户目录、数据库和workspace。
- 截图发现并修复拒绝按钮竖排、受控模式页脚写只读、受控取消错误声称无副作用；最终原生截图复核布局。
- 增强原生脚本：限定自己的进程树清理、workspace显示断言、原生审批截图、实际 Verdict PASS 检查；S05改为如实描述超时错误可见且可取消。
- current/r2为中间证据，最终以native-approval-20260917-r3为准。完整说明见WINDOWS_NATIVE_APPROVAL_AUDIT_2026-09-17.md。


### 审批到达时的阅读锚点续验
- 新增测试模拟用户已滚动到实时尾部上方，再发送 approval.requested；用同一可见 stream 文本块的屏幕坐标作为锚点，确认审批更新后其位置不变，且审批 live region 为 assertive。
- 首次用固定 scrollTop 断言失败（22733→22988），确认这是上方插入内容后 Chromium 的滚动补偿，不能直接判为跳动；已改为测量同一 DOM 锚点。
- 移除未经证实的全局高度补偿代码，当前实现维持浏览器原生锚点行为。构建成功，ui-execution-test 15 项通过。
- 仍未证明真实屏幕阅读器播报、系统休眠恢复、审批被替代/撤销和完整取消任务卡片；第7节继续 PARTIAL。


### 高风险审批键盘局部验收
- 新增真实 Tab/Shift+Tab 顺序、focus-visible/outline、等宽目标、Enter 直接拒绝桥参数断言。
- 浏览器执行16项通过；本轮仅新增测试和记录，未修改产品代码。
- 限定范围：程序化定位卡片起点后进行键盘操作，不是页面入口全链路或原生屏幕阅读器验证。二次防误触仍是待修复缺口。


### 卡片内取消任务入口
- 按第7节将取消任务添加到共享审批卡片，复用既有取消逻辑。
- 受控浏览器回归从卡片取消，验证一次cancel_model_task、零额外resolve_runtime_approval、未决审批关闭；保留副作用不自动撤销说明。
- 宽屏/390px布局和全部16项执行回归通过，前端构建通过；原生尚未重建，完整第7节未通过。


## 原生卡片取消续验（r4）

已重新构建包含卡片取消按钮的当前候选，SHA256：A2C903ADC0AF0B0D01E83C81981A7D2E2090CE0F0F45F12DF2CB9A650D3E4FDC。`native-approval-20260917-r4` 保存候选摘要、日志、结果和审批截图。原生7/7通过，新增 S03b 使用独立 cancelled-by-ui.txt：从主审批卡片取消后文件不存在、所有审批按钮消失、发送按钮恢复可用。原有6项回归同时通过。此证据补齐卡片取消的真实 Tauri/运行时链路，但不涵盖高风险二次防误触、独立撤销/替代或全规格通过。


### 第10节：验证结果不应被请求成功覆盖
- 复现：fixture 返回 ok:true 且 verification.status=FAIL，界面仍显示只读检查完成。原因是 runCordisTask 末尾无条件 setRunState(SUCCEEDED)。
- 修复：只有总体验证 PASS 且必需语义验证 PASS 才显示成功；失败、未知、必需弃权和缺失验证保留输出并显示未达到验收条件、要求核对证据和工作区。
- 前端构建通过；新增四种浏览器终态场景全部通过。整套执行回归退出码1：性能采样出现52–127ms长任务，不能宣称17项全部通过；原始结果固定保存于 .codex-tmp/verifier-terminal-20260917/execution-results.json。
- 本轮未重建原生exe。未知结果当前映射为任务未完成，并在详情保留UNKNOWN/PENDING；更细状态、默认可见风险、逐检查项证据跳转与原生端到端仍未完成。


### 流式长任务定位与同帧滚动合并
- ui-execution-test 新增可选 HMCODEX_UI_PROFILE=1：保存CPU profile与Chromium timeline trace；HMCODEX_UI_OUTPUT 支持独立证据目录。默认验收不启用采样，门槛未放宽。
- 修改前追踪：Layout 56次/573.798ms累计/110.977ms最长；动画帧22次/1374.333ms累计。热点包含followLiveTranscript同步scrollHeight读取。
- 修改：合并human/tools/shell的自动跟随请求为一次requestAnimationFrame回调，并在执行时重新检查用户是否仍跟随尾部。
- 修改后追踪：Layout39次/657.296ms累计/112.004ms最长；动画帧29次/773.188ms累计。布局次数减少，但布局总时间未下降，不能宣布优化已解决性能问题。
- 前后带采样运行都未通过50ms门槛；功能断言均完成。前后证据位于 .codex-tmp/stream-profile-20260917 与 stream-profile-20260917-after；comparison.json保存对比。仪器开销和环境波动未控制，只作为定位证据。
- 前端构建通过，原生exe尚未包含终态和本次滚动合并修改。需继续定位布局/重绘，最终仍须无采样验收。


### 未变化控件重绘与条件滚动恢复续验
- MutationObserver 重现流式回放对版本、输入提示、已保存任务列表的 68 次无效 DOM 变动。增加文本相等检查和线程列表输入引用缓存后为 0；指标已加入执行测试结果。
- patchLiveRegion 仅在标记实际变化时保存/恢复子 Agent 列表滚动，删除每帧无条件滚动读取；执行事件计数文字也改为按变化写入。
- 两次前端构建通过；领域/契约单测 7 文件 60/60 通过（条件滚动修改前）；最终浏览器执行套件功能断言全部完成，但性能门槛失败：conditional-scroll-after/results.json 记录 13 个 52–151ms 长任务。static-render-after 也失败，未删证据或放宽 50ms 门槛。
- 历史浏览器 12 项功能检查通过，证据 thread-cache-history；同时运行原生编译，记录的长任务不能用于独立性能比较。
- 已查看 conditional-scroll-after/desktop.png：两处审批终态卡片正常显示；fixture 混合了执行失败事件与最终 PASS，仅说明展示布局，不能作为真实任务一致性证据。
- 完整规格仍未通过；本轮优化未证明消除流式卡顿。原生验证结果另续。

- 原生构建完成（5m03s），候选 SHA256 `8FA4381DCFCE609CE0586DD8300A74EC2D864E5934333F4E18C5B81F3C704BA4`；native-render-20260917 原生安全 7/7 PASS。拒绝/卡片取消无目标文件，批准文件内容正确且显示 Verifier PASS，超时错误可见且可取消，模型端点不可达后重启恢复。S04 允许取消未结束运行，因此不证明成功终态自动收敛；S06 不证明 WebView 传输重连。
- 查看新候选 native-approval-requested.png，确认主区和侧栏三按钮布局及受控页脚。主区卡片定位由测试折叠 Agent 面板并滚动完成，不证明审批自动进入视野。高风险二次防误触等规格缺口仍未实现。


### 规格 §7 高风险批准二次防误触
- 对照原规格确认缺口，新增高风险确认 dialog；默认返回检查，首次点击不发批准，Escape 返回；主卡片直接拒绝仍保持一键。弹窗提供拒绝和确认一次，显示动作/目标/摘要，过期/状态/digest/run 变化关闭，最终发送前重新校验状态、digest、期限与重复锁。
- 浏览器 high-risk-confirmation-final/results.json 19 条结果通过；核对移动端截图后将三按钮全宽，拒绝和批准目标等宽。构建通过。此轮 longTasks=[]，不抹除上轮失败证据，不宣布长期性能门槛通过。
- 原生测试已增加首次批准只打开确认且不写文件、默认返回焦点以及第二次明确批准；新候选构建仍进行中，原生结果稍后追加。
- 后续规格核对：§10 当前 renderContinuousVerification 仍主要为过程分数/候选采样；run 终态仅追加语义摘要，缺逐检查项来源/时间/影响及证据跳转。§11 renderEvidencePanel 仍是最近六条命令摘要，不能替代文件/块的 proposed/executed/verified Diff。保留为明确未通过项。

- 原生高风险候选构建完成，SHA256 `48DFA00A77DA2A9E13496F5CCE76A7F1A99FE1C5976AC641DFD1FF70989504DC`；native-high-risk-20260917 安全测试 7/7 PASS。S04 明确验证首次点击仅开 dialog、默认焦点为返回且目标文件不存在；确认后真实文件内容正确、Verifier PASS。
- 查看原生 dialog 截图发现 primary-action 导航外边距导致按钮不齐，已重置 margin/padding/font-size/width。最终 dist high-risk-confirmation-aligned 19 条结果通过，新增桌面按钮同高同排和移动端等宽断言；最终移动截图已复核。此最后 CSS 对齐改动尚未重新嵌入原生 exe，原生证据覆盖确认逻辑和对齐前布局。
- 原生 S04 仍允许取消 lingering run，不能证明所有成功运行自动终止；S06 是模型端点失败/重启恢复。全规格继续未通过。


### 规格 §10：运行时逐项检查未显示修复
- 读取 RuntimeVerificationSummary、rule-verifier 和最终 runtime 返回：checks 已有 id/status/message/evidence，但 UI 仅呈现语义摘要，遗漏确定性逐项报告。
- 新增当前 run 的确定性验收检查列表，保留四种状态和证据引用，UNKNOWN/SKIPPED 明确非通过；报告接收时间不冒充检查时间，明确后端未提供逐项时间/影响等级。使用现有 timeline evidenceKind 存储，不引入新契约字段。
- 构建通过；verifier-checks-20260917 浏览器20条结果通过；查看桌面/390px截图，四状态、安全文本、空证据说明和新任务隔离均覆盖。未重建原生候选。
- 新增 UI_VERIFIER_REQUIREMENTS_AUDIT_2026-09-17.md，将第10节拆成独立要求。证据跳转、真实逐项时间/影响、错误返回/历史恢复和非阻断风险分类仍未完成。


### run.failed 逐项证据保留
- 当前 runtime 的 trajectoryErrorPayload 已发送 checks，但 UI run.failed 只追加摘要；新增共享 appendVerificationChecks，将失败事件的每项状态/说明/引用保留，与成功报告采用同一面板。未知状态降为 UNKNOWN，无效对象/引用忽略，不改写成通过。
- 构建通过；verifier-failed-report-20260917 功能断言全部通过，整体因54ms长任务失败。为使失败报告进入截图视野，测试补充 scrollIntoViewIfNeeded 后运行 verifier-failed-report-visible-20260917，21条结果通过、longTasks=[]。两次证据均保留，后一结果不抹除前一性能失败。
- 已查看失败报告可见截图：FAIL与UNKNOWN卡片、原始有效引用及“任务未完成”同时存在。报告在随后ok:false响应后保留。当前原生exe仍未包含此次面板。
- 新发现待修复：已开始运行的任务在最终失败时，lastSubmitReceipt.status 被无条件置为 rejected，导致“提交被拒绝”与任务实际已执行相矛盾；失败事件和失败返回还可能产生两条错误摘要。尚未将这些问题标为解决。

### 提交回执语义与排版续验
- 修复回执状态：仅在 run.started 或成功响应后显示“已被接受”；已接受任务后续执行失败保留 accepted；运行时确认前失败显示“未收到运行时接受确认”，不误报“已被拒绝”。
- 回执卡片改为三行布局（编号、状态、提示），浏览器截图 receipt-final-20260918 已查看；执行测试回归 22 条结果通过，新增前确认失败与执行后失败两个场景。
- npm.cmd test：7 文件、60 用例通过；本次 execution 回归 longTasks=[]，但历史运行仍出现过 51–151ms 长任务，性能 SLO 仍不能宣布长期通过。
- verifier-failed-report-visible-20260917 的失败报告截图仍显示两个 Cordis 错误摘要（run.failed 与 bridge 返回重复），待进一步去重；逐项检查已正确保留。

### 失败摘要去重续验
- 失败事件和桥接返回可能各自追加 Cordis runtime 错误，导致同一运行显示两条重复错误。新增按 runtime runId 记录 `run.failed`，桥接返回只在未收到该事件时追加主错误；逐项检查继续从失败事件保留。
- 构建通过；dedup-failed-20260918 执行回归 22 条通过，longTasks=[]。失败报告中的两个错误摘要问题已修复逻辑，截图证据仍保留旧版，需下一轮生成新截图确认视觉结果。

### 失败摘要去重视觉复核
- 重新构建并运行 dedup-failed-final-20260918：22 条执行回归通过、longTasks=[]；npm.cmd test 7 文件/60 用例通过。
- 查看 failed-verification-report.png：Cordis runtime 主错误只出现一条，确定性检查区域仍显示 FAIL 和 UNKNOWN 两张卡片及引用，未出现旧版重复错误。
- 该结果仍是 Chromium 模拟桥证据；原生候选未重建，历史性能长任务和长期 SLO 未被此单次运行覆盖。

### 全量原生功能回归与旧安装版区分
- `npm.cmd run test:ui` 默认使用安装版 `C:\Program Files\hmCodex\hmcodex-desktop.exe`，结果 10 通过、7 失败、3 跳过；T03 路径不换行和全部 NAV 失败均来自旧安装版，不能作为当前工作区源码结论。
- 使用当前候选 `desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/hmcodex-desktop.exe` 显式重跑：18 通过、0 失败、2 跳过。T03 工作区路径和 runs/workspace/memory/safety/diagnostics/workbench 导航全部通过；T12/T13 因需真实模型任务而跳过。
- 记录证据 functional-current-20260918；当前源码 CSS 已有 workspace path `overflow-wrap:anywhere`。以后验收不得把默认旧安装版结果当作当前候选结果。

### 设置、记忆、历史专项回归
- 当前源码专项测试全部通过：settings（焦点循环、关闭恢复、搜索、校验、重试、移动端/深色模式）；memory（字段、未知语义、三状态删除和刷新）；history（12 项，包括分页、迟到响应、恢复、草稿、移动端无溢出、重复切换 longTasks=[]）。
- 这些是 Chromium 模拟原生传输的功能证据，不覆盖真实屏幕阅读器、触控硬件或长期运行。

### 全量专项结果（2026-09-18）
- 当前候选 `ui-functional-test.mjs`：18 PASS、0 FAIL、2 SKIP（T12/T13 需要真实模型任务）。默认安装版仍是旧程序，10 PASS、7 FAIL、3 SKIP，不能作为当前源码证据。
- 当前候选 `ui-disconnect-test.mjs`：T14/T15 断线错误显示与恢复 2/2 PASS。
- 当前候选 `ui-streaming-test.mjs`：等待 30 秒仍未出现 STREAMING 行而失败；该脚本直接启动真实 runtime、未提供 fixture 模型，不能被浏览器 fixture 的流式回放通过替代。现状态记录为真实模型配置/运行链路未验证，不宣称 streaming 原生通过。
- settings、memory、history 专项通过；history 12 项且重复切换 longTasks=[]。
- 目前仍有可明确的验收边界：真实模型流式、T12/T13 真实任务、屏幕阅读器/实机触控、Diff 分层、证据跳转及长期性能。

### 当前候选全量专项续验
- `ui-functional-test.mjs` 显式当前候选：18/18 通过（2 个真实模型任务跳过）。
- `ui-disconnect-test.mjs` 显式当前候选：T14/T15 2/2 通过。
- `ui-streaming-test.mjs` 显式当前候选：30 秒等待真实 runtime 的 STREAMING 行超时。该脚本未注入 fixture provider；当前证据只能说明真实模型配置未建立流式行，不能判定 Chromium fixture 的流式渲染实现失败。
- settings、memory、history 通过；全量脚本测试 23/23 通过，桌面单测 60/60 通过。
- Diff 规格复核：当前模型和界面没有 proposed/executed/verified Diff 数据结构或文件/块渲染入口，不能宣称符合 §11；已保留为实现缺口。

### §10 证据导航续验（2026-09-18）
- 新增确定性检查证据渲染：能解析为当前 timeline `eventId`/`itemId`/digest 的引用显示可聚焦按钮；无对应文件、diff、命令或事件的 digest 明确显示“未解析”，不伪造链接。
- 点击可解析引用会切换到 workbench、设置运行筛选、展开执行过程并滚动到目标时间线项；workspace snapshot 行补充 runId/eventId/eventSequence，契约同步允许现有时间线元数据。
- 构建通过；npm test 7 文件/60 用例通过；execution 回归 22 条通过、longTasks=[]。目前只通过共享 fixture 的回归，尚未补专门的点击定位断言或原生候选验证。
- §11 Diff 仍未实现：没有 proposed/executed/verified 文件块模型和渲染；当前证据导航不改变该结论。


### 2026-09-18 继续验收：证据导航、结果合并与原生候选
- 修复 `runCordisTask` 在桥接 Promise 返回时用过期局部 `next` 覆盖实时 runtime 事件的问题。现在在成功/失败结果投影前以当前 `model` 重新基线，保留 workspace snapshot、tool result、approval 等已到达时间线事件；线程列表也基于最新列表合并。
- `ui-execution-test.mjs` 新增专门证据导航断言：`event:workspace-evidence-1` 显示可解析按钮，`build:sha256:fixture` 等无对应项的引用显示未解析；点击后执行组展开、工作区快照目标行存在、目标详情打开。执行回归 22/22 通过，`longTasks=[]`。
- 前端 `npm.cmd run build`、`npm.cmd test`（7 文件/60 测试）、`npm.cmd run test:scripts`（23/23）通过。
- 重新编译原生候选：`cargo build --bin hmcodex-desktop --features tauri/custom-protocol` 成功；UNC 工作区只产生硬链接复制警告。当前候选路径为 `desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/hmcodex-desktop.exe`。
- 当前候选真实功能任务：`ui-functional-test.mjs --task` 20/20 通过；取消、终态、导航、工作区预览和运行记录均通过。断线回归 T14/T15 2/2 通过。受控安全回归 S01/S02/S03/S03b/S04/S05/S06 7/7 通过。
- 真实 provider 流式专项仍失败：`ui-streaming-test.mjs` 等待 30 秒没有出现 `STREAMING` 行。运行日志显示相关真实任务约 68 秒、`toolRounds=0` 后完成；该结果说明当前真实配置未建立可观测高频 `model.text_delta`，不能用 fixture 流式证据替代真实 provider SLO。
- 规格结论不变：证据导航从“未验证”升级为“共享 fixture 已验证、原生未单独验证”；§11 proposed/executed/verified 分层 Diff、完整 10 类设置、Council UI、Memory 版本/冲突分类、屏幕阅读器/高对比/触控实机、长期 p95/SLO 和竞品基线仍是未完成或未验证项。


### 真实 provider 流式续验（2026-09-18）
- 原 `ui-streaming-test.mjs` 将首个 `STREAMING` 行等待固定为 30 秒；当前 runtime 启动阶段可超过该窗口，先前超时不能证明流式缺失。
- 测试脚本新增 `--stream-start-timeout-ms` / `HMCODEX_STREAM_START_TIMEOUT_MS`，默认 120000ms；本次当前原生候选使用 120 秒窗口通过：`samples=297`、`maxStreamingLength=2897`、`markerKeptWhileGrowing=297`、终态“只读检查完成”。
- 这证明当前真实 provider 的增量行会保持同一个 `.app-shell`，流式期间没有重建根节点。仍不能据此宣称长期 p95/SLO、不同 provider、断线中途恢复和超大输出均通过。


### 工作区专项续验（2026-09-18）
- `ui-workspace-test.mjs` 7/7 通过：延迟 native hydration、切换 root 新线程、历史线程隔离、取消/同目录选择、目录失败同步、目录选择竞态、旧 workspace read 不覆盖新 workspace。
- 该专项补强 §2 信息架构与 §11 workspace snapshot 的行为证据；Diff proposed/executed/verified 仍未实现。

### 无障碍媒体与响应式续验（2026-09-18）
- 新增 `desktop/scripts/ui-accessibility-test.mjs`，通过真实 Tauri WebView/CDP 对当前候选检查 9/9：可见按钮可访问名称、表单控件标签/提示、1440px 桌面无横向溢出、390px 移动无横向溢出、根字体 200% 无横向溢出、`prefers-reduced-motion` 命中且动画/过渡计算值为 `1e-06s`、滚动为 `auto`、`prefers-contrast: more` 命中且控件实际边框为 2px。
- 修复高对比度 CSS：原规则只设置 `border-width`，会被 `.send-button { border: 0 }` 的类选择器覆盖；现改为带 `!important` 的 2px 实线边框，并重建 dist 后复测通过。
- 该结果覆盖 WebView 自动化和媒体查询模拟；屏幕阅读器真实播报、Windows 系统高对比度主题、实机触控以及 2in1/tablet/phone companion 仍未完成，因此 §16 与总体验收继续 PARTIAL。
