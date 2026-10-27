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
const knife = 'tip-soft-multifamily-external-hygiene-r1';
const out = `offloop/out-${knife}`;
const PIN = '2258685ce9793639ebc9698c8961dcedccf6e49b';
const baselineSha256 = '816046a6ecfff25e632cdcc98ae6b71b16fb1d5201c454b494b6356e5e653df4';
const freezeLockSha256 = '9ec0ce59094ce355957ee045ae22594167c54cae02e047159dd8f5f530a31063';
const currentProducts = {
  'dayloop-soft.mjs': '3dcbb96acbf980d3b73019920b247a04e1b7d85b72d0e858b4b0b55bcb6ab213',
  'on-closed.mjs': '6181dea75e82b3ecbe47e0132a99d026438a8a7aef97243f0a23f16d282f6995',
  'probe-l1.mjs': 'd4d5059e5e048c5090a3f866c3fd72e8828b2f93a61c2bc27bd7d5402d77b0de',
  'soft-worktree.mjs': '45d3119e9a2f4ceae239f16ff61b863d67c20880786b561979ae9c9cb2c21316',
  'compose.mjs': 'e284a70868d3954cfe6ce2461683b9e3edbd3d5305c5754cd2eedcafe7aa4e4b',
  'experience.mjs': '64e7c25770e78cec02cb7d5714ef9ea13ed450ca9ca941865138eea824c58aeb',
  'propose.mjs': '08390e92bc5de89c5b29286b24c942e93ec5256f6fc20e643f9bf09b0ea5c411',
  'path-signals.mjs': '0015ecd052983c354a4db1aa1d77919751d3793b99008826d0963d5e2e762732',
};
// Supplied historical authority hashes: reads only, never run the live/replay harnesses.
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
  'dayloop-tip-soft-contrast-live-r1': {
    'summary.json': '545e24ef610d9b35fad66c68feb1c5acac11cf26ced609f06366188fe048ceb7',
  },
};
const historicalRequests = {
  'dayloop-tip-soft-adopt-live-r1': 'f52fe3935c678514be236a848460ee1cfc2f14782f232f6a373beb0e5bea5d31',
  'tip-soft-adopt-second-family-live-r1': '82a7a2dab9de482955b86fef7dae9fba2cc9e3e6a10d13681266296c21ca08af',
  'tip-soft-adopt-t4-retry-live-r1': 'f20658bd8eefc4cc75e97f3f5dd344f915e28afa72feea6ed0e3029d436da753',
  'tip-soft-adopt-third-family-live-r1': '34358f4705b2966eda44638035e03185695158a3607b22c6ba2b4da968d47062',
};
const benchNames = [...Object.keys(authority), knife];
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha256 = (relative) => digest(fs.readFileSync(path.join(root, relative)));

function externalSection(name) {
  const text = read(`bench-log-offloop-${name}.md`);
  const headings = [...text.matchAll(/^## EXTERNAL \/ 并行哈希[\t ]*\r?$/gm)];
  assert.equal(headings.length, 1, `${name}: exactly one EXTERNAL section`);
  return text.slice(headings[0].index + headings[0][0].length).split(/^#{1,2} /m)[0];
}

function tableRows(section, file) {
  return section.split(/\r?\n/).filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()))
    .filter((cells) => cells[0] === `\`${file}\``);
}

test('T-tsme-1: six unique EXTERNAL sections verify disk products and authority MATCH while preserving historical requests', () => {
  const sections = new Map(benchNames.map((name) => [name, externalSection(name)]));
  for (const [name, section] of sections) {
    assert.match(section, /历史/, `${name}: label historical evidence`);
    assert.match(section, /现盘/, `${name}: label current disk evidence`);
    for (const file of ['dayloop-soft.mjs', 'soft-worktree.mjs', 'propose.mjs']) {
      assert.equal(tableRows(section, `offloop/${file}`).length, 1, `${name}: required product ${file}`);
    }
    for (const [file, expected] of Object.entries(currentProducts)) {
      const rows = tableRows(section, `offloop/${file}`);
      assert.ok(rows.length <= 1, `${name}: no competing product rows for ${file}`);
      for (const cells of rows) {
        assert.equal(cells.length, 4, `${name}: four product columns for ${file}`);
        // The t3 table is an intentionally preserved historical MATCH table.
        const current = name === 'dayloop-tip-soft-adopt-live-r1' ? cells[1] : cells[2];
        if (name === 'dayloop-tip-soft-adopt-live-r1') assert.match(cells[2], /收口现盘/);
        assert.equal(current, `\`${expected}\``, `${name}: full current sha for ${file}`);
        assert.ok(['MATCH', '本刀未改', 'EXTERNAL_DRIFT'].includes(cells[3]), `${name}: explicit verdict`);
      }
    }
  }
  for (const [file, expected] of Object.entries(currentProducts)) {
    assert.equal(sha256(`offloop/${file}`), expected, `${file}: documented current sha matches disk`);
  }

  for (const [name, files] of Object.entries(authority)) {
    for (const [file, expected] of Object.entries(files)) {
      const relative = `offloop/out-${name}/${file}`;
      assert.equal(sha256(relative), expected, `${relative}: authority bytes still MATCH`);
      for (const sample of [name, knife]) {
        assert.deepEqual(tableRows(sections.get(sample), relative), [
          [`\`${relative}\``, `\`${expected}\``, `\`${expected}\``, 'MATCH'],
        ], `${sample}: honest historical/current authority MATCH row`);
      }
    }
  }
  for (const [name, requestSha] of Object.entries(historicalRequests)) {
    assert.ok(read(`bench-log-offloop-${name}.md`).includes(requestSha), `${name}: preserve historical requestSha`);
    for (const sample of [name, knife]) {
      assert.match(sections.get(sample), /历史 requestSha256/, `${sample}: label request history`);
      assert.ok(sections.get(sample).includes(requestSha), `${sample}: full historical requestSha`);
    }
  }
  assert.deepEqual(tableRows(sections.get('dayloop-tip-soft-contrast-live-r1'), 'offloop/propose.mjs'), [[
    '`offloop/propose.mjs`',
    '`ab3046cdad220211c8e940cd408a6aa787d5b6bc4b8652eef45af2827aac90c0`',
    `\`${currentProducts['propose.mjs']}\``,
    'EXTERNAL_DRIFT',
  ]], 'contrast preserves the original propose drift rather than replacing it with MATCH');
});

test('T-tsme-2: every supplied product is unchanged, PIN is fixed and freeze/bench stay FROZEN handoff or independent SCAN CLOSED with selfClosed=false', (t) => {
  const sessionPath = '/tmp/codex-tip-soft-multifamily-external-hygiene-r1/before-hashes.txt';
  const preserved = fs.readFileSync(path.join(root, out, 'before-hashes.txt'));
  if (fs.existsSync(sessionPath)) {
    assert.deepEqual(preserved, fs.readFileSync(sessionPath), 'preserve the session before-hashes verbatim');
  }
  assert.equal(digest(preserved), baselineSha256, 'durable baseline remains pinned after /tmp expires');
  const before = new Map();
  for (const line of preserved.toString('utf8').trim().split(/\r?\n/)) {
    const match = line.match(/^(tip|[a-z0-9-]+\.mjs) ([a-f0-9]{40}|[a-f0-9]{64})$/);
    assert.ok(match, `invalid before-hashes row: ${line}`);
    assert.ok(!before.has(match[1]), `duplicate before-hashes row: ${match[1]}`);
    before.set(match[1], match[2]);
  }
  for (const [file, expected] of Object.entries(currentProducts)) {
    assert.equal(before.get(file), expected, `${file}: required product in supplied baseline`);
  }
  assert.equal(before.size, 12, 'all eleven supplied products plus tip are checked');
  for (const [file, expected] of before) {
    if (file === 'tip') continue;
    assert.match(expected, /^[a-f0-9]{64}$/, `${file}: product SHA-256`);
    assert.equal(sha256(`offloop/${file}`), expected, `${file}: product before=after`);
    assert.deepEqual(tableRows(externalSection(knife), `offloop/${file}`), [[
      `\`offloop/${file}\``, `\`${expected}\``, `\`${expected}\``, 'MATCH',
    ]], `${file}: own EXTERNAL reports the complete baseline`);
  }
  assert.deepEqual(fs.readFileSync(path.join(root, out, 'after-hashes.txt')), preserved,
    'post-work hashes use the unchanged product list, order and bytes');
  assert.equal(before.get('tip'), PIN);
  assert.equal(STEAL_TIP_PIN, PIN);
  const tip = probeTipHead('/workspace/dda-tip-r25');
  if (tip.ok) assert.equal(tip.head, PIN, 'readable tip HEAD remains pinned');
  else t.diagnostic(`ENVIRONMENT skip: tip git HEAD (${tip.code}): ${tip.message}; STEAL_TIP_PIN/snapshot PIN checked`);

  const freeze = read(`freeze-offloop-${knife}.md`);
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
  const lock = freeze.split('## 0. ')[1]?.split('\n## 1. ')[0];
  assert.equal(typeof lock, 'string', '§0 lock exists');
  assert.equal(digest(lock), freezeLockSha256, '§0 remains byte-intact');

  const bench = read(`bench-log-offloop-${knife}.md`);
  assert.ok(benchLifecycleHonest(bench),
    'bench must be FROZEN / SCAN READY or independent SCAN CLOSED — PASS with NO_PRODUCT_DELTA');
  const benchStatuses = [...bench.matchAll(/^- Status: \*\*([^*\n]+)\*\*/gm)];
  assert.equal(benchStatuses.length, 1, 'one bench Status');
  const benchFrozen = benchStatuses[0][1] === 'FROZEN / SCAN READY';
  const benchClosed = /^CLOSED — PASS(?:\s*[（(]NO_PRODUCT_DELTA[）)]|\s*·\s*NO_PRODUCT_DELTA)\s*$/.test(benchStatuses[0][1])
    && /独立 SCAN/.test(bench);
  assert.ok(benchFrozen || benchClosed, 'strict handoff or independent SCAN CLOSED; no bare self-CLOSED');
  assert.match(bench, /`selfClosed=false`/);
  assert.doesNotMatch(bench, /selfClosed\s*=\s*true/);
  assert.match(bench, /\bNO_PRODUCT_DELTA\b/);
  assert.match(bench, /无空 tip 双绿；本刀 PASS 仅指 EXTERNAL 文档与完整性验收/);
  assert.match(bench, /不构成 tip\/runtime 产品执行通过声明/);
  // An empty-tip mention must remain a rejection, never a product-pass claim.
  const emptyTipLines = bench.split(/\r?\n/).filter((line) => /空\s*tip.*双绿|empty[ -]tip.*dual[ -]green/i.test(line));
  assert.ok(emptyTipLines.length > 0, 'explicit empty-tip boundary');
  for (const line of emptyTipLines) assert.match(line, /无空 tip 双绿/, 'empty tip cannot claim product success');
});
