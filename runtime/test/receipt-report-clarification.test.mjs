import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareBuildTestVerification } from '../src/decision/build-test-verification.mjs';
import { applyDocumentReportRepair, documentReportRepair, receiptReportClarification } from '../src/decision/receipt-report-clarification.mjs';

const step = { stepId: 'verify', actionKind: 'TEST', summary: 'Execute `npm test`', dependencies: [] };
const receipt = { id: 'test-1', stepId: 'verify', kind: 'TEST', command: 'npm', args: ['test'], cwd: '.',
  invocationKey: createHash('sha256').update(JSON.stringify(['TEST', '.', 'npm', ['test']])).digest('hex'),
  exitCode: 0, outputDigest: 'digest', testCounts: { tests: 4, pass: 4, fail: 0 }, artifacts: [] };
const statement = '测试：执行 `npm test`，退出码 0，4 项检查全部通过，覆盖了内部模块';
function proposed(overrides = {}) {
  const text = 'Keep this sentence.\n' + statement;
  const prepared = prepareBuildTestVerification(text, [receipt]);
  return receiptReportClarification({ text, step, plan: { steps: [step] }, completedSteps: [],
    ruleStatus: 'PASS', claims: prepared.claims, receipts: [receipt],
    checks: [{ id: prepared.claims[0].id, status: 'UNKNOWN', code: 'BUILD_TEST_CLAIM_EVIDENCE_MISSING', evidence: [receipt.id] }],
    ...overrides });
}

test('only narrows the affected sentence, retains it as unverified, and re-verifies the revised receipt statement', () => {
  const result = proposed();
  assert.match(result.revised, /^Keep this sentence\./u);
  assert.ok(result.revised.includes('尚待核实：“' + statement + '”'));
  const reviewed = prepareBuildTestVerification(result.revised, [receipt]);
  assert.deepEqual(reviewed.claims, []);
  assert.ok(reviewed.checks.some(check => check.status === 'PASS' && check.evidence.includes(receipt.id)));
});

test('keeps original report on mismatched scope, conflict, unavailable review, or superseded evidence', () => {
  for (const overrides of [
    { plan: { steps: [{ ...step, summary: 'Execute `npm test:integration`' }] } },
    { step: { stepId: 'unrelated', actionKind: 'REPORT' } },
    { ruleStatus: 'FAIL' },
    { receipts: [receipt, { ...receipt, id: 'test-2', exitCode: 1 }] },
    { checks: [{ status: 'FAIL', code: 'BUILD_TEST_CONCLUSION_CONFLICT' }] },
    { checks: [{ status: 'UNKNOWN', code: 'BUILD_TEST_VERIFIER_UNAVAILABLE' }] }
  ]) assert.equal(proposed(overrides), undefined);
});

test('replays an intermediate generation report whose plan names an unquoted artifact', () => {
  const path = 'docs/dda-project-intro.pptx';
  const digest = '413a5c565a2ee2848a9dfa484aaba30b7061a3fd341e123dc95affd945140980';
  const step = { stepId: 'write-new-pptx-script', actionKind: 'EXECUTE', dependencies: ['collect-project-facts'],
    summary: '若现有构建脚本不可用，则新建一个 Node 脚本（如用 pptxgenjs 或手写 OOXML）按整理要点生成 docs/dda-project-intro.pptx 并执行成功。' };
  const receipt = { kind: 'BUILD', id: 'build-test-process-1', stepId: step.stepId, command: 'node',
    args: ['docs/build-project-pptx.mjs'], cwd: '.', exitCode: 0, outputDigest: 'sha256:process',
    invocationKey: 'ee709b410b2f21c1c1fb203f123943f9d0eb81d90fad5d300d3075f93d60f431', artifacts: [
      { id: 'build-test-process-1-artifact-1', path, sha256: 'sha256:' + digest, sizeBytes: 26565, disposition: 'GENERATED',
        pptx: { slideCount: 12, entryCount: 35 } }
    ] };
  for (const reference of [path, '`' + path + '`']) {
    const text = `**执行成功证据**\n- 产物：\`${path}\`，26565 字节，12 页，35 个 ZIP 条目，sha256=${digest}。\n**改动文件**\n- 仅重新生成了 ${reference}（既有脚本产物），未改动任何源码或其他文件。\n\n**尚未验证**\n- 后续完整独立校验尚未执行。`;
    const { checks, claims } = prepareBuildTestVerification(text, [receipt]);
    const options = { text, step, plan: { steps: [step] }, completedSteps: step.dependencies, claims, receipts: [receipt], ruleStatus: 'PASS',
      checks: [...checks, { id: claims[0].id, status: 'UNKNOWN', code: 'BUILD_TEST_CLAIM_EVIDENCE_MISSING', evidence: [receipt.id] }] };
    const proposal = receiptReportClarification(options);
    assert.match(proposal.revised, /原稿中的完整说法尚待核实/u);
    assert.ok(proposal.revised.endsWith('后续完整独立校验尚未执行。'));
    const rechecked = prepareBuildTestVerification(proposal.revised, [receipt]);
    assert.equal(rechecked.claims.length, 0);
    assert.deepEqual(rechecked.checks.map(item => item.status), ['PASS', 'PASS', 'PASS']);
    for (const other of ['archive/' + path, path + '.bak']) {
      assert.equal(receiptReportClarification({ ...options, plan: { steps: [{ ...step, summary: '生成 ' + other }] } }), undefined);
    }
  }
});

test('matches an unquoted planned command or an exact host-declared argv and cwd', () => {
  const unquoted = { ...step, summary: '运行 npm test 并记录输出' };
  assert.ok(proposed({ plan: { steps: [unquoted] } }));
  const noCommand = { ...step, summary: 'Inspect the test results' };
  const plan = { steps: [noCommand] };
  const declaredCommand = { stepId: step.stepId, command: 'npm', args: ['test'], cwd: '.' };
  assert.ok(proposed({ plan, declaredCommand }));
  assert.equal(proposed({ plan, declaredCommand: { ...declaredCommand, cwd: 'another-project' } }), undefined);
  assert.equal(proposed({ plan, declaredCommand: { ...declaredCommand, args: ['test:other'] } }), undefined);
  assert.equal(proposed({ plan: { steps: [{ ...step, summary: 'Run `npm test --subset`' }] } }), undefined);
});


test('document-only report repair refuses conflicting, final, stale or unrelated observations', () => {
  const text = '文件将在后续步骤单独验收。运行构建成功且采用了既有脚本。';
  const sentence = '运行构建成功且采用了既有脚本';
  const path = 'dda-overview.pptx', sha256 = 'sha256:' + '1'.repeat(64);
  const receipt = { id: 'b1', stepId: 'build', kind: 'BUILD', outputDigest: sha256, exitCode: 0,
    artifacts: [{ path, sha256, sizeBytes: 100, disposition: 'GENERATED', pptx: { slideCount: 5 } }] };
  const input = { text, step: { stepId: 'build', actionKind: 'EXECUTE' }, isDeliveryStep: false, requestedBuildTest: {},
    verifiedFiles: [{ path, digest: sha256 }], hostChecks: [{ status: 'PASS' }], ruleStatus: 'PASS',
    checks: [{ id: 'c', status: 'UNKNOWN', code: 'BUILD_TEST_CLAIM_EVIDENCE_MISSING' }],
    observedClaims: [{ id: 'c', kind: 'BUILD', statement: sentence }], receipts: [receipt] };
  const repair = documentReportRepair(input);
  assert.ok(repair);
  for (const overrides of [{ isDeliveryStep: true }, { ruleStatus: 'FAIL' }, { hostChecks: [{ status: 'FAIL' }] },
    { checks: [...input.checks, { status: 'FAIL' }] }, { requestedBuildTest: { test: true } }, { verifiedFiles: [] },
    { verifiedFiles: [{ path, digest: 'sha256:' + '2'.repeat(64) }] }, { receipts: [{ ...receipt, stepId: 'other' }] }]) {
    assert.equal(documentReportRepair({ ...input, ...overrides }), undefined);
  }
  assert.equal(applyDocumentReportRepair(text, repair, '["quality-guaranteed"]'), undefined);
  assert.equal(applyDocumentReportRepair(text, repair, 'null'), undefined);
  const result = applyDocumentReportRepair(text, repair, '["artifact"]');
  assert.ok(result.revised.startsWith('文件将在后续步骤单独验收。'));
  assert.ok(result.revised.includes(sha256.slice(7)));
  assert.ok(result.revised.includes('尚待核实：“' + sentence + '”'));
  for (const note of ['构建命令按要求生成每页独立图表', '构建成功并验证动画', '经接收方签字，确认视觉完整性',
    '测试覆盖率为 99%', '构建生成 `second.pptx`', '输出 `专家审阅通过`', '输出署名签收文件']) {
    assert.equal(documentReportRepair({ ...input, text: note, observedClaims: [{ id: 'c', kind: 'BUILD', statement: note }] }), undefined, note);
  }
  for (const [goal, note] of [['请报告耗时', '运行耗时 100 ms'], ['请提供 SHA-256', '文件 SHA-256 `'+sha256+'`'],
    ['请执行指定命令', '指定命令已执行']]) {
    assert.equal(documentReportRepair({ ...input, goal, text: note, observedClaims: [{ id: 'c', kind: 'BUILD', statement: note }] }), undefined);
  }
});


test('replays the two unresolved clauses from the controlled same-thread PowerPoint run', () => {
  const script = 'build-dda-overview.mjs', path = 'dda-overview.pptx';
  const hash = 'c5e0e22060fbb0d8ee80490eff703576cf0046487a6c2abaf276e28a30ccf720';
  const stdout = 'OK: dda-overview.pptx written';
  const statements = ['`' + script + '`（9,278 字节，SHA-256 `' + hash + '`），此前已通过 file.write 写入并保留，本次恢复未重写脚本，仅实际执行了 node 运行这一剩余动作',
    '`node build-dda-overview.mjs`（cwd 为工作区根目录），exit code 0，耗时 788 ms，stdout 输出 `' + stdout + '`'];
  const sha256 = 'sha256:' + '4'.repeat(64);
  const receipt = { stepId: 'build-pptx', id: 'b1', kind: 'BUILD', command: 'node', args: [script], exitCode: 0, outputDigest: sha256,
    stdoutTextDigest: 'sha256:' + createHash('sha256').update(stdout).digest('hex'), artifacts: [{ path, sha256, sizeBytes: 106922,
      disposition: 'GENERATED', pptx: { slideCount: 5 } }] };
  const text = statements.join('。\n');
  const input = { text, goal: '请实际生成可编辑的演示文稿。', step: { stepId: 'build-pptx', actionKind: 'EXECUTE' }, isDeliveryStep: false,
    requestedBuildTest: {}, verifiedFiles: [{ path, digest: sha256 }], hostChecks: [{ status: 'PASS' }], ruleStatus: 'PASS',
    checks: statements.map((_, id) => ({ id, status: 'UNKNOWN', code: 'BUILD_TEST_CLAIM_EVIDENCE_MISSING' })),
    observedClaims: statements.map((statement, id) => ({ id, statement, kind: 'BUILD' })), receipts: [receipt] };
  const repair = documentReportRepair(input);
  assert.ok(repair);
  const revised = applyDocumentReportRepair(text, repair, '["artifact","slides"]').revised;
  assert.ok(statements.every(note => revised.includes('尚待核实：“' + note + '”')));
  const verified = prepareBuildTestVerification(revised, [receipt]);
  assert.deepEqual(verified.claims, []);
  assert.deepEqual(verified.checks.map(check => check.status), ['PASS', 'PASS']);
});
