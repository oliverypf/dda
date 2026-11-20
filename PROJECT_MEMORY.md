# hmCodex (dda) 项目记忆

> 生成：2026-11-20 · BitFun agent · 基于 master = `108b14ac3871`（当日刚完成 129 提交的大更新）
> 用途：供后续 AI 会话 / 开发快速上手。所有事实均引用具体路径，若代码已前进请以仓库为准。
> 本文件未纳入 git 跟踪，可自行决定提交或保留本地。

## 0. 30 秒摘要

`dda` 是**多平台 Agent 工作台**（HarmonyOS ArkTS / Windows Tauri 桌面 / Linux 无头 CLI），核心理念：**不可信的模型不得直接行动**。自研 Node/Cordis 本地 runtime 独占模型调用、任务编排、受控工具、审批、验证与审计；客户端只做展示、请求与确认。治理分两层：确定性硬边界（RuntimeSafetyMonitor、一次性 PolicyLease、Approval、Rule Verifier）+ **有界 Jev Decision Plane**（只在给定候选中做语义选择，永远不能授权/发租约/执行动作）。契约优先：`contracts/v1/` 的 JSON Schema 是各端唯一行为标准。

- 远程：`https://github.com/oliverypf/dda.git`（用户 oliver / oliverypf@qq.com），本地目录名 hmCodex
- **多机工作流**：Windows 机（Cursor + `C:\Users\User\hmCodex-local`）是主开发面；本机（鸿蒙 PC）是副本 + 鸿蒙侧环境；**远端 master 是真相源**，本机更新即拉取
- 阅读入口：根 `README.md` → `docs/LONG_TERM_DESIGN_INDEX.md`（文档权威顺序）→ `docs/AGENT_HARNESS_DESIGN.md` → `docs/JEV_DECISION_PLANE_DESIGN.md` → `docs/SECURITY_MODEL.md`

## 1. 模块地图

| 目录 | 内容 | 关键事实 |
|---|---|---|
| `runtime/` | **产品引擎**，Node ≥24 ESM/.mjs，包名 `@dda/windows-runtime`，依赖 Cordis（`@deepseek-ai/cordis`）、MCP client、playwright | `src/index.mjs` ≈8300 行"单体 CLI 调度器"；子包 `src/decision/`(14)、`kernel/`(14, resident kernel + cell + sandbox)、`platform/`(5)、`plugins/`(8)；`native/kernel-sandbox/` 是 **C/N-API** seccomp 过滤器（仅 linux/x64）。操作手册 `runtime/README.md` |
| `entry/` | HarmonyOS ArkTS 客户端 | bundleName `com.example.hmcodex`，SDK `6.1.1(24)`；**单页** `pages/Index.ets` + `services/CodexSession.ets`（WebSocket JSON-RPC 直连**已取消**的 App Server——迁移期历史实现）；无 HarnessFacade/ReadModel。测试 `entry/src/ohosTest/ets/test/*.test.ets` |
| `desktop/` | **当前主产品面**，Tauri 2 + Vite/TS 前端 | 产物 `dda-desktop.exe`，identifier `com.hmcodex.desktop`；bundle msi+nsis；Rust crate 仅 `src-tauri`（rust-toolchain 锁 windows-msvc）；capabilities 只有 `core:default`；测试 Vitest(14) + scripts(22) + Playwright UI 套件 |
| `linux-cli/` | **最新产品线**：无头 CLI（ADR-0023） | bins `dda`/`hmcodex` → `bin/dda.mjs`；平台自选 linux/windows/harmonyos-cli；审批模式 `prompt/jsonl/deny`；退出码契约 0–10+130；打包 `node linux-cli/scripts/pack.mjs` → 自含 tarball（明确不做 deb/AppImage/ARM64/musl/Node-SEA） |
| `contracts/` | 17 个 JSON Schema v1 + 7 fixtures | action-intent、agent-decision、decision-outcome、dream-run、execution-approval、execution-lease、execution-state、harness-event、harness-read-model、memory-record、plugin-governance-record、role-context、route-resolution、runtime-event、thread-record、trajectory-record、verifier-report。禁存凭据/CoT/provider token |
| `packages/` | `harness-model`（跨平台词汇：versions/exit-codes/event-kinds）；`harness-core`（HarnessFacade 稳定入口，**目前仍是 spawn 单体子进程**） | 无根 package.json、无 npm workspace，跨包用相对路径 |
| `offloop/` | "Harness²" 元工具（Propose→Probe→Compose），**CANDIDATE only**，人工 PR 门禁（ADR-0025，Proposed） | 88 个测试文件，`npm test` 只跑白名单 |
| `gateway/` | 仅 README 的可选远程适配器概念，**无实现** | |
| `docs/` | ~140 个 md；`docs/adr/` **12 个 ADR**（0001–0007、0021–0025；0008–0020 有意不分配；**下一个是 0026**） | 大量 Windows 阶段验收/证据文档在 `docs/artifacts/` |
| `.codex/` | **独立 Python 决策 agent**（decision_agent/ + hooks/），读本地 `jev.config.json` | ⚠️ 根目录存在真实 `jev.config.json`（gitignored，可能含 key）——**不要读取或记录其内容**；模板见 `jev.config.example.json` |

## 2. 核心概念速查（实现在 runtime/src/）

- **Jev Decision Plane**：`decision/engine.mjs` + `decision/jev-client.mjs`（System One 端点，默认 `https://api.typesafe.ai/v1/systemone`，model `jev-latest`）+ `decision/rules.mjs` 兜底。Node runtime 的 Jev 配置走 `model-config.json` decision 块 + `DDA_JEV_*` 环境变量（与 `.codex/` Python 侧的 jev.config.json 是**两套独立配置**）
- **JEV_EVIDENCE_REQUIRED**：Jev 要求补充证据的失败码，`task-recovery-controller.mjs:15`，属 AGENT_MISS_TRIGGER_CODES
- **DGU / DGR**：确定性-green 晋升双路径——DGU = green+Jev UNCERTAIN（`task-recovery-controller.mjs:429-511`），DGR = green+Jev BEHAVIOR REJECTED（`:513-524`）。⚠️ 歧义：offloop 里 DGR = decision-grade record
- **Trust(X)**：六维 A,S,C,O,R,E（Actor/Skill/Context/Object/Risk/Evidence）软收紧评分 `trust-x.mjs`；Bayesian 行为后验深化 `trust-deepen.mjs`
- **Risk Vector 十维**：I,P,B,V,D,A,X,N,F,T `risk-vector.mjs`；读后外泄信号 TRAJECTORY_READ_THEN_EGRESS
- **SafetyState 阶梯**：ALLOW→MONITOR→CONFIRM→SANDBOX→DENY→QUARANTINE（rank 0–5），带滞回慢恢复 `safety-state.mjs`；安全增量小刀 S1–S6 = profile-gate/incident/state/spectrum-gate/policy/evolution-cohort
- **Approval / 一次性 PolicyLease**：`runtime-safety-monitor.mjs` + `contracts/v1/execution-{approval,lease}.schema.json`（lease: PROPOSED→ACTIVE→CONSUMING→CONSUMED）；审批 TTL 15 分钟
- **Dream runs**：`dream-scheduler.mjs` 六阶段 ORIENT/GATHER/CONSOLIDATE/VERIFY/REVIEW/PRUNE；supervisor `dream-maintenance-supervisor.mjs`；只收 PROPOSED memory，fail-closed
- **Memory Journal**：`memory-journal.mjs`（schema 1.0，≤4096 条，sensitivities 四级）；**无来源事件的提案永不 ACTIVE**
- **Read Model**：`read-model-rebuilder.mjs`（PROJECTION_VERSION=10，19 个 run 状态）——Windows UI 的实际消费面
- **Plugin governance**：`plugin-governance.mjs` 十状态显式迁移图
- **Trajectory**：`trajectory-store.mjs` 追加式 JSONL（64KiB/事件，16MiB 上限），脱敏轮转

## 3. 构建 / 测试命令

```sh
# HarmonyOS (需要 DevEco 的 hvigorw,仓库未提交 wrapper)
hvigorw assembleHap --no-daemon --no-incremental
hvigorw test -p module=entry --no-daemon

# ★ 本机(鸿蒙PC)已验证可用的构建命令(2026-11-20):
PATH=/data/service/hnp/bin:$PATH \
  ~/deveco-linux/tools/node/bin/node ~/deveco-linux/tools/hvigor/bin/hvigorw.js \
  assembleHap -p product=default -p buildMode=debug --analyze=normal --parallel --incremental
# 产物: entry/build/default/outputs/default/entry-default-unsigned.hap (SignHap 跳过,无签名配置)
```

**★ 本机构建的关键坑（2026-11-20 实战验证）**：
1. `node_modules/@ohos/{hvigor,hvigor-ohos-plugin}` 必须是**指向 CLT 的符号链接**（`/data/service/hnp/hmos-clt.org/hmos-clt_1.0.0/hvigor/{hvigor,hvigor-ohos-plugin}`），**绝不能是拷贝**——拷贝会导致 hvigorCore 出现两个单例，报 `00302013 root node is not yet available`（项目只注册进了 CLI 那个单例，插件用的是另一个空壳）
2. `hvigor-config.json5` 与根 `oh-package.json5` 的 `modelVersion` 必须**一致且为 26.0.0**（本机 CLT hvigor 7.26.11 + API 26 SDK 的要求；远端 master 的 6.1.0 是给 Windows DevEco 6.1 的——**这两处是本机本地适配改动，git 可见**）
3. `~/deveco-linux/tools/hvigor/bin/hvigorw.js` 是前人写的 stub：桥接到 CLT hvigor 7.26.11、自动设 `DEVECO_SDK_HOME`（CLT SDK API 26.0.0.105）、自动加 `--no-daemon`；用 `~/deveco-linux/tools/node/bin/node`（v26.8.1，沙箱内可正常跑脚本，不需要 jitless）
4. `~/node_modules/@ohos/hvigor.bak-6236` 是前人的改名隔离（防旧 6.23.6 劫持解析），**别还原**
5. `NODE_OPTIONS=--jitless` 只在用 hnp node 24 跑脚本时需要；hvigor 构建链不需要

# runtime
cd runtime && npm install && npm test        # node --test --test-concurrency=6, 189 个测试

# desktop (Windows 主面)
cd desktop && npm install && npm run dev     # 127.0.0.1:1420
npm run build:windows                        # tauri build --target x86_64-pc-windows-msvc
npm run test:all:parallel                    # 统一并行入口; UI 套件必须后置顺序跑

# linux-cli
node linux-cli/bin/dda.mjs --version
node --test linux-cli/test/*.test.mjs runtime/test/platform.test.mjs
node linux-cli/scripts/pack.mjs              # 先 (cd runtime && npm install)
```

约定：分支 `cursor/<slug>-<4hex>`（另一台机器 Cursor）、`feat/`、`fix/`、`harness/<freeze-slug>-r1`；提交 = conventional + PR 引用（如 `fix(runtime): ... (#101)`）；代码内 `freeze-*-r1` 标记实现批次；环境变量只认 `DDA_*`（`HMCODEX_*` 已废弃），但数据目录 `%LOCALAPPDATA%\hmCodex`/`hmcodex.db`/bundle id 保留兼容名。

## 4. 本机（鸿蒙 PC）环境关键事实 ★ 后续会话必读

**OS**：HarmonyOS PC，arm64 musl；OHOS 链接器命名空间（`/etc/ld-musl-namespace-aarch64.ini`）。

**Harmonybrew 全部动态二进制是坏的**（git/curl/node…）：二进制 DT_RUNPATH 为空、`LD_LIBRARY_PATH` 被系统策略无视（设置了反而让进程崩）；静态二进制（fd、bunzip2）正常。`brew shellenv` 输出为空。**修复**：`~/fix-git.sh`（用户在自己的终端跑一次 → `~/git-fixed/`，注入 RUNPATH；未跑之前用户终端 git 也不可用）。

**BitFun 沙箱硬限制**（都是实测）：
- 沙箱自建 ELF **一律不能执行**（EPERM，MAC 按创建域打标签）；只有用户终端域创建/克隆的可执行文件能跑
- `/tmp` 是**每次调用独立的 tmpfs**——跨命令的临时数据必须放项目目录
- 沙箱内 node `-e`/脚本全崩（V8 fatal）；hnp python 完全可用
- `/data/service/hnp/bin/python3`（3.12，pip ✓，certifi ✓）是唯一可靠脚本引擎；`~/.npm-global/bin/devecocli` 存在但依赖 node → 沙箱内不可用；hnp 目录还有 npm/npx/python3.12
- 项目目录与 `.git` 属 BitFun 会话域 → 沙箱可读写；`/storage/Users/currentUser/.harmonybrew/Cellar` 只读+可执行+不可改

**本机 git 操作的正确姿势**（brew git 修复前/沙箱内）：
```sh
PY=/data/service/hnp/bin/python3
$PY -c "
import sys; sys.path.insert(0,'<项目>/.tmp_tools/dulwich-1.2.21')  # 纯 Python git
from dulwich import porcelain, repo
r = repo.Repo('<项目>')
porcelain.fetch(r,'origin')                       # .git/config 已配 http.sslCAInfo=certifi
porcelain.reset(r,'hard',treeish=r.refs[b'refs/remotes/origin/master'])
"
```
⚠️ dulwich reset hard 有**漏写 bug**（实测漏了 65 个文件）——reset 后必须逐文件对比树 blob 补写，脚本模板见 `.tmp_tools/dw_fix_mismatch.py`、更新全流程见 `.tmp_tools/dw_update.py`。
网络：GitHub 可直连（TLS 用 certifi 验证 OK）；`~/.zshrc` 有代理 `http://172.16.100.2:10808`（python urllib 会用它，urllib3/dulwich 不用也能通）。

## 5. 历史操作记录

- **2026-11-20 更新代码**：master `4debcee5a8a5` → `108b14ac3871`（129 提交：harness 系列修复 #44-#101、LINUX CLI 栈合并、Trust/Risk/Safety 体系、Windows 支持、审批到期续行）。工作树 1906 文件与远端**字节级一致**，status 干净。
- 更新前的 31 个本地未提交草稿（LINUX_CLI 文档旧版、desktop 测试脚本）**已备份**：`.tmp_tools/pre-update-backup/`（35 文件 + MANIFEST.txt + unified-diff）；旧 master 存于 `.git/ORIG_HEAD`
- `.tmp_tools/` 里还有：dulwich-1.2.21（保留！git 工具）、`dw_*.py` 操作脚本、`analyze.out`（129 提交清单）、`elf_emit_patched.py`（RUNPATH 注入器）；用户侧 `~/git-tools/elf_emit_patched.py` + `~/fix-git.sh`

## 6. 给后续会话的行动清单

1. 先 `Read PROJECT_MEMORY.md`（本文件），再读根 `README.md` 确认产品叙述有无更新
2. git 操作优先用 dulwich（见 §4），别浪费时间在坏的 brew git 上；用户终端若已跑过 `~/fix-git.sh`，真 git 在 `~/git-fixed/bin/git`（`GIT_EXEC_PATH=~/git-fixed/libexec/git-core`）
3. 构建 HarmonyOS 端需要 DevEco 工具链：沙箱内 devecocli 不可用（node 崩），需要时先让用户在自己终端跑，或想办法绕开 node
4. 大改动前 fetch 远端——另一台机器（Cursor/Windows）随时可能推进 master
5. ⚠️ 永远不要读取/提交 `jev.config.json`、`local.properties`、`model-config.json` 类本地敏感配置
