#!/usr/bin/env node
/**
 * Probe L1 smoke CLI (skippable; fixture/sim by default).
 *
 * Usage:
 *   node probe-l1.mjs --skip
 *   node probe-l1.mjs --fixture --baseline PATH --soft PATH [--slug SLUG]
 *   node probe-l1.mjs --sim --baseline PATH [--slug post-dpr-sticky-execute]
 *   node probe-l1.mjs --live --baseline PATH --soft PATH --model M --jev J
 *
 * Soft worktree = latch-md/docs only. Never auto-FROZEN.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeL1 } from './probe.mjs';
import { prepareSoftWorktree } from './soft-worktree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {
    skip: false,
    enabled: false,
    fixture: false,
    sim: false,
    live: false,
    baseline: [],
    soft: [],
    slug: 'post-dpr-sticky-execute',
    subjects: [],
    model: null,
    jev: null,
    tipSha: '2258685ce9793639ebc9698c8961dcedccf6e49b',
    softWorktree: null,
    prepareSoft: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--skip') out.skip = true;
    else if (a === '--fixture') {
      out.fixture = true;
      out.enabled = true;
    } else if (a === '--sim') {
      out.sim = true;
      out.enabled = true;
    } else if (a === '--live') {
      out.live = true;
      out.enabled = true;
    } else if (a === '--baseline') out.baseline.push(argv[++i]);
    else if (a === '--soft') out.soft.push(argv[++i]);
    else if (a === '--slug') out.slug = argv[++i];
    else if (a === '--subject') out.subjects.push(argv[++i]);
    else if (a === '--model' || a === '--jev') {
      const value = argv[i + 1];
      out[a.slice(2)] = value !== undefined && !value.startsWith('-') ? argv[++i] : null;
    } else if (a === '--tip-sha') out.tipSha = argv[++i];
    else if (a === '--soft-worktree') out.softWorktree = argv[++i];
    else if (a === '--prepare-soft') out.prepareSoft = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage:
  node probe-l1.mjs --skip
  node probe-l1.mjs --fixture --baseline PATH --soft PATH
  node probe-l1.mjs --sim --baseline PATH
  node probe-l1.mjs --live --baseline PATH --soft PATH --model M --jev J
  node probe-l1.mjs --fixture --soft-worktree DIR --baseline PATH --soft PATH
  node probe-l1.mjs --prepare-soft --soft-worktree DIR   # prepare only

Default is skip (no quota burn). Fixture/sim for CI.
--tip-sha SHA overrides the baseline (default: 2258685ce9793639ebc9698c8961dcedccf6e49b, post-#90 master).
--soft-worktree DIR records baseline tip SHA + soft file-list hash in summary.`);
    process.exit(0);
  }

  if (args.live && (!args.model?.trim() || !args.jev?.trim())) {
    console.error('live_requires_model_jev: --live requires both --model and --jev with nonblank values.');
    process.exit(2);
  }

  const hyp = {
    id: 'H-l1',
    slug: args.slug,
    probeKind: 'soft_or_latch_md',
    title: args.slug,
    class: args.slug.includes('host-note') ? 'soft_layer' : 'latch_draft_md',
    tags: args.slug.includes('host-note') ? ['soft', 'host-note'] : ['sticky'],
    latchDraftMd:
      args.slug === 'post-dpr-sticky-execute'
        ? [
            '## Latch draft (markdown only)',
            '',
            'When recover≥1 and topology is PLAN_THEN_EXECUTE:',
            '- Do NOT upgrade to DIAGNOSE_PROBE_RECOVER for probe-budget-only failure.',
            '- Emit harness.post_dpr_sticky_execute when suppressing.',
          ].join('\n')
        : null,
    summary: `L1 soft worktree smoke for ${args.slug}`,
  };

  if (args.prepareSoft && !args.enabled) {
    const prep = prepareSoftWorktree(hyp, { dir: args.softWorktree || undefined, write: true });
    console.log(JSON.stringify(prep, null, 2));
    process.exit(prep.ok ? 0 : 2);
  }

  if (args.skip || !args.enabled) {
    const r = probeL1(hyp, { enabled: false });
    console.log(JSON.stringify(r, null, 2));
    process.exit(0);
  }

  const fixtures = path.join(__dirname, 'test/fixtures');
  const baselinePaths =
    args.baseline.length > 0
      ? args.baseline
      : [path.join(fixtures, 'poison-loop-yes.jsonl')];
  const softPaths =
    args.soft.length > 0
      ? args.soft
      : args.sim
        ? []
        : [path.join(fixtures, 'l1-soft-clean.jsonl')];

  const mode = args.live ? 'live' : args.sim ? 'sim' : 'fixture';
  const r = probeL1(hyp, {
    enabled: true,
    mode,
    subjects: args.subjects.length ? args.subjects : ['t3/fixture'],
    model: args.model,
    jev: args.jev,
    softWorktreeDir: args.softWorktree || undefined,
    prepareSoftWorktree: Boolean(args.softWorktree) || args.prepareSoft,
    baseline: {
      jsonlPaths: baselinePaths,
      tipSha: args.tipSha,
      exitOk: true,
      summaryOk: true,
      verificationPass: false,
    },
    softLayer: {
      jsonlPaths: softPaths,
      tipSha: args.tipSha,
      worktree: args.softWorktree || 'soft-layer/docs-only',
      exitOk: true,
      summaryOk: true,
      verificationPass: true,
    },
  });

  console.log(JSON.stringify(r, null, 2));
  if (r.rejected) process.exit(2);
  process.exit(r.falseWin ? 2 : r.adopt ? 0 : 1);
}

main();
