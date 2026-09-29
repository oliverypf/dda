# 原生审批与安全验收（2026-09-17）

本轮真实 Windows Tauri/WebView2 运行当前源码构建的 debug 候选，通过本地模型 fixture 驱动真实 Node/Cordis 运行时、审批桥和受控文件操作。不是已安装的旧版本，也不是模拟 Tauri 的浏览器页面。

> **历史证据说明**：本记录的执行证据仍然有效，但架构解释以当前 [Jev Decision Plane 设计](JEV_DECISION_PLANE_DESIGN.md) 为准；Rule Verifier、Runtime Safety、Approval 和 PolicyLease 是硬边界，旧的 LLM Verifier/OpenViking 不是当前依赖。

- 构建：cargo build --bin hmcodex-desktop --features tauri/custom-protocol，成功。
- 候选：desktop/src-tauri/target/x86_64-pc-windows-msvc/debug/hmcodex-desktop.exe。
- SHA256：E46CC67B2E564ACD8BE0FBFCD2CE7386C8F8BD7A4D9B08C251D2E72BA36C688A。
- 最终证据目录：.codex-tmp/native-approval-20260917-r3/，含 candidate-hashes.json、results.json、native-security.log、native-approval-requested.png、native-approval-consumed.png。
- 原生测试：6/6 通过；浏览器执行回归：14/14 通过（含宽屏/390px审批按钮布局与受控取消文案）；本轮前端及原生构建成功。

## 实际检查范围

| 检查 | 证据与结论 |
|---|---|
| 受控模式 | 模式切换、说明和页脚显示一致，通过。 |
| 非法网络配置 | 非法 JSON 被界面拒绝，通过。 |
| 拒绝写入 | 拒绝审批后临时目录中目标文件不存在，通过。 |
| 批准写入 | 真实桥传递审批，目标文件内容正确、lease 已消费、独立 verifier 身份与 Verdict PASS 可见，通过。文件内容断言本身不证明恰好执行一次；一次性 lease 属性另由 runtime 单测提供有限证据。 |
| 授权状态 | 消费后卡片显示“授权已使用”，无可重放的审批按钮；超时操作卡片显示失败/结果不确定，通过。 |
| 副作用超时 | 错误在时间线和授权卡片可见，必要时取消运行后收敛，通过。不能推导“无需干预自动进入失败终态”。 |
| 模型连接失败 | 使用不可达模型 endpoint，界面显示错误；重启正常配置后刷新执行记录无该错误，通过。此项不等于 WebView 与原生传输断线重连。 |
| 按钮布局 | 原生截图与文字边界断言确认拒绝不被挤成竖排，两种选择等宽。取消/发送按钮不被上下文标签挤压。 |
| 工作区一致 | 从启动时指定隔离 root，并断言页面显示路径，避免只修改后端授权。 |

## 本轮发现并修复

1. 原生截图发现拒绝按钮被 width:100% 的批准按钮挤压。审批按钮改为等宽、40px最小高度、文字不换行；保持拒绝的直接操作。
2. 页脚硬编码“只读阶段”，在受控模式下与实际能力相矛盾；改为与模式同步。
3. 取消回执硬编码“没有产生外部副作用”。受控任务改为说明已经执行的操作不会自动撤销，需核对执行记录/工作区；浏览器测试明确覆盖该分支。
4. 测试脚本原先直接修改 native workspace，未更新前端展示。改为启动时配置独立 root，并断言可见路径。初次截图 current 目录不得作为工作区一致的通过证据。
5. 测试清理原先终止所有同名进程，改为只终止本脚本 PID 的进程树；LOCALAPPDATA/APPDATA/数据库/模型配置全部隔离。正常用户数据目录不作为本轮操作目标。

## 尚未证明

当前原生测试仍未覆盖本地审批期限边界、完整键盘防误触、审批替代、独立 lease 撤销/重连重建、完整 sandbox/资源限制/请求者/副作用范围说明。截图前测试主动收起子 Agent 并滚动到审批卡片，不能据此宣称审批到达时默认可见性符合。UI 规格整体仍为 PARTIAL。


## 原生卡片取消续验（r4）

已重新构建包含卡片取消按钮的当前候选，SHA256：A2C903ADC0AF0B0D01E83C81981A7D2E2090CE0F0F45F12DF2CB9A650D3E4FDC。`native-approval-20260917-r4` 保存候选摘要、日志、结果和审批截图。原生7/7通过，新增 S03b 使用独立 cancelled-by-ui.txt：从主审批卡片取消后文件不存在、所有审批按钮消失、发送按钮恢复可用。原有6项回归同时通过。此证据补齐卡片取消的真实 Tauri/运行时链路，但不涵盖高风险二次防误触、独立撤销/替代或全规格通过。
