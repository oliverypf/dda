# offloop — contrast-probe meta (Harness² closed hook)

Off-loop **Propose → Probe L0 → (optional L1 smoke) → Compose** for DDA bench **CLOSED MISS** or **path-anomaly（路径异常）**, wired by a **CLOSED hook**.

- **Does not** modify `oliverypf/dda` runtime host.
- Scripts live only under `dda-drive/offloop/`; outputs under `dda-drive/`.
- Win = scriptable green **and** poison-loop count == 0 (else false win).
- Compose writes **CANDIDATE** only (never auto-FROZEN); default path-anomaly remains EXPERIENCE-only. Only an allowlisted steal hypothesis with Probe adoption and complete pinned soft evidence can become CANDIDATE. Merged sticky-execute (#83/#84) is rejected as `shipped_duplicate` with EXPERIENCE and 0 candidate writes.
- Runtime must **0×** read `dda-drive/experience/` as unchecked Memory.
- EXPERIENCE（教训库）is retrieved into Propose as `prior` refs (Harness² improvement library).
- **CLOSED hook**: GATE（过门分）全绿且无 path-anomaly → **0×** `run-from-miss`（不空转 tip）。

旧候选升格状态：鹏飞已显式升格；sticky (`post-dpr-sticky-execute`) → **PROMOTED / SHIPPED-soft**，由 [sticky-host-note-promote-r1](../freeze-offloop-sticky-host-note-promote-r1.md) 补齐可测 latch-md 软指导，#83/#84 runtime 保持原实现；host-note-bias (`host-note-post-dpr-execute-bias`) → **PROMOTED / SHIPPED-soft（NO_PRODUCT_DELTA）**，沿用 `host-note-candidate-promote-r1` + `host-note-soft-align-pr82-r1` 的 soft HOST 正文，本刀仅覆盖旧挂档状态；steal (`steal-post-amt-terminal-replan`) → **SHIPPED / archived（#90）**，已合入，勿重复开刀。上述旧稿不在待冻升格队列；正文保留为历史证据，以 H1 / 状态栏及本刀 freeze 为准。

## Commands

```bash
cd /workspace/dda-drive/offloop
node --test test/*.test.mjs

# Day-loop hook（扫收 CLOSED 后一条命令）
node on-closed.mjs --run 99              # PASS+anomaly → EXPERIENCE-only
node on-closed.mjs --run 60              # GATE MISS → CANDIDATE or reject
node on-closed.mjs --run 60 --dayloop-soft --soft-worktree /tmp/swt --out-dir /tmp/out
                                         # MISS → soft day-loop (fixture); nails tip+hash CANDIDATE
node on-closed.mjs --run 68              # all-green no anomaly → no-op
node on-closed.mjs --run 99 --decide-only

# Post-SCAN one-shot（推荐：CLOSED 后扫收必调）
./post-scan-on-closed.sh                 # 最新 CLOSED-looking runId → on-closed → 打印 action
./post-scan-on-closed.sh --run 100       # 显式 runId（例：全绿 → noop）
node post-scan-on-closed.mjs --run 99    # path-anomaly → EXPERIENCE-only

# Direct pipeline (wire)
node run-from-miss.mjs --run60
node run-from-miss.mjs --run 99 --path-anomaly --allow-experience-only

# Probe L1 smoke（默认跳过；fixture/sim 不烧额度）
node probe-l1.mjs --skip
node probe-l1.mjs --fixture --baseline test/fixtures/poison-loop-yes.jsonl \
  --soft test/fixtures/l1-soft-clean.jsonl
node probe-l1.mjs --fixture --baseline test/fixtures/poison-loop-yes.jsonl \
  --soft test/fixtures/l1-soft-false-win.jsonl   # expect adopt=false
node run-from-miss.mjs --run60 --probe-l1        # optional L1 after L0
node probe-l1.mjs --fixture --soft-worktree /tmp/swt --baseline … --soft …
node run-from-miss.mjs --run60 --probe-l1 --soft-worktree /tmp/swt
# live（少用）：--live --model M --jev J + baseline/soft jsonl

# Soft day-loop e2e（一条命令；默认 fixture/sim，0 真打模型）
node dayloop-soft.mjs --fixture soft-clean --soft-worktree /tmp/swt --out-dir /tmp/out
node dayloop-soft.mjs --fixture false-win  --soft-worktree /tmp/swt --out-dir /tmp/out
node dayloop-soft.mjs --fixture hard-gate  --soft-worktree /tmp/swt --out-dir /tmp/out
```

## Product-root CLI（命令行入口） — Harness² MVP（最小可行产品）

From `/workspace/dda` (or from this `offloop/` package), use the product-root
entry for bounded off-loop evidence:

```bash
node offloop/bin/offloop.mjs help
node offloop/bin/offloop.mjs miss --fixture \
  --tip-path /workspace/dda-tip-r25 \
  --out-dir /tmp/dda-offloop-out

# A real bounded MISS can still delegate explicit bench inputs:
node offloop/bin/offloop.mjs miss \
  --tip-sha 2258685ce9793639ebc9698c8961dcedccf6e49b \
  --bench-log /path/to/bench-log-run60.md \
  --jsonl /path/to/run60a.jsonl
```

`core（核心）` is the default and performs only the bounded `run-from-miss`
path; `live（在线）` work is never enabled implicitly and live flags are
rejected by this entry. The `tip-path（tip 路径）` check runs before MISS work:
`--tip-sha` > `--tip-path` > `DDA_TIP_REPO` > the product repo's git root, and
the resolved non-empty SHA must equal the fixed pin
`2258685ce9793639ebc9698c8961dcedccf6e49b`. Each invocation emits `tipSha`,
`tipSource`, and `pinEqual`; an empty or drifting tip exits non-zero.

Output precedence is `--out-dir` > `OFFLOOP_OUT_DIR` > `offloop/out`, and
`--experience-dir` > `OFFLOOP_EXPERIENCE_DIR` > `offloop/experience`. A bounded
`MISS（未命中）` writes an auditable `EXPERIENCE（经验）` or `CANDIDATE（候选）`
artifact; CANDIDATE files remain reviewable PR proposals and are never merged
or promoted automatically. The default entry records zero live requests and
zero Main OpenRouter calls.

## Layout

| File | Role |
| --- | --- |
| `post-scan-on-closed.sh` / `.mjs` | SCAN 后一键：解析 CLOSED runId → `node on-closed.mjs --run N` → 打印 `action` |
| `on-closed.mjs` | CLOSED hook：MISS→`run-from-miss`；MISS+`--dayloop-soft`→`runDayloopSoft`；全绿 noop |
| `ingest.mjs` | bench-log (run60 + run99+ tables) + jsonl → timeline / path-signals |
| `path-signals.mjs` | agent_miss / DGR / tip-path / post_amt / progress-fail counters |
| `experience.mjs` | EXPERIENCE list + retrieve |
| `propose.mjs` | ≤3 hypotheses + `prior` from EXPERIENCE; non-sticky diversity and forbidden-class filter |
| `merged-directions.mjs` | Extendable shipped-direction list and slug/title/tags/PR matching; covers sticky-execute #83/#84, leaves ordinary soft HOST notes eligible |
| `poison-loop.mjs` | poison-loop counter + `evaluateWin` |
| `probe.mjs` | L0 contrast + **`probeL1`** smoke API（默认可跳过） |
| `probe-l1.mjs` | L1 CLI（`--skip` / `--fixture` / `--sim` / `--live` / `--soft-worktree DIR`） |
| `soft-worktree.mjs` | `prepareSoftWorktree`：隔离 HOST/skill/latch-md/docs；拒 hard-gate 路径 |
| `compose.mjs` | `freeze-candidate-*` + `experience/*`；L1 soft 采纳须钉 `tipShaBaseline`+`softTreeFileListHash`，缺证/硬闸→0× CANDIDATE |
| `run-from-miss.mjs` | CLI glue；可选 `--probe-l1` / `--soft-worktree` / `--tip-sha` |
| `dayloop-soft.mjs` | **一条命令** 软层日闭环 e2e：Ingest→Propose→L1+soft worktree→Compose（默认 fixture；显式 opt-in + 凭证允许有界 live，subjects≤2） |



## Soft worktree（软层对照目录）

- `prepareSoftWorktree(hypothesis)` 在隔离目录写入 **HOST note / skill / latch-md / docs** only。
- 假说若指向 **runtime / lease / topology / host src** → **立即 reject**，**0×** 写出（可选 EXPERIENCE）。
- L1：`node probe-l1.mjs --fixture --soft-worktree DIR …`；摘要记录 **baseline tip SHA** + **soft tree file-list hash**。
- 假赢仍不采纳；**从不**改 `oliverypf/dda` runtime 硬闸。
- **Compose**：L1 soft 采纳时 CANDIDATE 必须含 tip SHA + fileListHash + fileList；缺证或 `hard_gate_path` → **0×** 候选文件 + EXPERIENCE（`missing_soft_evidence` / `hard_gate_path`）。

## Soft day-loop e2e（软层日闭环）

- **一条命令**：`node dayloop-soft.mjs --fixture soft-clean|false-win|hard-gate --soft-worktree DIR --out-dir DIR`
- 流水线：Ingest → Propose → Probe L0 → Probe L1（+ soft worktree）→ Compose。
- soft-clean → 非 sticky `host-note-post-dpr-execute-bias` CANDIDATE 钉 `tipShaBaseline` + `softTreeFileListHash`；sticky → EXPERIENCE（`shipped_duplicate`）；false-win / hard-gate → EXPERIENCE-only，**0×** CANDIDATE / FROZEN。
- **默认 tip 基线**：post-#90 master `2258685`（完整 PIN：`2258685ce9793639ebc9698c8961dcedccf6e49b`）。`dayloop-soft`、CLOSED soft 钩及 `run-from-miss --soft-worktree` 均使用此 fallback；显式 `--tip-sha` / API `tipSha` 优先，其次为提供的 bench-log tip。
- **真 CANDIDATE**：磁盘上的 `freeze-candidate-*.md` 必须含 **CANDIDATE** 状态、`tipShaBaseline`、64-hex `softTreeFileListHash` 和允许路径的 soft `fileList`；无 `--tip-sha` 的 soft-clean 命令也钉默认 PIN。
- **默认路径 / CI 默配额 = 0 真打模型**；仅显式 opt-in（`--l1-live` / API `l1Mode:live`，CLI 配合 `--model M --jev J`）+ 非空 model/jev 凭证才允许有界 live（subjects≤2）；不改 runtime；不自动合。
- **CLOSED 钩**：`on-closed.mjs --run N --dayloop-soft`（或 `OFFLOOP_DAYLOOP_SOFT=1`）；全绿 / path-anomaly **不**强制 dayloop。
- **MISS baseline**：`--dayloop-soft` 优先吃该 run 的 `bench-log-runN.md` + jsonl（`baselineSource=run`）；缺产物 → **可见** fixture-fallback + EXPERIENCE（不静默假绿）。


## Probe L1 smoke

- **Default skipped**（不空刷额度）. Enable: `probe-l1.mjs --fixture|--sim|--live` or `run-from-miss.mjs --probe-l1`.
- **Contrast**: T×1–2 same-subject — baseline tip SHA vs **soft-layer/docs-only** worktree（永不改 host 硬闸）.
- **Win**: scriptable exit/ok/verification **and** poison-loop == 0；假赢（绿但环未归零）→ `adopt=false` → EXPERIENCE.
- **Pass** may write CANDIDATE；**never** auto-FROZEN.
- Live smoke log header includes **model / Jev** when provided.
- `probe-l1.mjs` 的默认 `--tip-sha` 同为 post-#90 master `2258685`（完整 PIN：`2258685ce9793639ebc9698c8961dcedccf6e49b`）；显式 SHA 仍可覆盖。
- CI uses fixtures under `test/fixtures/l1-soft-*.jsonl`（不需 live 模型）.

Steal exception (`steal-path-anomaly-candidate-r1`): `STEAL_EVIDENCE_KINDS` in
`path-signals.mjs` is locked to `post_amt` and `post_agent_miss_terminal_replan`.
The `harness.` prefix and hyphenated slugs/tags are spellings of these two kinds;
no additional steal-isomorphic kinds are enabled. `postAmtCount > 0` or allowlisted
kind/quote/tag/slug/notes establishes the shape. Bare `steal`, `agent_miss`, and
`post_miss_uncertain*` / `postMissUncertainCount` alone do not. A typed non-steal
quote cannot become steal merely by mentioning post_amt in its text. Generic
EXPERIENCE lessons stay observational when post_amt appears only in inherited
evidence; a lesson needs an explicit allowlisted direction to use the exception.

Propose reserves a slot for `steal-post-amt-terminal-replan` (`soft_layer`,
`steal`/`soft`/`post-amt` tags) when counter or quote evidence exists. Compose,
dayloop and run-from-miss share the same hypothesis gate. A steal write requires
Probe adopt, no false win, `tipShaBaseline` exactly
`2258685ce9793639ebc9698c8961dcedccf6e49b`, a 64-hex `softTreeFileListHash`, and
no merged-direction match. Wrong/missing PIN or hash rejects as
`missing_soft_evidence`; no Git HEAD lookup is required. The exception does not
alter historical non-steal soft candidates' evidence contract or enable live Probe.

`STEAL_TIP_PIN` is now post-#90 master `2258685ce9793639ebc9698c8961dcedccf6e49b` after `steal-tip-pin-post90-r1` landed; it remains conceptually separate from `DEFAULT_TIP` but is currently equal to it.

## 检视BOT SCAN checklist（扫收必含）

凡 tip / topology-live 标 **CLOSED**（PASS 或 MISS），扫收完成前：

1. 跑一键（或等价）：
   ```bash
   node dda-drive/offloop/post-scan-on-closed.mjs --run N
   # 等价：node dda-drive/offloop/on-closed.mjs --run N
   ```
2. 确认 stdout JSON 含 **`action`**：`miss` | `path-anomaly` | `noop`
3. 把 JSON / `offloop-hook-logs/closed-hook-runN-*.md` 路径写入该 freeze 的 **「扫收」** 段（或 `--append-bench-log`）
4. 契约提醒：MISS→CANDIDATE 可能；默认 path-anomaly→EXPERIENCE-only（仅 allowlist steal + Probe adopt + PIN/hash 齐全且非 shipped 可写 CANDIDATE）；全绿无 anomaly→noop；**从不**自动 FROZEN / 合 PR

### freeze「扫收」段模板补丁

在 tip / topology freeze 的 `## 扫收（代码检视BOT）` 末追加：

```markdown
- **offloop CLOSED hook**（Harness²）：
  - 命令：`node dda-drive/offloop/post-scan-on-closed.mjs --run N`
    （或 `node dda-drive/offloop/on-closed.mjs --run N`）
  - action：`noop` | `path-anomaly` | `miss`
  - hook-log：`dda-drive/offloop-hook-logs/closed-hook-runN-<stamp>.md`
  - CANDIDATE / EXPERIENCE：见 hook-log（不自动 FROZEN / 不合 PR）
```

path-anomaly 判定以 bench-log **矩阵格 notes** 为准（tip-path×N 遥测表本身不算残红）。
