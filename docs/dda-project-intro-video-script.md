# dda 项目介绍视频 · 分镜脚本

- 形式：**C · 纯动画 / 图文混剪**（全部画面由 HTML/CSS 矢量绘制，无实拍、无界面录屏、无外部素材）
- 目标时长：**87 秒**（7 幕，9+11+13+16+16+12+10）
- 画幅：16:9 横屏，交付分辨率 **1280×720**
- 语言与配音设定：**中文逐字字幕，不合成人声**（成片为纯视频轨，播放器静音播放可读）
- 视觉基调：深色科技风（背景 `#070b16`），青 `#38bdf8` / 紫 `#a78bfa` / 绿 `#34d399` 为强调色，卡片入场统一走 `translateY(18px) → 0` + 淡入（0.6s），支持 `prefers-reduced-motion`
- 母版与成片：分镜落地到 `docs/artifacts/dda-project-intro-video.html`（自包含单文件母版），由 `docs/render-project-intro-video.mjs` 抓帧编码为 mp4/webm

## 1. 分镜表

| 幕 | 时间码 | 时长 | 画面要点 | 动画 / 转场 | 字幕（逐字推进） |
| --- | --- | ---: | --- | --- | --- |
| 1 开场 | 00:00–00:09 | 9s | 中央巨型 `dda` 渐变字标；下方副标「可审计 · 可控制 · 本地优先」；英文标签 `AI AGENT WORKSPACE`；底部三枚平台胶囊：HarmonyOS / Windows / Linux；顶部 kicker `DECISION-DRIVEN AGENT` | 字标缩放淡入，副标与三平台胶囊依次上浮（0s / 0.1s / 0.2s 级联） | 这是 dda —— 一个把智能、安全和可审计性放在同一起点的本地 AI Agent 工作台。 |
| 2 痛点 | 00:09–00:20 | 11s | 三张并列卡片：◈ 黑箱决策 / ⚠ 权限失控 / ⌁ 难以追溯，各带一句解释；标题「为什么需要 dda？」 | 三卡 0.1s 间隔依次上浮入场，入场约 2 秒内收敛为静帧 | 今天的 Agent 常常是黑箱：它在做什么、凭什么做，我们说不清；一旦给了权限，命令、文件和网络就可能失控；出了问题，也没有可追溯的证据链。 |
| 3 定位 | 00:20–00:33 | 13s | 左栏三条要点（本地优先 / 多平台契约 / 数据本地化）；右栏架构示意：HarmonyOS、Windows、Linux 三节点向下汇聚箭头，指向核心块 `contracts/v1 · HarnessReadModel · 本地 Runtime`；标题「一个工作台，三种平台」 | 左右两栏同时淡入；汇聚箭头常亮脉冲 | dda 采用本地优先架构：Windows 桌面客户端驱动一个自研的 Node 与 Cordis 运行时；HarmonyOS、Windows 和 Linux 共用一套版本化协议契约；数据留在你的设备上。 |
| 4 产品 | 00:33–00:49 | 16s | 工作台三栏线框：左导航六项（工作台 / 运行记录 / 工作区 / 记忆 / 能力与安全 / 设置与诊断，首项高亮）；中栏运行条 `运行 #A1F3 · SUCCEEDED` + 时间线四项（用户消息 / Route 选角色 / Approval 待确认 / Rule Verifier PASS）+ Composer；右栏 Context（Route、Safety、Workspace、Verify）；标题「六个页面，一目了然」 | 导航→时间线→Context 自上而下逐段显现；待确认项用琥珀边框、通过项用绿色边框做状态编码（不只靠颜色，配文字） | 从工作台到运行记录，从工作区到记忆、能力与安全，六个页面把 Agent 的每一步都摊开给你看；时间线、审批卡片与可展开证据随任务实时更新。 |
| 5 安全 | 00:49–01:05 | 16s | 上半流程链 `READ_ONLY → ActionIntent → PolicyLease → Approval → Rule Verifier`（末段绿色）；下半 Jev 决策平面卡片（紫色边框），五个胶囊「候选 / 证据 / 选择 / 预期 / 结果」+ 一句边界说明；标题「每一步，都在受控范围」 | 流程链节点按序点亮；Jev 卡片二次上浮入场；末节点常亮表示核验完成 | dda 默认只读。任何副作用都要经过动作意图、一次性策略租约、逐项审批和确定性核验。Jev 决策平面记录候选、证据、选择与预期，可审计，却从不保存隐藏思维链。 |
| 6 技术 | 01:05–01:17 | 12s | 技术标签云三行：Tauri 2 / TypeScript / Rust / Node·Cordis；OpenAI Responses / Chat Completions / 兼容网关 / DeepSeek Harness；contracts/v1 JSON Schema / 本地 SQLite / 环境变量密钥 / 脱敏 Trajectory（前四枚用青色描边突出）；标题「可插拔，可验证」 | 胶囊错峰淡入，整体轻微浮动 | 技术上，它用 Tauri 2 与 TypeScript 构建客户端，模型提供方可以自由切换；关键协议固化为 JSON Schema；API 密钥只从环境变量读取，不写进项目代码。 |
| 7 结尾 | 01:17–01:27 | 10s | 主标题「开始使用 dda」；四步条：① 安装客户端 ② 授权工作区 ③ 配置模型 ④ 开始任务；辅行「README · 阶段四实施计划 · contracts/v1 契约目录」；底部渐变金句「让 Agent 的智能，始终在你的掌控之中。」 | 四步条 0.1s 级联上浮；金句最后 2 秒淡入并保持 | 安装客户端，授权工作区，配置模型，就可以开始。dda —— 让 Agent 的智能，始终在你的掌控之中。 |

## 2. 完整旁白 / 字幕稿

> 这是 dda —— 一个把智能、安全和可审计性放在同一起点的本地 AI Agent 工作台。
>
> 今天的 Agent 常常是黑箱：它在做什么、凭什么做，我们说不清；一旦给了权限，命令、文件和网络就可能失控；出了问题，也没有可追溯的证据链。
>
> dda 采用本地优先架构：Windows 桌面客户端驱动一个自研的 Node 与 Cordis 运行时；HarmonyOS、Windows 和 Linux 共用一套版本化协议契约；数据留在你的设备上。
>
> 从工作台到运行记录，从工作区到记忆、能力与安全，六个页面把 Agent 的每一步都摊开给你看；时间线、审批卡片与可展开证据随任务实时更新。
>
> dda 默认只读。任何副作用都要经过动作意图、一次性策略租约、逐项审批和确定性核验。Jev 决策平面记录候选、证据、选择与预期，可审计，却从不保存隐藏思维链。
>
> 技术上，它用 Tauri 2 与 TypeScript 构建客户端，模型提供方可以自由切换；关键协议固化为 JSON Schema；API 密钥只从环境变量读取，不写进项目代码。
>
> 安装客户端，授权工作区，配置模型，就可以开始。dda —— 让 Agent 的智能，始终在你的掌控之中。

字幕呈现规则：每幕字幕按 `localTime / (时长 × 0.72)` 的比例从 0 逐字增到全文字数（与母版实现一致），即每幕约 72% 处说完、剩余 28% 留给观众读图；不使用弹出式整句替换。

## 3. 制作与验收规格（供后续构建、校验步骤使用）

构建输入：

- 画面源：`docs/artifacts/dda-project-intro-video.html`（单文件、零外部请求）
- 渲染器：`docs/render-project-intro-video.mjs`，复用本机 Chrome/Edge + `desktop/node_modules/playwright-core`，无需 ffmpeg

量化验收阈值：

| 项 | 阈值 |
| --- | --- |
| 时长 | 85–90 秒（设计值 87s，容差 ±2–3s） |
| 分辨率 | 1280×720，16:9 |
| 容器 / 编码 | mp4 = H.264（`avc1` + `avcC`）；webm = VP9（`V_VP9`） |
| 可解码性 | `readyState = 4`，`error = null` |
| seek 抽查 | 至少 4 个点（5 / 30 / 60 / 84 秒）全部命中，偏差 ≤ 0.5s |
| 场景切点 | 检出 7 个切点，与 9 / 20 / 33 / 49 / 65 / 77 秒边界偏差 ≤ 1s |
| 黑屏检查 | 除首帧入场外，1fps 取样亮度均值不低于 10，无整段黑屏 |
| 字幕动画 | 第 2 幕 10–19.5s 内亮度占比单调上升，证明逐字推进而非整句闪现 |
| 音轨 | 本期交付无音轨（纯视频轨），mp4 中不得出现 `mp4a`/`soun` |
| 母版自包含 | 外部请求 0、页面错误 0 |

## 4. 事实来源

文案中的能力陈述取自工作区只读资料，不引入仓库外信息：

- `README.md`、`docs/MULTI_PLATFORM_ARCHITECTURE.md`：产品定位、三平台、本地优先架构
- `desktop/README.md`：核心功能、Node/Cordis runtime、模型配置、审批与受控执行
- `contracts/README.md`：`contracts/v1` 版本化 JSON Schema 与 `HarnessReadModel`
- `docs/UI_UX_SPEC.md`：六个一级页面的信息架构、Approval Card、Decision Trace、Safety 呈现
- `docs/WINDOWS_PHASE3_EXPERIENCE_REPORT.md`：六个页面已升级为真实页面、Route/审批/Verifier 证据接入
- `docs/artifacts/dda-project-intro-video.README.md`、`...verify.json`：既有成片 87 秒、7 幕、无音轨的实测结论
