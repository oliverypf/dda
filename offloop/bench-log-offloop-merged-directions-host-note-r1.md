# host-note 合并方向收口 r1 验收记录

日期：2026-10-25（America/Adak）。执行前已完整读取冻结说明 `freeze-offloop-merged-directions-host-note-r1.md`。

保存位置：`/workspace/dda-drive/bench-log-offloop-merged-directions-host-note-r1.md`（Codex 沙箱曾拒写父目录，由执行器复制到位）。`offloop/` 下保留同内容副本。

## 基线与计数

冻结说明给定基线为 **96/96**；`git -C /workspace/dda rev-parse HEAD` 实测完整 PIN（锁定提交）为 `a9c0b357bb0340325a02b3b50378851e22ddb4d9`。`offloop/` 自身没有可用的 Git（版本控制）元数据，因此修改范围通过开工前文件快照逐项比较。

本刀新增 **4 个用例**：原有 96 个用例加本刀为 **100 个**。工作期间并行任务新增 `test/experience-dedupe-retrieve-r1.test.mjs` 的 7 个用例和 `test/dayloop-l1-bounded-wire-r1.test.mjs` 的 7 个用例，并修改 `experience.mjs` / `propose.mjs` 及日循环接线；这些改动由原任务保留，本刀没有编辑或回退它们。最终共享目录完整测试为 **115/115 通过，0 失败、0 跳过**（相对 Codex 交卷时的 114，后续并行刀又多 1）。

当前环境的默认 `node --test` 只展示测试文件级计数：修改前命令为 21/21 个文件通过，最终为 24/24 个文件通过，均退出 0；不能把文件数写成单测数。因此额外使用 Node.js（JavaScript 运行环境）24 的无进程隔离模式，核验实际 114 个用例。新增 host-note 拒绝用例在旧匹配表下已观察到失败，加入条目后通过。

## 修改范围

- `offloop/merged-directions.mjs`：新增 `host-note-post-dpr-execute-bias` 方向，含 slug（短标识）的连字符及下划线写法、PR（合并请求）#82、同一行内同时包含 host-note（宿主提示）、post-DPR（诊断探测恢复后）、execute-bias（执行偏向）的标题模式，以及特定标签组合。保留 sticky（粘性执行）/#83/#84 原条目。
- `offloop/compose.mjs`：仅把 shipped_duplicate（已交付方向重复）的经验课文案改为通用已交付方向说明，避免 host-note 被误写成 #83/#84；Compose（组稿门）的判定顺序和证据门槛未改。
- `offloop/test/merged-directions-host-note-r1.test.mjs`：新增 2 个表驱动回归，覆盖别名、标题、标签、#82 各种直接引用，以及 #820、无关 PR、普通软提示和 steal（可产品化分支）的不匹配边界。
- `offloop/test/compose.test.mjs`：新增 1 个直接采用 host-note 的拒绝用例；原正向用例改为普通文档检查提示。
- `offloop/test/compose-soft-evidence.test.mjs`：新增 1 个带继承 host-note/#82 引用的 steal 正向用例，使用实际准备的软文件树、完整 PIN 和文件清单 hash（摘要）。原有通用软证据门槛测试保留。
- 正向回归最小修复：`test/propose-diversity-dedupe-r1.test.mjs`、`test/soft-contrast-pair.test.mjs`、`test/true-candidate-r1.test.mjs`、`test/e2e-soft-dayloop.test.mjs`、`test/dayloop-from-miss.test.mjs`、`test/on-closed-soft.test.mjs`。
- 为维持 soft-clean（干净软层对照）夹具的成功语义，新增 `test/fixtures/e2e-soft-baseline.jsonl`：保留原有六条毒循环事件，加一条明确的 `harness.post_agent_miss_terminal_replan` 夹具事件。本刀对 `dayloop-soft.mjs` 仅修改一行默认夹具路径；后续并行任务的日循环接线改动未被覆盖。原 `poison-loop-yes.jsonl` 不变。正向候选改用 steal 并满足原有完整 PIN 条件。

**steal 的任何 slug 均未加入 MERGED_DIRECTIONS（已合并方向表）。** runtime（运行时）、steal allowlist（证据白名单）、tip（当前提交）/topology（拓扑）双绿规则及默认值均未由本刀修改。

## 验证命令与结果

工作目录：`/workspace/dda-drive/offloop`。

```bash
node --test test/*.test.mjs
# 24 个测试文件通过，退出 0

/workspace/node24/bin/node --test --test-isolation=none --test-reporter=tap test/*.test.mjs
# tests 115; pass 115; fail 0; cancelled 0; skipped 0; todo 0
```

完整输出保存在 `offloop/out-merged-directions-host-note-r1/node-test.tap` 和 `offloop/out-merged-directions-host-note-r1/individual-tests.tap`。TAP（测试结果文本协议）中的第二份输出逐项列出实际用例。

另以 `runDayloopSoft({ fixture: 'soft-clean', outDir, softWorktreeDir, date: '2026-10-25' })` 实际落盘验收，输出目录为 `offloop/out-merged-directions-host-note-r1/`；汇总见 `acceptance.json`。完整 PIN 与冻结一致，三个假说均通过 L1（一级软层对照），随后由 Compose 执行合并方向去重。

## 验收表

| 验收项 | 实测结果与证据 |
| --- | --- |
| host-note 本方向采用 | `matchesMergedDirection=true`；即使 `adopt=true`，仍为 `wroteCandidate:false`、`reason:shipped_duplicate`；生成 EXPERIENCE（经验课），其中 `adopted_candidate: no (shipped_duplicate)`；host-note 的 CANDIDATE（候选）文件数为 0。覆盖直接用例和日循环落盘。 |
| 别名、标题、标签、#82 | 连字符/下划线 slug、词序变化标题、特定标签、#82 文本、地址及对象形式均命中；每种形式都验证只有经验课、0 个候选。 |
| 非目标边界 | #820 文本、标签、地址、对象及 `PR-820` 均不命中；普通 `soft`（软层）+`host-note` 标签和缺少关键方向词的提示均不命中。 |
| steal 可生成候选 | `matchesMergedDirection=false`；白名单内 `post_amt`（代理未命中后终止重规划）证据、完整 PIN、实际文件摘要和通过的软层对照齐备后，写入唯一候选 `freeze-candidate-steal-post-amt-terminal-replan-r1.md`。 |
| 继承引用隔离 | steal 的 prior（继承经验）和 evidence（证据）引用 host-note/#82 仍可生成候选；普通软提示继承 host-note/#82 及 sticky/#83/#84 也不碰撞。 |
| sticky/#83/#84 | 原条目和原回归保留；已有 sticky 别名与 #83/#84 即使携带可采用证据仍拒绝为 `shipped_duplicate`。 |
| 真实日循环产物 | 唯一候选属于 steal；host-note 与 sticky 各写一份拒绝经验课；FROZEN（冻结稿）写入数 0。 |
| 完整回归 | 冻结基线 96；本刀新增 4；并行任务新增 14；最终 115/115 全绿（本刀 +4；并行刀合计 +15）。 |

另通过快照断言确认 sticky 原条目完全相同；`path-signals.mjs`（含 steal 白名单及 PIN）、`probe.mjs`、`soft-worktree.mjs` 和原毒循环夹具保持相同内容。

日循环证据文件：

- `offloop/out-merged-directions-host-note-r1/acceptance.json`
- `offloop/out-merged-directions-host-note-r1/experience/2026-10-25-host-note-post-dpr-execute-bias-rejected.md`
- `offloop/out-merged-directions-host-note-r1/freeze-candidate-steal-post-amt-terminal-replan-r1.md`

SCAN（交付复核）结论：host-note 已收口为已交付库证据；steal 保持可产品化，未进入已合并方向表。代码与完整回归已完成，验收记录已落在指定父目录路径。本记录仅供 @BOT2 复核，未向聊天发送消息。
