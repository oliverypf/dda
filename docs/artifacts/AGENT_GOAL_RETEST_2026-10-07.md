# hmCodex 目标复测：2026-10-07

> 这是当天较早阶段的中间报告。后续已补桌面升级重试、真实 Codex 对照、持久化证据、真实工程任务与 Jev 官方协议修复。最新结论见 [当前目标验收](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_STATUS_2026-10-07.md)。以下保留当时状态供追溯。

严格按当前三项验收要求：**1 项已达成，2 项部分达成，目标继续保持 active。** 这表示三项验收的通过数量，不是整个项目完成度为 33%。工程流程已有可复跑证据；真实产品优势尚无充分对照证据。

| 目标 | 状态 | 本次证据 | 距离完整达成还缺什么 |
|---|---|---|---|
| 预置中断任务，从 checkpoint 继续 | 已达成（本地自动化验收） | 新编译的 Tauri 桌面程序，点击实际“继续任务”；恢复到成功终态，有实际工具完成记录，executor 请求增加，planner 请求保持不变 | 生产可信度还应增加实际杀进程、重新启动、多个工作区的故障样本；当前满足预置 checkpoint 的测试要求 |
| 必失败任务，经重试／升级模型／Jev 决策成功 | 部分达成 | 运行时实际读不存在文件，产生 WORKSPACE_NOT_FOUND；Jev 选择 USE_STRONG_MODEL，决策轨迹选中 strong-model；强模型实际读取 README 并获得文件内容；最终验证 PASS | 桌面“失败 → 点击重试／升级 → 成功”仍无完整用例。现有 T14 只检查成功后的禁用状态；还要断言桌面选中的模型确实用于重试，而不是只改变标签 |
| 固定任务集，持续记录指标，与普通 Codex 同模型对照 | 部分达成，关键对照未完成 | 固定 3 个模拟任务，重复 2 批；有成功／恢复／token／估算费用／工具指标汇总；已修复批次之间故障注入未重置的问题 | 当前对照是裸模型请求，不是普通 Codex；模型输出和 token 是模拟数据，人工分钟固定为 0，实际费用未知；每次覆盖报告并删除原始临时证据，缺少持续历史和真实任务验收器 |

## 最终验证结果

重新构建成功：WINDOWS_FULL_LOCAL，Windows x64 debug 可执行程序。TypeScript 检查、前端构建和 Rust 编译均通过；本次没有重新验收安装包发布流程。

| 验证 | 最终结果 | 证据 |
|---|---|---|
| 运行时完整测试 | 606 通过，0 失败，1 跳过，共 607 项 | 本次 `runtime/npm test` 输出；跳过项是超过 100,000 事件的压力测试 |
| Jev 升级加强验收 | 1/1 通过 | [日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_RETEST_JEV_UPGRADE_2026-10-07.log) |
| 桌面单元测试 | 60/60 通过 | [日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_RETEST_DESKTOP_2026-10-07.log) |
| 桌面脚本测试 | 23/23 通过 | [日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_RETEST_SCRIPTS_2026-10-07.log) |
| Rust 桌面桥接测试 | 26/26 通过 | [日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_RETEST_RUST_2026-10-07.log) |
| 原生桌面功能／checkpoint 继续 | 25/25 通过，0 跳过 | [日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_RETEST_UI_RESUME_VALIDATED_2026-10-07.log) |
| 原生桌面审批／拒绝／取消／超时／恢复 | 7/7 通过 | [日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_RETEST_UI_SECURITY_COMPLETE_2026-10-07.log) |
| 原生桌面断线／恢复配置 | 2/2 通过 | [日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_RETEST_UI_DISCONNECT_COMPLETE_2026-10-07.log) |
| 原生流式渲染 | 通过，输出增长时窗口主节点保持 | [日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_RETEST_UI_STREAMING_COMPLETE_2026-10-07.log) |
| 原生可访问性／窄屏布局 | 通过 | [日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_RETEST_UI_ACCESSIBILITY_COMPLETE_2026-10-07.log) |
| 浏览器历史交互 | 12/12 通过，含加载旧页时阅读位置保持 | [日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_RETEST_UI_HISTORY_2026-10-07.log) |
| 浏览器执行交互 | 23/23 通过，含流式事件、审批、阅读位置、失败状态 | [日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_RETEST_UI_EXECUTION_2026-10-07.log) |
| 工作区切换 | 7 个场景通过，含延迟切换后的会话续接 | [日志](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_RETEST_UI_WORKSPACE_FIXED_2026-10-07.log) |
| 设置／记忆／诊断 | 三个独立套件通过 | 对应 GOAL_RETEST_UI_SETTINGS／MEMORY／DIAGNOSTICS 日志 |

浏览器套件使用模拟的 Tauri 桥接；原生套件使用实际编译程序和本地模型服务。以上结论只覆盖列出的场景，不表示所有产品功能都已完成穷尽验收。尤其没有把桌面重试按钮的存在当成重试成功证据，也没有单独重新验收原截图中项目列表滚动条的视觉问题。

## 固定任务复跑

| 条件 | 成功 | 首次成功 | 恢复成功／机会 | 输入＋输出 token | 工具轮数 |
|---|---:|---:|---:|---:|---:|
| 同模型裸 provider | 4/6 | 4/6 | 0/2 | 112 | 0 |
| hmCodex 运行时 | 6/6 | 4/6 | 2/2 | 256 | 4 |

模型和使用量均由本地 fixture 指定。两个条件中，裸 provider 没有执行工具和恢复循环，因此恢复率差异不能说明优于普通 Codex。费用是按虚构的本地价格估算，实际费用字段为 UNKNOWN；人工介入分钟为脚本固定值，不能推导真实用户节省了多少时间。此次也不能推出生产场景更省钱或更快。

明细：[本次固定任务报告](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_EVIDENCE_RETEST_2026-10-07.json)。PRE_FIX 文件保留修复前的无效批次，不能用于比较或合并统计。

## 本次修复

1. 跨项目打开历史会话时，目录同步会清掉正在加载的 historyView。现在保留选中的会话和输入状态，目录同步结束后刷新发送门控；延迟目录切换的回归场景通过。
2. 固定任务第二批对照没有重置故障注入，造成对照成功率虚高。现在每批、每个条件开始前都重置。
3. 原生测试共享 WebView 设置，并有旧脚本跳过新建任务的项目选择弹窗。测试现使用独立 WebView 目录，完成实际项目选择；浏览器目录放在工作区外，避免锁文件导致工作区快照失败。
4. 空闲面板测试现在等待启动数据加载结束，并明确在工作台检查增量刷新；网络输入错误测试等待实际反馈完成。清理会结束本次启动的进程树。
5. Jev 升级测试不再仅凭强模型返回一句成功文字通过：必须执行成功的文件读取，并确认模型获得真实文件内容。

## 达成目标的剩余顺序

1. 补原生桌面失败任务用例，实际点击“重试／升级”，核对最终成功、模型身份、工具证据和 Jev 决策轨迹。
2. 将对照换成真实普通 Codex CLI：双方使用相同模型、同一固定任务、独立且相同的初始工作区、相同权限和预算。保留两边原始运行日志、模型请求使用量和版本信息。
3. 给固定任务建立独立验收器，例如代码测试、预期文件结果和实际恢复状态；逐次追加历史记录，保留失败样本。人工介入按输入／审批／等待事件计时；费用使用实际账单或明确价格与缓存计费规则，未知值保留为未知。
4. 跑真实代码修改、故障恢复和长任务，多次重复；再做 Jev 开／关、模型路由／预算／缓存开／关的对照，分别判断成功率、恢复率、耗时、人工时间和费用是否改善。

“代码即状态”的恢复流程和 Jev 的升级流程已有工程证据；“省钱”和“解决更快”仍需上述真实对照。当前不能把测试通过率直接当成用户值得付费的收益证明。
