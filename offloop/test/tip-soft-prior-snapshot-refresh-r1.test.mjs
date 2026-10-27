import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { STEAL_TIP_PIN } from '../path-signals.mjs';
import { probeTipHead } from './test-git-eperm-env-harden-r1.test.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const knife = 'tip-soft-prior-snapshot-refresh-r1';
const out = `offloop/out-${knife}`;
const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const priorDocument = 'bench-log-offloop-dayloop-tip-soft-adopt-live-r1.md';
const stalePriorSha = 'f75affc1f0de4a20aef6d784d82d1f2bcd148e8727329dce83735f833ab59d2c';
const livePriorSha = '3dcdc191f5d8e0d5deee4bd504150b1650d666323a6993bd59b61a2a0d67b17c';
const freezeLockSha256 = '65ac87978fd6afb64b5629224eb6b847292f0fb07507fe6abe6eb5df5b1011c1';
const readBytes = relative => fs.readFileSync(path.join(root, relative));
const read = relative => readBytes(relative).toString('utf8');
const readJson = relative => JSON.parse(read(relative));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sha256 = relative => digest(readBytes(relative));

// Captured before this knife's six edits. Reversing only the selected value must
// reproduce these whole-file hashes, including all other fields and whitespace.
const fixtures = {
  'offloop/out-tip-soft-adopt-t4-retry-live-r1/before-integrity.json':
    'face5094d8e0d54684cbc2e8caaf82c868a85f283310cc8f9f9594935a0df405',
  'offloop/out-tip-soft-adopt-t4-retry-live-r1/source-integrity.json':
    '419eca5fb46141a016e4447b8361530e9f8465ab4e8599a2eadd9bcd6fd967f8',
  'offloop/out-tip-soft-adopt-third-family-live-r1/before-integrity.json':
    '3211a85fbc9fe4673c59958fe1ce2f53cf4ecece7fa4302391d8ef25574977f3',
  'offloop/out-tip-soft-adopt-third-family-live-r1/source-integrity.json':
    'a0cff9b8a7313efc10aaaeb5d3ebdd6b52756253096fbb06f838eee06abeb311',
  'offloop/out-tip-soft-adopt-third-family-live-r1/knife5-suite-overlay/before-integrity.json':
    'face5094d8e0d54684cbc2e8caaf82c868a85f283310cc8f9f9594935a0df405',
  'offloop/out-tip-soft-adopt-third-family-live-r1/knife5-suite-overlay/source-integrity.json':
    '419eca5fb46141a016e4447b8361530e9f8465ab4e8599a2eadd9bcd6fd967f8',
};
const authority = {
  'dayloop-tip-soft-adopt-live-r1': {
    'summary.json': '5f7d91d06000fab3eafe61fe6796db3a496d4c0697a1e6db10e4bbeb1d06f0e3',
    'adopt-record.json': '480e2d3e9edfb9a17ac43918065a52abda151f65f0bd39002399721f866f948e',
    'adopt-evidence.json': 'c04cb13cfcd9c9042ff9386c00be431a52d86da81e485b79665d9735a2d0f09f',
  },
  'tip-soft-adopt-second-family-live-r1': {
    'summary.json': 'ed181bb889d47cf7a529716c1caa6cb0fded5b7d47d1a06ff4990be020090bcb',
    'adopt-record.json': 'c7ce45c8a84de08e95cfecfb68ea71520c0a6ddd3d7d8b5d358528b3c980b721',
    'adopt-evidence.json': 'cf5200626ed8d30b2e3addf870c803d027f16458f660029b6372f0515353a488',
  },
  'tip-soft-adopt-t4-retry-live-r1': {
    'summary.json': '1a82c724c8c32e040d7cd4ba5c54543fe85b68ee24a43068bb6954bc7839e773',
    'adopt-record.json': 'f35ad4715e3adf60f1b0dc3c9d97931dbf2d9c4a218d65e0b25ed11bff94d951',
    'adopt-evidence.json': 'e52f6d4fb17aed62b02511aa2588a4dfd92d6ee2d59802ba03e0789231c0cab9',
  },
  'tip-soft-adopt-third-family-live-r1': {
    'summary.json': '54b13c005b36c27d3001288ee82fd94730bd56db1ee330d0703ae377baa7551b',
    'adopt-record.json': 'd516017555ae61a42855c74e471dc10d00566aac6f9f3edefb66ae4cb2399eb2',
    'adopt-evidence.json': '5762c9251e6dc4c6230245e878ff622ded8de359d9f303300e27f1ac61c2f02e',
  },
};
const conclusions = {
  'dayloop-tip-soft-adopt-live-r1': {
    adopt: true, result: 'success', requestSha256: 'f52fe3935c678514be236a848460ee1cfc2f14782f232f6a373beb0e5bea5d31',
  },
  'tip-soft-adopt-second-family-live-r1': {
    adopt: false, result: 'TRANSPORT', requestSha256: '82a7a2dab9de482955b86fef7dae9fba2cc9e3e6a10d13681266296c21ca08af',
  },
  'tip-soft-adopt-t4-retry-live-r1': {
    adopt: true, result: 'success', requestSha256: 'f20658bd8eefc4cc75e97f3f5dd344f915e28afa72feea6ed0e3029d436da753',
  },
  'tip-soft-adopt-third-family-live-r1': {
    adopt: true, result: 'success', requestSha256: '34358f4705b2966eda44638035e03185695158a3607b22c6ba2b4da968d47062',
  },
};
const protectionFaces = [
  'dayloop-soft.mjs', 'on-closed.mjs', 'probe-l1.mjs', 'soft-worktree.mjs',
  'compose.mjs', 'experience.mjs', 'propose.mjs', 'path-signals.mjs',
];

test('T-tspsr-1: six exclusive prior snapshots match the live bench; all other fixture bytes and adopt/TRANSPORT authority remain fixed', t => {
  assert.equal(sha256(priorDocument), livePriorSha, 'live bench SHA-256 remains the authorized refresh target');
  for (const [file, beforeSha] of Object.entries(fixtures)) {
    const text = read(file);
    const prior = JSON.parse(text).priorDocuments;
    const keys = Object.keys(prior).filter(key => key.endsWith(priorDocument));
    assert.equal(keys.length, 1, `${file}: exactly one target priorDocuments entry`);
    const key = keys[0];
    assert.equal(prior[key], livePriorSha, `${file}: target priorDocuments MATCH`);
    assert.equal(text.includes(stalePriorSha), false, `${file}: no remaining stale SHA`);
    const currentEntry = `${JSON.stringify(key)}: ${JSON.stringify(livePriorSha)}`;
    const oldEntry = `${JSON.stringify(key)}: ${JSON.stringify(stalePriorSha)}`;
    assert.equal(text.split(currentEntry).length, 2, `${file}: one exact replacement`);
    assert.equal(digest(text.replace(currentEntry, oldEntry)), beforeSha,
      `${file}: every other prior, product/archive/freeze/PIN field and byte stays unchanged`);
  }
  for (const [family, files] of Object.entries(authority)) {
    for (const [file, expected] of Object.entries(files)) {
      assert.equal(sha256(`offloop/out-${family}/${file}`), expected, `${family}/${file}: authority bytes MATCH`);
    }
    for (const file of ['summary.json', 'adopt-record.json']) {
      const record = readJson(`offloop/out-${family}/${file}`);
      for (const [key, expected] of Object.entries(conclusions[family])) {
        assert.equal(record[key], expected, `${family}/${file}: historical ${key} preserved`);
      }
    }
  }
  t.diagnostic('Target tsatr/tsatf prior check: 6/6 MATCH; 12 authority SHA-256 checks MATCH; no burn or replay');
});

test('T-tspsr-2: PIN, every session product and freeze §0 remain fixed; freeze/bench stay FROZEN handoff or independent SCAN CLOSED with selfClosed=false', t => {
  const snapshots = {
    'before-hashes.txt': '64606fb422165386af72ffc1589d20b553618834dedf3a4fa12f979284318bd4',
    'session-start.json': '39caf21b56c9b8f886856bebcc31331eb6ef389dee12ee269261ebbc33013660',
  };
  for (const [name, expected] of Object.entries(snapshots)) {
    const copied = readBytes(`${out}/${name}`);
    assert.equal(digest(copied), expected, `${name}: durable session copy is pinned`);
    const original = `/tmp/codex-${knife}/${name}`;
    if (fs.existsSync(original)) assert.deepEqual(copied, fs.readFileSync(original), `${name}: verbatim session copy`);
  }
  const session = readJson(`${out}/session-start.json`);
  assert.equal(session.knife, knife);
  assert.equal(session.wave, 'wave12');
  assert.equal(session.knifeNumber, 2);
  assert.equal(session.pack, 'A');
  for (const key of ['tipPin', 'tipHead', 'STEAL_TIP_PIN']) assert.equal(session[key], PIN);
  for (const key of ['productWrites', 'runtimeWrites']) assert.equal(session[key], 0);
  assert.equal(session.selfClosed, false);
  assert.equal(session.freezeLockSha256, freezeLockSha256);
  assert.equal(session.stalePriorSha, stalePriorSha);
  assert.equal(session.livePriorSha, livePriorSha);
  assert.equal(STEAL_TIP_PIN, PIN);
  assert.equal(read(`${out}/tip-head.txt`).trim(), PIN);
  const tip = probeTipHead('/workspace/dda-tip-r25');
  if (tip.ok) assert.equal(tip.head, PIN, 'readable tip HEAD remains pinned');
  else {
    assert.equal(tip.environment, true, 'only git availability may degrade to ENVIRONMENT');
    t.diagnostic(`ENVIRONMENT skip: tip git HEAD (${tip.code}): ${tip.message}; STEAL_TIP_PIN/session PIN and all other assertions remain checked`);
  }

  const before = readBytes(`${out}/before-hashes.txt`);
  assert.deepEqual(readBytes(`${out}/after-hashes.txt`), before, 'same product list, order and duplicate rows after work');
  const rows = before.toString('utf8').trim().split('\n');
  assert.equal(rows.length, 26, 'all session rows are retained, including duplicates');
  const products = new Map();
  for (const line of rows) {
    const match = line.match(/^([a-f0-9]{64})  (offloop\/[^/]+\.mjs)$/);
    assert.ok(match, `valid product hash row: ${line}`);
    const [, expected, file] = match;
    if (products.has(file)) assert.equal(products.get(file), expected, `${file}: consistent duplicate row`);
    products.set(file, expected);
    assert.equal(sha256(file), expected, `${file}: product before=after MATCH`);
    assert.equal(session.productHashes[path.basename(file)], expected, `${file}: session metadata agrees`);
  }
  assert.equal(products.size, 15, 'all fifteen session products are checked');
  assert.deepEqual([...products.keys()].sort(), Object.keys(session.productHashes).map(file => `offloop/${file}`).sort());
  for (const file of protectionFaces) assert.ok(products.has(`offloop/${file}`), `${file}: required protection face`);

  const freeze = read(`freeze-offloop-${knife}.md`);
  // Codex hands off FROZEN; independent SCAN may flip to CLOSED — PASS（NO_PRODUCT_DELTA）.
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
  // Match the session's lock-body convention, retaining the newline before §1.
  assert.equal(freeze.split('## 0. 锁定\n').length, 2, 'one §0 lock');
  assert.equal(freeze.split('## 1. 不做').length, 2, 'one §1 boundary');
  const lockBody = freeze.split('## 0. 锁定\n')[1].split('## 1. 不做')[0];
  assert.equal(digest(lockBody), freezeLockSha256, '§0 remains byte-intact');

  const bench = read(`bench-log-offloop-${knife}.md`);
  const benchStatuses = [...bench.matchAll(/^- Status: \*\*([^*\n]+)\*\*/gm)];
  assert.equal(benchStatuses.length, 1, 'one bench Status');
  const benchFrozen = benchStatuses[0][1] === 'FROZEN / SCAN READY';
  const benchClosed = /^CLOSED — PASS(?:\s*[（(]NO_PRODUCT_DELTA[）)]|\s*·\s*NO_PRODUCT_DELTA)\s*$/.test(benchStatuses[0][1])
    && /独立 SCAN/.test(bench);
  assert.ok(benchFrozen || benchClosed, 'strict handoff or independent SCAN CLOSED; no bare self-CLOSED');
  assert.match(bench, /`selfClosed=false`/);
  assert.doesNotMatch(bench, /selfClosed\s*=\s*true/);
  assert.match(bench, /2026-10-26（America\/Adak）/);
  assert.match(bench, /NO_PRODUCT_DELTA/);
  assert.match(bench, /无空 tip 双绿；本刀 PASS 仅指 prior-snapshot 夹具与完整性验收/);
  assert.match(bench, /不构成 tip\/runtime 产品执行通过声明/);
  const emptyTipLines = bench.split(/\r?\n/).filter(line => /空\s*tip.*双绿|empty[ -]tip.*dual[ -]green/i.test(line));
  assert.ok(emptyTipLines.length > 0, 'explicit empty-tip boundary');
  for (const line of emptyTipLines) assert.match(line, /无空 tip 双绿/, 'empty tip cannot claim product success');
  for (const gloss of [
    'PRIOR_SNAPSHOT_STALE=先验快照过期假红', 'PIN=钉死基线哈希', 'NO_PRODUCT_DELTA=无产品差分',
    'MATCH=一致', '现盘=当前磁盘', '历史=历史会话证据', 'SCAN=独立扫收', 'adopt=采纳结论不翻案',
  ]) assert.ok(bench.includes(gloss), `bench explains ${gloss}`);
  t.diagnostic('Product edits 0×; 26/26 hash rows (15 products) MATCH; freeze FROZEN|SCAN CLOSED; selfClosed=false');
});
