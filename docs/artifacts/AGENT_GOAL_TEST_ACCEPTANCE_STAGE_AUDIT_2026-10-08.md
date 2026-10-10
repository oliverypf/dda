# 测试执行证据修复与验收：2026-10-08

当前源码 5186ceb599c120d765faf1bfc3150294064ab64504620a214f6d5e185e1638bc 已编译：运行时 **653 通过、0 失败、1 跳过**；基准脚本 **32 通过**；原生桌面 **27/27**。

新增负例验证了普通脚本接收 --test 后返回0、只跑语法检查、测试错误文件、只有口头成功和无关读取报错都不能通过工程恢复验收。现在同时检查实际 Node 调用、预置测试文件及其真实通过记录，并继续做独立断言和文件范围检查。验收协议版本为 2.0，固定任务的提示和初始文件仍为任务集 3.1。

Pro 的上一批计划24次、完成10次后中止。双方均遭遇HTTP500，最小Pro请求超时；Flash最小请求成功。原始结果保留，未执行或中断项目不计通过，也不据此声称任何客户端优势。中止的是核实过的测试进程。

后续同模型对照使用双方相同的真实 mimo-v2.6-flash、相同六任务及两轮重复，hmCodex另启用真实Jev。这个批次单独验收，不能混入Pro结果或改称真实Pro升级测试。

Flash发布额度价格为每百万token输入USD0.14、输出USD0.28、缓存读取USD0.0028，来自当日核对的[OpenCode Go官方文档](https://opencode.ai/docs/go/#usage-limits)。这些数值表示订阅额度消耗，实际现金收费保持未知。

[机器审计](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_TEST_ACCEPTANCE_STAGE_AUDIT_2026-10-08.json) · [中止批次](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_DIAGNOSTIC_RECOVERY_ABORTED_2026-10-08.json) · [运行时回归](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_TEST_ACCEPTANCE_FULL_RUNTIME_2026-10-08.log)

完整对照、Jev开关效应、真实升级、实际费用与人工收益仍待验证，目标保持active。
