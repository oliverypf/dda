# Agent 目标的自动验收

## 从真实任务中改进执行 harness

2026-10-08 的项目归档监督任务以 `7e0e5f4` 为基线，由真实 dda runtime、`mimo-v2.6-pro` 和启用强制校验的 Jev 在隔离工作区执行。原始运行 `run-edec5783-7519-4f11-ad6a-798db213a42a` 曾连续遇到两次 `test.execute / SAFETY_COMMAND_NOT_ALLOWED`，随后调整调用成功。该失败事实保留，不能用后续修复覆盖。

对应的命令恢复 harness 已进入运行时：

- `createExplicitLeaseProvider` 暴露不可变的获准命令名称快照；模型工具描述提示分开传递 executable、args 和工作区相对 cwd。
- `taskRunner` 在命令拒绝时保留原始失败码，同时向下一模型轮提供 `USE_APPROVED_COMMAND_OR_WORKSPACE_TOOL` 指引，说明可用的工作区读取工具、获准命令以及需要报告能力缺口的情况。
- 这些信息只用于指导。Jev、执行器检查、逐次 lease 和工作区边界继续生效；不能据此自动批准原来被拒绝的命令。

同一初次运行在 900 秒任务期限结束时仍没有产生文件差异，共完成 30 次工具调用、记录 23 次模型调用（包含最后取消的调用）。原有无进展保护只检测重复的相同证据，无法提示持续读取不同源码片段但没有交付的情况。因此加入 `HOST_PROGRESS_CHECKPOINT`：在受控模式且具备文件工具时，每取得 8 个新的成功工作区读取结果，提醒模型确认剩余证据，并在用户确实要求实现、证据充分时转入小步修改与验证。成功的文件工具调用会重置计数。检查点不强制修改，不认定其他命令没有修改文件，也不改变只读模式或原有循环上限。

第二轮 `run-8653bc5b-db0b-4795-a853-3b7682f6d4f8` 的实际补丁调用暴露 `PATCH_TOO_LARGE`：约 375 KB 的 `desktop/src/main.ts` 超过了旧补丁工具 256 KiB 的整文件限制，即使修改片段很小也无法应用。工具现区分“源/结果文件上限 1 MiB”和“替换片段上限 256 KiB”，与执行器已有文件写入上限一致，保留匹配次数、摘要、完整分页读取及逐次授权检查。新增边界回归又发现，成功修改后的大 diff 会超过工具默认输出上限，造成“实际已写入却报告失败”；现按 JSON 编码后的 UTF-8 字节数限制差异预览，并返回 `diffTruncated` 和完整内容摘要。

第五轮进一步暴露大文件定位成本：模型持续按字符窗口读取源码，监督者在约 648 秒后取消并为下一轮提供定点源码上下文。为使后续任务不依赖人工计算位置，真实工作区适配器的 `workspace.read` 增加可选 `findText`：在已授权的指定文件中进行字面匹配，从首个匹配位置返回受限片段及实际字符偏移；支持从指定偏移继续查找，不把输入当正则。未找到明确返回 `found:false` 和空内容。原来的敏感路径、越界路径、二进制文件与输出大小限制保留；不支持该能力的适配器不暴露这个参数。该能力尚未在本轮已经启动的模型进程中验证提速。

定向复现入口：

```powershell
npm --prefix runtime run test:harness-supervision
```

本次 47 项定向检查通过，包含真实受控执行器拒绝错误命令、下一轮收到恢复信息、执行获准 Node 命令成功、未获准写入仍被拒绝，以及进度提示、只读豁免、修改后计数重置、大文件精确修改、字节边界和字面定位读取。模型循环测试使用固定输出，文件测试使用真实临时文件和执行器；这些结果证明机制和约束正确，不代表真实模型成功率或速度已经提高。后续真实任务应继续记录首次成功率、错误类型、工具调用数、模型耗时和监督介入，不自动把统计记录标记为可复用经验。

最终完整运行时回归为 681 通过、1 失败、1 跳过。失败为 `thread-history-reader.test.mjs:50` 对空计划 checkpoint 的旧恢复断言，在未改动运行时的基线 `7e0e5f4` 工作区上同样复现，不记为本次新引入，也不宣称全套通过。第四轮真实归档任务已执行文件修改且前端编译通过，但终态为 `PLAN_STEP_FAILED:execute:UNCERTAIN`，语义校验报 `JEV_TIMEOUT`。独立界面检查发现当前项目清理和布局缺陷，已反馈 dda 继续修改；不得将补丁成功、编译成功或服务超时等同于完整功能通过。

命名兼容说明：产品现统一称为 `dda`。以下完整功能与收益对照结果对应各自记录的源码快照，改名不会重写历史结果；原始条件 ID `hmcodex-runtime`、`hmcodex-jev-on/off` 和归档路径继续保留。


三类自动化测试已实现并完成核验，见 [逐项完成核验](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_IMPLEMENTATION_COMPLETION_AUDIT_2026-10-08.json)。同一 df857d5a 源码的一键入口已实际跑通五个阶段：重新编译、恢复回归 78/78、固定任务验收检查 16/16、原生桌面 28/28、本地 fixture 对照 24/24。见 [一键完整结果](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_MERGED_ONE_COMMAND_2026-10-08.json)。该一键运行没有请求真实升级；真实升级与 Jev 自动恢复另由下述同源码真实报告证明。48 条真实运行的持久化记录已逐项核对。测试实现完成不表示产品优势、现金节省或人工节省已经证明；供应商未报告的用量和缺失账单继续记录为未知。

2026-10-08 的最新源码 df857d5a 已完成运行时 673 项通过、0 失败、1 项可选检查跳过，基准脚本 38/38，新编译原生桌面 28/28，Windows x64 debug 编译成功。阶段核验和证据摘要见 [最新验收与剩余工作](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_MERGED_RETEST_AUDIT_2026-10-08.json)。checkpoint 继续已验证；[真实显式升级](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_NODE_PREVIEW_MERGED_UPGRADE_2026-10-08.json)中，Flash 先失败、恢复同一 checkpoint、切换到 Pro，经真实 Jev 验证成功。

[最新源码的真实 Jev 自动恢复](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_NODE_PREVIEW_MERGED_AUTOMATIC_2026-10-08.json)也通过：实际缺失文件错误后，Jev 决定恢复，Flash 读取正确文件并成功。这次仍使用 Flash，不能声称已实测 Jev 自动选择更强模型。df857d5a 的 24 次同模型客户端对照现已完整结束：dda 成功 8/12、恢复 4/8，普通 Codex 成功 11/12、恢复 7/8，见 [最新完整成对核验](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_MERGED_PAIRED_COMPLETION_AUDIT_2026-10-08.md)。12 对初始文件相同，19 条接受的成功均从原始工具事件重新确认实际内容和测试。该批次没有体现成功率优势；较少的工具轮数和总耗时伴随更多失败，不能直接推断节省。

df857d5a 的独立 24 次 Jev 开／关实验也已完整结束：关闭、开启均成功 11/12、恢复 7/8。关闭累计耗时 404104 ms、45 次模型调用、29 个工具轮；开启为 585798 ms、54 次模型调用、33 个工具轮，另有 64 次 Jev 请求、53 次成功响应、约 93.2 秒代理测量请求耗时。开启的第一轮功能任务受到实际命令权限拒绝；关闭的第二轮语法任务失败，两条均保留。该样本没有体现 Jev 成功率或提速优势，服务波动及不同失败任务限制因果解释。两批共 48 次、24 对输入相同的实际运行，41 条接受的成功均从原始工具事件重新核验。见 [完整 48 次核验](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_MERGED_COMPARE_COMPLETION_AUDIT_2026-10-08.md)。总 token、完整价格估算及实际现金费用仍因缺失用量和账单而未知，人工收益未测量。

最新客户端批次的四条 dda 失败分别为两次 Jev 验证超时、一次实际测试未完成后的真实 Jev 拒绝，以及一次实际工作区路径权限拒绝；普通 Codex 一条工程任务超时。代码独立验收通过不能替代模型实际测试、权限及任务终态。较早的不透明提案中还出现完整命令与独立参数同时传入，执行器不将此混合输入当作已知 Node 命令；后续正确输入仍被要求补证据，准入稳定性没有解决。原始失败不改写，总 token、真实现金收费与人工收益继续保留未知。

上一版源码 81a07cf9 的完整 24 次同模型对照已结束：dda 成功 10/12、恢复 6/8，普通 Codex 成功 9/12、恢复 5/8，见 [完整成对核验](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_CURRENT_PAIRED_COMPLETION_AUDIT_2026-10-08.json)。12 对初始文件相同，19 条成功记录均有实际工具内容；其余失败和超时保留。差异只有一个成功案例，样本小且受第三方模型工具配置和服务波动影响，不能证明总体优势。

81a07cf9 的独立 24 次 Jev 开／关实验也已完成：关闭成功 12/12、恢复 8/8，开启成功 8/12、恢复 5/8，见 [开／关完整核验](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_CURRENT_ABLATION_COMPLETION_AUDIT_2026-10-08.json)。该批次开启后的成功率及耗时没有体现优势；不能用修复后诊断改写这批结果。总 token 和真实费用因用量缺失仍未知；已报告 token／额度小计不是总量，双方无人运行的人工分钟为 0 也不能证明省人工。

新源码已合入两个修复并重新编译验收：完整 Node 命令提案现在使用执行器同一解析器生成有界预览，并读取当前授权文件上下文；工作区 I/O 完成或失败时会清理旧超时定时器，原超时时长与权限保持。新主代码测试 7/7 及完整回归通过。合入前的两次隔离真实功能任务仍记录为 1/2：另一轮代码、实际测试和独立断言均通过，但两次真实 Jev 验证超时，保留失败，见 [隔离真实诊断](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_NODE_PREVIEW_FEATURE_LIVE_2026-10-08.json)。该诊断不能替代新源码完整对照。

本轮修复了三处可复现问题：实际完整 Node 命令字符串的验收遗漏；Jev 验证请求中的重复证据；只读 checkpoint 恢复丢失已执行失败事实。明确的 Jev 运输故障现在只重试验证，复用同次执行的实际结果，不再因此重放执行器；原始语义 FAIL、权限失败与证据缺失仍不能通过。新增真实本地子进程测试验证无重复写入、无重复测试租约和持续服务故障保持非成功。

前版源码 5186ceb5 的 Flash 六任务各两轮、双方共 24 次真实对照已经完整结束。原评分为 dda 6/12、普通 Codex 9/12；按协议 2.1 对原始执行只读复核后为 8/12、9/12，两条遗漏的真实完整 Node 命令被正确计入。见 [归档复核](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_TEST_ACCEPTANCE_ARCHIVED_REGRADE_2026-10-08.json)。复核不改变原失败与超时，不算修复后源码的新实验。协议 2.1 要求主机原生命令摘要、实际预置失败、正确测试文件与真实通过记录。优势尚未证明。

源码 2f4cf8b2 的 Pro 对照已明确中止：计划24次、完成10次后，双方连续出现HTTP500，最小Pro请求超时而Flash请求成功。已完成的成功、失败、超时和未知的中断结果均保留，见 [中止记录](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_DIAGNOSTIC_RECOVERY_ABORTED_2026-10-08.md)。这不是完整对照，也不证明任何客户端优势。较长的新增本地 fixture 曾发生30秒外层期限超时，调整至60秒后通过；中间一次超时参数改错用例也已修正，原失败日志仍保留。

前版源码 b972fad8 的运行时 650 通过、0 失败、1 项可选检查跳过，原生桌面 27/27，真实模型加 Jev 的四类恢复任务各两轮为 7/8。读取恢复本批次 2/2 通过；一轮语法任务已实际跑通完整测试，却因准入反复补证据与重复诊断最终判为停滞，仍保留失败。详见 [前轮测试与目标进度](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_RETEST_PROGRESS_2026-10-07.md)。自动测试已具备，完整收益目标尚未达成。

前版源码 9accbfdd 的完整 24 次客户端对照已完成：dda 9/12、普通 Codex 10/12，恢复成功分别为 5/8、6/8，详见 [前版完整对照](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_LITERAL_GATE_PAIRED_2026-10-07.md)。它不能补作最新源码的控制组；较早两任务 4/4 诊断也不能替代完整对照。

这个入口覆盖三类验收：从预置 checkpoint 继续任务；预置失败后的桌面重试升级以及运行时 Jev 恢复；固定任务集与本机普通 Codex CLI 的同模型对照。它会编译并启动真实 Tauri 窗口，自动操作 UI，不需要逐个点击按钮。

本次项目归档最终已由 dda 完成功能修改，经独立 19 项界面检查和编译后合入主工作区并重新编译 Windows 程序。原模型运行中的超时和取消仍保留，完整过程及验收边界见 [项目归档监督记录](SUPERVISED_PROJECT_ARCHIVE.md)。

## 一条命令运行

在仓库根目录运行本地模型 fixture 验收：

```powershell
node desktop/scripts/validate-agent-goal.mjs --repeat 2
```

使用当前真实模型配置跑完整对照：

```powershell
node desktop/scripts/validate-agent-goal.mjs --live-config C:/Users/User/AppData/Local/hmCodex/model-config.json --repeat 2 --output docs/artifacts/AGENT_GOAL_VALIDATION_LIVE.json
```

额外用 `--upgrade-model <模型 ID>` 把真实失败、checkpoint 恢复和显式模型升级纳入一键验收。该模型必须和当前执行模型不同，并且供应商路由可用；使用已登记模型时保留其独立路由，否则复用配置的供应商路由。此步骤需要 `JEV_API_KEY`，缺少配置、密钥或不同模型会明确失败。未传此参数时总报告标为 `realModelUpgrade: NOT_REQUESTED`，本地升级 fixture 不能替代真实供应商验收。

```powershell
node desktop/scripts/validate-agent-goal.mjs --live-config <Flash配置路径> --live-jev --upgrade-model mimo-v2.6-pro --repeat 2 --output docs/artifacts/AGENT_GOAL_VALIDATION_FULL_LIVE.json
```

可以单独执行升级流程：

```powershell
node desktop/scripts/goal-upgrade-harness.mjs --live-config <配置路径> --strong-model <不同模型ID> --output docs/artifacts/AGENT_GOAL_UPGRADE_VALIDATION.json
```

升级入口也支持 `--active-model`、`--runtime-root`、`--active-pricing-config` 和 `--strong-pricing-config`。报告保存实际模型身份、源代码摘要、真实工具结果、Jev 原始答案和各阶段退出状态；没有账单和真人记录时保留未知。

增加 `--automatic-recovery` 时改为同次任务内的实际缺失文件失败与最多三次恢复，让真实 Jev 决定动作；配置的更强模型可用，但不强制其选择。同模型重试成功只证明自动恢复，不能冒充模型升级。一键入口指定 `--upgrade-model` 后同时执行显式 checkpoint 升级与 Jev 自动恢复两种实验。

也可以在 desktop 目录使用 `npm run test:goal -- --live-config <配置路径>`。真实模式需要配置中的 API key 环境变量已经存在；不要把密钥写进命令或报告。普通 Codex CLI 必须已安装。真实调用会消耗供应商用量。

入口依次执行 Windows x64 debug 编译、checkpoint/Jev/升级运行时回归、原生桌面继续及重试流程、固定任务对照。某步失败仍记录其日志；当前编译失败时跳过 UI 并明确标为失败，避免拿旧程序冒充当前编译。所有步骤完成后只有全部通过才返回退出码 0。默认是本地 fixture；fixture 的 token 与模型输出不能证明生产收益。

运行时恢复步骤还会真正启动并强制终止一个多步骤进程，再启动新进程从其持久化 checkpoint 继续。先完成的步骤及其输出摘要、尝试次数必须保持；只重试中断的只读步骤。JSON 日志和阶段一 SQLite 两种存储均验证。只有旧运行的主机事件与新运行都明确为 READ_ONLY 才允许重试；实际写入后中断、来源证据缺失或恢复时改为受控模式，仍拒绝自动重放。测试只终止自己创建的运行时，不终止桌面用户任务。

总报告保存在指定 output，分步日志和对照报告在旁边带时间戳的 `goal-validation-*` 目录。回归范围是这三类目标，不等于整个产品所有功能都已穷尽验收。

原生步骤也预置 80 条持久化历史任务，以实际滚轮核对列表末项可达且外层侧栏不移动，自动保存滚动截图。补强后的用例全程用 `Input.dispatchMouseEvent` 滚到末项；此前用例的末项定位曾依赖脚本设置滚动位置，现在只在验收完成后恢复 fixture 的原位置。最新同一编译程序 27/27 的补充证据见 [全程滚轮验收](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_NATIVE_WHEEL_SUPPLEMENT_2026-10-08.json)。

最新 df857d5a 编译程序的较矮 WebView 视口 1280×474 CSS 像素原生测试通过 28/28，其中额外一项验证指定视口确实生效；继续任务、重试升级、80 条任务滚轮末项、侧栏底部和取消流程均保留。这是 WebView 视口模拟，原生窗口边框未调整。可在一键入口加 `--ui-viewport-width 1280 --ui-viewport-height 474`，或直接调用 UI 脚本的 `--viewport-width`／`--viewport-height`。测试截图见 [最新较矮视口](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_NODE_PREVIEW_MERGED_NATIVE_2026-10-08.png)。

## 固定任务与验收

任务集 3.1 有六个任务，每个条件默认重复两次，交替先后顺序。

| 任务 | 操作 | 独立验收 |
|---|---|---|
| inspect-readme-001 | 读取 README | 正确标记必须出现在实际成功工具的输出中 |
| inspect-layout-001 | 列目录 | 四个预期文件必须出现在实际成功输出中 |
| recoverable-read-001 | 先读取缺失文件，再读取 README | 第一阶段确实报错，之后成功工具取得正确标记 |
| code-normalize-001 | 先跑失败测试，修复 normalizeName | 空值、转换、NFKC、空格及大小写的独立断言 |
| code-syntax-001 | 先触发语法错误，修复 parseTags | 语法、CSV 解析、去空值及稳定去重断言 |
| code-feature-001 | 增加 uniqueNames | 保留原导出、复用归一化、顺序、空值及非数组断言 |

工程任务要求模型实际运行 `node --test --test-isolation=none` 并成功，随后主机在干净环境中运行独立断言、语法和测试。Windows Codex 沙箱阻止 Node 测试工作进程，因此双方使用相同的进程内测试选项。只运行 `node --check` 不能满足成功测试条件。改测试、增加额外文件、修改目标之外的文件、仅口头报告成功都会失败。原生工具输入及输出用摘要关联到持久化事件。

普通 Codex 是已安装的 CLI，使用自定义 Responses 路由；双方经同一个 Chat Completions 适配器访问相同真实上游模型。第三方模型采用 CLI 的回退工具配置，本批次请求没有原生 apply_patch 工具，代码修改需经终端完成。客户端自身提示、工具定义、缓存和恢复策略仍不同，不能把结果扩展为原生 GPT Codex 的综合能力比较。读任务为只读，工程任务为工作区写入；dda 使用显式 file.write/test.execute 能力和 node 命令许可。两边从独立但相同的初始文件开始。默认单任务时限为只读 180 秒、工程 300 秒。

可以只跑对照，不再编译和操作 UI：

```powershell
node desktop/scripts/goal-evidence-harness.mjs --suite all --repeat 2 --live-config C:/Users/User/AppData/Local/hmCodex/model-config.json --output docs/artifacts/AGENT_GOAL_COMPARISON.json
```

`--suite engineering` 只跑三类代码任务，`--task-ids` 选择明确的任务 ID。`--conditions hmcodex-runtime` 或 `--conditions ordinary-codex` 可只复测一个客户端；默认仍为双方。选择性诊断不能替代完整固定任务验收，也不能与不同源码批次拼成成对结果。

## 真实 Jev 恢复测试

较早源码的同源码真实开／关对照及证据边界修复见 [前版 Jev 再验收报告](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_JEV_ABLATION_AUDIT_2026-10-07.md)。最新源码仍需独立开／关实验；Jev 接口可用与工作流小样本成功不能替代提速、省钱的比较证据。

在真实模型命令中增加 `--live-jev`，运行时会实际调用 Jev，普通 Codex 条件仍不使用 Jev。这属于增加决策模型后的实验，不能和 Jev 关闭的批次混为相同条件。`validate-agent-goal.mjs` 和 `goal-evidence-harness.mjs` 都支持此参数。

```powershell
node desktop/scripts/goal-evidence-harness.mjs --conditions hmcodex-runtime --task-ids recoverable-read-001 --repeat 2 --live-config C:/Users/User/AppData/Local/hmCodex/model-config.json --live-jev --output docs/artifacts/AGENT_GOAL_JEV_RECOVERY.json
```

需要当前进程已有 `JEV_API_KEY`。父进程代理把供应商凭据留在父进程；子运行时只取得本地代理凭据。所有真实 Jev 答案原样转发，保留每次请求、响应模型和供应商 usage，不按预期答案替换。请求失败或没有使用量时保持未知。

使用 `--jev-ablation` 运行同一 dda 源码的 Jev 开／关成对实验：

```powershell
node desktop/scripts/goal-evidence-harness.mjs --suite all --repeat 2 --live-config C:/Users/User/AppData/Local/hmCodex/model-config.json --jev-ablation --output docs/artifacts/AGENT_GOAL_JEV_ABLATION.json
```

每对任务的初始文件、运行时源码与上游模型必须一致；每轮交替先后顺序，失败和超时仍计入原条件。两臂均为 dda，不能把它作为普通 Codex 的对照。不能同时传 `--live-jev` 或普通 Codex 条件。Jev 实际调用数、输入／输出 token、代理测量的请求耗时和 API 价格估算单列；语言模型订阅额度保持独立。未执行任何 Jev 请求的开启条件仍保留，并标记实际激活数量，不能当作 Jev 成功作用的证据。一键入口也支持此参数。

`jev-requests.json` 是逐任务原始证据，`decisionProvider` 单列决策调用数、输入／输出 token 与发布 API 价格估算。主表的 token、调用和额度仍是语言模型，Jev 另列，避免把订阅额度和决策 API 估算混成现金收费。Jev 发布价格来源见 [TypeSafe 官方说明](https://typesafe.ai/blog/introducing-system-one-models-and-jev)。测试显式使用 5000 ms 决策上限，不修改用户持久化配置。真实服务拒绝或超时会导致验收失败；接口连通不能替代完整恢复成功。

决策证据的单条 claim 仍限制在 500 字符。模型回答与实际工具结果现在先生成有效的有界 JSON，再经过 DecisionState 的限制：保留原始长度、截断标记、正文首尾；工具结果另保留实际 ok／exitCode，模型回答另保留有限的反引号字面值。这些模型字面值仍是低置信度的未可信数据，不提供工具执行证明或权限。不能通过截断序列化 JSON、提高置信度或跳过硬验收来让实验通过。

工具准入会提供主机登记的工具策略、配置的能力及命令名称，以及有界的未可信调用预览。进程预览区分测试／语法检查等标志，隐藏任意参数值和内联代码；文件写入／patch 另提供有界的拟修改文本。此前实际返回的成功或失败工具结果也进入准入，失败进程在 stdout 为空时保留 stderr 摘要。配置的能力只表示可进入主机检查，不能冒充已经签发的单次租约。

主机明确标记 `invocationAttempted=false`、`gateDecision=REQUEST_EVIDENCE` 且错误码为 `TOOL_ACTION_REQUIRES_EVIDENCE` 的提案，属于执行前补证据请求。它保留在历史中，不当作已执行失败或重复副作用；只有这类提案时仍不能判定任务完成。仅错误码相同、实际已尝试执行、明确 BLOCK、权限错误和未解决的实际测试失败，继续遵守原有失败规则。一键运行时步骤包括这些证据边界和真实子进程恢复检查。

测试及文件修改准入可以通过既有授权工作区读取最多四份相关文件，每次最多 4096 字符，再生成最多 500 字符的 JSON claim；快照只用于候选路径，不冒充当前内容，也不当作测试已执行。证据优先保留实际失败／成功测试、写入、工具策略和调用预览。正常写入后的文件复查与实际读取摘要变化不再误判重复；相同周期内的无新证据读取与重复写入仍受停滞约束。准入提问区分请求的诊断失败、主机授权和未知范围，原始 Jev BLOCK 及主机硬约束继续保留。目标入口已加入相关证据、决策与规则检查。

## 指标和证据来源

每次运行向 `docs/artifacts/agent-goal-runs/history.jsonl` 追加记录，保留失败。每个批次保留模型请求、工具事件、退出状态、最终工作区、代码独立验收、内容审计、源码摘要及源码快照。源码在运行期间变化会中止批次，避免混入不同实现。

新批次同时保存测试脚本与价格配置的摘要和源码快照，方便核对任务及验收口径。`--runtime-root` 可明确指定隔离运行时副本，报告会记录实际路径与该副本的摘要；隔离副本的结果不自动成为当前主工作区的验收结果。

后续批次的模型及 Jev 代理另记录供应商返回的响应 ID 和白名单请求标识，便于与真实收费记录关联；不记录授权头或 Cookie，也不会据此生成收费金额。当前 24 次批次启动后才增加这些字段，保存的脚本快照仍决定本轮口径，不向旧请求补写标识。相关桌面脚本回归 53/53 通过。

真实模式同时核对请求模型和成功上游响应中的模型身份。超时后有界收尾；继承管道不能正常关闭时保存部分输出并标记 `timeoutOutputTruncated`，该任务继续算超时，不能按完整成功处理。

记录成功率、恢复率、输入/缓存/输出 token、模型调用数、工具轮数、耗时、人工活跃分钟和费用。请求缺少 usage 时，总 token 保持 UNKNOWN；`usageCoverage` 单列已报告请求数和已知小计，不能把小计当总量。恢复率既报告机会数也报告成功数，不能只展示恢复成功的样本。

OpenCode Go 的默认价格配置有官方来源和核对时间，分别计算未缓存输入、缓存输入和输出。其计价依据是订阅额度消耗，**不是实际现金账单**。实际账单未导入时 `actualCost` 为 UNKNOWN。[官方额度及计价说明](https://opencode.ai/docs/go/#usage-limits)。其他模型需用 `--pricing-config` 提供具有来源的 schemaVersion 1.0 配置，字段为 model、source、checkedAt、currency USD、basis API_PRICE/SUBSCRIPTION_QUOTA、inputPerMillion、cachedInputPerMillion、outputPerMillion。

无人测试的人工时间是 0，来源为 `NO_HUMAN_CHANNEL`，不能据此声称省人工。需要真人数据时传 `--interventions-ledger`，在实际活动开始/结束时记录：

```powershell
node desktop/scripts/goal-measurements.mjs docs/artifacts/human-activities.jsonl <CASE_START中的runKey> <活动ID> START HUMAN
node desktop/scripts/goal-measurements.mjs docs/artifacts/human-activities.jsonl <同一个runKey> <同一个活动ID> END HUMAN
```

脚本写入当时的真实时间。重叠活动按时间并集合计；AUTOMATION 活动不计人工；缺起点或终点、没有实际活动证据都保持 UNKNOWN。活动必须在对应运行时间窗口内。不要用自动脚本执行 HUMAN 记录来伪造真人活动。

## 之后补账单或活动证据

账单 JSONL 每条必须有 schemaVersion 1.0、runKey、model、currency USD、amount、chargeId、source、coverage。FULL_RUN 表示供应商提供完整运行费用；PER_CALL 还需要对应模型请求 sequence。缺请求费用、重复收费冲突或模型不匹配不会变成 0。订阅总价不能直接当成某个任务费用。

供应商账单通常晚于测试，可生成新的派生报告：

```powershell
node desktop/scripts/goal-reconcile-report.mjs --report docs/artifacts/AGENT_GOAL_COMPARISON.json --billing-ledger docs/artifacts/provider-billing.jsonl --output docs/artifacts/AGENT_GOAL_COMPARISON_BILLED.json
```

可用 `--interventions-ledger` 补完原本有真人活动的运行；原始无人运行禁止事后添加 HUMAN 活动。派生报告保留原指标、源报告摘要和未匹配的 runKey，拒绝覆盖现有文件，不修改原始日志或历史。没有真实账单和真人活动，就不能完成省钱/省人工的收益验证。

真实 Jev 批次另需 `--decision-billing-ledger`。格式相同，model 使用请求模型 ID `jev-latest`，PER_CALL 的 sequence 指向 `jev-requests.json` 的决策请求序号。语言模型账单与 Jev 账单分别核对；缺任何一个实际费用分项时，总实际收费仍 UNKNOWN，不把语言模型的收费冒充总收费。估算额度和发布 API 价格继续分别保留，只有来自两份实际账单的 USD 金额才可合计。

Jev 与模型升级的故障注入用本地服务验证状态链。默认同模型对照关闭 Jev，`--live-jev` 的客户端对照仅给 dda 启用真实 Jev；两种条件分开记录。当前真实同模型对照不能证明低价路由或强模型升级的经济收益，还需实际多模型配置与独立开/关对照。

Jev 客户端现按官方 `/v1/systemone` 与 criteria/instructions schema 请求。除 SDK 连通探测外，真实语言模型加真实 Jev 的失败恢复工作流已完成 2/2 成功验证，20 次决策请求均成功，保留对应运行时源码快照。这个单方小样本证明该快照的实际集成可用，仍不能证明 Jev 比关闭时更快或更省钱。之后新增真实进程中断恢复的改动在当前源码单独验收，旧真实模型结果不自动成为新源码的结果。实际运行时需要显式 decision 配置或 `HMCODEX_JEV_ENABLED`。默认 1200 ms 超时低于首次 SDK 实测 1348 ms，正式启用时应验证任务适用的超时和降级。最新证据与剩余验收见 [进程中断恢复与当前验收](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_PROCESS_INTERRUPTION_AUDIT_2026-10-07.md)。
