# dda 项目介绍视频 · 制作说明

本目录交付一个 60–90 秒中文项目介绍片，主题为 **dda —— 可审计、可控制、本地优先的 AI Agent 工作台**。

## 交付物

| 文件 | 说明 |
| --- | --- |
| `dda-project-intro-video.mp4` | **成片**：87 秒、1280×720、H.264。通用播放器可直接打开，推荐用于交付与分享。 |
| `dda-project-intro-video.webm` | **成片**：87 秒、1280×720、VP9。内容与 mp4 相同，体积更小，适合网页嵌入（MediaRecorder 不写 duration 元数据，个别播放器进度条可能显示“未知时长”，交付以 mp4 为准）。 |
| `dda-project-intro-video.html` | 分镜源（母版）：自包含可播放演示，单文件、无外部依赖、16:9 横屏、7 个分镜、逐字字幕动画、播放/暂停/进度/跳幕控制。浏览器打开即自动播放。 |
| `dda-project-intro-video.render.json` | 渲染实测记录：浏览器路径、编码格式、抓帧数、实测时长、分辨率与字节数。 |
| `dda-project-intro-video.verify.json` | 成片校验记录：文件摘要、容器结构、解码播放/seek、逐秒与 4fps 取样像素统计。 |

## 如何播放

直接双击用现代浏览器（Edge / Chrome）打开 `dda-project-intro-video.html`：

- **空格**：播放 / 暂停
- **← / →**：上一幕 / 下一幕
- **点击底部圆点**：跳到指定分镜
- **点击进度条**：跳转到任意时间点
- 播放到结尾自动停止，点 ⟲ 从头重播

## 视频规格

- 时长：**87 秒**（7 幕，9+11+13+16+16+12+10）
- 画幅：**16:9 横屏**，舞台随窗口自适应
- 语言：中文旁白字幕；无外部音频依赖
- 视觉：深色科技风，青/紫渐变主色，卡片入场动画，支持 `prefers-reduced-motion`

## 完整旁白稿

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

## 分镜表

| 幕 | 时长 | 画面 | 字幕/要点 |
| --- | --- | --- | --- |
| 1 开场 | 9s | 巨大 dda Logo + 三平台标签 | 品牌与定位标语：可审计 · 可控制 · 本地优先 |
| 2 痛点 | 11s | 三张并列卡片（黑箱/失控/难追溯） | 为什么需要 dda |
| 3 定位 | 13s | 左侧三条要点 + 右侧三端汇聚到共享契约的架构图 | 本地优先架构与多平台契约 |
| 4 产品 | 16s | 桌面工作台 UI 线框：左侧六页导航、中间时间线与审批卡、右侧 Context 面板 | 六个页面，一目了然 |
| 5 安全 | 16s | READ_ONLY→ActionIntent→PolicyLease→Approval→Verifier 流程 + Jev 决策要素 | 受控执行与可审计决策轨迹 |
| 6 技术 | 12s | 技术栈标签云 | Tauri 2 / TypeScript / Rust / Node·Cordis / 多协议 / JSON Schema |
| 7 结尾 | 10s | 四个上手步骤 + 行动号召 | 开始使用 dda + 品牌金句 |

## 素材来源

所有画面均由 HTML/CSS 矢量绘制，无外部图片、字体或网络请求，避免版权与离线播放问题。文案事实来自工作区内只读资料：

- `README.md`：产品名称、定位、多平台、安全边界、构建与运行方式
- `desktop/README.md`：核心功能、runtime、模型配置、审批与流程
- `contracts/README.md`：契约目录与 JSON Schema 事实源
- `docs/UI_UX_SPEC.md`：信息架构、六页导航、Approval Card、Decision Trace、Safety 展示
- `docs/WINDOWS_PHASE3_EXPERIENCE_REPORT.md`：六个已落地页面与界面元素

## 重新渲染成片

渲染脚本复用系统已安装的 Chrome / Edge：把 `.stage-wrap` 舞台逐帧抓取到 1280×720 canvas，再用
`canvas.captureStream()` + `MediaRecorder` 直接编码下载。因此本机**不需要 ffmpeg**，也不需要下载
Playwright 自带的浏览器二进制。

在仓库根目录执行：

```powershell
node docs/render-project-intro-video.mjs
```

- 前置条件：Node 18+，以及 `desktop/node_modules` 里的 `playwright-core`（`npm install` 已包含）。
- 浏览器默认按 Chrome → Edge 顺序探测；也可显式指定：
  `node docs/render-project-intro-video.mjs --chrome "C:\Program Files\Google\Chrome\Application\chrome.exe"`
- 一次运行约 90–100 秒，同时产出 `.webm`（VP9）与 `.mp4`（H.264），并把实测结果写入
  `dda-project-intro-video.render.json`。
- 修改文案或分镜后，只需编辑 `dda-project-intro-video.html` 再重跑该命令；若脚本以
  `endedBy != playback-complete` 退出（看门狗中断），产物不可用，需重跑。

## 成片校验结果（只读实测）

校验脚本不修改成片，只用 Chrome headless 解码、seek 与取样统计；明细见 `dda-project-intro-video.verify.json`。

- **时长与分辨率**：`mp4` 解码时长 87.06 秒、1280×720、`readyState=4`；`webm` 同样 1280×720，但 `video.duration` 为 `null`（容器无 Duration 元素）。
- **可定位性**：两个成片在 5 / 30 / 60 / 84 秒处 seek 全部命中（`currentTime` 精确落点），无解码错误。
- **画面结构**：以 1 秒粒度取样 88 帧，检出 7 个切点（1/10/21/34/50/66/78 秒），与分镜边界 9/20/33/49/65/77 秒一致；亮度均值 10.4–29.8，仅 0 秒处为暗场起步，无黑屏段。
- **字幕与入场动画**：10–19.5 秒区间以 4fps 取样，字幕带亮像素占比从 0.37% 单调升到 4.63% 并在 17.25 秒饱和，证明逐字推进；9–11 秒卡片入场在约 2 秒内收敛为静帧。
- **母版自包含**：`dda-project-intro-video.html` 加载时外部请求 0 个、页面错误 0 个，页内 7 个分镜、声明总长 `01:27`，与成片一致。
- **音轨**：`mp4` 中不存在 `mp4a` box 与 `soun` handler，`webm` 中不存在 `A_OPUS`/`OpusHead`，两个成片均为纯视频轨（与上文“未合成语音”一致）。
- **帧率**：`render.json` 抓到 711 帧 / 87 秒，实测解码更新率 7.3–8 fps；字幕逐字推进可辨，但快速运镜会偏卡。

## 已知限制与后续优化建议

- 旁白以**逐字字幕**呈现，未合成语音；如需配音，可导出脚本用 TTS 生成音轨后与画面合成。
- `.webm` 由浏览器 `MediaRecorder` 直接产出，容器里没有 duration 元数据：Chrome 实测 `video.duration` 为 `null`（`.mp4` 为 87.06 秒），画面可正常解码与拖动，但部分播放器会显示不确定时长。需要严格时长显示时使用 `.mp4`。
- 分镜 4 为工作台 UI 的矢量线框示意，非真实录屏；如需真实界面，可运行桌面端后录制替换该幕。
- `.mp4` 为 fragmented MP4，`mvhd` 的 `duration` 写的是 0：Chrome 能靠 `moof` 分片解出 87.06 秒并可任意 seek，但只读 `mvhd` 的工具会报 0 时长；需要严格元数据时用 `ffmpeg -i in.mp4 -c copy out.mp4` 重写索引。
- 抓帧率受逐帧截图与 JPEG 转码限制（约 8fps）。若需要 30fps 成片，应改为在页面内按 `requestAnimationFrame` 直接绘制到 canvas 并延长录制时长，而不是提高截图频率。
- 音乐/音效未内置，可在导出阶段叠加低强度科技氛围背景音乐（注意音量低于人声）。
