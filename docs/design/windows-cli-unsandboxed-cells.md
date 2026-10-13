# dda Phase-2b follow-on: Windows unsandboxed code cells (Prime-aligned)

Status: **FROZEN (Grok GO)** for the original windows-cli arm — implemented and merged as [#23](https://github.com/oliverypf/dda/pull/23) (`99e79cb`). Desktop follow-on is [#24](https://github.com/oliverypf/dda/pull/24) (`2b97122`).
Base: Phase-2b (#21 journal + OS sandbox + cells), Linux semantics unchanged.
Grok 4.7 recheck #1: GO-WITH-NITS (folded). Recheck #2: **GO**.
Amendment (desktop design lock): Non-goals Job Object line now allows KILL_ON_JOB_CLOSE-only reaping; journal path split vs windows-desktop — see UI draft.
Companion UI draft `docs/design/windows-desktop-code-cells.md`: **FROZEN (Grok GO)** (recheck #4); 鹏飞 2026-10-13 said 开干 — UI/desktop impl in progress.
**Amendment (Grok UI recheck #1 BLOCKED → CLI consistency):** desktop arm on the same `codeCellsAvailability` function; `windows-cli`+`DESKTOP_CELLS`→`PLATFORM_IDENTITY_MISMATCH`; `linux×windows-desktop`→`PLATFORM_IDENTITY_MISMATCH` (closes bwrap fall-through); runtime journal default by identity + legacy migration; resident attach does **not** require `WINDOWS_UNSANDBOXED`. Full desktop product semantics live only in `docs/design/windows-desktop-code-cells.md`. The earlier header claim “CLI 部分的语义不改（除 Job Object 交叉引用）” is **corrected** by this amendment.
**Amendment (Grok UI recheck #2 BLOCKED → CLI consistency):** desktop arm runs **before** `CODE_CELLS_DISABLED` (**only** `win32 × windows-desktop` never yields `CODE_CELLS_DISABLED`; other OS + `windows-desktop` still uses the generic path); `sessionKeep` ⇔ `DDA_RESIDENT_KERNEL` truthy, threaded into both `codeCellsAvailability` calls; on `win32` × `windows-desktop`, `index.mjs` calls availability even when `CODE_CELLS` unset and resolves identity journal path first; `CellHost.start` passes the same `sessionKeep`/`nodeVersion`; resident desktop attach **rewrites** the existing `kernel-feature.test.mjs` assertion (does not add a second test); READY must send `sandbox:'none'`; mismatch tests need `CODE_CELLS`+resident+journal so the generic path reaches identity; desktop tool copy uses its own branch key.
**Amendment (Grok UI recheck #3 GO-WITH-NITS → CLI consistency):** narrow “never `CODE_CELLS_DISABLED`” to `win32 × windows-desktop` only (`linux × windows-desktop` without `CODE_CELLS` stays `CODE_CELLS_DISABLED`); unset `DDA_PLATFORM` stays on the generic path — availability compares the raw string `windows-desktop` and does **not** use `resolvePlatformIdentity` (unset→windows-desktop); fall-through closure is **explicit** `DDA_PLATFORM=windows-desktop` on linux; `DDA_KERNEL_CODE_CELLS` is the master switch on the **generic path only** (desktop arm does not read it); `kernel-session.json` path is only `%LOCALAPPDATA%\hmCodex\journal\<identity>\kernel-session.json`.

Reference: Prime Agent on Windows runs resident kernel/worker under user permissions; OS sandbox is Linux bubblewrap / macOS sandbox-exec only; official warning: not a security sandbox. Node `vm` is also **not** a security boundary (timeout/async escapes known) — same residual risk as Prime; must appear in Windows tool copy + docs.

## Amendment vs older Phase-2 docs

`docs/RESIDENT_KERNEL_PHASE2_DESIGN.md` said code cells presuppose an OS sandbox and listed Windows as a Phase-2a non-goal. **This draft amends:** Linux cells still require OS sandbox; Windows unsandboxed cells are a **flagged exception**; effects + portable Linux identity set do **not** change.

## Goal

Enable Phase-2b `kernel.exec` code cells on native Windows without inventing Job Object / AppContainer OS isolation. Match Prime’s product stance: lifecycle isolation yes, security sandbox no.

## Non-goals

- Job Objects / AppContainers / Hyper-V / Docker-as-default **as a security sandbox** (still non-goal). **Exception (windows-desktop cells, and CLI if it adopts the same reaper):** `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` may be used **only** to reap runtime/worker process trees on host exit — document explicitly 「不是沙箱」; must not be described as OS isolation and must not conflict with `WINDOWS_NO_OS_SANDBOX`. See `docs/design/windows-desktop-code-cells.md` §3 / §11. Job Object **create failure** is not cells unavailability and is not a sandbox error; fall back to cancel + `taskkill /T`. `CREATE_BREAKAWAY_FROM_JOB` / nested-job assignment only as reaping mechanics if the host is already in a job.
- Weakening Linux fail-closed (no bwrap → cells unavailable)
- macOS (leave blocked / unchanged this round)
- Claiming FS deny-write / net / exec canaries on Windows
- Enabling Phase-2a write effects (`fs.write` / `fs.patch` / `test.run`) on Windows
- Putting `windows-cli` **or** `windows-desktop` into `PORTABLE_CLI_PLATFORMS` / `isLinuxCliPlatform`
- Making `detectKernelSandbox` return available for all win32
- Shared skip-canary env flag on the Linux `cell-worker.mjs`
- Sharing one effect-journal file between `windows-cli` and `windows-desktop` (STARTED→UNKNOWN rehydrate must not clobber the other identity). Paths: `%LOCALAPPDATA%\hmCodex\journal\windows-cli\` vs `...\journal\windows-desktop\` — see UI draft §6.1 and Journal defaults below.

## Flags (all default OFF)

| Flag | Role |
|------|------|
| `DDA_RESIDENT_KERNEL=1` | Resident kernel master (still required for cells; attach itself does **not** require cells flags) |
| `DDA_KERNEL_CODE_CELLS=1` | Master cells switch on the **generic path only**; the desktop arm (`win32 × windows-desktop`) does **not** read it |
| `DDA_KERNEL_WINDOWS_UNSANDBOXED=1` | **Win32-only explicit confirm** — required with CODE_CELLS for the windows-cli cells arm; neither alone is enough. **Not** required for resident attach. |
| `DDA_KERNEL_WINDOWS_DESKTOP_CELLS=1` | **Desktop-only** cells confirm (Tauri-injected). On `windows-cli` identity → `PLATFORM_IDENTITY_MISMATCH`. See UI draft. |
| `DDA_KERNEL_SANDBOX` | Linux OS-sandbox switch only |
| `DDA_PLATFORM=windows-cli` | Windows CLI identity (**reuse existing**; do not invent / do not fold into linux-cli set) |
| `DDA_PLATFORM=windows-desktop` | Windows desktop identity (runtime default when unset; cells arm specified only in UI draft) |

Truthy parser: existing (`1` / `true` / `on` / `yes` / `enabled`). Unset / `0` = off. `DDA_KERNEL_WINDOWS_DESKTOP_CELLS` uses the same parser.

Also required for cells: Node ≥ 24, writable journal (`JOURNAL_UNAVAILABLE` if not), resident attach (`KERNEL_NOT_ATTACHED` if not). Desktop arm adds `sessionKeep` and `DESKTOP_CELLS` — see UI draft §2.2.

### `DDA_KERNEL_SANDBOX` on Windows

**Hard error** if truthy on win32 → cells unavailable, reason e.g. `SANDBOX_UNSUPPORTED_ON_WINDOWS`. Same refuse if truthy together with `WINDOWS_UNSANDBOXED`. Unset/off: do not consult it; still report `sandbox.available: false`. Do not wire `DDA_KERNEL_SANDBOX_OP_WORKER` into this path. Do **not** OR `WINDOWS_UNSANDBOXED` into `isKernelSandboxEnabled` globally.

## Platform identity — **reuse** `windows-cli`; desktop arm is additive

- Do **not** add `windows-cli` or `windows-desktop` to `PORTABLE_CLI_PLATFORMS` / `isLinuxCliPlatform` (that also aliases `isPortableCliPlatform` and gates effects, XDG vs `%LOCALAPPDATA%`, executor).
- `windows-cli` already exists (`detectCliHost` on win32, restricted-windows executor).
- `windows-desktop` is **no longer blanket-refused** for cells: the desktop arm is specified only in the UI draft (`docs/design/windows-desktop-code-cells.md`). This CLI draft keeps the **windows-cli** success path unchanged and adds the mismatch / fall-through closures below.
- Pair identity with `process.platform`: refuse both mismatch directions **before** any sandbox probe (except the explicit desktop arm).

## Availability — single injected `platform` argument

`codeCellsAvailability` (and OS-sandbox detect used from it) must take `platform` (default `process.platform`), same pattern as `residentKernelAvailability`. One availability function is the **only** cells gate (including `runtime/src/index.mjs` ~2215 — stop requiring `isKernelSandboxEnabled` for cells start; call `codeCellsAvailability` + `cellHost.start().ready` instead).

**Gate split (must stay true):** `residentKernelAvailability` does **not** read cells flags (`CODE_CELLS` / `WINDOWS_UNSANDBOXED` / `DESKTOP_CELLS`). Only `codeCellsAvailability` uses the identity × cells table.

### `sessionKeep` / call-site threading (Grok UI recheck #2)

- `sessionKeep === true` **only when** `DDA_RESIDENT_KERNEL` is truthy. The session-keep path alone sets/clears that var; the cells toggle does not.
- `residentAvailable === (residentKernel.attached === true)`.
- When **`win32` and** `DDA_PLATFORM=windows-desktop` (raw string), `index.mjs` calls `codeCellsAvailability` **even if** `DDA_KERNEL_CODE_CELLS` is unset (`win32 × windows-desktop` must not be masked by `CODE_CELLS_DISABLED`), and resolves the identity journal path **before** that call so `journalAvailable` reflects writability. Unset `DDA_PLATFORM` does **not** enter this arm. Other OS + `windows-desktop` stays on the generic path (may return `CODE_CELLS_DISABLED`).
- `CellHost.start` passes the **same** `sessionKeep` and `nodeVersion` into its second `codeCellsAvailability` call.

Pseudocode (revised; desktop arm **before** `CODE_CELLS_DISABLED` + mismatch closures):

```
codeCellsAvailability({ env, platform = process.platform, journalAvailable, residentAvailable,
                        nodeVersion = process.version,
                        sessionKeep /* true only when DDA_RESIDENT_KERNEL truthy */ }):
  # --- Desktop arm FIRST (only win32 × windows-desktop) ---
  # BEFORE CODE_CELLS_DISABLED. win32 × windows-desktop never returns CODE_CELLS_DISABLED.
  # Any other OS with DDA_PLATFORM=windows-desktop still uses the generic path below,
  # so linux × windows-desktop without CODE_CELLS stays CODE_CELLS_DISABLED.
  # Compares raw env string 'windows-desktop' — does NOT call resolvePlatformIdentity
  # (which maps unset → windows-desktop). Unset therefore stays on the generic path.
  # Desktop arm does not read DDA_KERNEL_CODE_CELLS.
  if platform === 'win32' && env.DDA_PLATFORM === 'windows-desktop':
    if major(nodeVersion) < 24 → NODE_TOO_OLD
    if !sessionKeep → DESKTOP_SESSION_KEEP_REQUIRED
    if !residentAvailable → KERNEL_NOT_ATTACHED
    if !journalAvailable → JOURNAL_UNAVAILABLE
    if !DESKTOP_CELLS → WINDOWS_DESKTOP_CELLS_REQUIRED
    if isTruthy(DDA_KERNEL_SANDBOX) → SANDBOX_UNSUPPORTED_ON_WINDOWS
    if !WINDOWS_UNSANDBOXED → WINDOWS_UNSANDBOXED_REQUIRED
    return {
      available: true,
      reason: 'WINDOWS_NO_OS_SANDBOX',
      sandbox: { available: false, reason: 'NON_LINUX_PLATFORM', backend: null }
    }

  # --- Generic order (windows-cli success path reason priority UNCHANGED) ---
  if !CODE_CELLS → CODE_CELLS_DISABLED
  if !residentAvailable → KERNEL_NOT_ATTACHED
  if !journalAvailable → JOURNAL_UNAVAILABLE

  # Identity × OS mismatches — before sandbox probe
  if env.DDA_PLATFORM === 'windows-cli' && platform !== 'win32'
    → PLATFORM_IDENTITY_MISMATCH
  if env.DDA_PLATFORM === 'windows-cli' && isTruthy(DESKTOP_CELLS)
    → PLATFORM_IDENTITY_MISMATCH   # CLI must not accept desktop flag
  if platform === 'linux' && env.DDA_PLATFORM === 'windows-desktop'
    → PLATFORM_IDENTITY_MISMATCH   # explicit only; closes fall-through to bwrap. Unset ≠ windows-desktop here.
                                   # Without CODE_CELLS this line is never reached (generic path returns CODE_CELLS_DISABLED first).
                                   # linux-cli/portable stay on sandbox path
  if platform === 'win32' && env.DDA_PLATFORM !== 'windows-cli'
    → PLATFORM_IDENTITY_MISMATCH   # other win32 identities; unset is NOT routed through desktop arm
                                   # (desktop arm requires raw string windows-desktop; unset stays generic → lands here)

  if platform === 'win32':
    # identity is windows-cli here
    if isTruthy(DDA_KERNEL_SANDBOX) → SANDBOX_UNSUPPORTED_ON_WINDOWS
    if !WINDOWS_UNSANDBOXED → WINDOWS_UNSANDBOXED_REQUIRED
    return {
      available: true,
      reason: 'WINDOWS_NO_OS_SANDBOX',  # callers key off boolean available, not reason === 'AVAILABLE'
      sandbox: { available: false, reason: 'NON_LINUX_PLATFORM', backend: null }
    }

  # Linux OS-sandbox path only (WINDOWS_UNSANDBOXED / DESKTOP_CELLS must be ignored here)
  # linux-cli + portable set only; windows-desktop already refused above
  sandbox = detectKernelOsSandbox(env, platform)
  if !sandbox.available → sandbox.reason
  return { available: true, reason: 'AVAILABLE', sandbox }
```

**Health vs live session-keep:** on a fresh per-invoke health spawn, the desktop arm stops at `NODE_TOO_OLD` or `DESKTOP_SESSION_KEEP_REQUIRED`. Steps `KERNEL_NOT_ATTACHED` / `JOURNAL_UNAVAILABLE` / `WINDOWS_DESKTOP_CELLS_REQUIRED` are only observable on a live session-keep process.

### Resident attach on Windows (cells prerequisite; **not** cells auth)

- Allow attach when `platform === 'win32' && DDA_PLATFORM === 'windows-cli'` with only `DDA_RESIDENT_KERNEL=1` + Node ≥ 24 — **without** requiring OS sandbox, **without** requiring `WINDOWS_UNSANDBOXED` / `CODE_CELLS` / `DESKTOP_CELLS`.
- New attach arm: `platform === 'win32' && DDA_PLATFORM === 'windows-desktop'` under the **same** resident + Node rules (also does **not** require `DESKTOP_CELLS` / `WINDOWS_UNSANDBOXED`). Product details in UI draft.
- `sandboxAvailable` stays **false** on both Windows attach arms.
- Do **not** treat `DDA_RESIDENT_KERNEL_SANDBOX=1` override as authorization for Windows cells, and it must **not** light `sandboxAvailable`.
- **Test (`kernel-feature.test.mjs`, recheck #2 + #3 nit — rewrite existing assertion, do not add a second test):** rewrite the existing assertion that expects `win32` × `windows-desktop` resident → `available: false` (the one nested inside the windows-cli-related case) into the new attach case: `win32` × `windows-desktop` × `DDA_RESIDENT_KERNEL` × Node ≥ 24 with `DESKTOP_CELLS` and `WINDOWS_UNSANDBOXED` **unset** → `available: true`, `sandboxAvailable: false`. Same assertion also covers `DDA_RESIDENT_KERNEL_SANDBOX=1` still → `sandboxAvailable: false`.
- Phase-2a **write** effects stay on `isLinuxCliPlatform` → still refused on Windows.
- Phase-1 **read** kernel tools (`kernel.workspace_*`, `kernel.session_*`, inert `kernel.host_request`): register the **same** surface as Linux (needed for readonly bridge). Document that; not a Windows-only hidden set.
- Cell write `host.request` stays `KERNEL_SIDE_EFFECT_REFUSED` when effects identity/flags disallow.

## Journal defaults (identity split + legacy migration)

When `DDA_PLATFORM` is `windows-cli` or `windows-desktop` and neither `DDA_KERNEL_EFFECT_JOURNAL` nor `--kernel-effect-journal` is set, runtime defaults to:

`%LOCALAPPDATA%\hmCodex\journal\<identity>\kernel-effect-journal.json` (+ same-dir `.lock`)

**Never** fall back to `%LOCALAPPDATA%\hmCodex\kernel-effect-journal.json`.

- Legacy root file is migrated **once by windows-cli only** (desktop cells never wrote that journal). Migration turns `STARTED` → `UNKNOWN`.
- `kernel-session.json` path is **only** `%LOCALAPPDATA%\hmCodex\journal\<identity>\kernel-session.json` (same identity subdirectory; no alternate sibling path).
- Linux / portable layouts unchanged.

## Spawn / canary

| | Linux (existing) | Windows (new) |
|--|--|--|
| Entrypoint | existing sandboxed worker | **Separate entrypoint** selected only by win32 spawn — **not** an env skip-canary on shared `cell-worker.mjs` |
| Spawn | bwrap + seccomp shim / canary | `spawnUnsandboxedCellWorker`: bare `node`, `shell: false`, `env: buildRuntimeEnv(...)` (strip secrets / `NODE_OPTIONS`), **not** raw `process.env` |
| Canary | FS deny-write + net/exec as today | **None** — no half-fake canary |
| Ready | `ready` after canary | protocol **`ready` only**; payload must include `warning: 'WINDOWS_NO_OS_SANDBOX'` **and** `sandbox: 'none'` (today has `backend: 'unsandboxed'`; add `sandbox: 'none'` alongside) |
| Epoch / host.request / journal leases | unchanged where platform-agnostic | same |

Desktop reuses the same `cell-worker-windows.mjs` entrypoint; no second fork. See UI draft §3. READY must send `sandbox: 'none'` next to `warning: 'WINDOWS_NO_OS_SANDBOX'` (UI draft §4 badge predicate).

## Docs / UX / events

- `docs/RESIDENT_KERNEL_PHASE2B.md` Windows section: flags, reuse `windows-cli`, Prime + vm residual-risk warning, Linux still the isolation path; note desktop arm lives in UI draft.
- `registerKernelExecTool`: Windows registration uses different description (must **not** say “OS-sandboxed”). Desktop cells need their **own branch key** (e.g. by `DDA_PLATFORM === 'windows-desktop'`); copy mentions `windows-desktop` + `DDA_KERNEL_WINDOWS_DESKTOP_CELLS` and keeps “NOT a security sandbox”. Do **not** key only on a shared `windowsUnsandboxed` boolean — that overwrites the CLI string.
- `kernel.cells_ready` (and similar) must carry the same not-a-security-sandbox warning. UI badge predicate is **only** `warning === 'WINDOWS_NO_OS_SANDBOX'` and `sandbox === 'none'` from worker READY — not the `cells_ready` token (UI draft §4).
- Success reason `WINDOWS_NO_OS_SANDBOX` ≠ `'AVAILABLE'`; all callers use boolean `available`.

## Test plan

- `platform=win32` + `windows-cli` + CODE_CELLS + WINDOWS_UNSANDBOXED (+ resident/journal) → available, reason `WINDOWS_NO_OS_SANDBOX`; no bwrap canary; sandbox.available false. **Reason priority on this success path unchanged.**
- win32 + CODE_CELLS without WINDOWS_UNSANDBOXED → `WINDOWS_UNSANDBOXED_REQUIRED`.
- win32 + `linux-cli` → `PLATFORM_IDENTITY_MISMATCH`.
- linux + `windows-cli` (+ sandbox would otherwise be available) → `PLATFORM_IDENTITY_MISMATCH` (must not fall through to sandboxed cells).
- **linux × windows-desktop** → `PLATFORM_IDENTITY_MISMATCH` (must not fall through to bwrap); linux-cli / portable stay on sandbox path. Fixture must set `CODE_CELLS` + `residentAvailable` + `journalAvailable` so the generic path reaches identity mismatch.
- **windows-cli + DESKTOP_CELLS** → `PLATFORM_IDENTITY_MISMATCH`. Same fixture prerequisites (`CODE_CELLS` + resident + journal).
- win32 + truthy `DDA_KERNEL_SANDBOX` → `SANDBOX_UNSUPPORTED_ON_WINDOWS`.
- linux without bwrap → fail-closed (regression); `WINDOWS_UNSANDBOXED` must not substitute.
- `index.mjs` cells start path uses `codeCellsAvailability`, not `isKernelSandboxEnabled` alone. On `windows-desktop`, call even when `CODE_CELLS` unset; resolve identity journal path first; thread `sessionKeep`/`nodeVersion` into both availability calls (`CellHost.start` included).
- Injected `platform` argument exercises win32 arm on a Linux test host.
- Desktop-arm tests (rewrite `:72` → `WINDOWS_DESKTOP_CELLS_REQUIRED`; full flags + sessionKeep → available; reason order; **`win32 × windows-desktop`** never yields `CODE_CELLS_DISABLED`, while `linux × windows-desktop` without `CODE_CELLS` stays `CODE_CELLS_DISABLED`; health spawn stops at `NODE_TOO_OLD` / `DESKTOP_SESSION_KEEP_REQUIRED`) — see UI draft §9.
- Resident attach: win32 × windows-cli **without** `WINDOWS_UNSANDBOXED` still attaches; `sandboxAvailable` false.
- **Resident attach desktop (`kernel-feature.test.mjs`; rewrite existing, no second test):** same as Resident attach section above — rewrite the nested `win32×windows-desktop` → `available:false` assertion into the new attach case (`available: true`, `sandboxAvailable: false`; `DDA_RESIDENT_KERNEL_SANDBOX=1` still false).
- Worker READY on Windows sends `sandbox: 'none'` alongside `warning: 'WINDOWS_NO_OS_SANDBOX'`.

## Locked answers (from Grok recheck #1)

1. Separate / **reuse** `windows-cli`; do not expand portable linux set; refuse both mismatch directions.
2. Do **not** light Phase-2a write effects; resident process attaches; Phase-1 reads OK; `sandboxAvailable` false.
3. `DDA_KERNEL_SANDBOX=1` on Windows → **hard error**.
4. Recheck #2: **GO**. Residual docs notes folded below (non-blocking).

## Locked amendments (from Grok UI recheck #1 → CLI consistency)

1. Desktop arm exists on `codeCellsAvailability` (specified only in UI draft); frozen “refuse all non-windows-cli win32 identities” is amended.
2. `windows-cli` + `DESKTOP_CELLS` → `PLATFORM_IDENTITY_MISMATCH`.
3. `linux` × `windows-desktop` → `PLATFORM_IDENTITY_MISMATCH` (closes bwrap fall-through); linux-cli / portable unchanged on sandbox path.
4. Resident attach does **not** require `WINDOWS_UNSANDBOXED` (or other cells flags); desktop attach arm same rule.
5. Journal runtime default by identity; never fall back to root `hmCodex\kernel-effect-journal.json`; legacy migration once by windows-cli only; `kernel-session.json` same identity subdir.

## Locked amendments (from Grok UI recheck #2 BLOCKED → CLI consistency)

1. Desktop arm runs **before** `CODE_CELLS_DISABLED`; **`win32 × windows-desktop`** never yields `CODE_CELLS_DISABLED` (narrowed in recheck #3; see below).
2. `sessionKeep` ⇔ `DDA_RESIDENT_KERNEL` truthy; `residentAvailable` ⇔ `attached === true`; **win32** desktop `index.mjs` calls availability even when `CODE_CELLS` unset; resolve identity journal before the call; `CellHost.start` passes same `sessionKeep`/`nodeVersion`.
3. Resident desktop test in `kernel-feature.test.mjs` — **rewrite** existing `win32×windows-desktop` → `available:false` assertion into the new attach case (no second test); `sandboxAvailable` stays false even with `DDA_RESIDENT_KERNEL_SANDBOX=1`.
4. READY must send `sandbox: 'none'`; mismatch fixtures need `CODE_CELLS`+resident+journal; desktop tool copy uses its own branch key (not a shared `windowsUnsandboxed` overwrite).

## Locked amendments (from Grok UI recheck #3 GO-WITH-NITS → CLI consistency)

1. Narrow “never `CODE_CELLS_DISABLED`” to **`win32 × windows-desktop` only**. Other OS + `windows-desktop` stays on the generic path → `linux × windows-desktop` without `CODE_CELLS` stays `CODE_CELLS_DISABLED`.
2. Unset `DDA_PLATFORM` stays on the generic path. `codeCellsAvailability` compares the raw string `windows-desktop` and does **not** use `resolvePlatformIdentity` (unset→windows-desktop). Fall-through closure is **explicit** `DDA_PLATFORM=windows-desktop` on linux.
3. `DDA_KERNEL_CODE_CELLS` is the master switch on the **generic path only**; the desktop arm does not read it.
4. Fresh `health` only surfaces desktop-arm steps 1–2 (`NODE_TOO_OLD` / `DESKTOP_SESSION_KEEP_REQUIRED`); steps 3–5 come from the live session-keep process (UI §1 / §2.2).
5. `kernel-session.json` path is **only** `%LOCALAPPDATA%\hmCodex\journal\<identity>\kernel-session.json` (no alternate sibling path).
6. Rewrite the existing `kernel-feature.test.mjs` `win32×windows-desktop` resident `available:false` assertion into the new attach case; do not add a second parallel test.

## Still out of scope

macOS; Job Objects **as sandbox** (KILL_ON_JOB_CLOSE-only reaping exception above); HarmonyOS native cells path; windows-desktop cells **product UI** (tracked in `docs/design/windows-desktop-code-cells.md` — availability arm is amended here for consistency only).

## Residual notes (GO, non-blocking)

1. Spawn table “bare `node`” = host `nodeBinary` (`process.execPath`), `shell: false`, same pattern as `resident-kernel.mjs`.
2. vm / not-a-security-sandbox warning applies to Windows `kernel.exec` description and Windows `kernel.cells_ready` payload only; Linux `AVAILABLE` / bwrap copy stays OS-sandbox wording.
3. `SANDBOX_UNSUPPORTED_ON_WINDOWS` test is the identity-matched arm (`win32` + `windows-cli`); mismatch stays `PLATFORM_IDENTITY_MISMATCH`.
4. When writing docs: update **both** `docs/RESIDENT_KERNEL_PHASE2_DESIGN.md` (amendment) and `docs/RESIDENT_KERNEL_PHASE2B.md` (Windows section).
