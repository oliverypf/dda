# 额外复核链接状态变化

三份补丁都能发现单个 `FETCH_HEAD` 符号链接。第 1、3 次补丁只把易变文件的链接状态合并进 `metadataLinkDetected` 布尔值。当另一个链接已经存在时，新增链接或者改变链接所在路径都没有改变它们的元数据摘要。第 2 次把每个易变文件的链接标记保留在各自条目中，保留了原版本的区分能力。

| 受检版本 | 首次出现链接 | 已有 hook 链接，再增加 FETCH_HEAD 链接 | 保留 hook 链接，把另一个链接从 FETCH_HEAD 换到 index |
|---|---|---|---|
| 原版本 | 检出 | 检出 | 检出 |
| 第 1 次补丁 | 检出 | 未检出 | 未检出 |
| 第 2 次补丁 | 检出 | 检出 | 检出 |
| 第 3 次补丁 | 检出 | 未检出 | 未检出 |

在仓库根目录用 Node 24 运行以下命令。脚本默认读取本次留存的试验目录，也可以在命令末尾传入包含 `seed` 和三份 `dda-N/work` 的目录。[复核脚本](link-check.mjs)

```powershell
node --experimental-vm-modules docs/artifacts/git-fingerprint-feedback-2026-11-21/link-check.mjs
```

脚本读取各版本完整的 `runtime/src/git-observer.mjs` 并打印源码 SHA-256，在内存中导出该版本自己的 `readGitMetadata`。合成的 Git 子进程对 `rev-parse --git-dir` 返回 `.git`，`readdir` 返回指定的 hook 名称，`lstat` 根据当前用例报告路径缺失或属于符号链接。断言比较实际返回的 `metadataDigest` 和 `metadataLinkDetected`，两者任一改变即检出。正式评分的原测试和独立验收仍按原协议统计，这项复核单列。
