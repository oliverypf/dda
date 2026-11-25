# 两个未落盘候选的独立复核

第 3 次第 11 轮确实发生了保守拒绝。候选通过了原测试，但宿主无法收集到多链接保护需要的配对证据。对同一候选独立评分，两个多链接用例均失败。第 2 次第 12 轮的候选则在加载产品模块时触发语法错误。[第 3 次评分](dda-3-r11/grade.json) · [第 2 次评分日志](dda-2-r12/tests.tap)

| 候选 | 正式预检 | 独立多链接验收 |
|---|---|---|
| 第 3 次第 11 轮 | 原断言通过，保护证据不足，未写入 | 0 通过、2 失败 |
| 第 2 次第 12 轮 | 原测试进程退出码 1，未写入 | 0 通过、2 加载错误，均为 `Unexpected token 'export'` |

第 3 次的补丁从两个文件名集合中删除了 `FETCH_HEAD`。在额外的临时副本里，生产者分析器成功解析同一候选，随后按真实参数执行原测试。原测试三项均通过，但生产者循环在 `index` 和 `FETCH_HEAD` 中只访问到 `index`。保留性探针需要先找到包含基线键的已访问分组，再从组内选取第二个键。此处没有满足条件的分组，因而返回 `unverified`。[实际访问记录](dda-3-r11/instrumented-original.tap) · [回执和内容摘要](dda-3-r11/reconstruction.json)

对未插入诊断探针的候选运行本批同一份独立评分器，得到以下结果。本机创建原生符号链接返回 `EPERM`，评分器按正式协议使用合成 `lstat`，前后 Git HEAD 和暂存摘要均保持稳定。[逐项观测](dda-3-r11/grade.json)

- 已有 `index` 链接再新增 `FETCH_HEAD` 链接时，产品的元数据指纹保持相同。
- 链接从 `index` 迁到 `FETCH_HEAD` 时，指纹发生变化，但迁移后的 `metadataLinkDetected` 为 `false`。

在仓库根目录执行下列命令可重跑。脚本从原错误断点复制源码，在临时目录应用已归档的实际 `file.patch` 参数，与两条正式 `harness.repair_candidate` 事件逐一核对完整 SHA-256 后，调用本批评分器。额外的按键访问采样发生在独立评分完成之后。两次复核没有调用模型，不改变正式三次的结果。[重建脚本](rebuild.mjs) · [正式评分器](../grade-links.mjs)

```powershell
node docs/artifacts/git-fingerprint-preservation-2026-11-21/unverified-controls/rebuild.mjs
```
