import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTestProcessReceipt, fixedBuildTestReport, prepareBuildTestVerification, recordBuildTestReceipt, requestedBuildTestItems } from '../src/decision/build-test-verification.mjs';
import { createDecisionEngine } from '../src/decision/engine.mjs';

const digest = `sha256:${'a'.repeat(64)}`;
const processReceipt = (tool, request, stdout, extra = {}) => buildTestProcessReceipt({
  tool, request, output: { ok: true, exitCode: 0, cwd: '.', stdout, ...extra }, startedAtMs: 100, endedAtMs: 200, outputDigest: digest
});
const build = () => processReceipt('shell.execute', { command: 'npm', args: ['run', 'build:windows:full-local'] },
  'Built application at: target/dda.exe\nBundling dda.msi (target/dda.msi)\nartifact=target/old.exe');
const observe = async path => ({ path, absolutePath: `/work/${path}`, sizeBytes: 100, modifiedAtMs: path.endsWith('old.exe') ? 99 : 150 });

test('a named build invocation can prove it generated a PPTX without repeating the path', async () => {
  const path = 'docs/dda-project-intro.pptx';
  const declaration = 'DDA_BUILD_ARTIFACT ' + JSON.stringify({ version: 1, path, disposition: 'GENERATED', sha256: digest });
  const command = 'node docs/build-project-pptx.mjs';
  const load = async (cmd, id) => ({ ...await recordBuildTestReceipt(
    processReceipt('shell.execute', { command: cmd }, declaration), id, async () => ({
      path, sizeBytes: 26559, modifiedAtMs: 140, sha256: digest, pptx: { slideCount: 12, entryCount: 35 }
    })), stepId: 'run-build-script' });
  const correct = await load(command, 'build-1');
  const other = await load('node docs/build-other.mjs', 'build-2');
  const statement = 'run-build-script（PASS）**：在工作区根目录执行 `node docs/build-project-pptx.mjs`，退出码 0，生成 PPTX 文件';
  const review = (receipts, text = statement, completedSteps = ['run-build-script']) =>
    prepareBuildTestVerification(text, receipts, { completedSteps });
  const result = review([other, correct]);
  assert.deepEqual(result.claims, []);
  assert.deepEqual(result.checks.map(item => [item.status, item.evidence]), [
    ['PASS', ['build-1', digest, 'build-1-artifact-1']], ['PASS', ['build-1', digest, 'build-1-artifact-1']]
  ]);
  for (const input of [
    { ...correct, artifacts: [] }, other,
    { ...correct, artifacts: correct.artifacts.map(file => ({ ...file, path: 'wrong.zip' })) },
    { ...correct, artifacts: correct.artifacts.map(file => ({ ...file, pptx: undefined })) }
  ]) {
    const incomplete = review([input]);
    assert.equal(incomplete.claims.length, 0);
    assert.ok(incomplete.checks.every(check => check.status === 'UNKNOWN'));
  }
  for (const suffix of [' `docs/wrong.pptx`', ' `docs/wrong.pdf`', ' docs/wrong.pdf', ' “docs/wrong.pdf”']) {
    const wrongPath = review([correct, other], statement + suffix);
    assert.equal(wrongPath.checks[0].status, 'UNKNOWN');
    assert.ok(wrongPath.claims.every(claim => claim.evidence.every(receipt => !receipt.artifacts.length)));
  }
  const semantic = review([correct], statement, []);
  assert.ok(semantic.claims.some(claim => claim.kind === 'BUILD' && claim.evidence[0].artifacts[0].path === path));
  assert.ok(!semantic.checks.some(check => check.status === 'PASS'));
  const otherStep = { ...correct, id: 'later', stepId: 'other-step', endedAtMs: correct.endedAtMs + 1 };
  assert.ok(review([otherStep]).checks.every(check => check.status === 'UNKNOWN'));
  assert.deepEqual(review([correct, otherStep]), review([correct]));
  const genericBuild = review([{ ...correct, artifacts: [{ ...correct.artifacts[0], path: 'dist/output.zip', pptx: undefined }] }, other],
    '构建已通过，执行 `node docs/build-project-pptx.mjs`，交付物亦已准备好。');
  assert.deepEqual(genericBuild.claims.find(claim => claim.kind === 'BUILD').evidence.map(receipt =>
    [receipt.id, receipt.artifacts.map(file => file.path)]), [['build-1', ['dist/output.zip']]]);
  const tests = await recordBuildTestReceipt(processReceipt('test.execute', { command: 'node docs/verify-project-pptx.mjs docs/dda-project-intro.pptx' },
    'DDA_TEST_RESULT {"version":1,"tests":11,"pass":11,"fail":0}'), 'test-1', observe);
  const testStatement = 'verify-pptx-output（PASS）**：执行 `node docs/verify-project-pptx.mjs docs/dda-project-intro.pptx`，退出码 0，11 项检查全部通过：';
  const testConclusion = review([{ ...tests, stepId: 'verify-pptx-output' }], testStatement, ['verify-pptx-output']);
  assert.deepEqual(testConclusion.checks.map(check => check.status), ['PASS']);
});

test('a mixed build and PPTX generation claim cites the file checked against the emitted digest', async () => {
  const path = 'docs/dda-project-intro.pptx';
  const stdout = `DDA_BUILD_ARTIFACT ${JSON.stringify({ version: 1, path, disposition: 'GENERATED', sha256: digest })}`;
  const invocation = processReceipt('shell.execute', { command: 'node docs/build-project-pptx.mjs' }, stdout);
  const receipt = await recordBuildTestReceipt(invocation, 'build-2', async path => ({ ...await observe(path), sha256: digest }));
  const text = '构建（build-pptx，PASS）：执行 `node docs/build-project-pptx.mjs`，退出码 0，生成 `docs/dda-project-intro.pptx`。';
  const report = prepareBuildTestVerification(text, [receipt]);
  assert.deepEqual(report.checks, []);
  assert.deepEqual(report.claims.map(claim => claim.kind), ['ARTIFACT', 'BUILD']);
  for (const claim of report.claims) {
    assert.deepEqual(claim.paths, [path]);
    assert.deepEqual(claim.evidence[0].artifacts.map(file => file.sha256), [digest]);
  }
  const mismatch = await recordBuildTestReceipt(invocation, 'build-3', observe);
  assert.equal(prepareBuildTestVerification(text, [mismatch]).checks[0].code, 'BUILD_ARTIFACT_RECORD_MISSING');
});

test('current build outcome uses the latest identical command while preserving other commands and historical attempts', async () => {
  const receipts = await Promise.all(['build:app', 'build:worker', 'build:app'].map(async (script, i) => {
    const invocation = processReceipt('shell.execute', { command: 'npm', args: ['run', script] }, '',
      { ok: i === 2, exitCode: i === 2 ? 0 : 1 });
    return recordBuildTestReceipt({ ...invocation, endedAtMs: 200 + i }, `build-${i + 1}`, observe);
  }));
  const ids = text => prepareBuildTestVerification(text, receipts).claims[0].evidence.map(receipt => receipt.id).sort();
  assert.deepEqual(ids('本轮的构建与校验结果都已记录为成功。'), ['build-2', 'build-3']);
  assert.deepEqual(ids('第一次构建失败。'), ['build-1', 'build-2', 'build-3']);
  assert.equal(prepareBuildTestVerification('构建退出码 1。', [receipts[0], receipts[2]]).checks[0].code, 'BUILD_TEST_CONCLUSION_CONFLICT');
});

test('checks a complete slide generation statement against independent file and process observations', async () => {
  const path = 'docs/dda-project-intro.pptx';
  const stdout = `DDA_BUILD_ARTIFACT ${JSON.stringify({ version: 1, path, disposition: 'GENERATED', sha256: digest })}`;
  const process = processReceipt('shell.execute', { command: 'node docs/build-project-pptx.mjs' }, stdout);
  const receipt = await recordBuildTestReceipt(process, 'build-1', async () => ({
    path, sizeBytes: 26565, modifiedAtMs: 150, sha256: digest, pptx: { slideCount: 12, entryCount: 35 }
  }));
  const statement = '生成：在工作区根目录执行 `node docs/build-project-pptx.mjs`，exit=0，输出 `docs/dda-project-intro.pptx`（12 页 / 35 个 zip 条目）';
  const check = (text, input = receipt) => prepareBuildTestVerification(text, [input]);
  const exact = check(statement);
  assert.deepEqual(exact.claims, []);
  assert.deepEqual(exact.checks.map(item => [item.status, item.evidence]), [['PASS', ['build-1', digest, 'build-1-artifact-1']]]);
  const withHash = statement.replace('12 页', `26565 字节，sha256=${digest.slice(7)}，12 页`);
  assert.equal(check(withHash).checks[0].status, 'PASS');
  for (const [before, after] of [['exit=0', 'exit=1'], ['12 页', '13 页'], ['35 个', '34 个'],
    ['26565 字节', '26566 字节'], [digest.slice(7), 'b'.repeat(64)]]) {
    assert.equal(check(withHash.replace(before, after)).checks[0].status, 'FAIL', before);
  }
  assert.equal(check(statement.replace(path, 'other.pptx')).checks[0].status, 'UNKNOWN');
  assert.equal(check(statement, { ...receipt, artifacts: receipt.artifacts.map(file => ({ ...file, pptx: undefined })) }).checks[0].status, 'UNKNOWN');
  for (const extra of ['，已发布到公网', '，PowerPoint 打开成功', '，16:9 深色背景']) {
    const partial = check(statement + extra);
    assert.ok(partial.claims.length >= 1, extra);
    assert.deepEqual(partial.checks, []);
  }
  const counts = processReceipt('test.execute', { command: 'node --test' },
    'DDA_TEST_RESULT {"version":1,"tests":11,"pass":11,"fail":0}');
  const verified = await recordBuildTestReceipt(counts, 'test-1', observe);
  const testClaim = '核验：`node --test`，exit=0，11 项检查全部通过，0 项失败';
  assert.equal(check(testClaim, verified).checks[0].status, 'PASS');
  assert.equal(check(testClaim.replace('11 项', '10 项'), verified).checks[0].status, 'FAIL');
});

test('missing support for an extra assertion stays unknown during semantic review', async () => {
  const built = await recordBuildTestReceipt(build(), 'build-1', observe);
  const { claims } = prepareBuildTestVerification('构建成功并已发布到公网。', [built]);
  const engine = createDecisionEngine({ enabled: true, client: { async decide() {
    return { answers: { 'build-test-claim-1': { choice: 'INSUFFICIENT' } } };
  } } });
  const [result] = await engine.judgeBuildTestClaims({ claims, runId: 'unknown' });
  assert.equal(result.status, 'UNKNOWN');
  assert.equal(result.code, 'BUILD_TEST_CLAIM_EVIDENCE_MISSING');
});

test('records real build arguments and links only fresh authorized artifacts to the invocation', async () => {
  const recorded = await recordBuildTestReceipt(build(), 'build-1', observe);
  assert.equal(recorded.command, 'npm');
  assert.deepEqual(recorded.args, ['run', 'build:windows:full-local']);
  assert.equal(recorded.exitCode, 0);
  assert.deepEqual(recorded.artifacts.map(artifact => [artifact.path, artifact.installer]),
    [['target/dda.exe', false], ['target/dda.msi', true]]);
  const report = prepareBuildTestVerification('编译成功。安装包：`target/dda.msi`。已生成 `target/old.exe`。已生成 `/unrelated/dda.exe`。', [recorded]);
  assert.deepEqual(report.claims.map(claim => claim.kind), ['BUILD', 'ARTIFACT']);
  assert.deepEqual(report.claims[1].evidence[0].artifacts.map(artifact => artifact.path), ['target/dda.msi']);
  assert.ok(!Object.hasOwn(report.claims[1].evidence[0].artifacts[0], 'absolutePath'));
  assert.deepEqual(report.checks.map(check => check.code), ['BUILD_ARTIFACT_RECORD_MISSING', 'BUILD_ARTIFACT_RECORD_MISSING']);
});

test('reviews step conclusions only for recorded command types', async () => {
  const missing = prepareBuildTestVerification('构建成功。测试全部通过。', []);
  assert.deepEqual(missing, { claims: [], checks: [] });
  const terminalMissing = await recordBuildTestReceipt({ ...build(), exitCode: null }, 'build-1', observe);
  const testExit = processReceipt('test.execute', { command: 'node --test' }, 'test output without counts');
  assert.deepEqual(testExit.args, ['--test']);
  const noSummary = await recordBuildTestReceipt(testExit, 'test-1', observe);
  assert.deepEqual(prepareBuildTestVerification('历史记录显示 npm run build:exe 失败。', [noSummary]), { claims: [], checks: [] });
  const rustTests = processReceipt('shell.execute', { command: 'cargo test' },
    'test result: ok. 2 passed; 0 failed; 0 ignored\ntest result: ok. 1 passed; 0 failed; 1 ignored');
  assert.deepEqual(rustTests.testCounts, { pass: 3, fail: 0, skipped: 1 });
  const report = prepareBuildTestVerification('构建成功。测试全部通过。测试命令退出码为 0。', [terminalMissing, noSummary]);
  assert.deepEqual(report.checks.map(check => check.code), ['PROCESS_EXIT_RECORD_MISSING', 'TEST_RESULT_RECORD_MISSING']);
  assert.deepEqual(report.claims.map(claim => claim.kind), ['TEST_PROCESS']);
  assert.deepEqual(prepareBuildTestVerification('预计生成 `target/dda.exe`。计划运行测试。尚未运行测试。', []), { claims: [], checks: [] });
});

test('Jev selects a verdict and an existing citation for each eligible conclusion', async () => {
  const built = await recordBuildTestReceipt(build(), 'build-1', observe);
  const failed = processReceipt('test.execute', { command: 'node', args: ['--test', 'suite.mjs'] },
    'TAP version 13\n# tests 4\n# pass 3\n# fail 1\n# skipped 0', { ok: false, exitCode: 1 });
  const tests = await recordBuildTestReceipt(failed, 'test-1', observe);
  const { claims } = prepareBuildTestVerification('编译成功。所有相关测试全部通过。已生成可直接运行的 `target/dda.exe`。', [built, tests]);
  let calls = 0;
  const engine = createDecisionEngine({ enabled: true, client: { async decide({ questions, purpose }) {
    calls++;
    assert.equal(purpose, 'verification');
    assert.equal(questions['build-test-claim-2'].context.evidence[0].testCounts.fail, 1);
    assert.deepEqual(questions['build-test-claim-2'].choices, ['MATCH__test-1', 'CONFLICT__test-1', 'INSUFFICIENT']);
    return { answers: {
      'build-test-claim-1': { choice: 'MATCH__build-1' },
      'build-test-claim-2': { choice: 'CONFLICT__test-1' },
      'build-test-claim-3': { choice: 'MATCH__missing-artifact' }
    } };
  } } });
  const checks = await engine.judgeBuildTestClaims({ claims, runId: 'run-1' });
  assert.deepEqual(checks.map(check => check.status), ['PASS', 'FAIL', 'UNKNOWN']);
  assert.deepEqual(checks[1].evidence, ['test-1', digest]);
  assert.equal(checks[2].code, 'BUILD_TEST_VERIFIER_UNAVAILABLE');
  assert.deepEqual(await engine.judgeBuildTestClaims({ claims: [], runId: 'run-1' }), []);
  assert.equal(calls, 1);
});

test('fixed build results come from the run receipts and requested outcome', async () => {
  const built = await recordBuildTestReceipt(build(), 'build-1', observe);
  const requested = requestedBuildTestItems('编译 exe 并生成安装包。不要运行测试。');
  assert.deepEqual(requested, { build: true, test: false, artifact: true, installer: true });
  const report = fixedBuildTestReport([built], requested);
  assert.deepEqual(report.items.map(item => [item.id, item.status]), [
    ['build-command-result', 'VERIFIED'], ['test-result', 'NOT_REQUESTED'], ['build-artifact-origin', 'VERIFIED']
  ]);
  assert.equal(report.items[0].results[0].exitCode, 0);
  assert.deepEqual(report.items[2].results.map(file => file.path), ['target/dda.msi']);
  assert.equal(prepareBuildTestVerification('现已编完。安装包在 target/dda.msi。', [built]).claims.length, 0);
  const pending = fixedBuildTestReport([{ ...built, artifacts: built.artifacts.filter(file => !file.installer) }], requested);
  assert.equal(pending.items[0].results[0].execution, 'SUCCEEDED');
  assert.equal(pending.items[2].code, 'BUILD_ARTIFACT_RECORD_MISSING');
  assert.equal(fixedBuildTestReport([], requested).items[0].status, 'PENDING');
  assert.equal(fixedBuildTestReport([], requestedBuildTestItems('如何构建和运行测试？')), undefined);
  assert.deepEqual(requestedBuildTestItems('编译 exe，不生成安装包。'), { build: true, test: false, artifact: true, installer: false });
});

test('a structured reuse record requires a matching observed digest before accepting an old file', async () => {
  const stdout = `DDA_BUILD_ARTIFACT ${JSON.stringify({ version: 1, path: 'target/old.exe', disposition: 'REUSED', sha256: digest })}`;
  const produced = processReceipt('shell.execute', { command: 'npm run build' }, stdout);
  const verified = await recordBuildTestReceipt(produced, 'build-1', async path => ({ ...await observe(path), sha256: digest }));
  assert.equal(verified.artifacts[0].disposition, 'REUSED');
  assert.match(fixedBuildTestReport([verified], { artifact: true }).items[2].detail, /本次复用/u);
  const mismatch = await recordBuildTestReceipt(produced, 'build-1', observe);
  assert.deepEqual(mismatch.artifacts, []);
  assert.equal(fixedBuildTestReport([mismatch], { artifact: true }).items[2].status, 'PENDING');
});

test('a complete machine-readable test report carries run counts and the executed suites', async () => {
  const stdout = 'DDA_TEST_RESULT {"version":1,"tests":3,"pass":2,"fail":0,"skipped":1,"suites":["unit.test.mjs"]}';
  const command = { command: 'node --test' };
  const observed = processReceipt('test.execute', command, stdout, { truncated: true });
  const receipt = await recordBuildTestReceipt(observed, 'test-1', observe);
  const report = fixedBuildTestReport([receipt], { test: true });
  assert.equal(report.items[1].status, 'VERIFIED');
  assert.deepEqual(report.items[1].results[0].suites, ['unit.test.mjs']);
  assert.deepEqual(report.items[1].results[0].counts, { tests: 3, pass: 2, fail: 0, skipped: 1, todo: 0 });
  const incorrect = prepareBuildTestVerification('全部 3 项测试通过。测试命令退出码为 1。', [receipt]);
  assert.deepEqual(incorrect.claims, []);
  assert.deepEqual(incorrect.checks.map(check => check.code), ['BUILD_TEST_CONCLUSION_CONFLICT', 'BUILD_TEST_CONCLUSION_CONFLICT']);
  assert.equal(processReceipt('test.execute', command, stdout.replace('"tests":3', '"tests":9')).testCounts, undefined);
});
