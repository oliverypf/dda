import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { composeCandidate } from '../compose.mjs';

test('T-ol-4: EXPERIENCE append readable', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ol-exp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const expDir = path.join(dir, 'experience');
  composeCandidate({
    hypothesis: {
      id: 'H3',
      slug: 'experience-poison-loop-lesson',
      title: 'lesson',
      summary: 'x',
      evidence: [{ text: 'e', sequence: 1 }],
    },
    probeResult: { adopt: false, falseWin: false, baseline: { poison: { count: 1 } }, notes: [] },
    ingest: { cells: [{ cellId: 't3/run60a' }], totals: { poisonLoopCount: 1 } },
    outDir: dir,
    experienceDir: expDir,
    date: '2026-10-22',
    write: true,
  });
  const files = fs.readdirSync(expDir);
  assert.ok(files.length >= 1);
  const body = fs.readFileSync(path.join(expDir, files[0]), 'utf8');
  assert.match(body, /EXPERIENCE/);
  assert.match(body, /0×/);
});

test('T-ol-4: grep dda runtime — no read of dda-drive/experience as Memory', () => {
  // Prefer tip/master-ish worktree; fall back to /workspace/dda
  const candidates = [
    '/workspace/dda-post-dpr-sticky-execute-r1',
    '/workspace/dda-topology-live-r5',
    '/workspace/dda',
  ];
  const root = candidates.find((p) => fs.existsSync(path.join(p, 'runtime')));
  assert.ok(root, 'expected a dda checkout with runtime/');

  const runtimeDir = path.join(root, 'runtime');
  // Scan directly so this isolation check also works where child processes are denied.
  const forbidden = /dda-drive\/experience|experience\/.*memory|readExperience|loadExperience/i;
  const hits = [];
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(file);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(file);
        if (content.includes(0)) continue;
        for (const [index, line] of content.toString('utf8').split('\n').entries()) {
          if (forbidden.test(line)) hits.push(`${file}:${index + 1}:${line}`);
        }
      }
    }
  }
  scan(runtimeDir);

  const lines = hits
    .map((l) => l.trim())
    .filter(Boolean)
    // allow comments that explicitly forbid the pattern
    .filter((l) => !/0×|must not|never read|forbid/i.test(l));

  assert.equal(
    lines.length,
    0,
    `runtime must 0× read dda-drive/experience; hits:\n${lines.join('\n')}`,
  );
});
