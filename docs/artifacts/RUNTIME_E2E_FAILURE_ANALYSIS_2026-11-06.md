# runtime 端到端失败根因分析（2026-11-06）

> 范围：`runtime> npm test`（显式 `test/**/*.test.mjs`）剩余的 13 条失败中，9 条端到端（起真 CLI 子进程 + localhost fixture）。
> 结论：**9 条全部是陈年既存问题，非本次会话改动引入**；基线 `382a5a2` 的 git worktree 对比 + 改动前 baseline 日志均证实。
> 本文只记录根因，不改任何实现/测试。修复涉及审批与租约安全边界，且用户已决定整体删除 READ_ONLY（见 [ADR-0026](../adr/0026-remove-read-only-execution-mode.md)），应在那轮统一处理。

## 1. 验证方法

- 在 `382a5a2`（本次会话所有改动之前）建 detached worktree，用 junction 挂主工作区 `runtime/node_modules`，单跑 `verification-only-recovery-runtime.test.mjs`：9 用例 / pass 4 / fail 5，失败形态与当前一致（`1 !== 2`、`false !== true`、`9 !== 3`）。
- 改动前的 baseline 日志 `%TEMP%/dda-baseline-20261105/tmp-runtime-glob-181648.log` 里，`jev-tool-evidence` 3 条 + kernel gate 1 条已记录为 ✖。
- 诊断脚本复用了各测试的 fixture，把子进程 stdout 落盘解析，抓到真实 `payload` 与 `harness.errors`。诊断临时文件均已删除，工作区干净。

## 2. 9 条分两组

| 组 | 用例 | 数量 | 共同现象 |
| --- | --- | --- | --- |
| A | `verification-only-recovery-runtime.test.mjs` native workflow（READ_ONLY/PASS、CONTROLLED/PASS、CONTROLLED/FAIL、CONTROLLED/SERVICE_FAILURE、CONTROLLED/PASS delayed） | 5 | `ok:false`、`PLAN_STEP_FAILED:execute:FAIL`、`SAFETY_LEASE_REQUIRED`，model 调用 6 次（期望 2/3） |
| B | `jev-tool-evidence.test.mjs` 3 条（controlled failing test / autodiscovered tests / repeated restricted syntax diagnosis） | 3 | `result.code=1`、首个 `test.execute` 即 `SAFETY_LEASE_REQUIRED`，model 调用 12 次（期望约 5） |
| C | `kernel-readonly-gate.test.mjs` 第 2 条（READ_ONLY blocks kernel.host_request） | 1 | 子进程 `STOP_SUCCESS`、`actions.progress PASS`，探针被当成功只读执行，没有 BLOCK 结果 |

## 3. A + B 同源根因：#16 的"验证 UNCERTAIN 后重新审批"门禁与旧 fixture 不兼容

时间线（git 历史实锤）：

- `268d4d6`（2026-10-11）`feat(runtime): re-approve side effects after an uncertain verifier verdict (#16)` 引入 `verifierStateRequiresReapproval` / `verifierReapproval.active`（`index.mjs:676, 5105-5126`）：验证 UNCERTAIN/STALLED 后，下一次副作用必须显式审批；无 live approver 时 `resolveApprovalOutcome` 返回 `REFUSE`（`controlled-tools.mjs:281-284`、`kernel/approval-session.mjs:466-485`）。
- 该提交只新增了 `verifier-reapproval.test.mjs`，**没有同步** `verification-only-recovery-runtime.test.mjs` 和 `jev-tool-evidence.test.mjs` 的 fixture。
- `verification-only-recovery-runtime.test.mjs` 最后一次修改是 `f096a4f`（2026-10-11，仅重命名 `HMCODEX_*`→`DDA_*`）；`jev-tool-evidence.test.mjs` 同样停留在 `f096a4f`。

具体链路（诊断脚本抓到的真实 payload）：

```
fixture 首次 /jev 返回裸 503（模拟瞬时失败）
  → canRetryVerificationOnly 要求精确 JEV_HTTP_503 + jev-behavior-judge/UNKNOWN 证据
    （decision/verification-retry.mjs:57-62）
  → 裸 HTTP 503 未被识别成可 verification-only 重试，verificationOnlyRetry 未置位
  → 验证保持 UNCERTAIN → verifierReapproval.active = true（index.mjs:5110-5121）
  → 测试没传 --events stdout，approvalInterface 未创建（index.mjs:687），hasLiveApprover=false
  → requestApproval REFUSE（approval-session.mjs:466-485）
  → createExplicitLeaseProvider 拿不到 lease → SAFETY_LEASE_REQUIRED
     （controlled-tools.mjs:397-418、runtime-safety-monitor.mjs:642）
  → test.execute / file.write 失败，WRITE_STALE_DIGEST 随之出现
  → 验证 FAIL → runtime 反复恢复重放整个工具序列
  → model 调用 6 / 12 次，超出 fixture 设计的 2-3 / 5 次
```

诊断抓到的子进程输出（节选）：

```
{"ok":false,"error":"PLAN_STEP_FAILED:execute:FAIL","harness":{"toolResults":4,
 "successfulWrites":1,"verification":{"status":"FAIL","nextAction":"STOP_AND_REPORT"},
 "errors":[{"name":"test.execute","errorCode":"SAFETY_LEASE_REQUIRED"},
           {"name":"file.write","errorCode":"WRITE_STALE_DIGEST"},
           {"name":"test.execute","errorCode":"SAFETY_LEASE_REQUIRED"}]}}
```

B 组 12 次 model 调用的 `function_call_output` 错误码序列同样以 `SAFETY_LEASE_REQUIRED` 开头，确认同源。

**为什么不能简单改断言**：这些测试验证的是"transport verification-only 重试不重跑 executor"和"Jev wire 携带真实工具证据"，属安全关键行为。让它们转绿要么：(a) 让 fixture 起 live approver（`--events stdout` + 提供审批输入），(b) 让 503 被识别成可 verification-only 重试（改 `canRetryVerificationOnly` 的识别条件），(c) 调整 #16 门禁与 verification-only 重试的先后关系。三者都碰审批/租约边界，需评审。

## 4. C 组：READ_ONLY 硬闸对 kernel.host_request 的判定存疑

- 测试期望 `kernel.host_request {kind:'host.ping'}` 在 READ_ONLY 下被 BLOCK（`TOOL_NOT_ALLOWED_IN_MODE`），并断言第二轮请求带 tool result。
- 实测子进程 stdout：`toolCallCount=1`、`actions.progress PASS`、`decisionLayer.last.action=STOP`、reasonCode `HARD_SUCCESS_WITH_COMPLETE_REQUIREMENTS` —— **探针被当成一次成功只读动作执行完，直接收尾**，所以没有第二轮 tool 消息。
- `index.mjs:3779` 的硬闸是 `call.toolPolicyFacts?.readOnly === true && call.name !== 'kernel.host_request'`；`kernel-tools.mjs:233` 在 Phase-1 把 `kernel.host_request` 注册为 `readOnly: !effectsOn`（默认 true）。若 `call.name` 因任何原因不是精确的 `kernel.host_request`（例如 wire 编码名未解码、或 Phase-2a effects 开关改变了 readOnly 标记），`toolReadOnly` 就会为 true，硬闸不触发。
- 之前尝试把测试发出的工具名改成 wire 编码名 `hmc_kernel_x2e_host_request`，**仍红**，故排除"名字未编码"这一假设；chat-completions 路径（`model-openai.mjs:446`）与 responses 路径（`:310`）都做了 `decodeToolName`。
- 结论：这是**测试 fixture 与当前 READ_ONLY 内核桥实现的契约漂移**，不排除是 READ_ONLY 硬闸的实际漏洞。但用户已决定整体删除 READ_ONLY 执行模式，这条硬闸本身要重新设计，不在旧链上打补丁。

## 5. 其余 4 条（非端到端，环境性）

- `platform.test.mjs` 3 条：期望 POSIX 路径（`/srv/dda`），Windows 主机上 `path.resolve` 产出 `C:\srv\dda`。`paths.mjs` 顶部注释写明 "the Windows runtime test suite runs on Linux"，即这套测试设计上跑在 Linux 主机；不是产品缺陷，换 Linux 主机即转绿。
- `harness-idempotency-post-pass.test.mjs` T-idemp-4：硬编码 `/workspace/dda-drive/bench/drive.mjs`，本机不存在。同属 Linux 路径假设。

## 6. 修复建议（需评审，不擅自执行）

1. **优先级**：全部 9 条应并入 ADR-0026「移除 READ_ONLY」那轮统一处理——它们都围绕 READ_ONLY / 审批 / 租约链，而 ADR 正是要重设这条链。
2. A+B（8 条）：在评审中决定 (a)/(b)/(c) 哪种修复方向；若选 (b)，需同步 `decision/verification-retry.mjs` 的契约与 `verifier-reapproval.test.mjs`，并补"verification-only 重试先于 reapproval 门禁"的安全测试。
3. C（1 条）：随 READ_ONLY 删除一并退役；若删之前要单独守，先补一个"READ_ONLY 下 kernel.host_request 必被 BLOCK"的最小单测定位硬闸是否真漏。
4. 4 条环境性：在 Linux CI 跑，或在 Windows 上按 `paths.mjs` 设计意图把 portable 分支的路径断言显式标注为 POSIX-only（不改 path authority 模块，避免碰信任边界）。

## 7. 验证记录

- 基线 worktree 对比：`382a5a2` 上 `verification-only-recovery-runtime` 5 条同样红；worktree 已 `git worktree remove`，主工作区 `runtime/node_modules` 完好。
- 当前 `master`：`cead212` / `3936a61`；`npm test` = 1245 / pass 1229 / fail 13 / skipped 3。
- 本次分析未改任何代码；诊断临时文件 `.tmp-*.mjs` 与 `%TEMP%` 下 stdout 落盘均已清理。
