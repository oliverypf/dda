# 代码任务：普通 Codex vs hmCodex（2026-10-03）

固定任务 `normalize-name-001`：修改 `normalizeName`，让它 trim + lowercase 字符串，并对非字符串抛出 `TypeError`；不能修改测试；运行现有测试。

| 条件 | 结果 | 返工 | 测试 | 人工介入 |
|---|---|---:|---:|---:|
| 普通 Codex CLI | 成功 1/1 | 0 | 2/2 | 0 |
| hmCodex 受控 fixture | 成功 1/1 | 0 | 2/2 | 0 |

普通 Codex 实际修改了 `name.mjs`，随后 `node --test` 为 2/2。随后在批准的 `WINDOWS_PHASE1_5_CONTROLLED` 通道中，hmCodex 的本地确定性 fixture 通过两个工具轮完成了同样的写文件和测试动作，验证结果也是 2/2，工具调用 2 次，耗时 4559 ms。

这仍不是统计意义上的产品质量 A/B：每组只有 1 个样本，且两边使用的模型条件不同。它证明的是能力闭环已经能跑通；要比较真实成功率、返工和测试通过率，还需要同一模型或明确的模型分层，并扩大任务集。
