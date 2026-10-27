/**
 * Soft-layer worktree prep for Probe L1 contrast.
 * Allowed: HOST note / skill / latch-md / docs under an isolated dir.
 * Forbidden: lease / topology / runtime src (hard-gate) paths — reject, 0× writes.
 * Never edits oliverypf/dda runtime.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const PRODUCT_ROOT = path.dirname(fileURLToPath(import.meta.url));

function configuredExperienceDir(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit;
  const fromEnv = process.env.OFFLOOP_EXPERIENCE_DIR;
  return typeof fromEnv === 'string' && fromEnv.trim()
    ? fromEnv
    : path.join(PRODUCT_ROOT, 'experience');
}

/** Relative paths allowed under the soft worktree root. */
export const ALLOWED_SOFT_PREFIXES = Object.freeze([
  'HOST/',
  'host/',
  'docs/',
  'skill/',
  'skills/',
  'latch/',
  'latch-md/',
]);

export const ALLOWED_SOFT_BASENAMES = Object.freeze([
  'HOST.md',
  'HOST_NOTE.md',
  'host-note.md',
  'SKILL.md',
  'latch.md',
  'latch-draft.md',
  'README.md',
]);

/**
 * Hard-gate / runtime paths — hypothesis must not target these.
 * Matching → immediate reject, 0× worktree writes.
 */
export const HARD_GATE_PATH_RE = Object.freeze([
  /(?:^|\/)(?:packages\/)?(?:dda[-_]?runtime|runtime)\//i,
  /(?:^|\/)src\/(?:runtime|harness|topology|lease)\b/i,
  /(?:^|\/)(?:topology|lease|hardDecision|hard-decision|denylist)\.(?:ts|js|mjs|cjs)\b/i,
  /(?:^|\/)(?:SafetyLease|safety[_-]lease|TOPOLOGY_BUDGET)\b/i,
  /node_modules\/.*dda/i,
  /oliverypf\/dda\//i,
  /(?:^|\/)tip-(?:r\d+|product).*\/src\//i,
]);

/**
 * Collect path-like targets declared on a hypothesis.
 * @param {object} hypothesis
 * @returns {string[]}
 */
export function collectHypothesisPaths(hypothesis) {
  const out = [];
  const push = (v) => {
    if (v == null) return;
    if (Array.isArray(v)) {
      for (const x of v) push(x);
      return;
    }
    if (typeof v === 'object') {
      if (typeof v.path === 'string') out.push(v.path);
      if (typeof v.relPath === 'string') out.push(v.relPath);
      if (typeof v.file === 'string') out.push(v.file);
      if (typeof v.target === 'string') out.push(v.target);
      return;
    }
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
  };

  push(hypothesis?.targetPaths);
  push(hypothesis?.paths);
  push(hypothesis?.files);
  push(hypothesis?.softFiles);
  push(hypothesis?.patchPaths);
  push(hypothesis?.writePaths);
  push(hypothesis?.hostPaths);
  push(hypothesis?.runtimePaths);

  // Also scan summary/title for explicit path tokens that look like repo files
  const blob = `${hypothesis?.summary || ''}\n${hypothesis?.title || ''}\n${hypothesis?.latchDraftMd || ''}`;
  for (const m of blob.matchAll(
    /(?:^|[\s`"'(])((?:packages\/|src\/|runtime\/|tip-[^\s/`"')]+\/src\/)[^\s`"')]+)/g,
  )) {
    out.push(m[1]);
  }

  return [...new Set(out)];
}

/**
 * @param {string} p
 * @returns {boolean}
 */
export function isHardGatePath(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (!s) return false;
  return HARD_GATE_PATH_RE.some((re) => re.test(s));
}

/**
 * @param {string} rel
 * @returns {boolean}
 */
export function isAllowedSoftRelPath(rel) {
  const s = String(rel || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!s || s.includes('..')) return false;
  if (isHardGatePath(s)) return false;
  const base = path.posix.basename(s);
  if (ALLOWED_SOFT_BASENAMES.some((b) => b.toLowerCase() === base.toLowerCase())) return true;
  if (ALLOWED_SOFT_PREFIXES.some((pre) => s.startsWith(pre) || s.toLowerCase().startsWith(pre.toLowerCase()))) {
    return /\.(md|txt|markdown)$/i.test(s);
  }
  // bare docs-like markdown at root of soft tree
  if (/^(HOST|host-note|latch|SKILL|README)/i.test(base) && /\.md$/i.test(base)) return true;
  return false;
}

/** Match this direction only; a generic host-note tag is not enough. */
function isHostNotePostDprExecuteBias(hypothesis) {
  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/_/g, '-');
  const direction = 'host-note-post-dpr-execute-bias';
  const tags = new Set(Array.isArray(hypothesis?.tags) ? hypothesis.tags.map(normalize) : []);
  return normalize(hypothesis?.slug) === direction || tags.has(direction) ||
    (tags.has('host-note') && (tags.has('post-dpr-execute-bias') ||
      (tags.has('post-dpr') && tags.has('execute-bias'))));
}

/** Match only explicit sticky-execute directions, never a bare sticky tag. */
function isPostDprStickyExecute(hypothesis) {
  const normalize = (value) => String(value || '').trim().toLowerCase().replace(/_/g, '-');
  const tags = new Set(Array.isArray(hypothesis?.tags) ? hypothesis.tags.map(normalize) : []);
  return ['post-dpr-sticky-execute', 'sticky-execute', 'post-dpr-sticky'].includes(normalize(hypothesis?.slug)) ||
    tags.has('post-dpr-sticky-execute') ||
    (tags.has('sticky') && tags.has('post-dpr') &&
      (tags.has('execute') || tags.has('pte') || tags.has('sticky-execute')));
}

function buildPostDprStickyExecuteBody() {
  return [
    '## Sticky execute — soft HOST/latch guidance',
    '',
    'After DPR under PLAN_THEN_EXECUTE: probe-budget-only or JEV_EVIDENCE_REQUIRED-only FAIL must not re-upgrade to DIAGNOSE.',
    'Reference post_dpr_sticky_execute when suppressing this re-upgrade (soft guidance).',
    'This is soft HOST/latch guidance; it does not reimplement the runtime latch table or #83/#84 code.',
    '',
    '_Soft-layer only. Never edits runtime hard gates._',
  ].join('\n');
}

function appendPostDprStickyExecuteBody(content) {
  const body = buildPostDprStickyExecuteBody();
  return content.includes(body) ? content : content ? `${content}\n\n${body}` : body;
}

function buildHostNotePostDprExecuteBiasBody() {
  return [
    'HOST_DIAGNOSE_PROBE_EXHAUSTED_RECOVER: Probe budget exhausted under DIAGNOSE_PROBE_RECOVER.',
    'After DPR (diagnose_probe_exhausted_recover) under DIAGNOSE_PROBE_RECOVER: stop further read/list/focus empty probes.',
    'Next actions should prefer bounded file.write/file.patch or shell.execute/test.execute/verify.',
    'Sticky execute (#83 / post-dpr-sticky-execute) is the latch direction for the PLAN_THEN_EXECUTE window; this HOST note provides soft guidance only.',
    'probe-budget-only or JEV_EVIDENCE_REQUIRED-only FAIL must not re-upgrade to DIAGNOSE (post_dpr_sticky_execute).',
    'At most a small number of diagnose-probe-exhausted recovers per run; keep this recovery bounded.',
    'Measure the contrast: green + poisonLoop != 0 = false win. Accept a soft-layer win only when verification is green and poisonLoop == 0.',
    '',
    '_Soft-layer only. Never edits runtime hard gates._',
  ].join('\n');
}

/**
 * Build planned soft files from a soft hypothesis (no disk I/O).
 * @param {object} hypothesis
 * @returns {{ ok: true, files: { relPath: string, content: string, kind: string }[] } | { ok: false, reason: string, hardGatePaths: string[] }}
 */
export function planSoftFiles(hypothesis) {
  const declared = collectHypothesisPaths(hypothesis);
  const hard = declared.filter(isHardGatePath);
  if (hard.length > 0) {
    return {
      ok: false,
      reason: 'hard_gate_path',
      hardGatePaths: hard,
      files: [],
    };
  }
  const hostNotePostDprExecuteBias = isHostNotePostDprExecuteBias(hypothesis);
  const postDprStickyExecute = isPostDprStickyExecute(hypothesis);

  // Explicit softFiles: [{ path|relPath, content, kind? }]
  /** @type {{ relPath: string, content: string, kind: string }[]} */
  const files = [];
  const softFiles = hypothesis?.softFiles;
  if (Array.isArray(softFiles) && softFiles.length > 0) {
    for (const f of softFiles) {
      const rel = String(f.relPath || f.path || f.file || '').replace(/\\/g, '/').replace(/^\.\//, '');
      if (!isAllowedSoftRelPath(rel)) {
        return {
          ok: false,
          reason: isHardGatePath(rel) ? 'hard_gate_path' : 'disallowed_soft_path',
          hardGatePaths: isHardGatePath(rel) ? [rel] : [],
          disallowedPath: rel,
          files: [],
        };
      }
      let content = String(f.content ?? '');
      if (postDprStickyExecute && /(?:^|\/)latch-md\/|(?:^|\/)latch-draft\.md$/i.test(rel)) {
        content = appendPostDprStickyExecuteBody(content);
      }
      files.push({
        relPath: rel,
        content: hostNotePostDprExecuteBias && rel.toLowerCase() === 'host/host-note.md'
          ? `${content}\n\n${buildHostNotePostDprExecuteBiasBody()}`
          : content,
        kind: f.kind || classifySoftKind(rel),
      });
    }
  } else {
    // Derive from hypothesis class / latchDraftMd / summary
    const slug = hypothesis?.slug || 'soft-hypothesis';
    if (postDprStickyExecute || hypothesis?.latchDraftMd) {
      files.push({
        relPath: 'latch-md/latch-draft.md',
        content: postDprStickyExecute
          ? appendPostDprStickyExecuteBody(String(hypothesis?.latchDraftMd ?? ''))
          : String(hypothesis.latchDraftMd),
        kind: 'latch_md',
      });
    }
    if (hostNotePostDprExecuteBias || (hypothesis?.class === 'soft_layer' && !postDprStickyExecute) || hypothesis?.tags?.includes('host-note')) {
      files.push({
        relPath: 'HOST/host-note.md',
        content: [
          `# HOST note — ${hypothesis.title || slug}`,
          '',
          hypothesis.summary || '',
          '',
          hostNotePostDprExecuteBias
            ? buildHostNotePostDprExecuteBiasBody()
            : '_Soft-layer only. Never edits runtime hard gates._',
        ].join('\n'),
        kind: 'host_note',
      });
    }
    if (hypothesis?.class === 'soft_layer' || hypothesis?.tags?.includes('skill')) {
      files.push({
        relPath: 'skill/SKILL.md',
        content: [
          `# Skill — ${hypothesis.title || slug}`,
          '',
          hypothesis.summary || '',
          '',
          'Guidance only (soft harness). No lease/topology/runtime src edits.',
        ].join('\n'),
        kind: 'skill',
      });
    }
    if (files.length === 0) {
      files.push({
        relPath: 'docs/soft-hypothesis.md',
        content: [
          `# Soft hypothesis — ${slug}`,
          '',
          `title: ${hypothesis?.title || ''}`,
          '',
          hypothesis?.summary || '(no summary)',
          '',
          '_Isolated soft worktree. Hard gates untouched._',
        ].join('\n'),
        kind: 'docs',
      });
    }
  }

  // Final gate on planned relPaths
  for (const f of files) {
    if (!isAllowedSoftRelPath(f.relPath) || isHardGatePath(f.relPath)) {
      return {
        ok: false,
        reason: 'hard_gate_path',
        hardGatePaths: [f.relPath],
        files: [],
      };
    }
  }

  return { ok: true, files, hardGatePaths: [] };
}

function classifySoftKind(rel) {
  const s = rel.toLowerCase();
  if (s.includes('latch')) return 'latch_md';
  if (s.includes('host')) return 'host_note';
  if (s.includes('skill')) return 'skill';
  return 'docs';
}

/**
 * Stable file-list hash: sha256 over sorted "relPath\\0sha256(content)\\n".
 * @param {{ relPath: string, content: string }[]} files
 * @returns {{ fileList: { relPath: string, sha256: string, bytes: number }[], fileListHash: string }}
 */
export function hashSoftFileList(files) {
  const fileList = [...files]
    .map((f) => {
      const body = String(f.content ?? '');
      const sha256 = crypto.createHash('sha256').update(body, 'utf8').digest('hex');
      return { relPath: f.relPath.replace(/\\/g, '/'), sha256, bytes: Buffer.byteLength(body, 'utf8') };
    })
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const material = fileList.map((e) => `${e.relPath}\0${e.sha256}\n`).join('');
  const fileListHash = crypto.createHash('sha256').update(material, 'utf8').digest('hex');
  return { fileList, fileListHash };
}

/**
 * Prepare an isolated soft worktree directory from a hypothesis.
 *
 * @param {object} hypothesis
 * @param {{
 *   rootDir?: string,
 *   dir?: string,
 *   write?: boolean,
 *   experienceDir?: string,
 *   writeExperience?: boolean,
 *   date?: string,
 * }} [opts]
 * @returns {object}
 */
export function prepareSoftWorktree(hypothesis, opts = {}) {
  const write = opts.write !== false;
  const rootDir = opts.rootDir || path.join('/tmp', 'dda-offloop-soft-worktrees');
  const dir =
    opts.dir ||
    path.join(
      rootDir,
      `${sanitizeSlug(hypothesis?.slug || 'soft')}-${stamp()}`,
    );

  const planned = planSoftFiles(hypothesis);
  if (!planned.ok) {
    let experiencePath = null;
    if (opts.writeExperience) {
      experiencePath = maybeWriteRejectExperience(hypothesis, planned, opts);
    }
    return {
      ok: false,
      rejected: true,
      reason: planned.reason,
      hardGatePaths: planned.hardGatePaths || [],
      disallowedPath: planned.disallowedPath || null,
      dir: null,
      wrote: false,
      writeCount: 0,
      files: [],
      fileList: [],
      fileListHash: null,
      experiencePath,
      notes: [
        'reject: hypothesis targets runtime/hard-gate path — 0× soft worktree writes',
        ...(planned.hardGatePaths || []).map((p) => `hard-gate: ${p}`),
      ],
    };
  }

  const { fileList, fileListHash } = hashSoftFileList(planned.files);

  if (!write) {
    return {
      ok: true,
      rejected: false,
      reason: null,
      dir,
      wrote: false,
      writeCount: 0,
      files: planned.files,
      fileList,
      fileListHash,
      experiencePath: null,
      notes: ['dry-plan: soft files hashed; disk write skipped'],
    };
  }

  fs.mkdirSync(dir, { recursive: true });
  let writeCount = 0;
  for (const f of planned.files) {
    const abs = path.join(dir, f.relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, f.content, 'utf8');
    writeCount += 1;
  }

  // Manifest for audit / L1 summary
  const manifestPath = path.join(dir, '.soft-worktree-manifest.json');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        slug: hypothesis?.slug || null,
        tipShaHint: hypothesis?.tipSha || null,
        fileListHash,
        fileList,
        softLayerOnly: true,
        hardGates: 'untouched',
      },
      null,
      2,
    ),
    'utf8',
  );

  return {
    ok: true,
    rejected: false,
    reason: null,
    dir,
    wrote: true,
    writeCount,
    files: planned.files,
    fileList,
    fileListHash,
    manifestPath,
    experiencePath: null,
    notes: [
      `soft worktree ready: ${dir}`,
      `files=${writeCount} fileListHash=${fileListHash.slice(0, 12)}…`,
      'allowed: HOST note / skill / latch-md / docs only',
    ],
  };
}

function sanitizeSlug(slug) {
  return String(slug || 'soft')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'soft';
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function maybeWriteRejectExperience(hypothesis, planned, opts) {
  const experienceDir = configuredExperienceDir(opts.experienceDir);
  const date = opts.date || todayAdak();
  const slug = sanitizeSlug(hypothesis?.slug || 'hard-gate-reject');
  const body = `# EXPERIENCE — soft worktree rejected (hard-gate path)

- **date**: ${date} (America/Adak)
- **slug**: ${slug}
- **adopted_candidate**: no (hard_gate_path)
- **hardGatePaths**: ${(planned.hardGatePaths || []).map((p) => `\`${p}\``).join(', ') || '（无）'}
- **lesson**: Soft worktree may only stack HOST note / skill / latch-md / docs. Paths under runtime / lease / topology / host src are hard gates — reject immediately, **0×** writes. Never edit \`oliverypf/dda\` runtime from offloop Probe.
- **runtime contract**: DDA runtime must **0×** read \`dda-drive/experience/\` as unchecked Memory.
`;
  try {
    fs.mkdirSync(experienceDir, { recursive: true });
    const expPath = path.join(experienceDir, `${date}-${slug}-soft-worktree-hard-gate-rejected.md`);
    fs.writeFileSync(expPath, body, 'utf8');
    return expPath;
  } catch {
    return null;
  }
}

function todayAdak() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
