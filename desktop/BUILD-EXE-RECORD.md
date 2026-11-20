# dda-desktop.exe 编译构建记录 (BUILD-EXE-RECORD)

任务：编译 exe。本文记录可复现的构建命令、工具链与产物路径；结果以实际构建输出为准。

## 项目与目标

- 项目：dda（本仓库 `desktop/` 为 Tauri 2 桌面客户端，`runtime/` 为随包 Node/Cordis 运行时）
- 入口/清单：`desktop/src-tauri/Cargo.toml`（Rust 主程序）、`desktop/package.json`（前端与脚本）、`desktop/src-tauri/tauri.conf.json`
- 产物：`dda-desktop.exe`（productName `dda`，mainBinaryName `dda-desktop`，version 0.1.0）
- 目标平台/位数：Windows x64（`x86_64-pc-windows-msvc`）
  - `rust-toolchain.toml` 固定 `stable-x86_64-pc-windows-msvc`
  - `.cargo/config.toml` 固定 MSVC 链接器绝对路径（VS 18 BuildTools，HostX64\x64\link.exe），因此不依赖 VS Developer Shell 环境变量

## 构建命令（在 `desktop/` 目录执行）

```powershell
npm install                      # 前端/CLI 依赖（首次）
npm run runtime:install          # 随包 runtime 依赖（首次，缺失 runtime/node_modules 时）
npm run build:windows:full-local # 完整本地构建：Tauri CLI build --target x86_64-pc-windows-msvc（release + bundle）
```

- `build:windows:full-local`（`desktop/scripts/build-full-local.mjs`）：设置 `DDA_BUILD_RELEASE_CHANNEL=WINDOWS_FULL_LOCAL`，成功后 `stage-desktop-build.mjs` 输出可运行目录并打印 `staged runnable desktop: <path>`。
- `npm run build:exe`：仅生成 release exe（`tauri build --no-bundle`，经 VsDevCmd 初始化）。
- `npm run build:windows:full-local:fast`：`--debug --no-bundle` 快速变体，产物为 debug exe。

## 依赖版本（desktop/package.json）

- @tauri-apps/cli ^2.11.4、@tauri-apps/api ^2.11.1
- typescript ^7.0.2、vite ^8.2.2、vitest ^4.1.11
- 运行时要求 Node.js 22+（Cordis runtime 以 Node 子进程运行）

## 产物路径

- 主程序 exe：`desktop/src-tauri/target[-b199|-x64]/x86_64-pc-windows-msvc/release/dda-desktop.exe`
- 安装包（若 bundle 目标启用）：同级 `release/bundle/nsis|wix/`
- staged 可运行目录：由 `stage-desktop-build.mjs` 在构建成功后打印

## 状态

- 2026-10 会话检查：`target-b199`、`target-x64` 仅存在 debug 构建目录，尚未发现 release exe；本记录创建后执行完整构建并回填产物校验结果。

## 2026-11-13 构建结果（已验证）

- 命令：在 `desktop/` 执行 `npm run build:exe`（VsDevCmd `-arch=x64` → `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时约 8 分 50 秒。
- 前置修复：首次执行报 `Cannot find module '@tauri-apps/cli-win32-x64-msvc'`，原因是 `node_modules/@tauri-apps/` 只装了 arm64 原生绑定。执行 `npm install --no-save --no-audit --no-fund --include=optional @tauri-apps/cli-win32-x64-msvc@2.11.4` 补齐后，`node node_modules/@tauri-apps/cli/tauri.js --version` 返回 `tauri-cli 2.11.4`。`desktop/package.json` 与 `desktop/package-lock.json` 未改动。
- 产物：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 大小 11,656,192 字节（约 12 MB），生成时间 2026-11-13 16:49:31
  - PE Machine `0x8664`（x64），ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `062581d0a28b191810046fb79d54ee0581c84d2d91a2ad0f2cf90bc04b943f22`
- 前端产物同步重建：`desktop/dist/assets/`（`index-CGht79Cf.js`、`index-BkdVLwRU.css`）。
- Rust 编译仅有 2 条警告：`runtime_process_is_active` 未使用（dead_code）以及链接器 stdout 非 UTF-8，均不影响构建。
- 注意：`--no-bundle` 只生成裸 exe，不含 `tauri.conf.json` 中声明的 runtime / harness-model 资源。需要带资源、可直接运行的目录时用 `npm run build:windows:full-local`，或 `node scripts/stage-desktop-build.mjs --profile=release`。

## 第二次编译（增量）

- 触发：`desktop/src/main.ts` 在首次构建后有改动；在 `desktop/` 再次执行 `npm run build:exe`，退出码 0。
- 前端 chunk 由 `index-CGht79Cf.js` 变为 `index-_WCzeC9w.js`（415.77 kB），`dist/index.html` 已指向新 chunk；exe 二进制中可检索到 `index-_WCzeC9w.js`，旧 chunk 名已消失，确认新前端已嵌入。
- Rust 侧增量编译 `Finished release profile in 6m 44s`，仍只有原先那 2 条警告（dead_code、链接器 stdout 非 UTF-8）。
- 产物：11,656,704 字节，生成时间 2026-11-14 10:05:53，SHA-256 `b32dfb27241ccbfa449592bb3d89abeae57ab26021490da02a240636b7c63167`。
- 本次构建进程曾被长时间挂起（前端产物与最终链接之间间隔较大），但产物时序与内嵌资源校验均正常。最新值见下一节。

## 第三次编译（当前最新产物）

- 触发：11:19–11:45 之间共 8 个源码文件有改动（`desktop/src/domain/computer-access.ts`、`desktop/src/main.ts` 及 `runtime/src/` 下 6 个文件），此前 exe 不含这些改动；在 `desktop/` 再次执行 `npm run build:exe`，退出码 0，总耗时 6m38s。
- 前端 chunk 由 `index-CnRVQO0a.js` 变为 `index-Bw3BeD9Z.js`（417.63 kB），`dist/index.html` 已指向新 chunk；exe 中可检索到新 chunk 名，上一版 chunk 名已消失。
- Rust 增量编译 `Finished release profile in 5m 23s`，仍只有原先 2 条警告。
- **当前 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 大小 11,658,240 字节，生成时间 2026-11-14 11:55:34
  - PE Machine `0x8664`（x64），ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `c0d73327420d24adad91b9c8b9609a358946dd5f09698e63c22693d320735ec3`
- 备注：11:10/11:14 另有本会话之外触发的一次构建（chunk `index-CnRVQO0a.js`，exe SHA-256 `44cb5022ad1020e598aa74a6c3f82bee32df8cff7893b02f7b3639218381d019`），本次已覆盖。

## 2026-11-14 再次编译（增量，当前最新产物）

- 命令：在 `desktop/` 执行 `npm run build:exe`，退出码 0；`Finished release profile [optimized] target(s) in 4m 05s`。
- 前置检查：`node v24.19.0`、`npm 11.17.0`、`cargo 1.98.0`、`tauri-cli 2.11.4`；`node_modules/@tauri-apps/cli-win32-x64-msvc` 已存在，无需补装原生绑定。
- 前端重建：`dist/assets/index-CnRVQO0a.js`（416.70 kB）、`dist/assets/index-BkdVLwRU.css`；`dist/index.html` 已指向新 chunk。
- Rust 侧仍只有原先 2 条警告（`runtime_process_is_active` dead_code、链接器 stdout 非 UTF-8），不影响构建。
- **当前 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 大小 11,657,728 字节，文件时间 2026-11-14T02:42:37Z
  - PE Machine `0x8664`（x64），Subsystem `WINDOWS_GUI`，ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `e9090fe177e7927ee061e27562c3dd2cc2b445051cce2316159ffa888c938776`
  - 内嵌前端校验：exe 内可检索到 `index-CnRVQO0a.js`，旧 chunk `index-_WCzeC9w.js` 已不存在，确认新前端已嵌入。
- 说明：`--no-bundle` 只产出裸 exe，不携带 `tauri.conf.json` 中声明的 runtime / harness-model 资源；需要可直接运行目录时执行 `npm run build:windows:full-local` 或 `node scripts/stage-desktop-build.mjs --profile=release`。

## 只读产物复核（未重新编译）

- 本次仅做证据复核，未执行新的构建：先确认 `desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe` 存在，再做 PE 头与源文件时间戳比对。
  - PE 头：`MZ`/`PE`，Machine `0x8664`（X64），Subsystem `WINDOWS_GUI`，`dll=false`，11,657,728 字节。
  - SHA-256 `e9090fe177e7927ee061e27562c3dd2cc2b445051cce2316159ffa888c938776`，文件时间 2026-11-14T02:42:37Z，与上一节记录一致。
  - 内嵌前端：可检索到 `index-CnRVQO0a.js`（`freshChunkEmbedded=true`），旧 chunk `index-_WCzeC9w.js` 已不存在。
- 源文件新鲜度比对（`desktop/src/main.ts`、`desktop/dist/index.html`、`desktop/src-tauri/src/main.rs`、`desktop/package.json`）：均不晚于 exe 时间（`anySourceNewerThanExe=false`），因此无需重新编译。
- 复核脚本为临时文件 `.codex-tmp/exe-artifact-digest.mjs`（已被 `.gitignore` 忽略），不属于产品代码。
- `desktop/src-tauri/target-b199`、`target-x64` 仍只有 `debug/` 子目录，无 release exe；可运行产物只存在于 `target/` 下。

## 第四次编译（最新产物，2026-11-14 14:48）

> 以下为当前最新产物；上方各节标题中带"当前最新产物"字样的均为历史记录（本文件存在并发写入，历史章节保留原样）。

- 命令：在 `desktop/` 执行 `npm run build:exe`，退出码 0，耗时 4m39s（Rust 增量 3m43s）。前置检查：无 dda-desktop.exe 进程占用，`@tauri-apps/cli-win32-x64-msvc` 绑定仍在。
- 关键情况：11:50 之后只有 3 个 `runtime/src/` 文件改动（`index.mjs`、`plugins/task-runner.mjs`、`task-harness.mjs`，均于 14:40 修改），`desktop/src` 与 Rust 源码未变。前端 chunk 仍为 `index-Bw3BeD9Z.js`（417.63 kB）。**这些 runtime 改动不会进入 `--no-bundle` 的 exe 二进制**——它们是 `tauri.conf.json` 的 bundle resources，属于外部资源。
- exe 哈希仍从 `c0d73327…` 变为 `f97f11da…`，大小不变（11,658,240 字节）；PE TimeDateStamp 是真实链接时间 `0x6AF80435`（2026-11-14 14:48），差异来自重新链接而非源码。
- **当前 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,658,240 字节，生成时间 2026-11-14 14:48:21，PE `0x8664`（x64），ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `f97f11da15a7b8726b546d17dd65c63f9a754b0d55bd04ae6901aee6dd416ecb`
- **含最新 runtime 的可运行目录**：执行 `node scripts/stage-desktop-build.mjs --profile=release` 生成
  - `C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-G0BMc5\dda-desktop.exe`
  - 目录内还含 `openviking-server.exe`、`runtime/src`、`runtime/node_modules`、`packages/harness-model`；上述 3 个改动文件与工作区逐字节 SHA-256 比对均为 MATCH，`latest.json` 已指向该目录。
- 结论：要让 14:40 的 runtime 改动真正生效，用这个 staged 目录运行；单独替换裸 exe 不会带上这些改动。

## 第五次编译（最新产物，2026-11-14 15:17）

- 触发：`desktop/src/main.ts` 于 07:04:54Z 被改动，晚于上一次 exe（06:48:21Z）和上一次前端构建（06:44:43Z），裸 exe 已过期。`git status` 显示 `desktop/src`、`desktop/src-tauri/src/lib.rs` 共 12 个已修改文件与 4 个未跟踪新文件（含 `domain/image-attachments.ts`、`domain/thinking-stream.ts`）。
- 命令：在 `desktop/` 执行 `npm run build:windows -- --no-bundle`（等价 `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时 2m58s；`Finished release profile [optimized] target(s) in 2m 50s`。
- **阻塞点与处理**：首次执行失败于 `error: failed to remove file ...\release\dda-desktop.exe / 拒绝访问。 (os error 5)`——旧的 `dda-desktop.exe` 仍被运行中的实例占用。未终止任何用户进程，而是按本目录既有命名约定把旧二进制改名让位：`dda-desktop.locked-before-20261114-071406.exe`（旧 SHA-256 `f97f11da15a7b8726b546d17dd65c63f9a754b0d55bd04ae6901aee6dd416ecb`，11,658,240 字节，未删除）。改名后重建一次通过。
- 前端重建：`dist/assets/index-BxilQIL6.js`（417.92 kB）、`dist/assets/index-BkdVLwRU.css`（67.06 kB）；`dist/index.html` 已指向新 chunk，旧 chunk `index-Bw3BeD9Z.js` 已被替换。
- Rust 侧仍只有原先 2 条警告（`runtime_process_is_active` dead_code、链接器 stdout 非 UTF-8），不影响构建。
- **当前 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,658,752 字节，文件时间 2026-11-14T07:17:51Z
  - PE `MZ`/`PE`，Machine `0x8664`（X64），Subsystem `WINDOWS_GUI`，`dll=false`，6 个 section
  - SHA-256 `b0986210d9e8c68d3856e34cd55c3e46863a68bccd255636251fd658a99cf25f`
  - 内嵌前端校验：exe 内可检索到 `assets/index-BxilQIL6.js`（`embeddedChunks` 命中），确认本次前端已嵌入。
- 新鲜度比对（`desktop/src/main.ts`、`desktop/src-tauri/src/lib.rs`、`domain/image-attachments.ts`、`domain/thinking-stream.ts`、`dist/index.html`）：全部不晚于 exe，`anySourceNewerThanExe=false`。
- 说明：`--no-bundle` 只产出裸 exe，不携带 `tauri.conf.json` 中声明的 runtime / harness-model 资源；需要可直接运行目录时执行 `npm run build:windows:full-local` 或 `node scripts/stage-desktop-build.mjs --profile=release`。本次未启动 exe（GUI 程序无 `--help`，启动会重新占用产物并弹出窗口），验证以 PE 头、哈希、内嵌 chunk 与源文件时间戳为准。

## 第六次编译（最新产物，2026-11-14 15:27）

- 触发原因：只读复核发现 `desktop/src/main.ts` 的 mtime（2026-11-14T07:22:39Z）晚于第五次产物（07:17:51Z），即上一版裸 exe 已过期（`anySourceNewerThanExe=true`）；`git status --short` 另显示 `desktop/src` 与 `desktop/src-tauri/src/lib.rs` 共 14 个已修改文件、4 个未跟踪新文件（`domain/image-attachments.ts`、`domain/thinking-stream.ts` 及两个测试）。
- 前置检查：`desktop/node_modules/@tauri-apps/cli-win32-x64-msvc` 已就位，无需补装原生绑定。
- 命令：在 `desktop/` 执行 `npm run build:windows -- --no-bundle`（等价 `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时 2m19s；`Finished release profile [optimized] target(s) in 2m 12s`，`Built application at: ...\release\dda-desktop.exe`。
- 前端重建：`dist/assets/index-COxx2nA1.js`（417.02 kB）、`dist/assets/index-C6s_tEFV.css`（66.77 kB）；`dist/index.html` 已指向新 chunk，旧 chunk `index-BxilQIL6.js` 未再出现。
- Rust 侧仍只有原先 2 条警告（`runtime_process_is_active` dead_code、链接器 stdout 非 UTF-8），不影响构建；本次无文件占用错误，未改名或终止任何既有二进制。
- **当前 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,657,728 字节，文件时间 2026-11-14T07:27:39Z
  - PE `MZ`/`PE`，Machine `0x8664`（X64），Subsystem `WINDOWS_GUI`，`dll=false`，6 个 section
  - SHA-256 `c343f5a705b154b90d4bb0ac6fc79e8fa1c61d3cfdae25cdf9d6083b3c364575`
  - 内嵌前端校验：exe 内可检索到 `assets/index-COxx2nA1.js`（`embeddedChunks` 命中）
- 新鲜度比对（`desktop/src/main.ts`、`desktop/src-tauri/src/lib.rs`、`desktop/src-tauri/src/main.rs`、`desktop/dist/index.html`、`domain/thinking-stream.ts`、`domain/image-attachments.ts`）：全部不晚于 exe，`anySourceNewerThanExe=false`。
- 校验脚本：`.codex-tmp/exe-artifact-digest.mjs`（已被 `.gitignore` 忽略，非产品代码）。

## 第七次编译（最新产物，2026-11-14 15:56）

- 触发：按既定构建入口重新执行一次完整本地构建，同时产出可直接运行目录与最新裸 exe。
- 命令：在 `desktop/` 执行 `node scripts/build-full-local.mjs`（内部 `tauri build --target x86_64-pc-windows-msvc`，含 bundle；`beforeBuildCommand` = `npm run build`），退出码 0，耗时 2m52s；`Finished release profile [optimized] target(s) in 2m 52s`，`Built application at: ...\release\dda-desktop.exe`。
- 前置检查：`desktop/node_modules/@tauri-apps/cli-win32-x64-msvc` 已就位，无需补装原生绑定；全程无文件占用错误，未改名或终止任何既有二进制。
- 前端重建：`dist/assets/index-COxx2nA1.js`（417.02 kB）、`dist/assets/index-C6s_tEFV.css`（66.77 kB）；chunk 名与第六次一致（前端源码未变），`dist/index.html` 指向该 chunk。
- Rust 侧仍只有原先 2 条警告（`runtime_process_is_active` dead_code、链接器 stdout 非 UTF-8），不影响构建。
- **当前 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,657,728 字节，文件时间 2026-11-14T07:56:00Z
  - PE `MZ`/`PE`，Machine `0x8664`（X64），Subsystem `WINDOWS_GUI`，`dll=false`，6 个 section
  - SHA-256 `e638c02ce8e167856f886240ab0fc62ba34d1bc5c15b0385977c095717b5608a`
  - 内嵌前端校验：`embeddedChunks` 命中 `assets/index-COxx2nA1.js`
- staged 可运行目录（含 runtime / harness-model 资源）：构建打印 `C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-cWS08W\dda-desktop.exe`；该目录位于 `%LOCALAPPDATA%`，属受保护路径，未能由工具独立复核。
- 新鲜度比对（`desktop/src/main.ts`、`desktop/src-tauri/src/lib.rs`、`desktop/dist/index.html`、`desktop/package.json`）：全部不晚于 exe，`anySourceNewerThanExe=false`。
- 安装包未更新：`bundle/msi/dda_0.1.0_x64_en-US.msi`（SHA-256 `742143a01c6e621812577b916d824968b782d86ca181a45afbd726e73150288a`，2026-10-31T04:01:23Z）与 `bundle/nsis/dda_0.1.0_x64-setup.exe`（SHA-256 `36f5af7ad6d96506de655c81a2290764326276441f6daddfdba36db1acc97227`，2026-10-31T04:02:39Z）仍是本轮之前的产物，本次未产出新安装包。
- 说明：未启动 exe（GUI 程序，启动会重新占用产物并弹出窗口）；验证以 PE 头、SHA-256、内嵌 chunk 与源文件时间戳为准。

## 产物复核（本轮，只读；未重新编译）

- 结论：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe` 存在，且相对于全部前端与 Rust 源文件都未过期，因此本轮不触发重建。
  - PE 头（`workspace.inspect_binary`）：`MZ`/`PE` 有效，Machine `0x8664`（X64），64-bit，Subsystem `WINDOWS_GUI`，`dll=false`，6 个 section，11,657,728 字节。
  - SHA-256 `e638c02ce8e167856f886240ab0fc62ba34d1bc5c15b0385977c095717b5608a`，文件时间 2026-11-14T07:56:00.351Z。
  - 内嵌前端：`desktop/dist/index.html` 当前声明的 chunk 为 `assets/index-COxx2nA1.js`，exe 内可检索到同名 chunk；Vite 的 chunk 名由内容哈希生成，名称命中说明嵌入的是当前前端构建而非旧产物。
- 新鲜度：本轮把校验脚本扩展为整树扫描（`@dir` 参数，内部跳过 `node_modules`/`target`/`target-*`/`dist`/`.git`），不再只抽查几个文件。
  - `desktop/src` 最新 mtime：`desktop/src/styles.css` 2026-11-14T07:22:46.257Z。
  - `desktop/src-tauri/src` 最新 mtime：`desktop/src-tauri/src/lib.rs` 2026-11-13T02:34:32.880Z。
  - 两者均不晚于 exe（`anySourceNewerThanExe=false`）。
- 脚本：`.codex-tmp/exe-artifact-digest.mjs`（被 `.gitignore` 忽略，非产品代码），用法 `node .codex-tmp/exe-artifact-digest.mjs <exe> [file ...] [@dir ...]`。
- 边界说明：`--no-bundle` 的裸 exe 不含 `tauri.conf.json` 声明的 runtime / harness-model 资源；`runtime/src` 的改动属于外部资源，不会进入 exe 二进制。需要连同最新 runtime 一起运行时，用 `npm run build:windows:full-local` 或 `node scripts/stage-desktop-build.mjs --profile=release`（staged 目录位于 `%LOCALAPPDATA%`，本轮未由工具独立复核）。
- 本轮未做：未启动 exe（GUI 应用，启动会占用产物并弹窗）、未重新编译、未修改产品代码。

## 产物复核（verifier recovery 轮次，只读；未重新编译）

- 复查对象：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - PE 头（`workspace.inspect_binary`）：`MZ`/`PE` 有效，Machine `0x8664`（X64），64-bit，Subsystem `WINDOWS_GUI`，`dll=false`，6 个 section，11,657,728 字节。
  - SHA-256 `e638c02ce8e167856f886240ab0fc62ba34d1bc5c15b0385977c095717b5608a`，文件时间 2026-11-14T07:56:00.351Z（与第七次编译记录一致，未出现新的重链接）。
  - 内嵌前端：`desktop/dist/index.html` 当前声明的 chunk 为 `assets/index-COxx2nA1.js`，exe 内检索命中同名 chunk（`embeddedChunks`），说明嵌入的是当前前端构建。
- 新鲜度：整树扫描 `desktop/src`、`desktop/src-tauri/src`、`runtime/src` 与 `desktop/src/main.ts`、`Cargo.toml`、`tauri.conf.json`、`dist/index.html`，全部不晚于 exe，`anySourceNewerThanExe=false`，因此本轮不触发重建。
- 安装包：`bundle/nsis/dda_0.1.0_x64-setup.exe`（6,918,930 字节）与 `dda_0.1.0_arm64-setup.exe` 仍在，属历史产物，本轮未重新打包。
- 冒烟边界：该程序为 `WINDOWS_GUI` 子系统，无 `--help`/`--version` CLI；启动会占用产物并弹出窗口，且执行租约只批准 node/npm/npx/cargo/rustc/git，因此本轮不做启动冒烟，验证依据为 PE 头、SHA-256、内嵌 chunk 与源文件时间戳。

## 最新产物（2026-11-14 22:28 编译，含 21:39 之后的 runtime 改动）

> 本文件存在多个会话并发写入，各节"第 N 次编译"按各自会话编号，互不对齐；判断当前产物以本节为准。

- 前置状态：开始时 exe 为 15:56 版（SHA-256 `e638c02c…`，前端 chunk `index-COxx2nA1.js`）。`desktop/src` 的 6 处改动（15:05–15:22）已被 15:53 的前端构建收录；**21:39–21:41 改动的 4 个 `runtime/src/` 文件才是本次真正的新增内容**（`access-mode-instructions.mjs`、`index.mjs`、`plugins/task-runner.mjs`、`task-context.mjs`），晚于所有既有 exe 与复核时间点。
- 首次执行 `npm run build:exe` 在链接阶段失败：`error: failed to remove file ...\dda-desktop.exe` / `拒绝访问。(os error 5)`。原因是运行中的进程锁定了旧 exe；**该进程名为 `dda_desktop.exe`（下划线）**，用 `Get-Process -Name 'dda-desktop'`（连字符）检查会漏掉。用 `[IO.File]::Open(..., 'None')` 独占打开测试可确认锁定。
- 处理：未终止任何用户进程，按本目录既有 `locked-before-*` 约定把旧 exe 改名为 `dda-desktop.locked-before-20261114-222155.exe`（保留未删除）后重跑，退出码 0，耗时 6m25s（Rust 增量 2m42s）。
- 前端 chunk 仍为 `index-COxx2nA1.js`（417.02 kB，CSS `index-C6s_tEFV.css`），exe 内检索命中；Rust 侧仍是原先 2 条警告。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,657,728 字节，生成时间 2026-11-14 22:28:23，PE `0x8664`（x64），ProductName `dda`，FileVersion `0.1.0`，PE TimeDateStamp `0x6AF87007`
  - SHA-256 `c02e9c9dbb9def52033d1bc9ceb909c7056defe992bbf630082679fdf8cc5911`
- **含最新 runtime 的可运行目录**：`node scripts/stage-desktop-build.mjs --profile=release` →
  - `C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-CBKpOO\dda-desktop.exe`
  - 目录内含 `openviking-server.exe`、`runtime/src`、`runtime/node_modules`、`packages/harness-model`；上述 4 个 runtime 文件与工作区逐字节 SHA-256 比对全部 MATCH，staged exe 与裸 exe 哈希一致，`latest.json` 已更新（此前指向 `…-cWS08W`）。
- 结论：这 4 个 runtime 改动属于 bundle resources，不进裸 exe；要验证它们请运行 staged 目录。此前几节"整树扫描 `anySourceNewerThanExe=false`"的结论在 21:39 之后已不再成立。

## 第八次编译（当前最新产物，2026-11-15 08:50 本地 / 2026-11-15T00:50:48Z）

> 判断当前产物以本节为准。

- 触发：只读校验发现上一版 exe（SHA-256 `936aa301…`，2026-11-15T00:41:21Z）晚于前端构建但**早于** `desktop/src/styles.css`（2026-11-15T00:43:12Z），即样式改动未进入产物（`anyDesktopSourceNewerThanExe=true`）；`runtime/src` 最新 mtime 为 2026-11-14T13:41:16Z，未发生新改动。
- 命令：在 `desktop/` 执行 `npm run build:windows:full-local`（内部 `npm run build` + `tauri build --target x86_64-pc-windows-msvc`，含 bundle），退出码 0，耗时 192.8s；`Finished release profile [optimized] target(s) in 2m 56s`。
- 前端重建：`dist/assets/index-iZJiR_-Y.js`（417.61 kB）、`dist/assets/index-COHUHSZN.css`（67.01 kB）；`dist/index.html` 已指向新 chunk。
- Rust 侧仍只有原有 2 条警告（`runtime_process_is_active` dead_code、链接器 stdout 非 UTF-8），不影响构建；无文件占用错误，未改名或终止任何既有二进制。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,658,240 字节，文件时间 2026-11-15T00:50:48.327Z
  - PE `MZ`/`PE` 有效，Machine `0x8664`（X64），64-bit，Subsystem `WINDOWS_GUI`，`dll=false`，6 个 section
  - SHA-256 `c71f84bd20ccae4cd141db27c8432dad7cc77a0091afa03e079ed3f2d4792ea2`，PE TimeDateStamp `0x6AF901E8`
  - 内嵌前端校验：exe 内可检索到 `assets/index-iZJiR_-Y.js` 与 `assets/index-COHUHSZN.css`（均为 `true`），旧 chunk `assets/index-COxx2nA1.js` 已不存在（`oldChunkPresent=false`）
- 新鲜度：整树扫描 `desktop/src`、`desktop/src-tauri/src` 全部不晚于 exe，`anyDesktopSourceNewerThanExe=false`。
- staged 可运行目录（含 runtime / harness-model 资源）：构建打印 `C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-pewbcL\dda-desktop.exe`；该目录位于 `%LOCALAPPDATA%`（受保护路径），本轮未由工具独立复核。
- 说明：未启动 exe（`WINDOWS_GUI` 子系统，无 `--help`/`--version`，启动会占用产物并弹出窗口）；验证依据为 PE 头、SHA-256、内嵌 chunk 与源文件时间戳。

## staged 目录独立复核（verifier recovery 轮次，只读）

- 补上第八次编译遗留的证据缺口：staged 可运行目录位于 `%LOCALAPPDATA%`，本轮用只读脚本独立核验，未重新编译、未修改产品代码。
- `C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-pewbcL`（目录 mtime 2026-11-15T00:50:52.766Z）为最新 staged 目录，与本轮裸 exe 时间一致（00:50:48Z）。
  - staged `dda-desktop.exe`：11,658,240 字节，SHA-256 `c71f84bd20ccae4cd141db27c8432dad7cc77a0091afa03e079ed3f2d4792ea2`，与 `release/dda-desktop.exe` 完全一致。
  - 资源一致性（与工作区逐字节 SHA-256 比对，全部 `match=true`）：`runtime/src/index.mjs` `c7f0ab47…`、`runtime/src/task-context.mjs` `5d38a69d…`、`packages/harness-model/package.json` `b452acfd…`。
- 更早的 staged 目录 `…-zyoXwA`（00:41:23Z）与 `…-CBKpOO`（2026-11-14T14:28:42Z）仍保留，未被删除。
- 结论：第八次编译产出的裸 exe 与 staged 可运行目录同源同哈希，`runtime/` 资源已同步；此前"staged 目录未复核"的限制到此解除。

## 第九次编译（当前最新产物，2026-11-15T02:48:44Z）

> 判断当前产物以本节为准。

- 触发：用户说明有新开发代码，要求重新编译 exe；按既定入口对现有工程做增量编译。
- 命令：在 `desktop/` 执行 `npm run build:windows:full-local`（内部 `npm run build` + `tauri build --target x86_64-pc-windows-msvc`，含 bundle），退出码 0，总耗时约 195s（Rust 增量 2m 56s）。
- 前端重建：`dist/assets/index-iZJiR_-Y.js`（417.61 kB）、`dist/assets/index-COHUHSZN.css`（67.01 kB），与第八次编译的 chunk 名一致（前端源码未再变化），`dist/index.html` 指向该 chunk。
- Rust 侧仍只有原有 2 条警告（`runtime_process_is_active` dead_code、链接器 stdout 非 UTF-8，为中文代码页输出导致），不影响构建；无文件占用错误，未改名或终止任何既有二进制。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,658,240 字节，文件时间 2026-11-15T02:48:44.711Z
  - PE `MZ`/`PE` 有效，Machine `0x8664`（X64），64-bit，Subsystem `WINDOWS_GUI`，`dll=false`，6 个 section
  - SHA-256 `2efad7347f04f04fa8ae2fec82bae378c29251de7d76ce95906ffecf0ac01f3f`（上一版为 `c71f84bd…`，差异来自重新链接）
  - 内嵌前端校验：`embeddedChunks` 命中 `assets/index-iZJiR_-Y.js`
- 新鲜度：整树扫描 `desktop/src`（最新 `styles.css` 2026-11-15T00:43:12Z）、`desktop/src-tauri/src`（最新 `lib.rs` 2026-11-13T02:34:32Z）、`runtime/src`（最新 `plugins/task-runner.mjs` 2026-11-14T13:41:16Z），全部不晚于 exe，`anySourceNewerThanExe=false`。
- staged 可运行目录（含 runtime / harness-model 资源）：构建打印 `C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-BHqxRW\dda-desktop.exe`；该目录位于 `%LOCALAPPDATA%`（受保护路径），本轮未由工具独立复核。
- 安装包：`bundle/nsis/dda_0.1.0_x64-setup.exe` 仍是 2026-10-31T04:02:39Z 的旧产物（6,918,930 字节，SHA-256 `36f5af7a…`），本轮未重新打包。`tauri.conf.json` 的 `bundle.targets` 为空数组，需显式指定 NSIS/MSI 目标才会重建安装包。
- 说明：未启动 exe（`WINDOWS_GUI` 子系统，无 `--help`/`--version`，启动会占用产物并弹出窗口）；验证依据为 PE 头、SHA-256、内嵌 chunk 与源文件时间戳。

## 第十次编译（当前最新产物，2026-11-15T03:30:46Z）

> 判断当前产物以本节为准。

- 触发：用户要求再次编译 exe。
- 命令：在 `desktop/` 执行 `npm run build:windows:full-local`（内部 `npm run build` + `tauri build --target x86_64-pc-windows-msvc`，含 bundle），退出码 0，耗时约 151s。
- **首次执行失败并处理**：第一次运行在链接阶段报 `error: failed to remove file ...\release\dda-desktop.exe` / `拒绝访问。(os error 5)`；用独占打开测试确认为 `EBUSY`，即正在运行的实例锁定了上一版 exe（11,658,240 字节，2026-11-15T02:48:44.711Z）。未终止任何用户进程，按本目录既有 `locked-before-*` 约定把旧二进制改名为 `dda-desktop.locked-before-20261115032729.exe`（保留未删除）后重跑，第二次退出码 0。
- 前端重建：`dist/assets/index-IzHDAZ8N.js`（417.61 kB）、`dist/assets/index-COHUHSZN.css`（67.01 kB）；第九次记录中的 JS chunk 名为 `index-iZJiR_-Y.js`，本次实际产物为 `index-IzHDAZ8N.js`。
- Rust 侧仍只有原有 2 条警告（`runtime_process_is_active` dead_code、链接器 stdout 非 UTF-8），不影响构建；`Finished `release` profile [optimized] target(s) in 2m 19s`。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,658,240 字节，文件时间 2026-11-15T03:30:46.614Z
  - PE `MZ`/`PE` 有效，Machine `0x8664`（X64），64-bit，Subsystem `WINDOWS_GUI`，`dll=false`，6 个 section
  - SHA-256 `b096cd89b7169a5d93251c98414267152354ed52496b9b6c0811ba9bbaefc985`（上一版为 `2efad734…`）
  - 内嵌前端校验：`assets/index-IzHDAZ8N.js` 与 `assets/index-COHUHSZN.css` 均命中（`embeddedJs=true`、`embeddedCss=true`），旧 chunk `assets/index-iZJiR_-Y.js` 已不存在（`staleChunkPresent=false`）
- 新鲜度：整树扫描（跳过 `node_modules`/`target*`/`dist`/`.git`）。`desktop/src` 最新为 `src/main.ts` 2026-11-15T03:12:35.899Z；`desktop/src-tauri/src` 最新为 `lib.rs` 2026-11-13T02:34:32.880Z；`runtime/src` 最新为 `index.mjs` 2026-11-15T03:12:15.918Z。全部不晚于 exe，`anySourceNewerThanExe=false`。
- staged 可运行目录（含 runtime / harness-model 资源）：构建打印 `C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-8pSfra\dda-desktop.exe`；该目录位于 `%LOCALAPPDATA%`（受保护路径），本轮未由工具独立复核。
- 说明：未启动 exe（`WINDOWS_GUI` 子系统，无 `--help`/`--version`，启动会占用产物并弹出窗口）；验证依据为 PE 头、SHA-256、内嵌 chunk 与源文件时间戳。

## 第十一次编译（当前最新产物，2026-11-15T07:42:10Z）

> 判断当前产物以本节为准。

- 触发：用户要求“再编译”，采用增量编译，不执行清理。
- 命令：在 `desktop/` 执行 `npm run build:exe`（VsDevCmd `-arch=x64` → `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时约 261s；Rust 增量 `Finished release profile [optimized] target(s) in 3m 57s`。
- 前端重建：`dist/assets/index-CHkkDso_.js`（419.91 kB）、`dist/assets/index-COHUHSZN.css`（67.01 kB），vite `built in 581ms`（75 modules）。
- Rust 侧仍只有原有 2 条警告（`runtime_process_is_active` dead_code、链接器 stdout 非 UTF-8），不影响构建。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,660,800 字节（上一版 11,658,240），文件时间 2026-11-15T07:42:10.915Z
  - PE `MZ`/`PE` 有效，Machine `0x8664`（X64），64-bit，Subsystem `WINDOWS_GUI`，`dll=false`，6 个 section
  - SHA-256 `27dc22459df3acfbd3c77966a79511d8d3c3bd15d987116ba6454a293b7ca63a`（上一版 `b096cd89…`）
  - 内嵌前端校验：`assets/index-CHkkDso_.js` 命中，且 `dist/index.html` 指向同一 chunk。
- 新鲜度（整树扫描，跳过 `node_modules` / `target*` / `dist` / `.git`）：`desktop/src` 最新为 `src/main.ts` 2026-11-15T07:39:10.762Z；`desktop/src-tauri/src` 最新为 `lib.rs` 2026-11-13T02:34:32.880Z；`runtime/src` 最新为 `context-assembler.mjs` 2026-11-15T07:38:29.904Z。全部不晚于 exe，`anySourceNewerThanExe=false`。
- `--no-bundle` 只产出裸 exe，不携带 `tauri.conf.json` 声明的 runtime / harness-model 资源；需要可直接运行目录时执行 `npm run build:windows:full-local`。
- 说明：本轮未启动 exe（`WINDOWS_GUI` 子系统，无 `--help`/`--version`，启动会占用产物并弹出窗口）；验证依据为 PE 头、SHA-256、内嵌 chunk 与源文件时间戳。

## 只读复核 + staged 重新生成（2026-11-15T08:01Z，未重新编译）

> 本轮未产生新 exe；现有裸 exe 仍是最新，判断当前产物仍以第十一次编译为准。

- 结论：不触发重新编译。裸 exe `desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe` 已包含当前前端与 runtime 源码。
  - PE（`workspace.inspect_binary`）：`MZ`/`PE`，Machine `0x8664`（X64），64-bit，Subsystem `WINDOWS_GUI`，`dll=false`，6 个 section，11,660,800 字节。
  - SHA-256 `27dc22459df3acfbd3c77966a79511d8d3c3bd15d987116ba6454a293b7ca63a`，文件时间 2026-11-15T07:42:10.915Z，与第十一次编译记录一致，未出现新的重链接。
  - 内嵌前端：`desktop/dist/index.html` 声明 `assets/index-CHkkDso_.js`，exe 内检索命中（`embeddedChunks` 命中同名 chunk）；`desktop/dist/assets/` 仅保留 `index-CHkkDso_.js`（419,915 B）、`index-CHkkDso_.js.map`、`index-COHUHSZN.css`（67,012 B），无旧 chunk 残留。
- 新鲜度（整树扫描，跳过 `node_modules`/`target*`/`dist`/`.git`）：`desktop/src` 最新 `src/main.ts` 2026-11-15T07:39:10.762Z、`desktop/src-tauri/src` 最新 `lib.rs` 2026-11-13T02:34:32.880Z、`runtime/src` 最新 `context-assembler.mjs` 2026-11-15T07:38:29.904Z；`anySourceNewerThanExe=false`。
- 构建输入复核（全部早于 exe）：`src-tauri/tauri.conf.json` 2026-11-10T06:19Z、`src-tauri/Cargo.toml` 2026-11-09T13:12Z、`src-tauri/build.rs` 2026-11-06T02:57Z、`src-tauri/capabilities/default.json` 2026-09-29T10:14Z、`desktop/index.html` 2026-10-08T01:04Z、`desktop/vite.config.ts` 2026-09-04T02:13Z、`desktop/package.json` 2026-11-11T04:11Z、`desktop/tsconfig.json` 2026-09-01T01:32Z、`.cargo/config.toml` 2026-09-03T12:35Z。
- 重新生成 staged 可运行目录：`node desktop/scripts/stage-desktop-build.mjs --profile=release`，退出码 0，4.6s。
  - `C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-MBxQlK\dda-desktop.exe`，目录 mtime 2026-11-15T08:01:26.569Z。
  - staged exe 与裸 exe 逐字节一致：SHA-256 `27dc22459df3acfbd3c77966a79511d8d3c3bd15d987116ba6454a293b7ca63a`，11,660,800 字节（`exeMatch=true`）。
  - 资源与工作区 SHA-256 比对全部 `match=true`：`runtime/src/index.mjs`、`runtime/src/context-assembler.mjs`、`runtime/src/plugins/task-runner.mjs`、`packages/harness-model/package.json`。
  - `%LOCALAPPDATA%\dda\desktop-builds\latest.json` 已更新并指向该目录。
- 说明：本轮未重新编译、未启动 exe（`WINDOWS_GUI` 子系统，无 `--help`/`--version`，启动会占用产物并弹出窗口）、未修改产品代码；验证依据为 PE 头、SHA-256、内嵌 chunk、staged 资源逐字节比对与源文件时间戳。

## 复核收尾（verifier recovery 轮次，只读，未重新编译）

> 本轮未产生新 exe；当前产物判定不变，仍以「第十一次编译」一节为准。

- 本轮独立重跑校验脚本 `node .codex-tmp/exe-artifact-digest.mjs desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe desktop/src/main.ts @desktop/src @runtime/src @desktop/src-tauri/src`，退出码 0，脚本输出：
  - `sizeBytes` 11,660,800；`modified` 2026-11-15T07:42:10.915Z；`sha256` `27dc22459df3acfbd3c77966a79511d8d3c3bd15d987116ba6454a293b7ca63a`（与第十一次编译记录逐位一致，说明 exe 未被重新链接或替换）。
  - `chunkCandidates` 与 `embeddedChunks` 同为 `assets/index-CHkkDso_.js`，即 exe 内嵌的正是当前 `desktop/dist` 前端产物。
  - `anySourceNewerThanExe=false`；三棵源码树最新项分别为 `desktop/src/main.ts` 2026-11-15T07:39:10.762Z、`runtime/src/context-assembler.mjs` 2026-11-15T07:38:29.904Z、`desktop/src-tauri/src/lib.rs` 2026-11-13T02:34:32.880Z。
- 本轮独立重跑 PE 头检查（`workspace.inspect_binary`）：`format=PE`、`mz=MZ`、`peSignature=PE`、`machineHex=0x8664`、`architecture=X64`、`bits=64`、`subsystem=WINDOWS_GUI`、`dll=false`、`sectionCount=6`、`executable=true`、`sizeBytes=11660800`，与脚本数值互相印证。
- 结论：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe` 为当前最新且有效的 Windows x64 GUI 可执行产物，源码与构建输入均不晚于它，无需重新编译。
- 本轮限制：仍未启动 exe（`WINDOWS_GUI` 子系统、无 `--help`/`--version`，启动会占用产物并弹出窗口），因此"可启动性"未经运行验证；`bundle/nsis/dda_0.1.0_x64-setup.exe` 仍为 2026-10-31 的旧安装包，本轮未重新打包（`bundle.targets` 为空数组，需显式指定 NSIS/MSI 目标）。

## 第十二次编译（当前最新产物，2026-11-15T11:51:55Z）

> 判断当前产物以本节为准。

- 触发：用户要求“重新编译exe”。
- 命令：在 `desktop/` 执行 `node scripts/build-full-local.mjs`（内部 `npm run build` + `tauri build --target x86_64-pc-windows-msvc`，含 bundle），退出码 0，耗时约 142s；Rust 增量 `Finished \`release\` profile [optimized] target(s) in 2m 11s`。
- **首次执行失败并处理**：第一次运行 `npm run build:windows:full-local` 在链接阶段报 `error: failed to remove file ...\release\dda-desktop.exe` / `拒绝访问。(os error 5)`，即上一版 exe（11,660,800 字节，2026-11-15T07:42:10.915Z）被运行中的实例锁定。按本目录既有 `locked-before-*` 约定把旧二进制改名为 `dda-desktop.locked-before-20261115-194842.exe`（保留未删除），未终止任何用户进程；改名成功后重跑，退出码 0。
- 前端重建：`dist/assets/index-BQA8N8X7.js`（418.88 kB）、`dist/assets/index-COHUHSZN.css`（67.01 kB），vite `built in 266ms`（75 modules）。
- Rust 侧仍只有原有 2 条警告（`runtime_process_is_active` dead_code、链接器 stdout 非 UTF-8），不影响构建。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,660,288 字节，文件时间 2026-11-15T11:51:55.535Z
  - PE `MZ`/`PE` 有效，Machine `0x8664`（X64），64-bit，Subsystem `WINDOWS_GUI`，`dll=false`，6 个 section
  - SHA-256 `18682ed46d1eee9aea9d725573f41d223fe80fc78ccaa6e83a4a03c1369f80f3`（上一版 `27dc2245…`）
  - 内嵌前端校验：`desktop/dist/index.html` 声明 `assets/index-BQA8N8X7.js`，exe 内检索命中同名 chunk（`embeddedChunks` 命中）。
- 新鲜度（整树扫描，跳过 `node_modules`/`target*`/`dist`/`.git`）：`desktop/src` 最新 `src/main.ts` 2026-11-15T11:30:45.618Z；`desktop/src-tauri/src` 最新 `lib.rs` 2026-11-13T02:34:32.880Z；`runtime/src` 最新 `context-assembler.mjs` 2026-11-15T07:38:29.904Z。全部不晚于 exe，`anySourceNewerThanExe=false`。
- staged 可运行目录（含 runtime / harness-model 资源）：`C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-vp7DAZ\dda-desktop.exe`，`%LOCALAPPDATA%\dda\desktop-builds\latest.json` 已指向该目录；目录内容为 `dda-desktop.exe`（11,660,288 字节）、`openviking-server.exe`（528,896 字节）、`packages/`、`runtime/`。
- 安装包：`bundle.targets` 仍为空数组，本轮未重新打包 NSIS/MSI。
- 说明：未启动 exe（`WINDOWS_GUI` 子系统，无 `--help`/`--version`，启动会占用产物并弹出窗口）；验证依据为 PE 头、SHA-256、内嵌 chunk、staged 目录与源文件时间戳。

## 第十三轮：复核第十二次编译产物（只读，未重新编译）

> 本轮未产生新 exe。当前产物仍为「第十二次编译」（2026-11-15T11:51:55Z），本节仅回填独立复核证据。

- 复核对象：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
- 校验脚本：`node .codex-tmp/exe-artifact-digest.mjs <exe> @desktop/src @desktop/src-tauri/src @runtime/src desktop/dist/index.html`（cwd 为仓库根），退出码 0，输出：
  - `sizeBytes` 11,660,288；`modified` 2026-11-15T11:51:55.535Z；`sha256` `18682ed46d1eee9aea9d725573f41d223fe80fc78ccaa6e83a4a03c1369f80f3`（与第十二次编译记录逐位一致，说明 exe 未被重新链接或替换）。
  - `chunkCandidates` 与 `embeddedChunks` 同为 `assets/index-BQA8N8X7.js`，即 exe 内嵌的正是当前 `desktop/dist` 前端产物。
  - `anySourceNewerThanExe=false`；三棵源码树最新项：`desktop/src/main.ts` 2026-11-15T11:30:45.618Z、`desktop/src-tauri/src/lib.rs` 2026-11-13T02:34:32.880Z、`runtime/src/context-assembler.mjs` 2026-11-15T07:38:29.904Z。
- PE 头（`workspace.inspect_binary`）：`format=PE`、`mz=MZ`、`peSignature=PE`、`machineHex=0x8664`、`architecture=X64`、`bits=64`、`subsystem=WINDOWS_GUI`、`dll=false`、`sectionCount=6`、`executable=true`，与脚本数值互相印证。
- 安装包（`release/bundle/nsis/`）：`dda_0.1.0_x64-setup.exe` 6,918,930 字节、`dda_0.1.0_arm64-setup.exe` 6,776,870 字节、`hmCodex_0.1.0_x64-setup.exe` 6,571,401 字节；均为历史产物，本轮未重新打包。
- 结论：当前裸 exe 是有效的 Windows x64 GUI 可执行产物，构建输入（前端与 Rust 源码）均不晚于它，因此无需再次编译。
- 本轮限制：未启动 exe（GUI 子系统，无 `--help`/`--version`，启动会占用产物并弹窗），因此“可启动性”未经运行验证；staged 目录的独立复核见下一节。

## 第十四轮：staged 目录独立复核（只读，未重新编译）

> 本轮未产生新 exe。当前产物仍为「第十二次编译」（2026-11-15T11:51:55Z）；本节只补齐第十三轮遗留的 staged 证据缺口。

- 复核对象：`C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-vp7DAZ`，目录 mtime 2026-11-15T11:51:59.536Z，与裸 exe 时间 11:51:55.535Z 同源。
  - 目录顶层内容：`dda-desktop.exe`、`openviking-server.exe`、`packages`、`runtime`。
  - staged `dda-desktop.exe`：11,660,288 字节，SHA-256 `18682ed46d1eee9aea9d725573f41d223fe80fc78ccaa6e83a4a03c1369f80f3`，与 `release/dda-desktop.exe` 逐字节一致（`matchBare=true`）。
  - 资源逐字节比对（staged 与工作区 SHA-256）全部 `match=true`：`runtime/src/index.mjs`、`runtime/src/task-context.mjs`、`runtime/src/context-assembler.mjs`、`runtime/package.json`、`packages/harness-model/package.json`。
  - `%LOCALAPPDATA%\dda\desktop-builds\latest.json` 指向该目录（`target=x86_64-pc-windows-msvc`、`profile=release`）。
- 结论：第十二次编译的裸 exe 与 staged 可运行目录同源同哈希，`runtime/` 与 `packages/harness-model` 资源已同步；第十三轮“staged 未独立复核”的限制到此解除。
- 仍未覆盖：未启动 exe（GUI 子系统，无 `--help`/`--version`，启动会占用产物并弹窗），“可启动性”未经运行验证；`bundle.targets` 仍为空数组，NSIS/MSI 安装包未重建。

## 再编译 exe（2026-11-15T14:27:20Z，当前最新产物）

> 判断当前产物以本节为准。

- 触发：用户要求“再编译exe”，沿用既有入口做增量编译，未做清理。
- 命令：在 `desktop/` 执行 `npm run build:windows:full-local`（内部 `npm run build` + `tauri build --target x86_64-pc-windows-msvc`，含 bundle），退出码 0。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,660,800 字节，文件时间 2026-11-15T14:27:20.828Z
  - PE `MZ`/`PE` 有效，Machine `0x8664`（X64），64-bit，Subsystem `WINDOWS_GUI`，`dll=false`，6 个 section（`workspace.inspect_binary`）
  - SHA-256 `260a6f0a0746007229c8bf9e061418eea3a251b200d64af11d393b897e3b438b`，11,660,800 字节（与上述 `inspect_binary` 的 `sizeBytes` 一致）
- 内嵌前端校验：`desktop/dist/index.html`（SHA-256 `4d92f92a…`）当前声明 `assets/index-BzqFi3aA.js`，exe 内检索命中（`embeddedChunk=true`），说明嵌入的是当前前端构建。
- 新鲜度（整树扫描 `desktop/src`、`desktop/src-tauri/src`、`runtime/src`，跳过 `node_modules`/`target*`/`dist`/`.git`）：最新源文件为 `runtime/src/index.mjs` 2026-11-15T13:37:10.897Z，早于 exe，`anySourceNewerThanExe=false`。
- 说明：未启动 exe（`WINDOWS_GUI` 子系统，无 `--help`/`--version`，启动会占用产物并弹出窗口）；验证依据为构建退出码、PE 头、SHA-256、内嵌 chunk 与源文件时间戳。

## 第十五轮：本次编译的 staged 目录独立复核（只读，未重新编译）

> 本轮未产生新 exe。当前产物仍为上一节「再编译 exe」（2026-11-15T14:27:20Z）；本节只补齐该次编译的 staged 证据。

- 复核对象：`%LOCALAPPDATA%\dda\desktop-builds\latest.json` 当前指向的 `build-x86_64-pc-windows-msvc-n4Xhoz`（`target=x86_64-pc-windows-msvc`、`profile=release`）。
  - 顶层内容：`dda-desktop.exe`、`openviking-server.exe`、`packages`、`runtime`。
  - staged `dda-desktop.exe`：11,660,800 字节，mtime 2026-11-15T14:27:20.828Z，SHA-256 `260a6f0a0746007229c8bf9e061418eea3a251b200d64af11d393b897e3b438b`，与 `release/dda-desktop.exe` 逐字节一致（`stagedSha=bareSha`）。
  - 资源逐字节比对（staged 与工作区 SHA-256）全部 `match=true`：`runtime/src/index.mjs`、`runtime/src/task-context.mjs`、`runtime/src/context-assembler.mjs`、`runtime/package.json`、`packages/harness-model/package.json`。
- 安装包：`release/bundle/nsis/` 下仍是历史产物（`dda_0.1.0_x64-setup.exe` 6,918,930 字节、`dda_0.1.0_arm64-setup.exe` 6,776,870 字节、`hmCodex_0.1.0_x64-setup.exe` 6,571,401 字节），本次未重新打包；`bundle.targets` 仍为空数组，需显式指定 NSIS/MSI 目标才会重建。
- 仍未覆盖：未启动 exe（GUI 子系统，无 `--help`/`--version`，启动会占用产物并弹窗），"可启动性"未经运行验证。
- 说明：本轮只做只读核验，未重新编译、未修改产品代码、未删除任何既有的 `locked-before-*` / `before-*` 旧二进制。

## 第十六次编译（当前最新产物，2026-11-16T08:38:07Z）

> 判断当前产物以本节为准。

- 触发：用户要求"再编译exe"。编译前发现当前 exe（09:59 生成，SHA-256 `16b2d70f…`）是外部会话构建的，此后 `desktop/src/main.ts`（13:59:12Z）和 `desktop/src/styles.css`（13:59:14Z）有新改动，需要重新编译纳入。
- 命令：在 `desktop/` 执行 `npm run build:exe`（VsDevCmd `-arch=x64` → `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时 5m47s；Rust 增量 `Finished release profile [optimized] target(s) in 4m 43s`。
- 前端重建：`dist/assets/index-DtkTlDVh.js`（436.20 kB）、`dist/assets/index-BmXkmCaj.css`（69.79 kB），vite `built in 5.74s`（76 modules）；上一版 chunk 为 `index-CFK-MUbX.js`。
- Rust 侧仍只有原有 2 条警告（`runtime_process_is_active` dead_code、链接器 stdout 非 UTF-8），不影响构建。无文件占用错误（编译前确认无 dda-desktop / dda_desktop 进程运行）。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,676,160 字节，文件时间 2026-11-16T08:38:07Z（16:38:07 +08:00）
  - PE Machine `0x8664`（X64），ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `cc4e16731d6f875a7e5647da1d78dd3b7bdd06dcd38145b7c76570f8480d718d`
  - 内嵌前端校验：exe 内可检索到 `index-DtkTlDVh.js`，旧 chunk `index-CFK-MUbX.js` 已消失
- staged 可运行目录（含 runtime / harness-model 资源）：`C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-RWIL97\dda-desktop.exe`
  - staged exe SHA-256 `cc4e1673…` 与裸 exe 完全一致
  - 资源逐字节比对（staged 与工作区 SHA-256）全部 MATCH：`runtime/src/context-assembler.mjs`、`runtime/src/index.mjs`、`runtime/src/kernel/approval-session.mjs`、`runtime/src/model-usage.mjs`、`runtime/src/execution-state-store.mjs`、`runtime/src/experience-extractor.mjs`、`runtime/src/experience-placement.mjs`、`runtime/src/journal-context-port.mjs`
  - `%LOCALAPPDATA%\dda\desktop-builds\latest.json` 已指向该目录
- `--no-bundle` 只产出裸 exe，不携带 `tauri.conf.json` 声明的 runtime / harness-model 资源；需要可直接运行目录时用暂存版。
- 说明：未启动 exe（`WINDOWS_GUI` 子系统，无 `--help`/`--version`，启动会占用产物并弹出窗口）；验证依据为 PE 头、SHA-256、内嵌 chunk 检索与 staged 资源逐字节比对。

## 第十七次编译（当前最新产物，2026-11-16T13:15:09Z）

> 判断当前产物以本节为准。

- 触发：用户要求"再编译exe"。编译前发现 `dda_desktop` 进程（PID 5068，19:31 启动）正锁定旧 exe（独占打开测试报"正由另一进程使用"）；且有大批源码改动（20:30–21:04），包括 Rust 源码 `desktop/src-tauri/src/lib.rs`（20:58）与 `task_worktree.rs`（20:30）。
- 文件占用处理：按本目录既有 `locked-before-*` 约定，把旧 exe（16:38 版，SHA-256 `cc4e1673…`）改名为 `dda-desktop.locked-before-20261116-211010.exe` 保留，**未结束任何用户进程**；腾空路径后一次编译通过。
- 命令：在 `desktop/` 执行 `npm run build:exe`（VsDevCmd `-arch=x64` → `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时 5m07s；Rust 增量 `Finished release profile [optimized] target(s) in 4m 24s`。
- 前端重建：`dist/assets/index-DLKp2qG6.js`（441.49 kB）、`dist/assets/index-BmXkmCaj.css`（69.79 kB），vite `built in 3.58s`（78 modules）；上一版 chunk 为 `index-Dhet-dnJ.js`（20:18 的外部构建产物）。
- Rust 侧确实重新编译（警告行号从 `lib.rs:895` 变为 `lib.rs:977`，说明 `lib.rs` 改动已进包）；仍只有原有 2 条警告（`runtime_process_is_active` dead_code、链接器 stdout 非 UTF-8），不影响构建。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,728,384 字节（上一版 11,676,160，+52,224 B），文件时间 2026-11-16T13:15:09Z（21:15:09 +08:00）
  - PE Machine `0x8664`（X64），ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `f4b85ae30c962e316082cb282266373823dc1bde18df9a9ebfbb283c1eb55dbc`
  - 内嵌前端校验：exe 内可检索到 `index-DLKp2qG6.js`，旧 chunk `index-Dhet-dnJ.js` 已消失
- staged 可运行目录（含 runtime / harness-model 资源）：`C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-BcAudq\dda-desktop.exe`
  - staged exe SHA-256 `f4b85ae3…` 与裸 exe 完全一致
  - 资源逐字节比对（staged 与工作区 SHA-256）全部 MATCH：`runtime/src/index.mjs`、`runtime/src/agent-turns.mjs`、`runtime/src/heartbeat-worker.mjs`、`runtime/src/process-heartbeat.mjs`、`runtime/src/role-session-manager.mjs`
  - `%LOCALAPPDATA%\dda\desktop-builds\latest.json` 已指向该目录
- 说明：`--no-bundle` 只产出裸 exe，不携带 runtime / harness-model 资源，验证 runtime 改动须运行 staged 版；未启动 exe 做 GUI 冒烟（`WINDOWS_GUI` 子系统，无 `--help`/`--version`，启动会占用产物并弹出窗口）。

## 第十八次编译（当前最新产物，2026-11-16T13:29:50Z）

> 判断当前产物以本节为准。

- 触发：用户要求"再编译exe"。21:15 后 `desktop/src/main.ts`（21:18）、2 个测试文件及 `runtime/src` 3 个文件改动。
- 占用检查：`dda_desktop` 进程（PID 5068）仍在运行，但独占打开测试 OK（未锁定当前 exe），无需改名备份；一次编译通过。
- 命令：在 `desktop/` 执行 `npm run build:exe`（VsDevCmd `-arch=x64` → `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时 4m30s；Rust 增量 `Finished release profile [optimized] target(s) in 3m 58s`。
- 前端重建：`dist/assets/index-0l9sVSXV.js`（443.61 kB）、`dist/assets/index-BmXkmCaj.css`（69.79 kB），vite `built in 2.97s`（78 modules）；上一版 chunk 为 `index-DLKp2qG6.js`。
- Rust 侧仍只有原有 2 条警告（`runtime_process_is_active` dead_code 在 `lib.rs:977`、链接器 stdout 非 UTF-8），不影响构建；`lib.rs` 未再改动（警告行号未变）。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,730,944 字节（上一版 11,728,384，+2,560 B），文件时间 2026-11-16T13:29:50Z（21:29:50 +08:00）
  - PE Machine `0x8664`（X64），ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `f28cea79de0a175e9b2073ea5500812d99d6c8937803b4a9d46be369adb92c26`
  - 内嵌前端校验：exe 内可检索到 `index-0l9sVSXV.js`，旧 chunk `index-DLKp2qG6.js` 已消失
- staged 可运行目录（含 runtime / harness-model 资源）：`C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-DpIkPa\dda-desktop.exe`
  - staged exe SHA-256 `f28cea79…` 与裸 exe 完全一致
  - 资源逐字节比对（staged 与工作区 SHA-256）全部 MATCH：`runtime/src/access-mode-instructions.mjs`、`runtime/src/agent-turns.mjs`、`runtime/src/plugins/task-runner.mjs`
  - `%LOCALAPPDATA%\dda\desktop-builds\latest.json` 已指向该目录
- 说明：`--no-bundle` 只产出裸 exe，不携带 runtime / harness-model 资源，验证 runtime 改动须运行 staged 版；未启动 exe 做 GUI 冒烟。

## 第十九次编译（当前最新产物，2026-11-16T14:24:12Z）

> 判断当前产物以本节为准。

- 触发：用户要求"再编译exe"。21:29 后有 32 个源码文件改动（21:59–22:17），含 Rust 源码 `desktop/src-tauri/src/lib.rs`（22:06）与 `notifications.rs`（22:05），以及 `desktop/src/main.ts`（22:17）、styles.css、多个 domain 模块与 17 个 runtime 文件。
- 文件占用处理：`dda_desktop` 进程（PID 19612，21:31 启动）锁定旧 exe（独占打开测试确认）。按既有 `locked-before-*` 约定改名为 `dda-desktop.locked-before-20261116-221934.exe` 保留，**未结束任何用户进程**；腾空路径后一次编译通过。
- 命令：在 `desktop/` 执行 `npm run build:exe`（VsDevCmd `-arch=x64` → `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时 4m37s；Rust 增量 `Finished release profile [optimized] target(s) in 3m 57s`。
- 前端重建：`dist/assets/index-BXPBzshj.js`（452.53 kB）、`dist/assets/index-DlQnljeZ.css`（70.40 kB），vite `built in 2.22s`（79 modules）；上一版 chunk 为 `index-0l9sVSXV.js`。
- Rust 侧确实重新编译（警告行号从 `lib.rs:977` 变为 `lib.rs:978`，且新增 `notifications.rs`）；仍只有原有 2 条警告，不影响构建。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,622,400 字节（上一版 11,730,944，-108,544 B），文件时间 2026-11-16T14:24:12Z（22:24:12 +08:00）
  - PE Machine `0x8664`（X64），ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `089640e356689c14e6651633404bd3586baa826540e2a2aa8d35bbe72226c83f`
  - 内嵌前端校验：exe 内可检索到 `index-BXPBzshj.js`，旧 chunk `index-0l9sVSXV.js` 已消失
- staged 可运行目录（含 runtime / harness-model 资源）：`C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-MxgewW\dda-desktop.exe`
  - staged exe SHA-256 `089640e3…` 与裸 exe 完全一致
  - 资源逐字节比对（staged 与工作区 SHA-256）全部 MATCH：`runtime/src/index.mjs`、`runtime/src/task-run-coordinator.mjs`、`runtime/src/tool-registry.mjs`、`runtime/src/kernel/clarification-session.mjs`、`runtime/src/playwright-host.mjs`、`runtime/src/thread-store.mjs`
  - `%LOCALAPPDATA%\dda\desktop-builds\latest.json` 已指向该目录
- 说明：`--no-bundle` 只产出裸 exe，不携带 runtime / harness-model 资源，验证 runtime 改动须运行 staged 版；未启动 exe 做 GUI 冒烟（`WINDOWS_GUI` 子系统，无 `--help`/`--version`）。

## 第二十次编译（当前最新产物，2026-11-17T02:29:25Z）

> 判断当前产物以本节为准。

- 触发：用户要求"再编译exe"。22:24 后有 27 个源码文件改动（09:24–10:17），含 `desktop/src/main.ts`（10:17）、`desktop/src-tauri/src/lib.rs`（10:16）、多个 UI / domain 模块与 14 个 runtime 文件。
- 占用检查：无 dda-desktop / dda_desktop 进程运行，独占打开测试 OK，无需改名备份；一次编译通过。
- 命令：在 `desktop/` 执行 `npm run build:exe`（VsDevCmd `-arch=x64` → `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时 5m22s；Rust 增量 `Finished release profile [optimized] target(s) in 4m 13s`。
- 前端重建：`dist/assets/index-krdzGeKU.js`（465.95 kB）、`dist/assets/index-BGWphg1L.css`（72.31 kB），vite `built in 4.78s`（80 modules）；上一版 chunk 为 `index-BXPBzshj.js`；CSS 文件名也从 `index-DlQnljeZ.css` 变为 `index-BGWphg1L.css`。
- Rust 侧确实重新编译（`lib.rs` 10:16 改动）；仍只有原有 2 条警告，不影响构建。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,902,464 字节（上一版 11,622,400，+280,064 B），文件时间 2026-11-17T02:29:25Z（10:29:25 +08:00）
  - PE Machine `0x8664`（X64），ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `c24febdae1125ee7b65851e6c794b37c455705888b2bbdf8441dbd9d92378e6f`
  - 内嵌前端校验：exe 内可检索到 `index-krdzGeKU.js`，旧 chunk `index-BXPBzshj.js` 已消失
- staged 可运行目录（含 runtime / harness-model 资源）：`C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-WC1Jfg\dda-desktop.exe`
  - staged exe SHA-256 `c24febda…` 与裸 exe 完全一致
  - 资源逐字节比对（staged 与工作区 SHA-256）全部 MATCH：`runtime/src/index.mjs`、`runtime/src/kernel/approval-session.mjs`、`runtime/src/memory-journal.mjs`、`runtime/src/context-assembler.mjs`、`runtime/src/harness-event-store.mjs`、`runtime/src/thread-store.mjs`
  - `%LOCALAPPDATA%\dda\desktop-builds\latest.json` 已指向该目录
- 说明：`--no-bundle` 只产出裸 exe，不携带 runtime / harness-model 资源，验证 runtime 改动须运行 staged 版；未启动 exe 做 GUI 冒烟。

## 第二十一次编译（当前最新产物，2026-11-17T07:49:36Z）

> 判断当前产物以本节为准。

- 触发：用户要求"再编译exe"。10:29 后有 30 个源码文件改动（11:18–15:42），含 `desktop/src/main.ts`（15:42）、`desktop/src-tauri/src/lib.rs`（15:41）、新增 `runtime/src/decision/` 三文件与 `uncertain-step-continuation.mjs` 等 18 个 runtime 文件。
- 占用检查：无 dda-desktop / dda_desktop 进程运行，独占打开测试 OK，无需改名备份；一次编译通过。
- 命令：在 `desktop/` 执行 `npm run build:exe`（VsDevCmd `-arch=x64` → `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时 5m55s；Rust 增量 `Finished release profile [optimized] target(s) in 4m 47s`。
- 前端重建：`dist/assets/index-oh7Yskeg.js`（465.90 kB）、`dist/assets/index-Bjo6shPx.css`（72.55 kB），vite `built in 4.57s`（80 modules）；上一版 chunk 为 `index-krdzGeKU.js`，CSS 由 `index-BGWphg1L.css` 变为 `index-Bjo6shPx.css`。
- Rust 侧确实重新编译（`lib.rs` 15:41 改动）；仍只有原有 2 条警告，不影响构建。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,903,488 字节（上一版 11,902,464，+1,024 B），文件时间 2026-11-17T07:49:36Z（15:49:36 +08:00）
  - PE Machine `0x8664`（X64），ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `f5a0503b72828779f0c4f9fbd6ba261454f6f7ca809b8f095bf1bef45b2fb110`
  - 内嵌前端校验：exe 内可检索到 `index-oh7Yskeg.js`，旧 chunk `index-krdzGeKU.js` 已消失
- staged 可运行目录（含 runtime / harness-model 资源）：`C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-Icge8d\dda-desktop.exe`
  - staged exe SHA-256 `f5a0503b…` 与裸 exe 完全一致
  - 资源逐字节比对（staged 与工作区 SHA-256）全部 MATCH：`runtime/src/index.mjs`、`runtime/src/kernel/approval-session.mjs`、`runtime/src/decision/engine.mjs`、`runtime/src/uncertain-step-continuation.mjs`、`runtime/src/rule-router.mjs`、`runtime/src/role-session-manager.mjs`
  - `%LOCALAPPDATA%\dda\desktop-builds\latest.json` 已指向该目录
- 说明：`--no-bundle` 只产出裸 exe，不携带 runtime / harness-model 资源，验证 runtime 改动须运行 staged 版；未启动 exe 做 GUI 冒烟。

## 第二十二次编译（当前最新产物，2026-11-17T14:03:04Z）

> 判断当前产物以本节为准。

- 触发：用户要求"再编译exe"。15:49 后有 28 个源码文件改动（17:11–21:50），含 `desktop/src/main.ts`（21:18）、`desktop/src-tauri/src/lib.rs`（21:50）、新增 `runtime/src/decision/process-admission.mjs`、`runtime/src/model-context-limits.mjs/.d.mts`、`safety-executor.mjs`、`task-recovery-controller.mjs` 等 21 个 runtime 文件。
- 文件占用处理：`dda_desktop` 进程（PID 30020，19:51 启动）锁定旧 exe（独占打开测试确认）；按既有 `locked-before-*` 约定改名为 `dda-desktop.locked-before-20261117-215800.exe` 保留，**未结束任何用户进程**；腾空路径后一次编译通过。
- 命令：在 `desktop/` 执行 `npm run build:exe`（VsDevCmd `-arch=x64` → `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时 5m05s；Rust 增量 `Finished release profile [optimized] target(s) in 4m 00s`。
- 前端重建：`dist/assets/index-Bz5Z96I5.js`（470.91 kB）、`dist/assets/index-DJ_-lfQd.css`（73.12 kB），vite `built in 4.46s`（82 modules）；上一版 chunk 为 `index-oh7Yskeg.js`，CSS 由 `index-Bjo6shPx.css` 变为 `index-DJ_-lfQd.css`。另有 vite 插件耗时提示（82% 时间在插件钩子，含 `vite:prepare-out-dir` 2.1s），信息性警告，不影响产物。
- Rust 侧确实重新编译（警告行号从 `lib.rs:978` 跳到 `lib.rs:1024`，说明 lib.rs 有较大改动）；仍只有原有 2 条警告，不影响构建。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,948,032 字节（上一版 11,903,488，+44,544 B），文件时间 2026-11-17T14:03:04Z（22:03:04 +08:00）
  - PE Machine `0x8664`（X64），ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `2266f5d8d83f0fc4122e8a39258a59356395e9ead0722a2f59cae53849ad3380`
  - 内嵌前端校验：exe 内可检索到 `index-Bz5Z96I5.js`，旧 chunk `index-oh7Yskeg.js` 已消失
- staged 可运行目录（含 runtime / harness-model 资源）：`C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-05EYa8\dda-desktop.exe`
  - staged exe SHA-256 `2266f5d8…` 与裸 exe 完全一致
  - 资源逐字节比对（staged 与工作区 SHA-256）全部 MATCH：`runtime/src/index.mjs`、`runtime/src/kernel/kernel-tools.mjs`、`runtime/src/decision/process-admission.mjs`、`runtime/src/model-context-limits.mjs`、`runtime/src/safety-executor.mjs`、`runtime/src/task-recovery-controller.mjs`
  - `%LOCALAPPDATA%\dda\desktop-builds\latest.json` 已指向该目录
- 说明：`--no-bundle` 只产出裸 exe，不携带 runtime / harness-model 资源，验证 runtime 改动须运行 staged 版；未启动 exe 做 GUI 冒烟。

## 第二十三次编译（当前最新产物，2026-11-18T03:52:37Z）

> 判断当前产物以本节为准。

- 触发：用户要求"再编译exe"。编译前发现当前 exe 为 11-18 09:10 生成的外部构建（SHA-256 `785e04ab…`、chunk `index-CIqDJdQ8.js`）。时间线：`desktop/src/main.ts`（09:06）已被 09:10 那版收录，Rust 源码未再改动；真正的新改动是 11:30 的 5 个 `runtime/src` 文件（`controlled-tools.mjs`、`index.mjs`、`playwright-host.mjs`、`runtime-safety-monitor.mjs`、`safety-executor.mjs`）与 11-17 22:20 的 `harness-event-store.mjs`，均属 bundle resources。
- 占用检查：`dda-desktop` 进程（PID 12828，09:13 启动，**连字符命名**）在运行，但独占打开测试 OK（未锁 exe），无需改名备份；一次编译通过。
- 命令：在 `desktop/` 执行 `npm run build:exe`（VsDevCmd `-arch=x64` → `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时 6m31s；Rust 增量 `Finished release profile [optimized] target(s) in 5m 35s`。
- 前端重建：`dist/assets/index-CIqDJdQ8.js`（471.35 kB）、`dist/assets/index-DJ_-lfQd.css`（73.12 kB），vite `built in 3.88s`（82 modules）；chunk 名与上一版一致（前端源码未再变化）。vite 插件耗时提示为信息性警告，不影响产物。
- Rust 侧本轮重新编译了较多 crate（`vswhom-sys`、`embed-resource`、`tauri-build`、`tauri` 等，疑为构建缓存失效），`lib.rs` 警告仍停在 1024 行（源码未改）；仍只有原有 2 条警告。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,951,616 字节（与上一版 09:10 的 11,951,616 相同），文件时间 2026-11-18T03:52:37Z（11:52:37 +08:00）
  - PE Machine `0x8664`（X64），ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `c9e91a0638491a8ab9ebc85ee161433d6e25c7af70dadd8202953e51aab5c32c`（上一版 `785e04ab…`，差异来自重新链接）
  - 内嵌前端校验：exe 内可检索到 `index-CIqDJdQ8.js`
- staged 可运行目录（含 runtime / harness-model 资源）：`C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-Y3enwk\dda-desktop.exe`
  - staged exe SHA-256 `c9e91a06…` 与裸 exe 完全一致
  - 资源逐字节比对（staged 与工作区 SHA-256）全部 MATCH：`runtime/src/controlled-tools.mjs`、`runtime/src/index.mjs`、`runtime/src/playwright-host.mjs`、`runtime/src/runtime-safety-monitor.mjs`、`runtime/src/safety-executor.mjs`、`runtime/src/harness-event-store.mjs`
  - `%LOCALAPPDATA%\dda\desktop-builds\latest.json` 已指向该目录
- 说明：`--no-bundle` 只产出裸 exe，不携带 runtime / harness-model 资源，验证 11:30 那批 runtime 改动须运行 staged 版；未启动 exe 做 GUI 冒烟。

## 第二十四次编译（2026-11-18 后续构建，dda 运行内完成）

- 触发：用户要求“执行一次本地 Windows 构建并验证产物”。
- 命令：在 `desktop/` 执行 `npm run build:windows:full-local:fast`，退出码 0（fast 变体；本轮未使用 `build:exe`）。
- **裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,951,616 字节（与第二十三次记录数值相同，属重新链接后的同尺寸产物）
  - PE 校验：`MZ` 有效、PE 签名存在，Machine `0x8664`（X64），64 位，Subsystem `WINDOWS_GUI`，6 个 section，非 DLL
  - 同目录保留旧备份 `dda-desktop.locked-before-20261117-215800.exe`（11,903,488 字节）
- 同一 release 目录内已存在的安装包：
  - `bundle/msi/dda_0.1.0_x64_en-US.msi` 12,476,171 字节；`dda_0.1.0_arm64_en-US.msi` 12,270,780 字节；旧名 `hmCodex_0.1.0_x64_en-US.msi` 11,981,832 字节
  - `bundle/nsis/dda_0.1.0_x64-setup.exe` 6,918,930 字节；`dda_0.1.0_arm64-setup.exe` 6,776,870 字节；旧名 `hmCodex_0.1.0_x64-setup.exe` 6,571,401 字节
- 本轮未观察到的项：产物 SHA-256、staged 目录路径与资源比对结果、GUI 冒烟启动。二进制检查工具只返回头部元数据，因此本节不登记新摘要。

## 第二十五次：产物摘要回填与新鲜度复核（只读，2026-11-18T10:40:53Z 产物）

> 本轮未重新编译；本节补上第二十四次编译明确缺失的产物摘要，判断当前产物以本节数据为准。

- 复核对象：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`（与本任务已记录的成功构建 `npm run build:windows:full-local`（exit=0）时间一致）。
  - 大小 11,951,104 字节，文件时间 2026-11-18T10:40:53.733Z（18:40:53 +08:00）。注意：第二十四次记录写作 11,951,616 字节且未登记摘要，与当前文件不一致，说明此后又发生了一次重新链接。
  - SHA-256 `07027a6d519c7a7eb40fca25e25bc6be7e1fcf9ebeeb330f3ef1362223f207c4`。
- PE 头（`workspace.inspect_binary`）：`format=PE`、`mz=MZ`、`peSignature=PE`、`machineHex=0x8664`、`architecture=X64`、`bits=64`、`subsystem=WINDOWS_GUI`、`dll=false`、`sectionCount=6`、`executable=true`、`sizeBytes=11951104`，与脚本侧数值互相印证。
- 内嵌前端校验：`desktop/dist/index.html` 当前声明 `assets/index-D5UVLL9s.js`，exe 内检索命中（`embeddedChunk=true`）；旧 chunk `index-CIqDJdQ8.js`、`index-Bz5Z96I5.js`、`index-oh7Yskeg.js`、`index-krdzGeKU.js` 全部不存在（`staleChunks=[]`）。
- 新鲜度（整树扫描，跳过 `node_modules`/`target*`/`dist`/`.git`/`bundle`）：`desktop/src` 最新 `src/main.ts` 2026-11-18T10:23:38.820Z、`desktop/src-tauri/src` 最新 `lib.rs` 2026-11-17T13:50:43.387Z、`runtime/src` 最新 `index.mjs` 2026-11-18T10:32:23.998Z；全部不晚于 exe，`anySourceNewerThanExe=false`。
- 安装包：`release/bundle/nsis/` 与 `release/bundle/msi/` 内仍是历史产物（`dda_0.1.0_x64-setup.exe` 6,918,930 字节、`dda_0.1.0_arm64-setup.exe` 6,776,870 字节、`hmCodex_0.1.0_x64-setup.exe` 6,571,401 字节；`dda_0.1.0_x64_en-US.msi` 12,476,171 字节、`dda_0.1.0_arm64_en-US.msi` 12,270,780 字节、`hmCodex_0.1.0_x64_en-US.msi` 11,981,832 字节），未重新打包（`bundle.targets` 仍为空数组）。
- 仍未覆盖：未启动 exe 做 GUI 冒烟（`WINDOWS_GUI` 子系统，无 `--help`/`--version`，启动会占用产物并弹出窗口）；staged 可运行目录位于 `%LOCALAPPDATA%\dda\desktop-builds\`（受保护路径），本轮未独立复核其路径与资源比对。

## 第二十六次编译（当前最新产物，2026-11-18T11:07:17Z）

> 判断当前产物以本节为准。

- 触发：用户要求"再编译 exe"。编译前取证发现 exe 已过期：`desktop/dist/index.html` 已指向 `assets/index-DtYKXeND.js`，而旧 exe（`07027a6d…`，11,951,104 字节，2026-11-18T10:40:53.733Z）内嵌的仍是 `index-D5UVLL9s.js`（`embedded=false`）；同时 `desktop/src/main.ts` 2026-11-18T11:02:42.387Z、`desktop/src/domain/approval-review.ts` 2026-11-18T11:00:30.208Z 晚于旧 exe。
- 占用检查：对旧 exe 做读写打开成功（`lockFree=true`），无需 `locked-before-*` 改名备份，未终止任何进程。
- 命令：在 `desktop/` 执行 `npm run build:windows:full-local`（内部 `npm run build` + `tauri build --target x86_64-pc-windows-msvc`，含 bundle），退出码 0，耗时约 244s；Rust 增量 `Finished \`release\` profile [optimized] target(s) in 3m 38s`。
- 前端重建：`dist/assets/index-CzaMEmI2.js`（474.64 kB）、`dist/assets/index-DJ_-lfQd.css`（73.12 kB），vite `built in 515ms`（82 modules）；`dist/assets/` 仅保留这三个文件（JS + JS map + CSS），无旧 chunk 残留。
- Rust 侧仍只有原有 2 条警告（`runtime_process_is_active` dead_code 位于 `lib.rs:1024`、链接器 stdout 非 UTF-8），不影响构建。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,951,616 字节，文件时间 2026-11-18T11:07:17.526Z（19:07:17 +08:00）
  - PE（`workspace.inspect_binary`）：`format=PE`、`mz=MZ`、`peSignature=PE`、`machineHex=0x8664`、`architecture=X64`、`bits=64`、`subsystem=WINDOWS_GUI`、`dll=false`、`sectionCount=6`、`executable=true`
  - SHA-256 `6947ad5c83fb8342cbebe646701e10f4749707055c1d47a8f72fcb0582e0263b`（上一版 `07027a6d…`）
  - 内嵌前端校验：`assets/index-CzaMEmI2.js` 与 `assets/index-DJ_-lfQd.css` 均命中（`embeddedJs=true`、`embeddedCss=true`）；旧 chunk `index-D5UVLL9s.js`、`index-DtYKXeND.js`、`index-CIqDJdQ8.js` 均不存在（`staleEmbedded=[]`）。
- 新鲜度（整树扫描，跳过 `node_modules`）：`desktop/src`、`desktop/src-tauri/src`、`runtime/src` 三棵树无任何晚于 exe 的文件（`sourceNewerThanExe=[]`）；最晚源码为 `desktop/src/main.ts` 2026-11-18T11:02:42.387Z。
- staged 可运行目录（含 runtime / harness-model 资源）：`C:\\Users\\User\\AppData\\Local\\dda\\desktop-builds\\build-x86_64-pc-windows-msvc-6wWJdA\\dda-desktop.exe`
  - 顶层内容：`dda-desktop.exe`、`openviking-server.exe`、`packages`、`runtime`
  - staged exe 11,951,616 字节，SHA-256 `6947ad5c…`，与裸 exe 逐字节一致（`matchBare=true`）
  - 资源逐字节比对（staged 与工作区 SHA-256）全部 `match=true`：`runtime/src/index.mjs`、`runtime/src/context-assembler.mjs`、`runtime/package.json`、`packages/harness-model/package.json`
  - `%LOCALAPPDATA%\\dda\\desktop-builds\\latest.json` 已指向该目录（`target=x86_64-pc-windows-msvc`、`profile=release`）
- 安装包：`bundle.targets` 仍为空数组，本轮未重新打包；`release/bundle/nsis/` 与 `release/bundle/msi/` 内仍是历史产物（`dda_0.1.0_x64-setup.exe` 6,918,930 字节等）。
- 说明：未启动 exe（`WINDOWS_GUI` 子系统，无 `--help`/`--version`，启动会占用产物并弹出窗口），因此"可启动性"未经运行验证；验证依据为 PE 头、SHA-256、内嵌 chunk/CSS、staged 逐字节比对与源文件时间戳。

## 第二十四次编译（当前最新产物，2026-11-19T03:57:34Z）

> 判断当前产物以本节为准。

- 触发：用户要求"再编译exe"。编译前 exe 为 11-19 09:15 的外部构建（SHA-256 `bf037fd9…`、chunk `index-C8f3FV9f.js`，10:38 的前端产物未进 exe）。源码时间线：`desktop/src/main.ts`（11:16）晚于 exe 与 dist，前端需重建；`desktop/src-tauri/src/lib.rs`（09:15:39）与 exe（09:15:21）几乎同时，Rust 也重编；runtime 有 11:20–11:33 的大批新改动（bundle resources）。共 23 个文件改动。
- 占用检查：`dda-desktop` 进程（PID 24600，11:02 启动）在运行，独占打开测试 OK（未锁 exe），无需改名备份；一次编译通过。
- 命令：在 `desktop/` 执行 `npm run build:exe`（VsDevCmd `-arch=x64` → `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时 8m42s；Rust 增量 `Finished release profile [optimized] target(s) in 7m 30s`。
- 前端重建：`dist/assets/index-C6pHg4SH.js`（478.50 kB）、`dist/assets/index-DJ_-lfQd.css`（73.12 kB），vite `built in 4.76s`（82 modules）；上一版 chunk 为 `index-C8f3FV9f.js`。vite 插件耗时提示为信息性警告。
- Rust 侧本轮重新编译了较多 crate（`vswhom-sys`、`embed-resource`、`tauri-build`、`tauri` 等，缓存仍失效），`lib.rs` 警告仍停在 1024 行；仍只有原有 2 条警告。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,957,760 字节（上一版 11,951,616，+6,144 B），文件时间 2026-11-19T03:57:34Z（11:57:34 +08:00）
  - PE Machine `0x8664`（X64），ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `5ed803d34112e5d15b506f5b0cfe8dd81bf9511e646ea884a0f9ce5ea9768036`
  - 内嵌前端校验：exe 内可检索到 `index-C6pHg4SH.js`，旧 chunk `index-C8f3FV9f.js` 已消失
- staged 可运行目录（含 runtime / harness-model 资源）：`C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-fvBAzN\dda-desktop.exe`
  - staged exe SHA-256 `5ed803d3…` 与裸 exe 完全一致
  - 资源逐字节比对（staged 与工作区 SHA-256）全部 MATCH：`runtime/src/index.mjs`、`runtime/src/controlled-tools.mjs`、`runtime/src/decision/build-test-verification.mjs`、`runtime/src/safety-policy.mjs`、`runtime/src/kernel/approval-session.mjs`、`runtime/src/rule-router.mjs`
  - `%LOCALAPPDATA%\dda\desktop-builds\latest.json` 已指向该目录
- 说明：`--no-bundle` 只产出裸 exe，不携带 runtime / harness-model 资源，验证 11:20 那批 runtime 改动须运行 staged 版；未启动 exe 做 GUI 冒烟。

## 第二十五次编译（当前最新产物，2026-11-20T07:23:27Z）

> 判断当前产物以本节为准。

- 触发：用户要求"再编译exe"。编译前 exe 为 11-20 14:14 的外部构建，前端 chunk `index-8zo4-Rds.js`（14:08，已进 exe）。源码时间线：`desktop/src`（最新 `main.ts` 10:56）与 Rust 源码（`lib.rs` 10:45）均早于 14:14 exe；真正的新改动是 14:46 的 `runtime/src/index.mjs`（bundle resources）。`lib.rs` 警告行号从 1024 变 1028，说明 Rust 源码有实质变化被本次重编纳入。
- 占用检查：`dda-desktop` 进程（PID 20388，14:22 启动）在运行，独占打开测试 OK（未锁 exe），无需改名备份；一次编译通过。
- 命令：在 `desktop/` 执行 `npm run build:exe`（VsDevCmd `-arch=x64` → `tauri build --target x86_64-pc-windows-msvc --no-bundle`），退出码 0，耗时 8m11s；Rust 增量 `Finished release profile [optimized] target(s) in 7m 22s`。
- 前端重建：`dist/assets/index-8zo4-Rds.js`（477.35 kB）、`dist/assets/index-DJ_-lfQd.css`（73.12 kB），vite `built in 3.65s`（83 modules）；chunk 名与 14:14 版一致（前端源码未再变化）。vite 插件耗时提示为信息性警告。
- Rust 侧本轮重新编译了较多 crate（`vswhom-sys`、`embed-resource`、`tauri-build`、`tauri` 等，缓存仍失效），`lib.rs` 警告行号 1024→1028；仍只有原有 2 条警告。
- **当前裸 exe**：`desktop/src-tauri/target/x86_64-pc-windows-msvc/release/dda-desktop.exe`
  - 11,965,440 字节（上一版 11,951,616，+13,824 B），文件时间 2026-11-20T07:23:27Z（15:23:27 +08:00）
  - PE Machine `0x8664`（X64），ProductName `dda`，FileVersion `0.1.0`
  - SHA-256 `91e004c1b6e966050987c9ddcb85b058da16c3bd0c2f61413312e8d9e44c4a45`
  - 内嵌前端校验：exe 内可检索到 `index-8zo4-Rds.js`
- staged 可运行目录（含 runtime / harness-model 资源）：`C:\Users\User\AppData\Local\dda\desktop-builds\build-x86_64-pc-windows-msvc-KCefO2\dda-desktop.exe`
  - staged exe SHA-256 `91e004c1…` 与裸 exe 完全一致
  - 资源逐字节比对（staged 与工作区 SHA-256）全部 MATCH：`runtime/src/index.mjs`、`runtime/src/decision/plan-tier.mjs`、`runtime/src/decision/pptx-metadata.mjs`、`runtime/src/kernel/resident-kernel.mjs`、`runtime/src/deliverable-verifier.mjs`、`runtime/src/memory-verifier.mjs`
  - `%LOCALAPPDATA%\dda\desktop-builds\latest.json` 已指向该目录
- 说明：`--no-bundle` 只产出裸 exe，不携带 runtime / harness-model 资源，验证 14:46 的 runtime 改动须运行 staged 版；未启动 exe 做 GUI 冒烟。
