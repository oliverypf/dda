import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  prepareSoftWorktree,
  planSoftFiles,
  hashSoftFileList,
  isHardGatePath,
  collectHypothesisPaths,
} from '../soft-worktree.mjs';
import { probeL1 } from '../probe.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(__dirname, 'fixtures');

test('T-swt-1: soft hypothesis → prepareSoftWorktree writes allowed files; list hashable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dda-swt-ok-'));
  const dir = path.join(root, 'tree');
  const hyp = {
    id: 'H1',
    slug: 'post-dpr-sticky-execute',
    title: 'Sticky PTE',
    class: 'latch_draft_md',
    probeKind: 'soft_or_latch_md',
    tags: ['sticky'],
    summary: 'Soft latch-md only.',
    latchDraftMd: '## Latch draft\n\n- sticky PTE after DPR\n',
  };

  const planned = planSoftFiles(hyp);
  assert.equal(planned.ok, true);
  assert.ok(planned.files.some((f) => f.kind === 'latch_md'));

  const r = prepareSoftWorktree(hyp, { dir, write: true });
  assert.equal(r.ok, true);
  assert.equal(r.rejected, false);
  assert.ok(r.writeCount >= 1);
  assert.ok(r.fileListHash && /^[a-f0-9]{64}$/.test(r.fileListHash));
  assert.ok(r.fileList.length >= 1);
  assert.ok(fs.existsSync(path.join(dir, 'latch-md/latch-draft.md')));
  assert.ok(fs.existsSync(path.join(dir, '.soft-worktree-manifest.json')));

  const again = hashSoftFileList(r.files);
  assert.equal(again.fileListHash, r.fileListHash);

  // L1 records tip SHA + file-list hash
  const l1 = probeL1(hyp, {
    enabled: true,
    mode: 'fixture',
    softWorktreeDir: path.join(root, 'l1-tree'),
    prepareSoftWorktree: true,
    baseline: {
      jsonlPaths: [path.join(fixtures, 'poison-loop-yes.jsonl')],
      tipSha: '4439768',
      verificationPass: false,
    },
    softLayer: {
      jsonlPaths: [path.join(fixtures, 'l1-soft-clean.jsonl')],
      tipSha: '4439768',
      verificationPass: true,
    },
  });
  assert.equal(l1.rejected, undefined);
  assert.equal(l1.header.tipShaBaseline, '4439768');
  assert.ok(l1.header.softTreeFileListHash);
  assert.equal(l1.summary.contrast.softTreeFileListHash, l1.header.softTreeFileListHash);
  assert.equal(l1.adopt, true);
});

test('T-swt-2: hard-gate / runtime path → reject immediately, 0× writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dda-swt-bad-'));
  const dir = path.join(root, 'tree');
  const hyp = {
    id: 'H-bad',
    slug: 'patch-runtime-lease',
    title: 'Patch lease hard gate',
    class: 'host_code_patch',
    probeKind: 'host_code_patch',
    summary: 'Edit src/runtime/lease.ts to change SAFETY lease.',
    targetPaths: ['src/runtime/lease.ts', 'packages/dda-runtime/src/topology.ts'],
    softFiles: [
      {
        relPath: 'src/runtime/lease.ts',
        content: 'export const LEASE = 0;\n',
      },
    ],
  };

  assert.ok(collectHypothesisPaths(hyp).some(isHardGatePath));
  assert.equal(isHardGatePath('src/runtime/lease.ts'), true);
  assert.equal(isHardGatePath('HOST/host-note.md'), false);

  const before = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const r = prepareSoftWorktree(hyp, { dir, write: true, writeExperience: false });
  assert.equal(r.ok, false);
  assert.equal(r.rejected, true);
  assert.equal(r.reason, 'hard_gate_path');
  assert.equal(r.writeCount, 0);
  assert.equal(r.dir, null);
  assert.equal(r.fileListHash, null);
  assert.ok(!fs.existsSync(dir), 'must not create worktree dir on hard-gate reject');
  assert.deepEqual(before, fs.existsSync(dir) ? fs.readdirSync(dir) : []);

  const l1 = probeL1(hyp, {
    enabled: true,
    mode: 'fixture',
    softWorktreeDir: path.join(root, 'l1-bad'),
    prepareSoftWorktree: true,
    baseline: { tipSha: '4439768', verificationPass: false },
    softLayer: { verificationPass: true },
  });
  assert.equal(l1.adopt, false);
  assert.equal(l1.rejected, true);
  assert.equal(l1.reason, 'hard_gate_path');
  assert.ok(!fs.existsSync(path.join(root, 'l1-bad')));
});

test('T-swt-1b: host-note soft_layer writes HOST + skill; false-win still not adopted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dda-swt-host-'));
  const hyp = {
    id: 'H2',
    slug: 'host-note-post-dpr-execute-bias',
    title: 'HOST note bias',
    class: 'soft_layer',
    tags: ['soft', 'host-note', 'skill'],
    summary: 'Prefer write/execute after demote.',
    latchDraftMd: null,
  };
  const r = prepareSoftWorktree(hyp, { dir: path.join(root, 'tree'), write: true });
  assert.equal(r.ok, true);
  const rels = r.fileList.map((f) => f.relPath).sort();
  assert.ok(rels.some((p) => /HOST/i.test(p)));
  assert.ok(rels.some((p) => /skill/i.test(p)));
  const host = fs.readFileSync(path.join(r.dir, 'HOST/host-note.md'), 'utf8');
  assert.match(host, /After DPR \(diagnose_probe_exhausted_recover\).*DIAGNOSE_PROBE_RECOVER/);
  assert.match(host, /stop further read\/list\/focus empty probes/i);
  assert.match(host, /prefer bounded file\.write\/file\.patch or shell\.execute\/test\.execute\/verify/);
  assert.match(host, /Sticky execute \(#83 \/ post-dpr-sticky-execute\) is the latch direction/);
  assert.match(host, /green \+ poisonLoop != 0 = false win/);
  assert.match(host, /_Soft-layer only\. Never edits runtime hard gates\._$/);

  const l1 = probeL1(hyp, {
    enabled: true,
    mode: 'fixture',
    softWorktreeDir: path.join(root, 'l1'),
    prepareSoftWorktree: true,
    baseline: {
      jsonlPaths: [path.join(fixtures, 'poison-loop-yes.jsonl')],
      tipSha: '4439768',
      verificationPass: false,
    },
    softLayer: {
      jsonlPaths: [path.join(fixtures, 'l1-soft-false-win.jsonl')],
      tipSha: '4439768',
      verificationPass: true,
      exitOk: true,
      summaryOk: true,
    },
  });
  assert.equal(l1.falseWin, true);
  assert.equal(l1.adopt, false);
  assert.ok(l1.header.softTreeFileListHash);
});
