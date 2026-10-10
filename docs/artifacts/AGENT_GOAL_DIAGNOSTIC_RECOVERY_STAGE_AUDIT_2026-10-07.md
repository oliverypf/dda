# hmCodex 诊断恢复修复验收：2026-10-07

源码 2f4cf8b2dc3533b1f31d1ed6ff0de4b23ed3cd5044fa093c15b8896cf25f6320 已编译。完整运行时回归 **653 通过、0 失败、1 项跳过**，新程序原生桌面 **27/27**；目标测试脚本 30 通过。

主机为受限 Node 命令提供默认工作目录、测试发现方式与实际执行结果。一次重复语法检查后，如果不同的完整测试确实执行且退出码为 0，停滞规则会记录诊断已恢复。重复写入、多次诊断重复、缺少实际结果、失败测试和只有模型声明的成功仍不通过。

新回归在修复前返回 STALLED；修复后，真实子进程实际完成五次受控操作并消耗相应租约。该较长 fixture 在全量并发回归中撞上原 30 秒外层期限；调整为 60 秒后已通过。中间一次超时参数改错用例的失败也保留在原始日志，当前完整回归已重新验证。真实客户端的任务时限没有改变。

上一轮失败的 14 次实际工具轨迹独立重放后，新规则能识别后来的实际完整测试成功。这个重放只验证规则，不改动旧任务 FAILED 状态，不计为新的真实恢复成功。

上一源码 b972fad8 的真实模型加 Jev 仍为 7/8，新源码的完整客户端对照尚需完成；不能沿用旧通过率。后续还需 Jev 开／关实验、真实低价／强模型升级及实际账单和人工时间。收益目标保持 active。

Node 默认测试发现与语法检查的含义依据 [Node v24.19.0 测试文档](https://nodejs.org/download/release/v24.19.0/docs/api/test.html#running-tests-from-the-command-line)与[命令行文档](https://nodejs.org/download/release/v24.19.0/docs/api/cli.html#-c---check)。这些事实不授权执行测试，受控工具仍须通过原有主机策略和单次租约。

[机器审计](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_DIAGNOSTIC_RECOVERY_STAGE_AUDIT_2026-10-07.json) · [完整回归](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_DIAGNOSTIC_RECOVERY_FULL_RUNTIME_VALIDATED_2026-10-07.log) · [原生桌面](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_DIAGNOSTIC_RECOVERY_NATIVE_2026-10-07.log) · [归档轨迹重放](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_DIAGNOSTIC_RECOVERY_TRAJECTORY_REPLAY_2026-10-07.json)
