/**
 * Probe L0 + L1 smoke: scriptable win evaluation against poison-loop metrics.
 * L0: unit contrast (sticky suppress sim). L1: optional T×1–2 same-subject
 * baseline tip SHA vs soft-layer/docs-only worktree (default skipped).
 * No judge model. Never patches host hard-gates — soft/latch-md only.
 */
import { countPoisonLoops, evaluateWin } from './poison-loop.mjs';
import { readJsonlEvents } from './ingest.mjs';
import { prepareSoftWorktree } from './soft-worktree.mjs';

const DEFAULT_L1_TIP_SHA = '2258685ce9793639ebc9698c8961dcedccf6e49b';

function resolveTipSha(value) {
  return value === undefined ? DEFAULT_L1_TIP_SHA : value;
}

function hasUsableTipSha(value) {
  const tip = typeof value === 'string' ? value.trim() : '';
  return /^[a-f0-9]{7,64}$/i.test(tip) && !/^0+$/.test(tip);
}

/**
 * @param {object} hypothesis
 * @param {{ jsonlPaths?: string[], events?: object[], exitOk?: boolean, summaryOk?: boolean, verificationPass?: boolean, simulateStickySuppress?: boolean }} opts
 */
export function probeL0(hypothesis, opts = {}) {
  let events = opts.events || [];
  if ((!events || events.length === 0) && opts.jsonlPaths?.length) {
    events = opts.jsonlPaths.flatMap((p) => readJsonlEvents(p));
  }

  let poison = countPoisonLoops(events);

  // Contrast: if hypothesis is sticky latch and we simulate suppress, zero poison.
  // This is the L0 unit contrast without host patches.
  let contrasted = poison;
  if (opts.simulateStickySuppress && hypothesis?.slug === 'post-dpr-sticky-execute') {
    contrasted = {
      ...poison,
      count: 0,
      instances: [],
      note: 'simulated sticky suppress: post-dpr probe-only upgrades dropped',
    };
  }

  const baselineMetrics = {
    exitOk: opts.exitOk,
    summaryOk: opts.summaryOk,
    verificationPass: opts.verificationPass,
    poisonLoopCount: poison.count,
  };
  const contrastMetrics = {
    exitOk: opts.exitOk ?? true,
    summaryOk: opts.summaryOk ?? true,
    verificationPass: opts.verificationPass ?? true,
    poisonLoopCount: contrasted.count,
  };

  const baseline = evaluateWin(baselineMetrics);
  const contrast = evaluateWin(contrastMetrics);

  // Adopt only if contrast wins AND poison loop is zero.
  const adopt = contrast.win === true && contrasted.count === 0;
  const falseWin =
    contrast.falseWin === true ||
    (contrastMetrics.verificationPass &&
      contrastMetrics.exitOk !== false &&
      contrasted.count > 0);

  return {
    hypothesisId: hypothesis?.id,
    slug: hypothesis?.slug,
    baseline: { poison, win: baseline },
    contrast: { poison: contrasted, win: contrast },
    adopt,
    falseWin,
    probeKind: hypothesis?.probeKind || 'soft_or_latch_md',
    notes: [
      'L0 unit only; no host worktree patch in MVP Probe',
      adopt
        ? 'adopt: contrast win with poisonLoopCount==0'
        : falseWin
          ? 'reject: false win (green without poison loop zero)'
          : 'reject: contrast did not win',
    ],
  };
}

/**
 * Probe L1 smoke: optional T×1–2 same-subject contrast
 * (baseline tip SHA vs soft-layer/docs-only worktree).
 *
 * Default **skipped** (do not burn live quota). Prefer fixture/sim for CI.
 * Live mode requires explicit mode='live', enablement, model and jev.
 * Bounds and injected transport failures stop before event reads or tree writes.
 *
 * Soft-layer worktree may stack latch-md / docs only — never host hard-gates.
 *
 * @param {object} hypothesis
 * @param {{
 *   enabled?: boolean,
 *   skip?: boolean,
 *   mode?: 'fixture'|'live'|'sim',
 *   subjects?: string[],
 *   baseline?: { events?: object[], jsonlPaths?: string[], exitOk?: boolean, summaryOk?: boolean, verificationPass?: boolean, tipSha?: string },
 *   softLayer?: { events?: object[], jsonlPaths?: string[], exitOk?: boolean, summaryOk?: boolean, verificationPass?: boolean, tipSha?: string, worktree?: string },
 *   model?: string,
 *   jev?: string,
 *   transportError?: unknown,
 *   liveStatus?: string|number,
 *   l0?: object,
 *   reason?: string,
 * }} [opts]
 */
export function probeL1(hypothesis, opts = {}) {
  // Default skipped (save quota). Enable with opts.enabled===true or opts.skip===false.
  const enabled = opts.enabled === true || opts.skip === false;
  if (!enabled) {
    return {
      level: 'L1',
      skipped: true,
      enabled: false,
      reason: opts.reason || 'default_skip_save_quota',
      hypothesisId: hypothesis?.id,
      slug: hypothesis?.slug,
      adopt: null,
      falseWin: false,
      summary: null,
      notes: [
        'L1 skipped (default): enable with --probe-l1 / opts.enabled when L0 insufficient and live loop needed',
        'Probe worktree soft/docs only — no runtime hard-gate edits',
      ],
    };
  }

  const mode = opts.mode || (opts.softLayer?.jsonlPaths || opts.baseline?.jsonlPaths ? 'fixture' : 'sim');
  const subjects = [...(opts.subjects || [])];
  const requestedSoftTip = opts.softLayer && Object.prototype.hasOwnProperty.call(opts.softLayer, 'tipSha')
    ? opts.softLayer.tipSha
    : opts.baseline?.tipSha;
  const header = {
    model: opts.model || null,
    jev: opts.jev || null,
    tipShaBaseline: resolveTipSha(opts.baseline?.tipSha),
    tipShaSoft: resolveTipSha(requestedSoftTip),
    softWorktree: null,
    softTreeFileListHash: null,
    mode,
    note: 'L1 smoke: soft/docs layer only; never auto-FROZEN',
  };

  const stopped = (reason, details = {}) => ({
    level: 'L1',
    skipped: false,
    enabled: true,
    mode,
    hypothesisId: hypothesis?.id,
    slug: hypothesis?.slug,
    probeKind: hypothesis?.probeKind || 'soft_or_latch_md',
    header,
    summary: { subjects, header, baseline: null, contrast: null, delta: null },
    softWorktree: null,
    adopt: false,
    falseWin: false,
    reason,
    notes: [`L1 stopped: ${reason}; no contrast run`],
    ...details,
  });

  // A missing, blank, malformed, or zero SHA must stop the bounded probe.
  // Falling through to a green result would create the forbidden empty-tip
  // dual-green condition; an omitted field still receives the fixed default.
  if (!hasUsableTipSha(header.tipShaBaseline) || !hasUsableTipSha(header.tipShaSoft)) {
    return stopped('invalid_tip_sha', {
      rejected: true,
      tipShaBaseline: header.tipShaBaseline,
      tipShaSoft: header.tipShaSoft,
    });
  }

  // Preserve the requested subjects for audit; never truncate a larger run into adoption.
  const boundExceeded = subjects.length > 2;
  let rejectReason = boundExceeded ? 'bound_exceeded' : null;
  if (!rejectReason && mode === 'live') {
    if (![opts.model, opts.jev].every((value) => typeof value === 'string' && value.trim())) {
      rejectReason = 'live_requires_model_jev';
    } else if (new Set(subjects.map((subject) => subject.split('/')[0])).size > 1) {
      rejectReason = 'subject_family_mismatch';
    }
  }

  // Injectable only: no network request, retry, or expansion of subjects.
  const transport = Boolean(opts.transportError) ||
    ['transport', 'timeout', '402'].includes(String(opts.liveStatus ?? '').trim().toLowerCase());
  if (rejectReason || transport) {
    return stopped(rejectReason || 'transport', {
      ...(rejectReason ? { rejected: true } : {}),
      ...(boundExceeded ? { boundExceeded: true } : {}),
      ...(transport ? { transport: 'TRANSPORT' } : {}),
    });
  }

  /** Optional soft worktree prep (isolated HOST/skill/latch-md/docs). */
  let softTree = null;
  if (opts.softWorktreeDir || opts.prepareSoftWorktree === true) {
    softTree = prepareSoftWorktree(hypothesis, {
      dir: opts.softWorktreeDir || undefined,
      rootDir: opts.softWorktreeRoot || undefined,
      write: opts.writeSoftWorktree !== false,
      writeExperience: opts.writeSoftRejectExperience === true,
      experienceDir: opts.experienceDir,
    });
    if (softTree.rejected) {
      header.tipShaSoft = null;
      header.note = 'L1 reject: disallowed path in soft worktree prep';
      const result = stopped(softTree.reason, {
        softWorktree: softTree,
        rejected: true,
        notes: softTree.notes || ['reject: hard-gate path'],
      });
      return {
        ...result,
        summary: {
          ...result.summary,
          softWorktreeRejected: true,
          hardGatePaths: softTree.hardGatePaths,
        },
      };
    }
  }

  const baselineEvents = loadEvents(opts.baseline);
  const softEvents = loadEvents(opts.softLayer);

  const baselinePoison = countPoisonLoops(baselineEvents);
  let softPoison = countPoisonLoops(softEvents);

  // sim mode: soft-layer sticky latch-md suppresses probe-only re-upgrade
  if (
    mode === 'sim' &&
    softEvents.length === 0 &&
    baselineEvents.length > 0 &&
    (hypothesis?.slug === 'post-dpr-sticky-execute' ||
      hypothesis?.probeKind === 'soft_or_latch_md')
  ) {
    softPoison = {
      ...baselinePoison,
      count: 0,
      instances: [],
      stickyCount: (baselinePoison.stickyCount || 0) + 1,
      note: 'sim soft-layer latch-md: sticky PTE suppress (no host hard-gate)',
    };
  }

  const baselineMetrics = {
    exitOk: opts.baseline?.exitOk,
    summaryOk: opts.baseline?.summaryOk,
    verificationPass: opts.baseline?.verificationPass ?? false,
    poisonLoopCount: baselinePoison.count,
  };
  const softMetrics = {
    exitOk: opts.softLayer?.exitOk ?? true,
    summaryOk: opts.softLayer?.summaryOk ?? true,
    verificationPass: opts.softLayer?.verificationPass ?? true,
    poisonLoopCount: softPoison.count,
  };

  const baselineWin = evaluateWin(baselineMetrics);
  const softWin = evaluateWin(softMetrics);

  const falseWin =
    softWin.falseWin === true ||
    (softMetrics.verificationPass &&
      softMetrics.exitOk !== false &&
      softMetrics.summaryOk !== false &&
      softPoison.count > 0);

  // Adopt only if soft-layer contrast is scriptable green AND poison==0
  const adopt = softWin.win === true && softPoison.count === 0 && !falseWin;

  const softTreePath = softTree?.dir || opts.softLayer?.worktree || opts.softWorktreeDir || 'soft-layer/docs-only (no hard-gate)';
  const softTreeFileListHash = softTree?.fileListHash || opts.softLayer?.fileListHash || null;
  header.softWorktree = softTreePath;
  header.softTreeFileListHash = softTreeFileListHash;

  const summary = {
    subjects,
    header,
    baseline: {
      poisonLoopCount: baselinePoison.count,
      pathCounts: {
        dpr: baselinePoison.dprCount,
        sticky: baselinePoison.stickyCount,
      },
      win: baselineWin,
      metrics: baselineMetrics,
    },
    contrast: {
      poisonLoopCount: softPoison.count,
      pathCounts: {
        dpr: softPoison.dprCount,
        sticky: softPoison.stickyCount,
      },
      win: softWin,
      metrics: softMetrics,
      softLayerOnly: true,
      softWorktree: softTreePath,
      softTreeFileListHash,
      softTreeFileList: softTree?.fileList || null,
    },
    delta: {
      poisonDelta: baselinePoison.count - softPoison.count,
    },
  };

  const notes = [
    `L1 ${mode} contrast (T×${Math.max(subjects.length, 1)} same-subject)`,
    'soft-layer worktree: latch-md/docs only — no runtime hard-gate',
    adopt
      ? 'adopt: soft-layer green ∧ poisonLoopCount==0 → may write CANDIDATE'
      : falseWin
        ? 'reject: false win (green but poison-loop not zero) → EXPERIENCE'
        : 'reject: soft-layer contrast did not win → EXPERIENCE',
  ];
  if (header.model || header.jev) {
    notes.unshift(`live header model=${header.model || '?'} jev=${header.jev || '?'}`);
  }

  return {
    level: 'L1',
    skipped: false,
    enabled: true,
    mode,
    hypothesisId: hypothesis?.id,
    slug: hypothesis?.slug,
    probeKind: hypothesis?.probeKind || 'soft_or_latch_md',
    header,
    summary,
    baseline: { poison: baselinePoison, win: baselineWin },
    contrast: { poison: softPoison, win: softWin },
    adopt,
    falseWin,
    softWorktree: softTree,
    l0: opts.l0 || null,
    notes,
  };
}

function loadEvents(side) {
  if (!side) return [];
  if (side.events?.length) return side.events;
  if (side.jsonlPaths?.length) {
    return side.jsonlPaths.flatMap((p) => readJsonlEvents(p));
  }
  return [];
}
