import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..');
const adrPath = path.join(repoRoot, 'docs', 'adr', '0025-harness2-meta-vs-agent-harness.md');
const adrReadmePath = path.join(repoRoot, 'docs', 'adr', 'README.md');
const offloopReadmePath = path.join(packageRoot, 'README.md');
const fixedTip = '2258685ce9793639ebc9698c8961dcedccf6e49b';

const read = (filePath) => fs.readFileSync(filePath, 'utf8');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('T-H2-K2-ADR-BOUNDARY: ADR records directory ownership and dependency direction', () => {
  assert.equal(fs.existsSync(adrPath), true, `missing ADR: ${adrPath}`);
  const adr = read(adrPath);

  for (const directory of ['offloop/', 'runtime/', 'packages/harness-core', 'packages/harness-model']) {
    assert.match(adr, new RegExp(escapeRegExp(directory)));
  }
  assert.match(adr, /dependency direction|Allowed direction|依赖方向/i);
  assert.match(adr, /offloop\/.*must not import runtime internals/s);
  assert.match(adr, /runtime\/.*never depends on `offloop\//s);
  assert.match(adr, /packages\/harness-core.*May depend on `packages\/harness-model`/s);
  assert.match(adr, /packages\/harness-model.*does not depend on either implementation/s);
});

test('T-H2-K2-ADR-GATE: ADR records MISS through review-gated evidence', () => {
  const adr = read(adrPath);
  const flowStart = adr.indexOf('MISS（未命中） / path-anomaly（路径异常）');
  const flowEnd = adr.indexOf('```', flowStart);
  assert.ok(flowStart >= 0 && flowEnd > flowStart, 'missing bounded data-flow block');
  const flow = adr.slice(flowStart, flowEnd);
  for (const term of ['MISS', 'run-from-miss', 'ingest / path-signals', 'DGR', 'EXPERIENCE', 'CANDIDATE', 'human PR']) {
    assert.ok(flow.includes(term), `flow is missing ${term}`);
  }
  assert.match(adr, /hard gate remains fail-closed in Agent Harness/);
  assert.match(adr, /no reverse online policy write/);
});

test('T-H2-K2-NO-CODE: docs-only ADR is linked from the indexes', () => {
  const adr = read(adrPath);
  const adrReadme = read(adrReadmePath);
  const offloopReadme = read(offloopReadmePath);

  assert.match(adr, /Status: Proposed/);
  assert.match(adr, /This knife is docs-only/);
  assert.match(adrReadme, /\[0025\]\(0025-harness2-meta-vs-agent-harness\.md\)/);
  assert.match(offloopReadme, /\[ADR-0025\]\(\.\.\/docs\/adr\/0025-harness2-meta-vs-agent-harness\.md\)/);
});

test('T-H2-K2-TIP-PIN: ADR cites the fixed non-empty pin and rejects empty tips', () => {
  const adr = read(adrPath);
  assert.match(fixedTip, /^[0-9a-f]{40}$/);
  assert.match(adr, new RegExp(escapeRegExp(fixedTip)));
  assert.match(adr, /empty tip is not PASS|空 tip 不是 PASS/);
  assert.match(adr, /pinEqual=false/);
});
