import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';
import fixture from '../../../contracts/v1/fixtures/harness-read-model.ready.json';
import runtimeEventFixture from '../../../contracts/v1/fixtures/runtime-event.approval-requested.json';
import actionIntentFixture from '../../../contracts/v1/fixtures/action-intent.waiting-approval.json';
import verifierReportFixture from '../../../contracts/v1/fixtures/verifier-report.evidence.json';
import approvalFixture from '../../../contracts/v1/fixtures/execution-approval.presented.json';
import leaseFixture from '../../../contracts/v1/fixtures/execution-lease.active.json';
import trajectoryFixture from '../../../contracts/v1/fixtures/trajectory-record.task-created.json';
import schema from '../../../contracts/v1/harness-read-model.schema.json';
import runtimeEventSchema from '../../../contracts/v1/runtime-event.schema.json';
import actionIntentSchema from '../../../contracts/v1/action-intent.schema.json';
import verifierReportSchema from '../../../contracts/v1/verifier-report.schema.json';
import approvalSchema from '../../../contracts/v1/execution-approval.schema.json';
import leaseSchema from '../../../contracts/v1/execution-lease.schema.json';
import executionStateSchema from '../../../contracts/v1/execution-state.schema.json';
import trajectorySchema from '../../../contracts/v1/trajectory-record.schema.json';
import memorySchema from '../../../contracts/v1/memory-record.schema.json';
import dreamSchema from '../../../contracts/v1/dream-run.schema.json';
import pluginSchema from '../../../contracts/v1/plugin-governance-record.schema.json';
import roleContextSchema from '../../../contracts/v1/role-context.schema.json';
import threadSchema from '../../../contracts/v1/thread-record.schema.json';
import routeSchema from '../../../contracts/v1/route-resolution.schema.json';

describe('HarnessReadModel v1 contract', () => {
  it('accepts the shared ready fixture', () => {
    const validate = new Ajv2020({ allErrors: true }).compile(schema);

    expect(validate(fixture), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('accepts controlled execution but rejects external network side effects', () => {
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    const controlledFixture = {
      ...fixture,
      runtime: { ...fixture.runtime, commandExecution: true },
      composer: { ...fixture.composer, mode: 'CONTROLLED' }
    };
    expect(validate(controlledFixture), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validate({
      ...controlledFixture,
      runtime: { ...controlledFixture.runtime, networkSideEffects: true }
    })).toBe(false);
  });

  it('accepts a projected Decision DAG, feedback and evolution control surface', () => {
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    const withGovernanceFacts = {
      ...fixture,
      decisions: [
        { decisionId: 'decision-root', runId: 'run-1', decisionType: 'plan', role: 'planner', stepId: 'step-1', status: 'COMMITTED', optionCount: 2, eventSequence: 4, updatedAtMs: 1000 },
        { decisionId: 'decision-child', runId: 'run-1', decisionType: 'route', role: 'router', parentDecisionIds: ['decision-root'], status: 'COMMITTED', optionCount: 1, updatedAtMs: 2000 },
        { decisionId: 'decision-revising', runId: 'run-1', decisionType: 'route', role: 'router', parentDecisionIds: ['decision-root'], supersedesDecisionId: 'decision-child', status: 'COMMITTED', optionCount: 1, updatedAtMs: 3000 }
      ],
      feedback: [{ feedbackId: 'feedback-1', runId: 'run-1', outcomeStatus: 'SUCCEEDED', eventSequence: 5 }],
      evolutionControl: { enabled: true, changedAtMs: 1000 }
    };
    expect(validate(withGovernanceFacts), JSON.stringify(validate.errors, null, 2)).toBe(true);
    // A DAG node cannot smuggle extra fields, exceed the bounded option count,
    // or carry an unbounded parent list.
    expect(validate({
      ...withGovernanceFacts,
      decisions: [{ decisionId: 'd', status: 'COMMITTED', optionCount: 1, unexpected: true }]
    })).toBe(false);
    expect(validate({
      ...withGovernanceFacts,
      decisions: [{ decisionId: 'd', status: 'COMMITTED', optionCount: 33 }]
    })).toBe(false);
    expect(validate({
      ...withGovernanceFacts,
      decisions: [{ decisionId: 'd', status: 'COMMITTED', optionCount: 1, parentDecisionIds: Array.from({ length: 65 }, (_, index) => `parent-${index}`) }]
    })).toBe(false);
  });

  it('accepts a bounded candidate selection decision and rejects unbounded option facts', () => {
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    const withCandidates = {
      ...fixture,
      decisions: [{
        decisionId: 'decision-select',
        runId: 'run-1',
        decisionType: 'SELECT_CANDIDATE',
        role: 'planner',
        status: 'COMMITTED',
        optionCount: 3,
        selectedOptionId: 'binding-b',
        reasonCodes: ['CANDIDATE_SELECTION_JUDGE_RANKED'],
        selectionCriteria: ['deterministic_hard_elimination'],
        options: [
          { optionId: 'binding-a', actionKind: 'model.candidate', expectedQuality: 0.4, expectedCost: 1, expectedLatencyMs: 90, rejectionReasonCodes: [] },
          { optionId: 'binding-b', actionKind: 'model.candidate', expectedQuality: 0.9, rejectionReasonCodes: [] },
          { optionId: 'binding-c', actionKind: 'model.candidate', rejectionReasonCodes: ['TEST_FAILED'] }
        ],
        updatedAtMs: 1000
      }]
    };
    expect(validate(withCandidates), JSON.stringify(validate.errors, null, 2)).toBe(true);
    // Scores must stay in range, rejection reasons stay bounded, and the option
    // list stays capped.
    expect(validate({
      ...withCandidates,
      decisions: [{ ...withCandidates.decisions[0], options: [{ optionId: 'binding-a', expectedQuality: 1.4, rejectionReasonCodes: [] }] }]
    })).toBe(false);
    expect(validate({
      ...withCandidates,
      decisions: [{
        ...withCandidates.decisions[0],
        options: Array.from({ length: 9 }, (_, index) => ({ optionId: `binding-${index}`, rejectionReasonCodes: [] }))
      }]
    })).toBe(false);
    expect(validate({
      ...withCandidates,
      decisions: [{ ...withCandidates.decisions[0], options: [{ optionId: 'binding-a' }] }]
    })).toBe(false);
  });

  it('accepts the shared runtime event envelope and rejects unknown fields', () => {
    const validate = new Ajv2020({ allErrors: true }).compile(runtimeEventSchema);
    expect(validate(runtimeEventFixture), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(validate({ ...runtimeEventFixture, unexpected: true })).toBe(false);
  });

  it('validates action intent and verifier reports independently of the read model', () => {
    const validateIntent = new Ajv2020({ allErrors: true }).compile(actionIntentSchema);
    expect(validateIntent(actionIntentFixture), JSON.stringify(validateIntent.errors, null, 2)).toBe(true);

    const validateReport = new Ajv2020({ allErrors: true }).compile(verifierReportSchema);
    expect(validateReport({
      status: 'PASS',
      summary: '确定性检查通过',
      checks: [{ id: 'output.non_empty', status: 'PASS', message: '模型返回了结果' }]
    })).toBe(true);
    expect(validateReport(verifierReportFixture), JSON.stringify(validateReport.errors, null, 2)).toBe(true);
  });

  it('validates the durable approval and lease records independently', () => {
    const ajv = new Ajv2020({ allErrors: true });
    const validateApproval = ajv.compile(approvalSchema);
    const validateLease = ajv.compile(leaseSchema);
    expect(validateApproval(approvalFixture), JSON.stringify(validateApproval.errors, null, 2)).toBe(true);
    expect(validateLease(leaseFixture), JSON.stringify(validateLease.errors, null, 2)).toBe(true);
    expect(validateApproval({ ...approvalFixture, displayedDigest: 'not-a-digest' })).toBe(false);
    expect(validateLease({ ...leaseFixture, commands: [''] })).toBe(false);
  });

  it('validates the execution-state envelope and internal trajectory records', () => {
    const ajv = new Ajv2020({ allErrors: true });
    ajv.addSchema(actionIntentSchema);
    ajv.addSchema(approvalSchema);
    ajv.addSchema(leaseSchema);
    const validateState = ajv.compile(executionStateSchema);
    expect(validateState({ schemaVersion: '1.0', records: [actionIntentFixture, approvalFixture, leaseFixture] }), JSON.stringify(validateState.errors, null, 2)).toBe(true);
    expect(validateState({ schemaVersion: '1.0', records: [{ ...leaseFixture, recordType: 'approval' }] })).toBe(false);

    const validateTrajectory = ajv.compile(trajectorySchema);
    expect(validateTrajectory(trajectoryFixture), JSON.stringify(validateTrajectory.errors, null, 2)).toBe(true);
    expect(validateTrajectory({ ...trajectoryFixture, redactionState: 'RAW' })).toBe(false);
    expect(validateTrajectory({ ...trajectoryFixture, protocolVersion: undefined })).toBe(false);
  });

  it('accepts the current governance fields in the read-model projection', () => {
    const validate = new Ajv2020({ allErrors: true }).compile(schema);
    const current = {
      ...fixture,
      resumeThreadId: 'thread-fixture',
      memories: [{ memoryId: 'memory-fixture', statement: 'Use npm test', scope: 'workspace', confidence: 0.8, status: 'ACTIVE', createdAtMs: 1, updatedAtMs: 2 }],
      dreamRuns: [{ runId: 'dream-fixture', projectId: 'project-fixture', state: 'COMPLETED', startedAtMs: 1 }],
      plugins: [{ pluginId: 'plugin.fixture', version: '1.0.0', manifest: {}, source: 'CORE', packageDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', state: 'ACTIVE', createdAtMs: 1, updatedAtMs: 2 }],
      evolutionProposals: [{ proposalId: 'proposal-fixture', candidateId: 'candidate-fixture', status: 'PROPOSED', proposalDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', createdAtMs: 1, updatedAtMs: 2 }],
      evolutionReports: [{ reportId: 'report-fixture', proposalId: 'proposal-fixture', stage: 'OFFLINE_REPLAY', evaluatedAtMs: 2, reportDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' }]
    };
    expect(validate(current), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });

  it('covers persisted thread, role, routing and governance records', () => {
    const ajv = new Ajv2020({ allErrors: true });
    const digest = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(ajv.compile(memorySchema)({ memoryId: 'memory-1', runId: 'run-1', statement: 'Use npm test', sourceEventIds: [], scope: 'workspace', confidence: 0.5, kind: 'PROJECT', validFromMs: 1, createdAtMs: 1, updatedAtMs: 1, status: 'PROPOSED', history: [], recordDigest: digest })).toBe(true);
    expect(ajv.compile(dreamSchema)({ runId: 'dream-1', projectId: 'project-1', state: 'WAITING_GATE', startedAtMs: 1, recordDigest: digest })).toBe(true);
    expect(ajv.compile(pluginSchema)({ pluginId: 'plugin.example', version: '1.0.0', manifest: {}, source: 'CORE', packageDigest: digest, state: 'ACTIVE', createdAtMs: 1, updatedAtMs: 1, recordDigest: digest })).toBe(true);
    expect(ajv.compile(roleContextSchema)({ contextId: 'context-1', runId: 'run-1', role: 'planner', isolation: 'DEDICATED', state: 'READY', ownerPid: 1, runtimeInstanceId: 'runtime-1', metadata: {}, createdAtMs: 1, updatedAtMs: 1 })).toBe(true);
    expect(ajv.compile(threadSchema)({ id: 'thread-1', title: 'Task', cwd: 'C:/workspace', turns: [], state: 'IDLE', createdAtMs: 1, updatedAtMs: 1 })).toBe(true);
    expect(ajv.compile(routeSchema)({ taskClass: 'inspect', status: 'SELECTED', reason: 'STATIC_RULE', roles: { planner: 'default', executor: 'default', verifier: 'rule' } })).toBe(true);
  });
});
