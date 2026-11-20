import { expect, it } from 'vitest';
import { buildTestVerificationFailure, planFailureMessage } from './plan-failure';

it('reports the observed scope block, failed step and pending deliverables ahead of a generic verdict', () => {
  const payload = { code: 'PLAN_STEP_FAILED', stepId: 'read-project-files', stepFacts: {
    actionKind: 'READ', blockedTool: { name: 'shell.execute', command: 'node', errorCode: 'TOOL_OUTSIDE_EXECUTION_SCOPE' },
    blockedStepIds: ['write-new-builder', 'verify-new-pptx']
  } };
  const text = planFailureMessage(payload, '通用裁决', 'JEV_CHOICE');
  expect(text).toContain('步骤 read-project-files 验收失败');
  expect(text).toContain('node 超出只读步骤允许的范围，该调用未执行');
  expect(text).toContain('write-new-builder、verify-new-pptx');
  expect(text).not.toContain('通用裁决');
  expect(planFailureMessage(payload, '缺少项目资料读取证据。')).toContain('缺少项目资料读取证据。');
  expect(planFailureMessage({ code: 'OTHER' }, '原始原因')).toBe('原始原因');
});

it('keeps an uncertain compound claim visible alongside successful build, test and artifact receipts', () => {
  const summary = '现有执行记录不足以核对完整结论（运行构建脚本，退出码 0，生成 PPTX 文件）';
  const payload = {
    code: 'PLAN_STEP_FAILED', stepId: 'verify-pptx-output', reportStatus: 'UNCERTAIN',
    nextAction: 'REVIEW_BUILD_TEST_CONCLUSIONS', failureCodes: ['BUILD_TEST_CLAIM_EVIDENCE_MISSING'], summary,
    checks: [{ id: 'build-test-claim-1', status: 'UNKNOWN', message: summary, evidence: ['build-test-process-1'] }],
    buildTest: { items: [
      { label: '构建命令', status: 'VERIFIED', detail: 'node build.mjs，退出码 0' },
      { label: '测试结果', status: 'VERIFIED', detail: '通过 11，失败 0' },
      { label: '产物归属', status: 'VERIFIED', detail: 'docs/dda-project-intro.pptx，本次生成' }
    ] }
  };
  const failure = buildTestVerificationFailure(payload)!;
  expect(failure.code).toBe('BUILD_TEST_CLAIM_EVIDENCE_MISSING');
  expect(failure.text.split(summary)).toHaveLength(2);
  expect(failure.text).toContain('通过 11，失败 0');
  expect(failure.text).toContain('docs/dda-project-intro.pptx，本次生成');
  expect(failure.details.join('\n')).toContain('build-test-process-1');
  expect(planFailureMessage(payload, failure.text, failure.code)).toContain('验收结果待确认');
});

it('distinguishes contradicted counts from missing evidence and verification service outages without a receipts object', () => {
  const conflict = buildTestVerificationFailure({
    failureCodes: ['BUILD_TEST_CONCLUSION_CONFLICT'], checks: [
      { id: 'build-test-claim-1', status: 'FAIL', message: '通过实际记录为 10（11 项通过）' },
      { id: 'build-test-claim-2', status: 'UNKNOWN', message: '缺少幻灯片页数的执行证据（12 页）' }
    ]
  });
  expect(conflict?.text).toContain('通过实际记录为 10（11 项通过）');
  expect(conflict?.text).toContain('缺少幻灯片页数');
  const unavailable = buildTestVerificationFailure({ stepErrorCode: 'BUILD_TEST_VERIFIER_UNAVAILABLE' });
  expect(unavailable?.text).toContain('验证服务未能完成');
  expect(unavailable?.text).not.toContain('不一致');
  expect(buildTestVerificationFailure({ failureCodes: ['JEV_BEHAVIOR_REJECTED'] })).toBeUndefined();
});
