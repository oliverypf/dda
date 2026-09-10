# 连续概率 LLM Verifier

2026-09-10 用户明确要求实现 Stanford LLM-as-a-Verifier，不使用整数 judge。此要求适用于阶段二的候选选择和过程验证；模型直接生成的小数同样不构成连续概率验证。

参考：[官方项目](https://llm-as-a-verifier.com/)、[论文](https://arxiv.org/abs/2607.05391)、[官方实现](https://github.com/llm-as-a-verifier/llm-as-a-verifier)。

实施约束：

- 评分必须来自 provider 返回的评分位置 token logprobs；使用 A–T 有序量表，A 对应最高值。对有效评分 token 的概率归一化后求期望并映射到 [0,1]。
- 不解析文本整数、小数或单个字母作为备用分数。缺失 logprobs、评分位置不明或分布无有效质量时返回不可验证，保留明确原因。
- 按 Specification、Output、Errors 等独立准则执行重复验证，奇数次交换 A/B 位置；先按准则和次数聚合连续期望，再计算偏好。
- 候选选择实现可复现的 ring pass、pivot 选择和 pivot 比较；预算、随机种子、准则版本、重复次数和分布证据须可审计。
- 过程验证基于真实执行轨迹、工具证据和确定性结果，不能以候选草稿评价冒充执行成功。连续信号不能覆盖硬失败或批准副作用。
- provider、事件、成本、UI 和过程验证必须全部接线，不能只交付数学工具后宣称完成。

状态：实现中。候选选择的 JSON judge 已替换为概率期望、三准则两次重复及 PPT；OpenAI-compatible Responses/Chat Completions 适配器增加按需 logprobs 通道。每个成功评审样本写入 `CandidateVerificationSample`，包含左右候选身份、准则、重复序号、换位、评分分布和 prompt digest，独立记录出域调用；不持久化 reasoning 或原始草稿。

选择决策现在只引用本次尝试产生的 durable 事件，草稿和连续验证样本都进入决策 evidenceRefs；每个样本分别关联其左右候选的 option，避免跨步骤/重试混入旧证据。真实 runtime fixture 验证 2 个草稿、18 个样本进入决策，共 20 个引用，每个候选包含自身草稿和相关样本共 19 个引用（`phase2-evidence-validation.log`）。

已验证：连续模块 7/7；runtime 真实 HTTP fixture 端到端通过，覆盖 18 次 logprobs 调用、独立身份、无工具、连续选择及逐次样本/出域记录。fixture 不构成真实模型或发布验收证据。

失败及取消调用现已记录独立出域完成事实和延迟，预先取消不记作已调用；成功分布样本仍单独记录。候选全失败和 judge 失败的真实 HTTP runtime fixture 回归通过。最新全量并行回归 4/4 通过（runtime 502 项，501 通过、1 既有跳过），见 `../phase2-failed-egress-validation.log`。

待完成：真实 provider 能力验证、provider 实际用量与计费、配置化验证预算和准则、分布证据接入 Decision DAG/UI、过程轨迹连续验证与状态映射、实际安装包验收。其他 Council proposal/semantic verifier 的既有输出不自动视为本方法。
