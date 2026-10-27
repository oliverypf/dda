#!/usr/bin/env node
/**
 * CLI: off-loop Propose → Probe L0 → (optional L1) → Compose from CLOSED MISS or path-anomaly.
 *
 * Usage:
 *   node offloop/run-from-miss.mjs --run60
 *   node offloop/run-from-miss.mjs --run 99 --path-anomaly
 *   node offloop/run-from-miss.mjs --latest-closed --path-anomaly
 *   node offloop/run-from-miss.mjs --bench-log PATH --jsonl PATH [--jsonl PATH ...]
 *   node offloop/run-from-miss.mjs --run 99 --path-anomaly --allow-experience-only
 *   node offloop/run-from-miss.mjs --run60 --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingestMiss, resolveRedCellJsonl, resolveRun, resolveLatestClosed } from './ingest.mjs';
import { proposeFromIngest } from './propose.mjs';
import { probeL0, probeL1 } from './probe.mjs';
import { prepareSoftWorktree } from './soft-worktree.mjs';
import { composeCandidate } from './compose.mjs';
import { hypothesisIsSteal, isExperienceOnlyHypothesis } from './path-signals.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRIVE = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = {
    run60: false,
    run: null,
    latestClosed: false,
    pathAnomaly: false,
    allowExperienceOnly: false,
    dryRun: false,
    benchLog: null,
    jsonl: [],
    simulateSticky: true,
    probeL1: false,
    probeL1Soft: null,
    softWorktree: null,
    tipSha: null,
    model: null,
    jev: null,
    outDir: DRIVE,
    experienceDir: path.join(DRIVE, 'experience'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--run60') out.run60 = true;
    else if (a === '--run') out.run = argv[++i];
    else if (a === '--latest-closed') out.latestClosed = true;
    else if (a === '--path-anomaly') out.pathAnomaly = true;
    else if (a === '--allow-experience-only') out.allowExperienceOnly = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--no-simulate-sticky') out.simulateSticky = false;
    else if (a === '--probe-l1') out.probeL1 = true;
    else if (a === '--probe-l1-soft') out.probeL1Soft = argv[++i];
    else if (a === '--soft-worktree') out.softWorktree = argv[++i];
    else if (a === '--tip-sha') out.tipSha = argv[++i];
    else if (a === '--model') out.model = argv[++i];
    else if (a === '--jev') out.jev = argv[++i];
    else if (a === '--bench-log') out.benchLog = argv[++i];
    else if (a === '--jsonl') out.jsonl.push(argv[++i]);
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--experience-dir') out.experienceDir = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage:
  node run-from-miss.mjs --run60
  node run-from-miss.mjs --run N [--path-anomaly] [--allow-experience-only]
  node run-from-miss.mjs --latest-closed [--path-anomaly]
  node run-from-miss.mjs --bench-log P --jsonl P...

CLOSED MISS or path-anomaly → one-shot Propose→Probe L0→(optional L1)→Compose.
Produces freeze-candidate-*.md or explicit reject + EXPERIENCE.
--probe-l1 enables L1 smoke (fixture/sim; soft-layer only). Default skipped.
--soft-worktree DIR prepares isolated HOST/skill/latch-md/docs tree; hash recorded in L1 summary.
--tip-sha SHA sets L1 tipShaBaseline (default: ingest tip or 2258685ce9793639ebc9698c8961dcedccf6e49b, post-#90 master, when soft-worktree set).
Does not empty-rebench green tips.`);
    process.exit(0);
  }

  let benchLog = args.benchLog;
  let jsonlPaths = [...args.jsonl];
  let resolvedMeta = null;

  if (args.run60) {
    benchLog = path.join(DRIVE, 'bench-log-run60.md');
    const t3pairs = [
      [path.join(DRIVE, 'bench/t3/run60a.jsonl'), path.join(DRIVE, 'bench/t3/run60b.jsonl')],
      [
        path.join(DRIVE, 'bench/logs/run60-void1/t3/run60a.jsonl'),
        path.join(DRIVE, 'bench/logs/run60-void1/t3/run60b.jsonl'),
      ],
    ];
    let found = t3pairs.find(([a, b]) => fs.existsSync(a) && fs.existsSync(b));
    // void stubs are tiny; require a real poison-capable jsonl (>1KB) or fall back to fixtures
    if (found) {
      const sz = fs.statSync(found[0]).size;
      if (sz < 1024) found = null;
    }
    if (!found) {
      const fix = path.join(__dirname, 'test/fixtures/poison-loop-yes.jsonl');
      if (!fs.existsSync(fix)) {
        console.error('run60 jsonl missing and fixtures/poison-loop-yes.jsonl absent');
        process.exit(2);
      }
      console.error('warn: run60 live jsonl missing/void; using test/fixtures/poison-loop-yes.jsonl for sticky smoke');
      jsonlPaths = [fix];
    } else {
      jsonlPaths = found;
    }
    const resolved = resolveRedCellJsonl(benchLog, path.join(DRIVE, 'bench'));
    args._allRed = resolved.paths;
  } else if (args.run != null) {
    const mode = args.pathAnomaly ? 'path-anomaly' : 'auto';
    const resolved = resolveRun(args.run, { drive: DRIVE, mode });
    resolvedMeta = resolved;
    if (!resolved.ok) {
      console.error(`resolveRun failed: ${resolved.reason}`);
      process.exit(2);
    }
    benchLog = resolved.benchLogPath;
    jsonlPaths = resolved.paths;
    // Path-anomaly CLOSED PASS → experience-only is expected
    if (args.pathAnomaly || resolved.mode === 'path-anomaly') {
      args.allowExperienceOnly = true;
    }
  } else if (args.latestClosed) {
    const mode = args.pathAnomaly ? 'path-anomaly' : 'auto';
    const resolved = resolveLatestClosed({ drive: DRIVE, mode });
    resolvedMeta = resolved;
    if (!resolved.ok) {
      console.error(`resolveLatestClosed failed: ${resolved.reason}`);
      process.exit(2);
    }
    benchLog = resolved.benchLogPath;
    jsonlPaths = resolved.paths;
    if (args.pathAnomaly || resolved.mode === 'path-anomaly') {
      args.allowExperienceOnly = true;
    }
  }

  if (!jsonlPaths.length) {
    console.error('Need --run60 | --run N | --latest-closed | --jsonl');
    process.exit(2);
  }

  const ingest = ingestMiss({ benchLogPath: benchLog, jsonlPaths });
  // Keep the enclosing bench run alongside the per-cell runtime run ids.
  const runNumber = resolvedMeta?.n ?? args.run ?? (args.run60 ? '60' :
    path.basename(benchLog || '').match(/^bench-log-run(\d+)\.md$/i)?.[1]);
  if (ingest.runId == null && runNumber != null) {
    ingest.runId = `run${String(runNumber).replace(/^run/i, '')}`;
  }
  const proposal = proposeFromIngest(ingest, { experienceDir: args.experienceDir });

  console.log(
    JSON.stringify(
      {
        phase: 'ingest',
        resolved: resolvedMeta
          ? { n: resolvedMeta.n, mode: resolvedMeta.mode, paths: resolvedMeta.paths?.length }
          : null,
        totals: ingest.totals,
        pathSignals: ingest.pathSignals,
        cells: ingest.cells.map((c) => ({
          cellId: c.cellId,
          poisonLoopCount: c.poisonLoopCount,
          dprCount: c.dprCount,
          stickyCount: c.stickyCount,
          pathSignals: c.pathSignals
            ? {
                agentMiss: c.pathSignals.agentMissCount,
                dgr: c.pathSignals.dgrPromoteCount,
                tipPath: c.pathSignals.tipPathCount,
                postAmt: c.pathSignals.postAmtCount,
                progressFailLease: c.pathSignals.progressFailLeaseCount,
              }
            : null,
          finalOk: c.finalOk,
          finalVerification: c.finalVerification,
        })),
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        phase: 'propose',
        experienceHits: (proposal.experienceContext || []).map((e) => ({
          slug: e.slug,
          score: e.score,
          adopted: e.adopted,
        })),
        accepted: proposal.accepted.map((h) => ({
          id: h.id,
          slug: h.slug,
          evidence: h.evidence?.length,
          prior: (h.prior || []).map((p) => p.slug),
        })),
        rejected: proposal.rejected.map((h) => ({
          id: h.id,
          slug: h.slug,
          rejectReason: h.rejectReason,
        })),
      },
      null,
      2,
    ),
  );

  const results = [];
  for (const h of proposal.accepted) {
    const probe = probeL0(h, {
      jsonlPaths,
      exitOk: true,
      summaryOk: true,
      verificationPass: true,
      simulateStickySuppress: args.simulateSticky && h.slug === 'post-dpr-sticky-execute',
    });

    let adoptProbe = probe;
    if (h.class === 'soft_layer' || h.class === 'experience') {
      const companion = ingest.totals.poisonLoopCount > 0 && !probe.falseWin;
      adoptProbe = {
        ...probe,
        adopt: companion && h.class === 'experience' ? false : companion && h.slug.includes('sticky'),
        notes: [...probe.notes, 'soft/experience companion under MVP'],
      };
      if (h.class === 'experience') {
        adoptProbe = { ...probe, adopt: false, notes: [...probe.notes, 'experience-only'] };
      }
      if (h.class === 'soft_layer') {
        adoptProbe = {
          ...probe,
          adopt: false,
          notes: [...probe.notes, 'soft-layer deferred; sticky primary'],
        };
      }
    }

    // Observational paths remain lessons; allowlisted steal may reach the L1 gate.
    if (isExperienceOnlyHypothesis(h)) {
      adoptProbe = { ...probe, adopt: false, notes: [...(probe.notes || []), 'path-anomaly experience-only'] };
    }

    /** Optional Probe L1 smoke (default off — save quota). Soft-layer only.
     *  Skip observational EXPERIENCE; allowlisted steal still needs PIN + hash in Compose.
     */
    let l1 = null;
    const l1Eligible =
      args.probeL1 &&
      !isExperienceOnlyHypothesis(h);
    if (l1Eligible) {
      const softPaths = args.probeL1Soft ? [args.probeL1Soft] : [];
      const tipSha =
        args.tipSha ||
        ingest.tip ||
        (args.softWorktree ? '2258685ce9793639ebc9698c8961dcedccf6e49b' : null);
      l1 = probeL1(h, {
        enabled: true,
        mode: softPaths.length ? 'fixture' : 'sim',
        subjects: (ingest.cells || []).slice(0, 2).map((c) => c.cellId || c.cell).filter(Boolean),
        model: args.model,
        jev: args.jev,
        l0: probe,
        softWorktreeDir: args.softWorktree || undefined,
        prepareSoftWorktree: Boolean(args.softWorktree),
        baseline: {
          jsonlPaths,
          tipSha,
          exitOk: true,
          summaryOk: true,
          verificationPass: false,
        },
        softLayer: {
          jsonlPaths: softPaths,
          tipSha,
          worktree: args.softWorktree || 'soft-layer/docs-only',
          exitOk: true,
          summaryOk: true,
          verificationPass: true,
        },
      });
      // L1 fail → reject+EXPERIENCE. Allowlisted steal soft hypotheses can adopt;
      // Compose still enforces PIN/hash and shipped-direction rejection.
      if (l1.falseWin || l1.adopt === false) {
        adoptProbe = {
          ...adoptProbe,
          adopt: false,
          falseWin: l1.falseWin || adoptProbe.falseWin,
          reason: l1.reason || adoptProbe.reason,
          rejected: l1.rejected || adoptProbe.rejected,
          notes: [...(adoptProbe.notes || []), ...(l1.notes || []), 'L1 gate'],
          l1,
          softWorktree: l1.softWorktree,
          header: l1.header,
        };
      } else if (l1.adopt === true) {
        const candidateEligible =
          hypothesisIsSteal(h) ||
          h.slug === 'post-dpr-sticky-execute' ||
          h.class === 'latch' ||
          adoptProbe.adopt === true;
        adoptProbe = {
          ...adoptProbe,
          adopt: candidateEligible,
          falseWin: false,
          baseline: l1.baseline,
          contrast: l1.contrast,
          notes: [
            ...(adoptProbe.notes || []).map((note) => `L0: ${note}`),
            ...(l1.notes || []),
            candidateEligible ? 'L1 pass → may CANDIDATE' : 'L1 pass (soft deferred)',
          ],
          l1,
          softWorktree: l1.softWorktree,
          header: l1.header,
          tipShaBaseline: l1.header?.tipShaBaseline || tipSha,
          softTreeFileListHash: l1.header?.softTreeFileListHash || null,
        };
      }
    } else {
      l1 = probeL1(h, {
        enabled: false,
        reason: args.probeL1 ? 'skipped_experience_or_path_anomaly' : 'default_skip_save_quota',
      });
    }

    const composed = composeCandidate({
      hypothesis: h,
      probeResult: adoptProbe,
      ingest,
      outDir: args.outDir,
      experienceDir: path.join(args.outDir, 'experience'),
      write: !args.dryRun,
    });

    results.push({
      hypothesis: h.slug,
      prior: (h.prior || []).map((p) => p.slug),
      adopt: adoptProbe.adopt,
      falseWin: adoptProbe.falseWin,
      baselinePoison: probe.baseline.poison.count,
      contrastPoison: probe.contrast.poison.count,
      l1: l1
        ? {
            skipped: l1.skipped,
            adopt: l1.adopt,
            falseWin: l1.falseWin,
            mode: l1.mode,
            poisonDelta: l1.summary?.delta?.poisonDelta,
          }
        : null,
      wroteCandidate: composed.wroteCandidate,
      candidatePath: composed.candidatePath,
      experiencePath: composed.experiencePath,
      reason: composed.reason,
    });
  }

  console.log(JSON.stringify({ phase: 'compose', results }, null, 2));

  const candidate = results.find((r) => r.wroteCandidate);
  const anyExperience = results.some((r) => r.experiencePath);
  if (!candidate) {
    if (args.allowExperienceOnly && anyExperience) {
      console.log(
        `No CANDIDATE (explicit reject / experience-only). EXPERIENCE: ${results
          .filter((r) => r.experiencePath)
          .map((r) => r.experiencePath)
          .join(', ')}`,
      );
      process.exit(0);
    }
    console.error('No CANDIDATE written (no adopted hypothesis).');
    process.exit(1);
  }
  console.log(`CANDIDATE: ${candidate.candidatePath}`);
}

main();
