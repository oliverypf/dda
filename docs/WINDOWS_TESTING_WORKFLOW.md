# Windows 测试执行约定

> 当前架构口径：测试应覆盖本地 Memory Journal、Jev Decision Plane、Rule Verifier、Runtime Safety、Approval 和 PolicyLease。文中旧的 OpenViking sidecar 或 LLM Verifier 脚本仅用于历史证据回放，不属于当前发布依赖。

## 默认规则

Windows 各阶段的相互独立测试套件必须并行启动，以缩短反馈时间；不要因为等待一个慢套件而串行等待其他套件。每个套件仍须完整收集输出，任一套件失败时总命令返回非零。

统一入口（在 `desktop` 目录执行）：

```powershell
npm run test:all:parallel
```

该入口同时运行：

- runtime `npm test` / `npm run test:parallel`（Node test concurrency=6）；
- desktop Vitest `npm test`；
- desktop scripts `npm run test:scripts`（Node test runner）；
- Phase 3 源码标记检查 `npm run test:phase3-evidence`，不能替代行为或实机测试；
- TypeScript `tsc --noEmit`；
- Tauri/Rust 本地 runtime 测试；旧 `build-openviking-sidecar.mjs` 仅允许作为历史兼容证据入口，不属于当前发布依赖。

不要把并行理解为共享状态可以同时写入：每个测试套件必须使用临时/隔离 store。默认 `hmcodex.db`、线程文件和安装目录不能被多个会改变它们的测试同时使用；发现共享状态时，应先为测试提供独立目录或降低该套件内部并发。

## UI 测试

UI 证据分为隔离浏览器模拟 native bridge 与真实 Tauri/安装包两类；不能把模拟 UI 的通过数当作真实安装包端到端通过数。真实 Tauri 配合模拟模型 provider 的测试也应明确标记 provider 为 fixture。

| 套件 | 当前调用方式（在 desktop 目录） | 证据范围 |
| --- | --- | --- |
| 历史 UI | `node scripts/ui-history-test.mjs` | 隔离浏览器、模拟 native bridge；历史读取/切换/分页/旧响应隔离/草稿与展开保留 |
| 执行 UI | `npm run test:ui:execution` | 隔离浏览器、模拟 native bridge；角色/text delta、审批响应、跨页完成、取消/迟到事件 |
| 工作区 UI | `node scripts/ui-workspace-test.mjs` | 隔离浏览器、模拟 native bridge；项目与会话切换 |
| 安装版功能 UI | `npm run test:ui` 或按场景使用 `npm run test:ui:task` | 真实 Tauri/WebView2；后者包含模型任务，记录真实配置与调用范围 |
| 安装版安全 UI | `npm run test:ui:security` | 真实 Tauri 与本地模拟模型 provider；审批/拒绝/超时/Verifier/恢复 |
| 安装版断线 UI | `npm run test:ui:disconnect` | 真实安装进程、断线与恢复配置后的任务 |
| 安装版流式 UI | `npm run test:ui:streaming` | 真实安装进程；流式期间 shell/行身份与交互稳定性 |

执行约定：

1. 先完成基础并行套件，构建并冻结本次前端 dist，记录源码及 dist 摘要；模拟 UI 依赖构建产物，不允许测试过期 dist 后宣告当前源码通过。
2. 模拟基线按“历史 UI → 执行 UI → 受影响的工作区 UI”顺序采集；不得同时覆盖相同的结果目录。当前历史/执行结果默认位于 `.codex-tmp/history-ui/` 与 `.codex-tmp/execution-ui/`，使用时归档到带版本与时间的证据目录。
3. 安装版功能/任务、安全、断线、流式套件会启动/终止应用或操作本地 store，必须顺序运行；需要不同发布渠道/候选时先核对安装身份。模拟测试允许浏览不等于安全门已允许执行。
4. 明确保留慢 health/recovery 期间历史可见、慢审计不阻塞已提交终态、非流式/跨页完成、草稿/展开/焦点/阅读位置、1024 混合 delta、600 折叠事件及反复历史切换等回归；无 long task 的固定 fixture 结果不能替代最终安装包 SLO。
5. 逐套记录命令、起止时间、退出码、用例数、构建/安装身份与模拟/真实类别。执行套件不以首个失败掩盖其他可执行结果；若共享状态未清理或后续前置不满足，明确记录阻断而非标通过。必需套件失败、漏跑或缺产物均阻止发布验收通过。

阶段四待实现的测试接入：S4-15/16 增加 `test:ui:history` 和明确的 UI 汇总入口，将以上必需套件纳入结果汇总。当前 `test:all:parallel` 不运行这些 UI；本节记录计划与已有直接调用方式，不表示新入口已经实现。详见[阶段四计划](WINDOWS_PHASE4_IMPLEMENTATION_PLAN.md)和[验收矩阵](WINDOWS_PHASE4_ACCEPTANCE_MATRIX.md)。

## 失败与报告

- 并行任务不得在首个失败后提前退出，必须等待其他任务结束并报告各自 exit code；
- 报告记录每个套件的开始/结束时间、耗时和结果；
- 需要确定性诊断时，可单独重跑失败套件，但最终发布验收仍需使用并行入口加对应 UI 回归。
- runtime 若必须定位并发相关问题，才显式使用 `npm run test:serial`；这不是默认验收路径。
