import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { STEAL_TIP_PIN } from '../path-signals.mjs';
import { freezeLifecycleHonest, benchLifecycleHonest } from './test-lifecycle-scan-closed-accept-r1.test.mjs';
import { probeTipHead } from './test-git-eperm-env-harden-r1.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.join(root, 'offloop/out-post-dtelp-product-pin-hygiene-r1');
const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const COMPOSE = 'e284a70868d3954cfe6ce2461683b9e3edbd3d5305c5754cd2eedcafe7aa4e4b';
const SOFT = '3dcbb96acbf980d3b73019920b247a04e1b7d85b72d0e858b4b0b55bcb6ab213';
const OLD_COMPOSE = 'd00f0ef03eb4c30cef9097534db52ee5b3e59acd355d7a204ce83a6beac76e8f';
const OLD_SOFT = 'fc2b79d71186132d41910afa0f29e26f15fbf5b0d4d9d1562c2f8754a2ec5c8a';
const LOCK = 'ddee506c29d2b78bbee181d2a9db35b21e7dfaf92eaca10f32eb34221f5624dd';
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const readJson = relative => JSON.parse(read(relative));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha = relative => digest(fs.readFileSync(path.join(root, relative)));
const existing = relative => fs.existsSync(path.join(root, relative));

const primaryFixtures = [
  'offloop/out-tip-soft-adopt-second-family-live-r1/before-integrity.json',
  'offloop/out-tip-soft-adopt-second-family-live-r1/source-integrity.json',
  'offloop/out-tip-soft-adopt-t4-retry-live-r1/before-integrity.json',
  'offloop/out-tip-soft-adopt-t4-retry-live-r1/source-integrity.json',
  'offloop/out-tip-soft-adopt-third-family-live-r1/before-integrity.json',
  'offloop/out-tip-soft-adopt-third-family-live-r1/source-integrity.json',
  'offloop/out-tip-soft-adopt-fourth-family-live-r1/before-integrity.json',
  'offloop/out-tip-soft-adopt-fourth-family-live-r1/source-integrity.json',
  'offloop/out-dayloop-tip-soft-adopt-live-r1/source-integrity.json',
  'offloop/out-tip-soft-adopt-fifth-family-live-r1/before-integrity.json',
].filter(existing);

const authorities = {
  'offloop/out-dayloop-tip-soft-adopt-live-r1': {
    'summary.json': '5f7d91d06000fab3eafe61fe6796db3a496d4c0697a1e6db10e4bbeb1d06f0e3',
    'adopt-record.json': '480e2d3e9edfb9a17ac43918065a52abda151f65f0bd39002399721f866f948e',
    'adopt-evidence.json': 'c04cb13cfcd9c9042ff9386c00be431a52d86da81e485b79665d9735a2d0f09f',
  },
  'offloop/out-tip-soft-adopt-second-family-live-r1': {
    'summary.json': 'ed181bb889d47cf7a529716c1caa6cb0fded5b7d47d1a06ff4990be020090bcb',
    'adopt-record.json': 'c7ce45c8a84de08e95cfecfb68ea71520c0a6ddd3d7d8b5d358528b3c980b721',
    'adopt-evidence.json': 'cf5200626ed8d30b2e3addf870c803d027f16458f660029b6372f0515353a488',
  },
  'offloop/out-tip-soft-adopt-t4-retry-live-r1': {
    'summary.json': '1a82c724c8c32e040d7cd4ba5c54543fe85b68ee24a43068bb6954bc7839e773',
    'adopt-record.json': 'f35ad4715e3adf60f1b0dc3c9d97931dbf2d9c4a218d65e0b25ed11bff94d951',
    'adopt-evidence.json': 'e52f6d4fb17aed62b02511aa2588a4dfd92d6ee2d59802ba03e0789231c0cab9',
  },
  'offloop/out-tip-soft-adopt-third-family-live-r1': {
    'summary.json': '54b13c005b36c27d3001288ee82fd94730bd56db1ee330d0703ae377baa7551b',
    'adopt-record.json': 'd516017555ae61a42855c74e471dc10d00566aac6f9f3edefb66ae4cb2399eb2',
    'adopt-evidence.json': '5762c9251e6dc4c6230245e878ff622ded8de359d9f303300e27f1ac61c2f02e',
  },
  'offloop/out-tip-soft-adopt-fifth-family-live-r1': {
    'summary.json': '887b52f35f80c64c7e28074065915de871fb603cf1e6a49f38e31ae9ae51f05a',
    'adopt-record.json': '7b3813c2e3741215d7c09700579a2dd6c110ae391542b4e2041bc1f46a44fb14',
    'adopt-evidence.json': 'aac744618bb0407cff72c5d944b66d50be3b8e084eee0c829685f61cac318e47',
  },
};

function assertCurrentProductPins(file, value) {
  const current = [];
  for (const [key, hash] of Object.entries(value.sessionProducts || {})) {
    if (key.endsWith('compose.mjs')) current.push(['sessionProducts.' + key, hash, COMPOSE]);
    if (key.endsWith('dayloop-soft.mjs')) current.push(['sessionProducts.' + key, hash, SOFT]);
  }
  for (const [key, hash] of Object.entries(value.allProducts || {})) {
    if (key.endsWith('/compose.mjs')) current.push(['allProducts.' + key, hash, COMPOSE]);
    if (key.endsWith('/dayloop-soft.mjs')) current.push(['allProducts.' + key, hash, SOFT]);
  }
  for (const row of value.files || []) {
    if (!row.path || (!row.path.endsWith('/compose.mjs') && !row.path.endsWith('/dayloop-soft.mjs'))) continue;
    const expected = row.path.endsWith('/compose.mjs') ? COMPOSE : SOFT;
    current.push(['files[' + row.path + '].beforeSha256', row.beforeSha256, expected]);
    current.push(['files[' + row.path + '].afterSha256', row.afterSha256, expected]);
  }
  for (const [key, hash] of Object.entries(value.productCopyHashes || {})) {
    if (key === 'compose.mjs') current.push(['productCopyHashes.compose.mjs', hash, COMPOSE]);
    if (key === 'dayloop-soft.mjs') current.push(['productCopyHashes.dayloop-soft.mjs', hash, SOFT]);
  }
  assert.ok(current.length > 0, file + ': current product pin fields are present');
  for (const [field, actual, expected] of current) {
    assert.equal(actual, expected, file + ': ' + field + ' is post-knife5 current baseline');
  }
}

test('T-pdpp-1: current tip-soft pins, authority MATCH, and historical-copy policy are explicit', t => {
  assert.ok(primaryFixtures.length >= 9, 'all available primary integrity fixtures are sampled');
  for (const file of primaryFixtures) assertCurrentProductPins(file, readJson(file));
  assert.equal(sha('offloop/compose.mjs'), COMPOSE);
  assert.equal(sha('offloop/dayloop-soft.mjs'), SOFT);

  for (const [directory, files] of Object.entries(authorities)) {
    for (const [file, expected] of Object.entries(files)) {
      assert.equal(sha(directory + '/' + file), expected, directory + '/' + file + ': immutable authority MATCH');
    }
  }

  const historical = 'offloop/out-dayloop-tip-soft-adopt-live-r1/temporary-miss-drive-t2H55F/offloop/dayloop-soft.mjs';
  assert.equal(sha(historical), OLD_SOFT, 'historical soft copy remains byte-preserved');
  const bench = read('bench-log-offloop-post-dtelp-product-pin-hygiene-r1.md');
  for (const id of ['T-dtsal-1', 'T-tsasf-1', 'T-tsatr-1', 'T-tsatf-1', 'T-tsaff-1']) {
    assert.match(bench, new RegExp(id + '[^\n]*HISTORICAL_PRODUCT_COPY|HISTORICAL_PRODUCT_COPY[^\n]*' + id));
  }
  assert.equal((bench.match(/^## EXTERNAL \/ 并行哈希$/gm) || []).length, 1);
  assert.match(bench, /\| 文件 \| 历史 \| 现盘 \| 判定 \|/);
  assert.match(bench, /POST_DTELP_PRODUCT_PIN/);
  assert.match(bench, /APPROVED_HASH_REFRESH/);
  assert.match(bench, /HISTORICAL_PRODUCT_COPY/);
  const refresh = readJson('offloop/out-post-dtelp-product-pin-hygiene-r1/pin-refresh.json');
  assert.ok(refresh.changes.length >= 20);
  assert.ok(refresh.changes.every(row => row.file && row.field && row.oldSha && row.newSha && [
    'POST_DTELP_PRODUCT_PIN', 'APPROVED_HASH_REFRESH',
  ].includes(row.classification)));
  t.diagnostic('primary current pins and five authority triples MATCH; one historical soft copy remains old by policy');
});

test('T-pdpp-2: product 0×, PIN, FROZEN handoff or SCAN CLOSED, lock, and durable session hashes remain honest', t => {
  const beforePath = path.join(out, 'before-hashes.txt');
  const afterPath = path.join(out, 'after-hashes.txt');
  const before = fs.readFileSync(beforePath);
  assert.deepEqual(before, fs.readFileSync('/tmp/codex-post-dtelp-product-pin-hygiene-r1/before-hashes.txt'));
  assert.deepEqual(before, fs.readFileSync(afterPath));
  const rows = before.toString('utf8').trim().split(/\r?\n/).map(line => {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    assert.ok(match, 'valid durable product row: ' + line);
    return { hash: match[1], file: match[2] };
  });
  const seen = new Set();
  for (const row of rows) {
    assert.ok(!seen.has(row.file), 'no duplicate durable product row: ' + row.file);
    seen.add(row.file);
    assert.equal(sha(row.file), row.hash, row.file + ': NO_PRODUCT_DELTA');
  }
  for (const file of [
    'offloop/compose.mjs', 'offloop/dayloop-soft.mjs', 'offloop/experience.mjs',
    'offloop/soft-worktree.mjs', 'offloop/propose.mjs', 'offloop/path-signals.mjs',
    'offloop/on-closed.mjs', 'offloop/probe-l1.mjs',
  ]) assert.ok(seen.has(file), file + ': required product row is durable');

  const session = readJson('offloop/out-post-dtelp-product-pin-hygiene-r1/session-start.json');
  assert.equal(session.knife, 'post-dtelp-product-pin-hygiene-r1');
  assert.equal(session.tipPin, PIN);
  assert.equal(session.tipHead, PIN);
  assert.equal(session.STEAL_TIP_PIN, PIN);
  assert.equal(session.productWrites, 0);
  assert.equal(session.runtimeWrites, 0);
  assert.equal(session.selfClosed, false);
  assert.equal(STEAL_TIP_PIN, PIN);
  const tip = probeTipHead('/workspace/dda-tip-r25');
  if (tip.ok) assert.equal(tip.head, PIN, 'readable tip HEAD remains pinned');
  else {
    assert.equal(tip.environment, true, 'tip git degradation is ENVIRONMENT only');
    t.diagnostic('ENVIRONMENT skip: tip HEAD (' + tip.code + ') ' + tip.message);
  }

  const freeze = read('freeze-offloop-post-dtelp-product-pin-hygiene-r1.md');
  // Codex hands off FROZEN; independent SCAN may flip to CLOSED — PASS · NO_PRODUCT_DELTA.
  assert.ok(freezeLifecycleHonest(freeze),
    'freeze must be FROZEN (Codex honesty) or independent SCAN CLOSED — PASS with NO_PRODUCT_DELTA');
  const headings = [...freeze.matchAll(/^# .+$/gm)];
  assert.equal(headings.length, 1, 'one freeze H1');
  const title = headings[0][0].match(/\*\*([^*]+)\*\*\s*$/)?.[1] ?? '';
  const statuses = [...freeze.matchAll(/^-\s+\*\*状态[：:]\s*([^*\n]+)\*\*/gm)];
  assert.equal(statuses.length, 1, 'one freeze 状态');
  const frozenHandoff = /^FROZEN \/ (?:开干|SCAN READY)(?:[（(]|$)/.test(title)
    && /^FROZEN \/ (?:开干|SCAN READY)(?:[（(]|$)/.test(statuses[0][1])
    && !/\bCLOSED\b/.test(`${title}\n${statuses[0][1]}`);
  const scanClosed = /^CLOSED — PASS(?:\s*[（(]NO_PRODUCT_DELTA[）)]|\s*·\s*NO_PRODUCT_DELTA)\s*$/.test(title)
    && /^CLOSED — PASS\b/.test(statuses[0][1])
    && (/独立 SCAN/.test(freeze) || /[（(]SCAN\s*·/.test(statuses[0][0] ?? statuses[0][1]));
  assert.ok(frozenHandoff || scanClosed, 'FROZEN handoff or independent SCAN CLOSED — PASS · NO_PRODUCT_DELTA');
  const lock = freeze.match(/^## 0\. 锁定[\s\S]*?(?=^## 1\. 不做)/m)?.[0];
  assert.equal(digest(Buffer.from(lock || '')), LOCK, 'freeze §0 lock remains byte-identical');

  const bench = read('bench-log-offloop-post-dtelp-product-pin-hygiene-r1.md');
  assert.ok(benchLifecycleHonest(bench),
    'bench must be FROZEN / SCAN READY or independent SCAN CLOSED — PASS with NO_PRODUCT_DELTA');
  const benchStatuses = [...bench.matchAll(/^- Status: \*\*([^*\n]+)\*\*/gm)];
  assert.equal(benchStatuses.length, 1, 'one bench Status');
  const benchFrozen = benchStatuses[0][1] === 'FROZEN / SCAN READY';
  const benchClosed = /^CLOSED — PASS(?:\s*[（(]NO_PRODUCT_DELTA[）)]|\s*·\s*NO_PRODUCT_DELTA)\s*$/.test(benchStatuses[0][1])
    && /独立 SCAN/.test(bench);
  assert.ok(benchFrozen || benchClosed, 'strict handoff or independent SCAN CLOSED; no bare self-CLOSED');
  assert.match(bench, /selfClosed=false/);
  assert.doesNotMatch(bench, /selfClosed\s*=\s*true/);
  assert.match(bench, /\bNO_PRODUCT_DELTA\b/);
  for (const line of bench.split(/\r?\n/).filter(line => /空\s*tip.*双绿/.test(line))) {
    assert.match(line, /不得|未执行|禁止/);
  }
  assert.ok(existing('offloop/out-post-dtelp-product-pin-hygiene-r1/pin-refresh.json'));
  t.diagnostic('18/18 durable product rows MATCH; PIN stable; FROZEN handoff|SCAN CLOSED dual-latch; §0 lock MATCH; selfClosed=false');
});
