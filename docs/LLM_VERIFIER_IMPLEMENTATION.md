# 连续概率 LLM Verifier（已废弃）

> 本文是历史实现记录，不再描述当前运行时架构。2026-09-22 起，候选选择和行为/结果判断统一迁移到 Jev Decision Plane；当前设计见 [JEV_DECISION_PLANE_DESIGN.md](./JEV_DECISION_PLANE_DESIGN.md)。`continuous-verifier.mjs`、旧语义 verifier turn 和旧候选 judge 不再由主运行链调用。

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

失败及取消调用现已记录独立出域完成事实和延迟，预先取消不记作已调用；成功分布样本仍单独记录。候选全失败和 judge 失败的真实 HTTP runtime fixture 回归通过。最新全量并行回归 `total=5 passed=5 failed=0`（runtime 528 项，527 通过、1 既有跳过），见 `../phase2-parallel-validation-3.log`。

配置化验证预算与准则已接线：`model.verifier` 受 `criteria/repetitions/maxComparisons/pivots/seed/maxPromptChars` 白名单约束，未知字段和越界值按 `MODEL_CONFIG_UNKNOWN_FIELD` / `MODEL_CONFIG_INVALID_FIELD` 拒绝；judge 调用真实应用该配置，`CandidateVerificationCompleted.config` 记录实际生效值。真实 runtime fixture 新增 `configured` 场景断言评测调用数为 `3 × criteria × repetitions`。

分布证据已接入读模型与 UI：`PROJECTION_VERSION` 9 的候选验证样本投影携带 `leftDistribution`/`rightDistribution`，只保留 A–T token 与 [0,1] 内的 probability/value，越界或非数字字段一律丢弃，prompt/输出/推理文本无法通过该通道；桌面端在连续验证分区旁显示有界百分比分布，契约 `harness-read-model.schema.json` 同步补齐定义。

过程轨迹连续验证与状态映射已接线：semantic verifier 角色不再返回模型自述的 `status`/`progress`/小数，而是先输出 `{"summary","evidenceRefs","failureCodes"}`，再输出恰好一个 `<score> LETTER </score>` 评分标签。运行时以 `logprobs: true` 调用 provider，把 `score-logprobs` 位置交给 `extractProcessScore` 得到 A–T 期望，`mapContinuousScoreToVerdict` 按 `passThreshold=0.9` / `failThreshold=0.5` 映射为 PASS / FAIL / ABSTAIN：`score ≥ 0.9` 记 PASS，`score ≤ 0.5` 记 FAIL 并附 `PROCESS_VERIFICATION_REJECTED`，中间区间记 ABSTAIN 并附 `PROCESS_VERIFICATION_UNCERTAIN`。缺失 logprobs 或评分位置不明时返回 ABSTAIN，reason `SEMANTIC_VERIFIER_LOGPROBS_UNAVAILABLE`、source `LOGPROBS_MISSING`，绝不回退到模型自述的字母或数字；成功时 source 为 `TOKEN_LOGPROB_EXPECTATION`。事件与任务结果携带 host 派生的 `score`/`variance`/`distribution`/`method`/`thresholds`，`SemanticVerificationCompleted` 与读模型 `verifier` 投影只保留有界 token 证据。真实 CLI fixture（`plan-step-runtime`、`candidate-fanout-runtime`）断言 logprobs 请求、期望分数、分布 token、FAIL/ABSTAIN 映射，以及仅返回文本时回退为 ABSTAIN。

操作员配置入口已跨层打通（2026-09-11）：运行时 `runtime/src/model-config.mjs` 早前已支持 `model.verifier` 段，但桌面端此前既没有表单也没有持久化通道，操作员只能手工编辑 `%LOCALAPPDATA%\hmCodex\model-config.json`。现在补齐三段：

- 桌面表单：设置弹窗新增「连续验证（LLM as a Verifier）」分组，可编辑判定标准（每行一条，最多 8 条、每条 ≤1000 字符）、重复次数、最大比较数、支点数、提示长度上限、随机种子以及 PASS/FAIL 阈值；留空即省略该字段并由运行时套用默认值（重复 2、比较 32、支点 2、上限 60000 字符、PASS 0.9 / FAIL 0.5）。
- 客户端校验：`desktop/src/domain/verifier-config.ts` 逐条镜像 `normalizeContinuousVerifierConfig` 的边界，并在 PASS ≤ FAIL 时按运行时“先归一化省略侧再比较”的语义拒绝反转配置（即使只填了一侧）。越界值在写盘前就被拒绝，避免把运行时无法加载的配置写进文件。
- 持久化：`ModelConfig` 增加可选的 `verifier` 值对象并按原样双向透传，`persist_model_config` 白名单加入 `verifier`；未配置时整体省略该键，清空全部项会从已有配置文件中删除该段，而已有角色绑定等其他高级字段保持不变。

证据：`cd desktop && node ./node_modules/vitest/vitest.mjs run --configLoader native --dir src --exclude "scripts/**/*.test.mjs"` 6 文件 41/41 通过（含新增 `src/domain/verifier-config.test.ts` 7 项）；`cd desktop/src-tauri && cargo test` 24/24 通过（含新增 `model_config_save_round_trips_verifier_section` 与扩展的字段名/保留既有测试）；`node ./node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` 通过；`node ./scripts/build.mjs` 通过。

待完成：真实 provider 能力验证、provider 实际用量与计费、实际安装包验收。其他 Council proposal/semantic verifier 的既有输出不自动视为本方法。
