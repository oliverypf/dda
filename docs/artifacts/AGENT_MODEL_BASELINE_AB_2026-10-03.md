# 普通模型直连 vs hmCodex（2026-10-03）

同一组 5 个 prompt 使用同一个本地模型 fixture：一组直接调用 provider，另一组通过 hmCodex task CLI。两组各 5 次。

| 条件 | 成功率 | 平均 wall time | 输入 token/次 | 输出 token/次 | 工具轮数 | 总 token |
|---|---:|---:|---:|---:|---:|---:|
| 普通模型直连 | 5/5 | 16.4 ms | 12 | 4 | 0 | 80 |
| hmCodex | 5/5 | 4941.4 ms | 12 | 4 | 0 | 80 |

本 fixture 下，hmCodex 没有增加模型 token，也没有工具轮数；增加的是约 4925 ms 的 CLI、持久化和事件处理开销。由于请求只发往本机 fixture，没有外部 provider 计费，所以本批次 provider 费用是 **$0**；本机 CPU/进程成本没有计价模型，生产 endpoint 的费用仍未知。这里的“普通模型”是原始 provider 调用，不是完整的普通 Codex 产品。
