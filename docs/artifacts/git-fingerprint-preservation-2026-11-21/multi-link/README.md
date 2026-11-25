# Git 元数据的多链接独立验收

两项验收都从一个临时 Git 仓库开始，两侧都有链接，文件字节、HEAD 和暂存指纹保持相同。原有链接再增加一条、或者将唯一的链接换到另一条路径时，公开的 `GitObserver.snapshot().metadataDigest` 应能区分两次观测。评分器还重复观测一次完全相同的初始状态，确认指纹自身稳定。[测试源码](../multi-link.test.mjs)

| 历史版本 | 已有链接再加一条 | 链接换位 | 逐项证据 |
| --- | --- | --- | --- |
| 原始种子 | 通过 | 通过 | [JSON](seed/grade.json) · [TAP](seed/tests.tap) |
| 原错误断点 | 通过 | 通过 | [JSON](wrong-checkpoint/grade.json) · [TAP](wrong-checkpoint/tests.tap) |
| 上轮第 1 次 | 失败 | 失败 | [JSON](feedback-1/grade.json) · [TAP](feedback-1/tests.tap) |
| 上轮第 2 次 | 通过 | 通过 | [JSON](feedback-2/grade.json) · [TAP](feedback-2/tests.tap) |
| 上轮第 3 次 | 失败 | 失败 | [JSON](feedback-3/grade.json) · [TAP](feedback-3/tests.tap) |

上轮第 1、3 次的四个失败样本都读到了预期的链接布局，两侧 `metadataLinkDetected` 也都为真，但主指纹保持相同。上轮第 2 次在主指纹中保留了按路径区分链接的表示，能够检出两种变化。历史种子和错误断点在这两项上通过，原六项中的普通刷新仍需单独评分。[上轮三份补丁](../../git-fingerprint-feedback-2026-11-21/decisions.md)

| 本轮正式版本 | 已有链接再加一条 | 链接换位 | 逐项证据 |
| --- | --- | --- | --- |
| 第 1 次 | 通过 | 通过 | [JSON](dda-1/grade.json) · [TAP](dda-1/tests.tap) |
| 第 2 次 | 通过 | 通过 | [JSON](dda-2/grade.json) · [TAP](dda-2/tests.tap) |
| 第 3 次 | 通过 | 通过 | [JSON](dda-3/grade.json) · [TAP](dda-3/tests.tap) |

**本机的文件类型观测采用替代。** Windows 文件符号链接创建实测返回 `EPERM`，本机未列出已安装的 WSL 发行版，Docker 的本地 Linux 服务端未运行。评分进程对指定路径的 `lstat` 返回对应的链接类型。实际文件内容、Git 子进程和候选版本的观察器均照常运行。证据中的 `synthetic-lstat` 标记了这一限制；具有文件链接权限的环境会直接创建指向临时仓库内相同字节的文件链接，标为 `native-file-symlinks`。[评分入口](../grade-links.mjs)

每份 JSON 保存原产品源码树哈希、独立测试文件哈希、初始状态、同状态对照、最终状态和各项检查。命令为 `node grade-links.mjs <工作区> <独立输出目录>`。退出码 0 表示两项全过，1 表示有行为断言未满足，2 表示评分环境或执行异常。测试只在另建的产品副本中运行，评分输出在独立归档目录。[评分入口](../grade-links.mjs)
