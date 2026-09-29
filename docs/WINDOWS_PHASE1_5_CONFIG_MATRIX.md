# Windows 阶段 1.5/2 配置矩阵（Controlled 配置矩阵）

本文件落实 [WINDOWS_PHASE2_IMPLEMENTATION_PLAN.md](WINDOWS_PHASE2_IMPLEMENTATION_PLAN.md) S2-00 的“配置矩阵”交付：明确默认关闭、显式启用、开发模式和发布模式的差异。矩阵以当前代码为事实源，不以意图或摘要为准。

## 1. 构建期与运行期事实源

| 阶段 | 构建入口 | 构建期变量 | 熔断到制品内的 channel |
| --- | --- | --- | --- |
| Phase 1 只读 | `npm run build:windows:phase1`（`desktop/scripts/build-phase1.mjs`） | `HMCODEX_BUILD_RELEASE_CHANNEL=WINDOWS_PHASE1_READ_ONLY` | `WINDOWS_PHASE1_READ_ONLY` |
| Phase 1.5 受控 | `npm run build:windows:phase15`（`desktop/scripts/build-controlled.mjs`） | `HMCODEX_BUILD_RELEASE_CHANNEL=WINDOWS_PHASE1_5_CONTROLLED` | `WINDOWS_PHASE1_5_CONTROLLED` |
| Phase 2 全本地 | `npm run build:windows:full-local`（`desktop/scripts/build-full-local.mjs`） | `HMCODEX_BUILD_RELEASE_CHANNEL=WINDOWS_FULL_LOCAL` | `WINDOWS_FULL_LOCAL` |
| 开发构建 | `npm run dev` / `tauri dev`（不经过上述脚本） | 不设置该变量 | 无熔断 channel |

`desktop/src-tauri/build.rs` 只接受四个合法值并在编译期写入 `HMCODEX_BAKED_RELEASE_CHANNEL`；制品内 bake 的 channel 是发布模式的唯一权威。三个发布构建脚本在构建前删除 `NAPI_RS_NATIVE_LIBRARY_PATH` 与 `NAPI_RS_FORCE_WASI`，避免污染前端/原生构建。

## 2. 四态矩阵

| 维度 | 默认关闭（默认值） | 显式启用（受控/全本地） | 开发模式 | 发布模式（只读/受控/全本地） |
| --- | --- | --- | --- | --- |
| channel 来源 | `HMCODEX_BAKED_RELEASE_CHANNEL` 与 `HMCODEX_RELEASE_CHANNEL` 都缺失时取 `WINDOWS_MVP_PRE_PHASE1` | 由构建脚本 bake 到制品 | 无 bake，可显式设置 `HMCODEX_RELEASE_CHANNEL` 做本地验证 | bake 固定；运行期环境变量不能覆盖或降级 |
| 非法 channel | `RELEASE_CHANNEL_INVALID` | 同左 | 同左 | 同左 |
| 执行 mode | 默认拒绝副作用；只读动作可用 | 需要 workspace grant + capability + 模型 binding，动作再走 intent/approval/lease | 与显式启用相同，但只用于开发验证 | 只读 channel 强制 `mode=READ_ONLY`，其它 mode 抛 `RELEASE_CHANNEL_READ_ONLY` |
| 缺配置 | 默认拒绝，不创建副作用 operation | `capability`、workspace grant、Policy 或模型 binding 任一缺失即拒绝 | 同上 | 同上 |
| 任务存储 | 任意可用 store | 任意可用 store；受控发布要求 durable store | 任意可用 store | `WINDOWS_PHASE1_READ_ONLY` 要求 `.db`，否则 `RELEASE_CHANNEL_SQLITE_REQUIRED` |
| 插件签名 | 未签名插件可在开发模式加载并醒目标记 | `WINDOWS_PHASE1_5_CONTROLLED` / `WINDOWS_FULL_LOCAL` 要求可信签名，否则 `PLUGIN_SIGNATURE_REQUIRED` | 未签名开发插件仅在此模式运行 | 同“显式启用”，签名与来源/manifest/API 兼容/digest 一并校验 |
| retention 观察 | 独立后台任务，不参与授权判定 | 同左 | 同左 | 同左 |
| 可发布性 | 不是发布候选 | 受控链路与安全门通过后发布 `WINDOWS_PHASE1_5_CONTROLLED` | 永远不是发布候选 | 通过 release-check 后才可作为发布候选 |

## 3. 解析顺序与拒绝语义

1. `resolveReleaseChannel()` 读取 `HMCODEX_BAKED_RELEASE_CHANNEL`，缺失时回退 `HMCODEX_RELEASE_CHANNEL`，仍缺失则回退 `WINDOWS_MVP_PRE_PHASE1`；不在合法集合内抛 `RELEASE_CHANNEL_INVALID`。
2. 存在构建期 bake 时，运行期 `HMCODEX_RELEASE_CHANNEL` 不能改变实际 channel（`release-channel.test.mjs` 的“a baked release channel cannot be downgraded by the runtime environment”）。
3. 只读 channel 的 mode 与 store 约束在创建副作用 operation 之前生效。
4. 受控/全本地 channel 的插件加载在签名校验失败时于 governance 记录创建前拒绝。
5. Runtime Safety Monitor 默认 `READ_ONLY`，任何副作用在 spawn 之前拒绝。

## 4. 证据

- `runtime/test/release-channel.test.mjs` 6/6：Phase 1 拒绝 controlled mode、非法 channel 失败关闭、durable SQLite 要求、baked channel 不可被环境降级。
- `desktop/scripts/build-phase1.test.mjs`、`desktop/scripts/build-controlled.test.mjs`：构建期 channel 固定与污染变量清理。
- `runtime/test/plugin-signature.test.mjs`：发布频道未签名插件抛 `PLUGIN_SIGNATURE_REQUIRED`。
- `runtime/test/safety-executor.test.mjs`：默认 `READ_ONLY` 且在 spawn 前拒绝全部副作用。
- `docs/artifacts/WINDOWS_PHASE2_RELEASE_CHECK_FULL_LOCAL_2026-09-11.json`：`WINDOWS_FULL_LOCAL` 候选 release-check 8/8 通过。
