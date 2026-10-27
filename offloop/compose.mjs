/**
 * Compose CANDIDATE freeze-candidate-*.md + experience/* for Probe-passing hypotheses.
 * Never writes FROZEN. Never auto-upgrades.
 * L1 soft-layer adopt must nail tipShaBaseline + softTreeFileListHash (+ fileList) or reject write.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchesMergedDirection, MERGED_REJECT_REASON } from './merged-directions.mjs';
import { hypothesisIsSteal, isExperienceOnlyHypothesis, notesPathAnomaly, summarizePathAnomalyFields, STEAL_TIP_PIN } from './path-signals.mjs';

const PRODUCT_ROOT = path.dirname(fileURLToPath(import.meta.url));

function configuredPath(explicit, envName, fallback) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit;
  const fromEnv = process.env[envName];
  return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv : fallback;
}

/**
 * @param {object} opts
 * @param {object} opts.hypothesis
 * @param {object} opts.probeResult
 * @param {object} [opts.ingest]
 * @param {string} [opts.outDir]
 * @param {string} [opts.experienceDir]
 * @param {string} [opts.date] yyyy-mm-dd
 * @param {object} [opts.transportRecord] transportClass/requestSha256/subjects/elapsedMs; used only on an L1 transport stop
 * @param {boolean} [opts.write=true]
 */
export function composeCandidate(opts) {
  const {
    hypothesis,
    probeResult,
    ingest,
    outDir: requestedOutDir,
    experienceDir: requestedExperienceDir,
    date = todayAdak(),
    write = true,
  } = opts;
  const outDir = configuredPath(requestedOutDir, 'OFFLOOP_OUT_DIR', path.join(PRODUCT_ROOT, 'out'));
  const experienceDir = configuredPath(
    requestedExperienceDir,
    'OFFLOOP_EXPERIENCE_DIR',
    path.join(PRODUCT_ROOT, 'experience'),
  );

  const softEv = extractSoftEvidence(probeResult);
  const steal = hypothesisIsSteal(hypothesis);

  const rejectExperience = (reason, transportRecord = null) => {
    const exp = buildExperience({
      hypothesis, probeResult, ingest, date, adopted: false, reason, softEv,
      missingEvidence: false, transportRecord,
    });
    const expPath = path.join(experienceDir, `${date}-${hypothesis.slug}-rejected.md`);
    if (write) {
      fs.mkdirSync(experienceDir, { recursive: true });
      fs.writeFileSync(expPath, exp, 'utf8');
    }
    return {
      wroteCandidate: false, candidatePath: null,
      experiencePath: write ? expPath : null, experienceBody: exp, reason,
    };
  };

  // Hard-gate soft tree reject → 0× CANDIDATE (even if adopt were somehow true)
  if (isHardGateRejected(probeResult)) {
    const reason = 'hard_gate_path';
    const exp = buildExperience({
      hypothesis,
      probeResult,
      ingest,
      date,
      adopted: false,
      reason,
      softEv,
      missingEvidence: false,
    });
    const expPath = path.join(experienceDir, `${date}-${hypothesis.slug}-rejected.md`);
    if (write) {
      fs.mkdirSync(experienceDir, { recursive: true });
      fs.writeFileSync(expPath, exp, 'utf8');
    }
    return {
      wroteCandidate: false,
      candidatePath: null,
      experiencePath: write ? expPath : null,
      experienceBody: exp,
      reason,
    };
  }

  // An inconsistent adopt=true must never override a false-win rejection.
  if (probeResult?.falseWin || resolveL1(probeResult)?.falseWin) {
    return rejectExperience('false_win');
  }

  // A stopped transport has no contrast evidence, even with an inconsistent
  // adopt=true. Persist the stop itself instead of the hypothesis's lesson.
  const l1 = resolveL1(probeResult);
  if (l1?.transport === 'TRANSPORT' || l1?.reason === 'transport') {
    return rejectExperience('experience_only', opts.transportRecord || {});
  }

  if (!probeResult?.adopt || resolveL1(probeResult)?.adopt === false) {
    const notes = (probeResult?.notes || []).join(' ');
    const reason = probeResult?.falseWin
      ? 'false_win'
      : isExperienceOnlyHypothesis(hypothesis) || /experience-only|path-anomaly/i.test(notes)
        ? 'experience_only'
        : probeResult?.reason === 'hard_gate_path'
          ? 'hard_gate_path'
          : probeResult?.baseline?.win?.reason || 'probe_not_adopt';
    const exp = buildExperience({
      hypothesis,
      probeResult,
      ingest,
      date,
      adopted: false,
      reason,
      softEv,
      missingEvidence: false,
    });
    const expPath = path.join(experienceDir, `${date}-${hypothesis.slug}-rejected.md`);
    if (write) {
      fs.mkdirSync(experienceDir, { recursive: true });
      fs.writeFileSync(expPath, exp, 'utf8');
    }
    return {
      wroteCandidate: false,
      candidatePath: null,
      experiencePath: write ? expPath : null,
      experienceBody: exp,
      reason,
    };
  }

  // These gates also apply to direct Compose calls with adopt-looking evidence.
  if (matchesMergedDirection(hypothesis)) return rejectExperience(MERGED_REJECT_REASON);
  if (isExperienceOnlyHypothesis(hypothesis)) return rejectExperience('experience_only');

  // Steal always needs PIN + hash, including L0/adopt claims without L1 markers.
  // Retain the existing non-steal L1 contract for historical soft candidates.
  if (steal || claimsL1SoftAdopt(probeResult)) {
    const tipOk = steal
      ? softEv.tipShaBaseline === STEAL_TIP_PIN
      : Boolean(softEv.tipShaBaseline && String(softEv.tipShaBaseline).trim());
    const hashOk =
      typeof softEv.softTreeFileListHash === 'string' &&
      /^[a-f0-9]{64}$/i.test(softEv.softTreeFileListHash);
    if (!tipOk || !hashOk) {
      const reason = 'missing_soft_evidence';
      const exp = buildExperience({
        hypothesis,
        probeResult,
        ingest,
        date,
        adopted: false,
        reason,
        softEv,
        missingEvidence: true,
      });
      const expPath = path.join(experienceDir, `${date}-${hypothesis.slug}-rejected.md`);
      if (write) {
        fs.mkdirSync(experienceDir, { recursive: true });
        fs.writeFileSync(expPath, exp, 'utf8');
      }
      return {
        wroteCandidate: false,
        candidatePath: null,
        experiencePath: write ? expPath : null,
        experienceBody: exp,
        reason,
        missingSoftEvidence: {
          tipShaBaseline: softEv.tipShaBaseline || null,
          softTreeFileListHash: softEv.softTreeFileListHash || null,
          tipOk,
          hashOk,
        },
      };
    }
  }

  const slug = hypothesis.slug;
  const candidateName = `freeze-candidate-${slug}-r1.md`;
  const candidatePath = path.join(outDir, candidateName);
  const body = buildCandidateMd({ hypothesis, probeResult, ingest, date, softEv });
  const exp = buildExperience({
    hypothesis,
    probeResult,
    ingest,
    date,
    adopted: true,
    reason: 'probe_adopt',
    softEv,
    missingEvidence: false,
  });
  const expPath = path.join(experienceDir, `${date}-${slug}.md`);

  if (write) {
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(experienceDir, { recursive: true });
    fs.writeFileSync(candidatePath, body, 'utf8');
    fs.writeFileSync(expPath, exp, 'utf8');
  }

  return {
    wroteCandidate: true,
    candidatePath: write ? candidatePath : null,
    candidateBody: body,
    experiencePath: write ? expPath : null,
    experienceBody: exp,
    reason: 'probe_adopt',
    softEvidence: softEv,
  };
}

/** @param {object|null|undefined} pr */
export function extractSoftEvidence(pr) {
  const l1 = resolveL1(pr);
  const tipShaBaseline =
    pr?.tipShaBaseline ||
    pr?.header?.tipShaBaseline ||
    pr?.summary?.header?.tipShaBaseline ||
    l1?.tipShaBaseline ||
    l1?.header?.tipShaBaseline ||
    l1?.summary?.header?.tipShaBaseline ||
    pr?.baseline?.tipSha ||
    null;

  const softTreeFileListHash =
    pr?.softTreeFileListHash ||
    pr?.header?.softTreeFileListHash ||
    pr?.softWorktree?.fileListHash ||
    pr?.summary?.contrast?.softTreeFileListHash ||
    l1?.softTreeFileListHash ||
    l1?.header?.softTreeFileListHash ||
    l1?.softWorktree?.fileListHash ||
    l1?.summary?.contrast?.softTreeFileListHash ||
    null;

  const fileList =
    pr?.softTreeFileList ||
    pr?.softWorktree?.fileList ||
    pr?.summary?.contrast?.softTreeFileList ||
    l1?.softWorktree?.fileList ||
    l1?.summary?.contrast?.softTreeFileList ||
    null;

  return {
    tipShaBaseline: tipShaBaseline ? String(tipShaBaseline) : null,
    softTreeFileListHash:
      typeof softTreeFileListHash === 'string' ? softTreeFileListHash : null,
    fileList: Array.isArray(fileList) ? fileList : null,
  };
}

/** @param {object|null|undefined} pr */
export function resolveL1(pr) {
  if (!pr) return null;
  if (pr.level === 'L1') return pr;
  if (pr.l1 && (pr.l1.level === 'L1' || pr.l1.skipped === false || pr.l1.enabled === true)) {
    return pr.l1;
  }
  return null;
}

/**
 * L1 soft-layer adopt claim: L1 ran (not skipped) and compose is asked to adopt.
 * Soft evidence (tip SHA + fileListHash) is then mandatory.
 * @param {object|null|undefined} pr
 */
export function claimsL1SoftAdopt(pr) {
  if (!pr?.adopt) return false;
  const l1 = resolveL1(pr);
  if (!l1 || l1.skipped === true) return false;
  // Soft worktree attachment alone also marks soft claim when adopting
  if (pr.softWorktree != null || l1.softWorktree != null) return true;
  // Any enabled L1 contrast is soft-layer/docs — require evidence on adopt
  if (l1.enabled === true || l1.level === 'L1') return true;
  return false;
}

/** @param {object|null|undefined} pr */
export function isHardGateRejected(pr) {
  if (!pr) return false;
  const reasons = [
    pr.reason,
    pr.softWorktree?.reason,
    pr.l1?.reason,
    pr.l1?.softWorktree?.reason,
  ];
  if (reasons.some((r) => r === 'hard_gate_path')) return true;
  if (pr.softWorktree?.rejected === true) return true;
  if (pr.l1?.softWorktree?.rejected === true) return true;
  if (pr.summary?.softWorktreeRejected === true) return true;
  if (pr.l1?.summary?.softWorktreeRejected === true) return true;
  if (pr.rejected === true && /hard.?gate/i.test(String(pr.reason || ''))) return true;
  return false;
}

function todayAdak() {
  // Box clock is America/Adak; ISO date is fine.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatFileList(fileList) {
  if (!Array.isArray(fileList) || fileList.length === 0) return '- (none)';
  return fileList
    .map((f) => {
      const rel = typeof f === 'string' ? f : f?.relPath || f?.path || '?';
      return `- \`${rel}\``;
    })
    .join('\n');
}

function buildCandidateMd({ hypothesis, probeResult, ingest, date, softEv }) {
  const cells = (ingest?.cells || [])
    .map(
      (c) =>
        `- ${c.cellId}: poisonLoop=${c.poisonLoopCount} dpr=${c.dprCount} sticky=${c.stickyCount} verif=${c.finalVerification}`,
    )
    .join('\n');
  const evidence = (hypothesis.evidence || [])
    .map((e) => `- [${e.cellId || '?'} #${e.sequence}] ${e.text}`)
    .join('\n');

  const alignNote = 'If direction differs from an open PR, document the delta here before升格.';

  const tip = softEv?.tipShaBaseline || 'n/a';
  const tipShort = String(tip).slice(0, 7);
  const hash = softEv?.softTreeFileListHash || 'n/a';
  const fileListBlock = formatFileList(softEv?.fileList);
  const softEvidenceFooter = softEv?.tipShaBaseline?.trim() && /^[a-f0-9]{64}$/i.test(hash)
    ? `- **soft_evidence**: tipShaBaseline=\`${tip}\` tipShort=\`${tipShort}\` softTreeFileListHash=\`${hash}\`\n\n`
    : '';

  return `# dda harness 冻结稿 — ${hypothesis.title} r1：**CANDIDATE**

- **状态：CANDIDATE（勿开干）。** 待 BOT2 SCAN 升格 / 鹏飞点名「冻」后改 FROZEN。
- **来源：** off-loop contrast-probe MVP（\`dda-drive/offloop/\`）@ ${date}
- **性质：** meta 冻稿候选；**不**改 tip 默认；**不**自动合 PR；runtime **0×** 读 EXPERIENCE。
- **对齐：** ${alignNote}

## 0. 证据

| 项 | 值 |
| --- | --- |
| ingest cells | ${ingest?.cells?.length ?? 0} |
| poisonLoop total | ${ingest?.totals?.poisonLoopCount ?? probeResult?.baseline?.poison?.count ?? '?'} |
| dpr total | ${ingest?.totals?.dprCount ?? '?'} |
| tipShaBaseline | \`${tip}\` |
| softTreeFileListHash | \`${hash}\` |

Cells:
${cells || '- (none)'}

Evidence quotes:
${evidence || '- (none)'}

### 0.1 L1 soft-layer contrast

| 项 | 值 |
| --- | --- |
| tipShaBaseline | \`${tip}\` |
| tipShort | \`${tipShort}\` |
| softTreeFileListHash | \`${hash}\` |

Soft-layer \`fileList\` (HOST / skill / latch-md / docs):
${fileListBlock}

## 1. 锁定（草案，markdown only）

${hypothesis.summary}

${hypothesis.latchDraftMd || '_soft-layer / experience only; no latch table_'}

### 1.1 不做

- 不抬 maxProbes；不放宽 lease / hardDecision / denylist
- 不改 tip 产品默认 TOPOLOGY=on
- 不以换 Jev/provider 为主假说
- MVP Probe **不** worktree 真改 host

## 2. Probe 记录

| 项 | 值 |
| --- | --- |
| hypothesis | ${hypothesis.id} \`${hypothesis.slug}\` |
| adopt | ${probeResult.adopt} |
| falseWin | ${probeResult.falseWin} |
| tipShaBaseline | \`${tip}\` |
| softTreeFileListHash | \`${hash}\` |
| baseline poisonLoop | ${probeResult.baseline?.poison?.count} |
| contrast poisonLoop | ${probeResult.contrast?.poison?.count} |
| contrast win reason | ${probeResult.contrast?.win?.reason} |
| notes | ${(probeResult.notes || []).join('; ')} |

${softEvidenceFooter}## 3. 升格清单

- [ ] BOT2 SCAN：证据真、非目标清、不绕硬闸
- [ ] 鹏飞点名「冻」或既有自动冻规则
- [ ] 改名为 \`freeze-harness-${hypothesis.slug}-r1.md\` 且状态改 **FROZEN**
- [ ] 开干仍走现有 worktree→PR→抽检（本文件不自动开干）

## 4. 开干

**勿开干。** 本文件是 CANDIDATE。
`;
}

function buildExperience({
  hypothesis,
  probeResult,
  ingest,
  date,
  adopted,
  reason,
  softEv,
  missingEvidence,
  transportRecord = null,
}) {
  const poison = ingest?.totals?.poisonLoopCount ?? probeResult?.baseline?.poison?.count ?? 0;
  const prior = (hypothesis.prior || [])
    .map((p) => `${p.slug}${p.adopted ? ' (adopted)' : ''}`)
    .join(', ');
  const oneLine = (value) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  const transportClass = oneLine(transportRecord?.transportClass) || 'unspecified';
  const requestSha = /^[a-f0-9]{64}$/i.test(transportRecord?.requestSha256 || '')
    ? transportRecord.requestSha256 : null;
  const transportFields = transportRecord ? [
    '- **transport_result**: TRANSPORT',
    `- **transportClass**: ${transportClass}`,
    `- **requestSha256**: ${requestSha || 'n/a (not supplied)'}`,
    `- **subjects**: ${Array.isArray(transportRecord.subjects) ? transportRecord.subjects.map(oneLine).join(', ') || 'n/a' : 'n/a'}`,
    `- **elapsedMs**: ${Number.isFinite(transportRecord.elapsedMs) && transportRecord.elapsedMs >= 0 ? transportRecord.elapsedMs : 'n/a'}`,
  ].join('\n') + '\n' : '';
  const lesson = transportRecord
    ? `TRANSPORT / ${transportClass}: honest stop; no usable L1 contrast. ${requestSha ? `requestSha256=${requestSha}. ` : ''}Warn/prior only; not adopt=true or CANDIDATE authorization.`
    : reason === MERGED_REJECT_REASON
      ? 'This hypothesis matches an already shipped direction. Retain this probe as EXPERIENCE; do not promote it as a new candidate.'
      : hypothesis.summary
      ? hypothesis.summary
      : 'Keep probe evidence with its adoption or rejection reason. Green without poisonLoop==0 is a **false win**.';
  const missingLine = missingEvidence
    ? `- **missing_soft_evidence**: tipShaBaseline=${softEv?.tipShaBaseline || '(absent)'} softTreeFileListHash=${softEv?.softTreeFileListHash || '(absent)'} — CANDIDATE write rejected`
    : softEv?.tipShaBaseline || softEv?.softTreeFileListHash
      ? `- **soft_evidence**: tipShaBaseline=\`${softEv?.tipShaBaseline || 'n/a'}\` softTreeFileListHash=\`${softEv?.softTreeFileListHash || 'n/a'}\``
      : '- **soft_evidence**: n/a (L0 / no L1 soft claim)';
  const pathSummary = summarizePathAnomalyFields(ingest);
  const pathNotes = [
    hypothesis.class, hypothesis.slug, hypothesis.title, hypothesis.summary,
    ...(hypothesis.tags || []), ...[].concat(hypothesis.notes || []),
    ...(probeResult?.notes || []), ...(ingest?.cells || []).map((cell) => cell.notes),
  ].join('\n');
  const includePathFields = reason === 'experience_only' || isExperienceOnlyHypothesis(hypothesis) ||
    /path[-_]anomaly/i.test(pathNotes) || notesPathAnomaly(pathNotes).any ||
    Object.values(pathSummary.counts).some((value) => value > 0);
  const pathFields = includePathFields ? [
    `- **runId**: ${pathSummary.runId ?? 'n/a'}`,
    `- **path_counts**: DGR=${pathSummary.counts.dgr} tip-path=${pathSummary.counts.tipPath} post_amt=${pathSummary.counts.postAmt} agent_miss=${pathSummary.counts.agentMiss}`,
    `- **path_tags**: ${pathSummary.path_tags.join(', ') || '(none)'}`,
    `- **check_ids**: ${pathSummary.checkIds.join(', ') || '(none)'}`,
  ].join('\n') + '\n' : '';
  return `# EXPERIENCE — ${hypothesis.title}

- **date**: ${date} (America/Adak)
- **slug**: ${hypothesis.slug}
- **adopted_candidate**: ${adopted ? 'yes' : 'no'} (${reason})
- **source runs**: ${(ingest?.cells || []).map((c) => c.cellId).join(', ') || 'n/a'}
${pathFields}- **poison loop**: count=${poison}
- **prior**: ${prior || 'none'}
${missingLine}
${transportFields}- **lesson**: ${lesson}
- **runtime contract**: DDA runtime must **0×** read \`dda-drive/experience/\` as unchecked Memory.
- **promoted knife**: none
`;
}
