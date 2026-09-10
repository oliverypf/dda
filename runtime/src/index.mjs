#!/usr/bin/env node
import { PluginRegistry, pluginManifest } from './plugins/registry.mjs';
import { randomUUID } from 'node:crypto';
import { assertReleaseExecutionMode, assertReleaseHarnessStore, resolveReleaseChannel } from './release-channel.mjs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { defaultModelConfigPath, loadModelConfig, resolveModelConfig } from './model-config.mjs';
import { logger } from './logger.mjs';
import { createTrajectoryStore, sha256Digest, parseLegacyTrajectoryEvents } from './trajectory-store.mjs';
import { createGitObserver } from './git-observer.mjs';
import { createGitAuditStore } from './git-audit-store.mjs';
import {
  createHarnessEventStore,
  HARNESS_APP_VERSION,
  HARNESS_POLICY_VERSION,
  HARNESS_PRODUCER_VERSION,
  HARNESS_PROTOCOL_VERSION,
  HARNESS_STORAGE_SCHEMA_VERSION
} from './harness-event-store.mjs';
import { checkpointHarnessDatabase, restoreHarnessDatabase } from './harness-store-checkpoint.mjs';
import { assertLegacyHarnessMigrated } from './harness-store-migration-guard.mjs';
import { assertProjectionOutput } from './projection-output-guard.mjs';
import { redactSensitiveData, scanSupportBundle } from './support-bundle-privacy.mjs';
import { createMeteredHarnessEventStore, readCommitMetrics } from './commit-metrics.mjs';
import { createReadModelRebuilder, pageProjectionTimeline } from './read-model-rebuilder.mjs';
import { createFileRetentionProgressStore, createRetentionWorker, parseRetentionWorkerBatchSize, parseRetentionWorkerFailureLimit, parseRetentionWorkerInterval } from './retention-worker.mjs';
import { createExecutionScopeSnapshot, compareGitObservations } from './execution-scope-snapshot.mjs';
import { createExecutionStateStore, executionDigest } from './execution-state-store.mjs';
import { createThreadStore } from './thread-store.mjs';
import { createRuleVerifier } from './rule-verifier.mjs';
import { createTaskRunCoordinator } from './task-run-coordinator.mjs';
import { createTaskCancelRegistry, taskCancelStorePath } from './task-cancel-registry.mjs';
import { classifyTask, createRuleRouter } from './rule-router.mjs';
import { createRoleSessionManager } from './role-session-manager.mjs';
import { createTaskSafetyPrecheck } from './task-safety-precheck.mjs';

// S2-12 risk hint: a settled low-risk inspect task stays single-candidate, an
// unclassified task class escalates to the design's "no history" fanout case,
// and a controlled non-inspect step is treated as high risk.
const candidateFanoutRisk = (taskClass, mode) => taskClass === 'inspect'
  ? (mode === 'CONTROLLED' ? 'MEDIUM' : 'LOW')
  : (mode === 'CONTROLLED' ? 'HIGH' : 'MEDIUM');
import { evaluateSemanticVerifierIndependence } from './semantic-verifier-gate.mjs';
import { assembleCheckpointContext, assembleMemoryContext, assembleTrajectoryContext } from './context-assembler.mjs';
import { createMemoryJournal } from './memory-journal.mjs';
import { createJournalContextPort } from './journal-context-port.mjs';
import { createOpenVikingContextPort } from './openviking-context-port.mjs';
import { createDreamScheduler } from './dream-scheduler.mjs';
import { createDreamMaintenanceSupervisor, parseDreamActiveRuns, parseDreamMaintenanceFailureLimit, parseDreamMaintenanceInterval } from './dream-maintenance-supervisor.mjs';
import { createMemoryVerifier } from './memory-verifier.mjs';
import { createAgentDecisionTrace } from './decision-trace.mjs';
import { createFeedbackRegistry } from './feedback-registry.mjs';
import { assessBayesian, rankSafeCandidates } from './bayesian-assessment.mjs';
import { createModelScenarioProfileRegistry } from './model-scenario-profile.mjs';
import { evaluateDecisionTrace, exportLearningSample } from './decision-evaluation.mjs';
import { CAPABILITIES, EXECUTION_MODES, RuntimeSafetyMonitor, WorkspaceLeaseRegistry } from './runtime-safety-monitor.mjs';
import { RestrictedWindowsExecutor } from './restricted-windows-executor.mjs';
import { RestrictedNetworkAdapter } from './restricted-network-adapter.mjs';
import { createExplicitLeaseProvider } from './controlled-tools.mjs';
import { createPluginGovernance, pluginGovernanceDigest } from './plugin-governance.mjs';
import { createDynamicPluginLoader, validatePluginDependencies, validatePluginManifest } from './plugin-loader.mjs';
import { createCapabilityScopedPluginContext, pluginContextGrantSummary, validatePluginInject } from './plugin-context.mjs';
import { createRecoveryContext, runVerifierRecovery } from './task-recovery-controller.mjs';
import { createProfileRegistry } from './profile-registry.mjs';
import { createModelRegistry } from './model-registry.mjs';
import { createRoleBindingResolver } from './role-binding-resolver.mjs';
import { createCreditBlameLedger } from './credit-blame-ledger.mjs';
import { createModelEgressLedger, normalizeEgressTarget } from './model-egress-ledger.mjs';
import { createEvolutionEvaluator } from './evolution-evaluator.mjs';
import { EvolutionControlStore } from './evolution-control.mjs';
import { normalizePlannerPlan, restorePlannerPlan, runCandidateJudgeTurn, runCouncilJudgeTurn, runCouncilMemberTurn, runExecutorTurn, runIsolatedModelTurn, runPlannerTurn, runSemanticVerifierTurn } from './agent-turns.mjs';
import { normalizeCandidateSetSpec, planCandidateFanout } from './candidate-fanout.mjs';
import { runCandidateDraftStage } from './candidate-draft-stage.mjs';
import { createAgentCouncil } from './agent-council.mjs';
import { createPlanStepCoordinator } from './plan-step-coordinator.mjs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { canonicalMappedPath, preferMappedPath } from './windows-path.mjs';
import { assessStorageCapacity, assertStorageCapacityForRun, DEFAULT_MAX_BYTES } from './storage-capacity.mjs';

const BOOLEAN_ARGS = new Set(['--resume', '--auto-evolution-proposal', '--purge-expired', '--require-holdout']);
const APPROVAL_TTL_MS = 120000;
// One CLI invocation runs at most one task; never derive identity from errors.
let taskResponseRunId;

// The desktop shell owns this process's stdout pipe. When the shell exits or
// restarts while a run is still streaming, the pipe can close mid-write. A
// closed pipe must end this child quietly instead of surfacing an uncaught
// EPIPE that leaves a FATAL log behind and hides the real run outcome.
process.stdout.on('error', (error) => {
  if (error?.code === 'EPIPE') {
    // The desktop shell is gone (closed pipe); stop this orphaned run instead
    // of continuing to execute with nowhere to report events. Startup
    // recovery reconciles any run that was left non-terminal.
    process.exit(0);
  }
  throw error;
});
const writeStdout = (text) => {
  try {
    process.stdout.write(text);
  } catch (error) {
    if (error?.code !== 'EPIPE') throw error;
  }
};

// A mapped Windows drive and its UNC spelling refer to the same workspace,
// but string comparison alone would make a resumed Thread look unrelated.
// Resolve existing paths through the native filesystem identity once at the
// runtime boundary and compare the normalized identity thereafter.
const canonicalWorkspacePath = (value) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  const input = value.trim();
  // Keep an explicitly mapped drive for actual I/O. Only the comparison key
  // below needs native canonical identity; storing UNC here makes every
  // workspace read and subprocess cwd traverse the slower network spelling.
  return /^[A-Za-z]:[\\/]/u.test(input)
    ? preferMappedPath(input)
    : canonicalMappedPath(input);
};

const workspacePathKey = (value) => {
  const canonical = canonicalWorkspacePath(value);
  const normalized = canonical.replace(/[\\/]+/g, '\\');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
};

const argValue = (name) => {
  for (let index = 3; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (token === name) {
      const value = process.argv[index + 1];
      return value !== undefined && !value.startsWith('--') ? value : undefined;
    }
    if (token.startsWith(`${name}=`)) return token.slice(name.length + 1);
    if (token.startsWith('--') && !token.includes('=') && !BOOLEAN_ARGS.has(token)) index += 1;
  }
  return undefined;
};

const arg = (name, fallback) => {
  const value = argValue(name);
  return value === undefined ? fallback : value;
};

const modelOverridesFromArgs = () => ({
  ...(argValue('--provider') !== undefined ? { provider: argValue('--provider') } : {}),
  ...(argValue('--protocol') !== undefined ? { protocol: argValue('--protocol') } : {}),
  ...(argValue('--model') !== undefined ? { model: argValue('--model') } : {}),
  ...(argValue('--base-url') !== undefined ? { baseURL: argValue('--base-url') } : {}),
  ...(argValue('--endpoint') !== undefined ? { endpoint: argValue('--endpoint') } : {}),
  ...(argValue('--api-key-env') !== undefined ? { apiKeyEnv: argValue('--api-key-env') } : {})
});

const command = process.argv[2] ?? 'snapshot';
const eventOutput = argValue('--events') ?? process.env.HMCODEX_EVENTS ?? '';

const csv = (value) => String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

const executionMode = () => {
  const raw = arg('--execution-mode', arg('--mode', process.env.HMCODEX_EXECUTION_MODE ?? EXECUTION_MODES.READ_ONLY));
  if (raw === EXECUTION_MODES.READ_ONLY) return assertReleaseExecutionMode(EXECUTION_MODES.READ_ONLY);
  if (raw === EXECUTION_MODES.CONTROLLED || raw === 'CONTROLLED_WRITE') return assertReleaseExecutionMode(EXECUTION_MODES.CONTROLLED);
  throw new Error('EXECUTION_MODE_INVALID');
};

const capabilityNames = (value) => csv(value).map((item) => ({
  shell: CAPABILITIES.SHELL,
  'shell.execute': CAPABILITIES.SHELL,
  write: CAPABILITIES.WRITE_FILE,
  'file.write': CAPABILITIES.WRITE_FILE,
  test: CAPABILITIES.TEST,
  'test.execute': CAPABILITIES.TEST
}[item] ?? item));

const parseNetworkTargets = (value) => {
  if (value === undefined || String(value).trim() === '') return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('NETWORK_TARGETS_INVALID');
  }
  if (!Array.isArray(parsed) || parsed.length > 32
    || parsed.some((target) => !target || typeof target !== 'object' || Array.isArray(target) || typeof target.host !== 'string')) {
    throw new Error('NETWORK_TARGETS_INVALID');
  }
  return parsed;
};

const executionOptions = (mode) => ({
  mode,
  ...(argValue('--command-allowlist') !== undefined
    ? { commandAllowlist: csv(argValue('--command-allowlist')) }
    : process.env.HMCODEX_COMMAND_ALLOWLIST
      ? { commandAllowlist: csv(process.env.HMCODEX_COMMAND_ALLOWLIST) }
      : {})
});

const defaultEvolutionStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'evolution-proposals.json') : undefined;
};

const defaultEvolutionEvaluationStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'evolution-evaluations.json') : undefined;
};

const defaultTrajectoryStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'trajectory.jsonl') : undefined;
};

const auditSigningOptions = () => {
  const keyEnv = argValue('--audit-signing-key-env') ?? process.env.HMCODEX_GIT_AUDIT_SIGNING_KEY_ENV ?? 'HMCODEX_GIT_AUDIT_SIGNING_KEY';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(keyEnv)) throw new Error('GIT_AUDIT_SIGNING_ENV_INVALID');
  const key = process.env[keyEnv];
  return key ? { signingKey: key, signingKeyRef: keyEnv } : {};
};

const defaultGitAuditStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'git-audit.json') : undefined;
};

const defaultHarnessEventStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'hmcodex.db') : undefined;
};

// Task execution and recovery must resolve the same authority for an identical
// trajectory scope. Legacy storage remains a pre-Phase-1 compatibility path.
const taskHarnessEventStore = (trajectoryPath, scopedTrajectory) => assertReleaseHarnessStore(
  arg('--harness-event-store', process.env.HMCODEX_HARNESS_EVENT_STORE
    ?? (!scopedTrajectory ? defaultHarnessEventStore()
      : resolveReleaseChannel() === 'WINDOWS_PHASE1_READ_ONLY' && trajectoryPath ? `${trajectoryPath}.db` : undefined))
);

const defaultThreadStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'threads.json') : undefined;
};

const defaultRoleContextStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'role-contexts.json') : undefined;
};

const defaultMemoryStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'memory.json') : undefined;
};

const defaultDreamStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'dream-runs.json') : undefined;
};

const defaultFeedbackStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'feedback.json') : undefined;
};

const defaultModelScenarioProfileStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'model-scenario-profiles.json') : undefined;
};

const defaultDecisionTraceStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'decision-trace.json') : undefined;
};

const defaultProfileStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'profiles.json') : undefined;
};

const defaultModelRegistryStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'model-registry.json') : undefined;
};

const defaultCreditBlameStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'credit-blame.json') : undefined;
};

const defaultModelEgressStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'model-egress.json') : undefined;
};

const defaultPluginGovernanceStore = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'plugin-governance.json') : undefined;
};

const defaultPluginRoot = () => {
  const dataRoot = process.env.HMCODEX_DATA_DIR ?? process.env.LOCALAPPDATA ?? process.env.APPDATA;
  return dataRoot ? join(dataRoot, 'hmCodex', 'plugins') : undefined;
};

const trajectoryErrorPayload = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  const separator = message.indexOf(':');
  const code = (separator < 0 ? message : message.slice(0, separator)).replace(/[^A-Z0-9_]/gi, '').slice(0, 80) || 'RUNTIME_ERROR';
  return {
    code,
    messageDigest: sha256Digest(message),
    messageLength: message.length
  };
};

const manifests = () => {
  const registry = new PluginRegistry();
  registry.register(pluginManifest('workspace-readonly', 'Readonly Workspace', 'workspace', ['workspace.read.metadata', 'workspace.read.content'], ['workspace.read.snapshot']));
  registry.register(pluginManifest('model-deepseek', 'DeepSeek Model Provider', 'model-provider', ['model.invoke.stream'], ['network.connect.host']));
  registry.register(pluginManifest('model-openai-compatible', 'OpenAI Compatible Model Provider', 'model-provider', ['model.invoke.stream'], ['network.connect.host']));
  registry.register(pluginManifest('tool-registry', 'Provider-neutral Tool Registry', 'tooling', ['tool.list', 'tool.invoke.readonly', 'tool.invoke.controlled'], ['workspace.read.metadata', 'workspace.read.content', 'executor.invoke.controlled']));
  registry.register(pluginManifest('executor-windows', 'Restricted Windows Executor', 'executor', ['executor.invoke.controlled'], ['filesystem.write.workspace', 'process.spawn.restricted']));
  registry.register(pluginManifest('executor-tools', 'Controlled Executor Tools', 'tooling', ['tool.invoke.controlled'], ['executor.invoke.controlled']));
  registry.register(pluginManifest('task-runner', 'Cordis Task Runner', 'agent', ['task.run.readonly', 'task.run.controlled'], ['workspace.read.snapshot', 'tool.invoke.readonly', 'tool.invoke.controlled']));
  registry.register(pluginManifest('task-run-coordinator', 'Task Run Coordinator', 'agent', ['task.state.transition'], ['trajectory.write']));
  registry.register(pluginManifest('plan-step-coordinator', 'Plan Step Coordinator', 'agent', ['task.plan.schedule', 'task.plan.resume'], ['trajectory.write', 'thread.write']));
  registry.register(pluginManifest('rule-verifier', 'Deterministic Rule Verifier', 'verifier', ['verify.task.rules'], ['workspace.read.snapshot', 'trajectory.read.redacted']));
  registry.register(pluginManifest('agent-turns', 'Isolated Planner and Semantic Verifier Turns', 'agent', ['agent.plan', 'agent.verify.semantic'], ['network.connect.host', 'trajectory.write']));
  registry.register(pluginManifest('agent-council', 'Bounded Agent Council', 'agent', ['agent.deliberate', 'agent.abstain'], ['trajectory.write']));
  registry.register(pluginManifest('role-session-manager', 'Role Session Manager', 'agent', ['role.context.allocate', 'role.context.fork'], ['thread.read', 'thread.write']));
  registry.register(pluginManifest('rule-router', 'Static Rule Router', 'agent', ['route.resolve'], ['profile.read']));
  registry.register(pluginManifest('thread-store', 'Local Thread Store', 'workspace', ['thread.list', 'thread.resume', 'thread.fork'], ['thread.read', 'thread.write']));
  registry.register(pluginManifest('plugin-governance', 'Plugin Governance', 'skill', ['plugin.validate', 'plugin.quarantine'], ['plugin.manifest.read', 'plugin.registry.write']));
  registry.register(pluginManifest('memory-journal', 'Memory Journal', 'skill', ['memory.propose', 'memory.verify'], ['trajectory.read.redacted']));
  registry.register(pluginManifest('context-port', 'Provider-neutral Context Port', 'skill', ['context.recall', 'context.record', 'context.used', 'context.commit'], ['trajectory.read.redacted']));
  registry.register(pluginManifest('context-openviking', 'OpenViking Context Adapter', 'skill', ['context.recall', 'context.record', 'context.used', 'context.commit'], ['network.connect.loopback']));
  registry.register(pluginManifest('memory-verifier', 'Deterministic Memory Verifier', 'verifier', ['memory.verify.source', 'memory.verify.conflict'], ['trajectory.read.redacted', 'memory.read']));
  registry.register(pluginManifest('dream-scheduler', 'Dream Scheduler', 'skill', ['memory.dream.schedule'], ['trajectory.read.redacted']));
  registry.register(pluginManifest('evolution-registry', 'Evolution Proposal Registry', 'skill', ['profile.propose-update'], ['trajectory.read.redacted']));
  return registry.list();
};

async function runTask() {
  const prompt = arg('--prompt', '');
  const workspaceRoot = canonicalWorkspacePath(arg('--workspace', ''));
  const mode = executionMode();
  const releaseChannel = resolveReleaseChannel();
  const approvedCapabilities = capabilityNames(arg('--lease-capabilities', process.env.HMCODEX_LEASE_CAPABILITIES ?? ''));
  const approvedCommands = csv(arg('--lease-commands', process.env.HMCODEX_LEASE_COMMANDS ?? ''));
  const approvedNetworkTargets = parseNetworkTargets(arg('--network-targets', process.env.HMCODEX_NETWORK_TARGETS));
  const autoEvolutionProposal = parseBoolean(
    process.argv.includes('--auto-evolution-proposal') ? 'true' : argValue('--auto-evolution-proposal'),
    parseBoolean(process.env.HMCODEX_AUTO_EVOLUTION_PROPOSAL, false)
  );
  const agentMode = String(arg('--agent-mode', process.env.HMCODEX_AGENT_MODE ?? 'single')).toLowerCase();
  if (!['single', 'multi'].includes(agentMode)) throw new Error('AGENT_MODE_INVALID');
  const resumeRequested = process.argv.includes('--resume');
  const runId = `run-${randomUUID()}`;
  taskResponseRunId = runId;
  const evolutionVerificationToken = randomUUID();
  const runStartedAtMs = Date.now();
  const requestedTaskTimeoutMs = Number(arg('--task-timeout-ms', process.env.HMCODEX_TASK_TIMEOUT_MS ?? '0'));
  const taskTimeoutMs = Number.isFinite(requestedTaskTimeoutMs) && requestedTaskTimeoutMs > 0
    ? Math.min(Math.floor(requestedTaskTimeoutMs), 24 * 60 * 60 * 1000)
    : 0;
  const taskAbortController = new AbortController();
  let taskTimeoutError;
  let taskCancelError;
  let cancelPollTimer;
  let cancelPollStopped = false;
  const taskTimeoutTimer = taskTimeoutMs > 0
    ? setTimeout(() => {
        taskTimeoutError = Object.assign(new Error(`TASK_TIMEOUT:${taskTimeoutMs}`), { code: 'TASK_TIMEOUT' });
        taskAbortController.abort(taskTimeoutError);
      }, taskTimeoutMs)
    : undefined;
  taskTimeoutTimer?.unref?.();
  logger.info(`run started | runId=${runId} | mode=${mode} | agentMode=${agentMode} | resume=${resumeRequested} | workspace=${workspaceRoot}`);
  const approvalContexts = new Map();
  let activeSnapshotDigest;
  let initialGitObservation;
  let eventSequence = 0;
  const emitEvent = (kind, payload = {}) => {
    if (eventOutput !== 'stdout') return;
    const event = {
      type: 'runtime_event',
      schemaVersion: '1.0',
      runId,
      sequence: ++eventSequence,
      kind,
      payload,
      emittedAtMs: Date.now()
    };
    writeStdout(`${JSON.stringify(event)}\n`);
  };
  const pendingApprovals = new Map();
  const approvalInterface = eventOutput === 'stdout' && mode === EXECUTION_MODES.CONTROLLED
    ? createInterface({ input: process.stdin })
    : undefined;
  approvalInterface?.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (message?.type !== 'approval_response' || typeof message.requestId !== 'string') return;
      const pending = pendingApprovals.get(message.requestId);
      if (!pending) return;
      if (message.displayedDigest !== pending.requestDigest) return;
      pendingApprovals.delete(message.requestId);
      clearTimeout(pending.timer);
      const approved = message.approved === true;
      void (async () => {
        if (pending.context?.approval) await executionState.transition(pending.context.approval.recordId, approved ? 'APPROVED' : 'DECLINED');
        if (pending.context?.intent) await executionState.transition(pending.context.intent.recordId, approved ? 'APPROVED' : 'REJECTED');
        if (!approved) approvalContexts.delete(pending.requestDigest);
        if (coordinator.state === 'WAITING_APPROVAL') {
          await coordinator.transitionAndFlush(approved ? 'EXECUTING' : 'FAILED', {
            reason: approved ? 'APPROVAL_GRANTED' : 'APPROVAL_DECLINED',
            metadata: { requestId: message.requestId }
          });
        }
        emitEvent('approval.resolved', {
          requestId: message.requestId,
          state: approved ? 'APPROVED' : 'DECLINED',
          displayedDigest: pending.requestDigest,
          ...(pending.context?.intent ? { intentId: pending.context.intent.recordId } : {}),
          ...(pending.context?.approval ? { approvalId: pending.context.approval.recordId } : {})
        });
        pending.resolve(approved);
      })().catch(() => pending.resolve(false));
    } catch {
      // Ignore malformed host input; the pending approval will expire safely.
    }
  });
  const requestApproval = async ({ capability, request }) => {
    const requestId = `approval-${randomUUID()}`;
    const requestDigest = executionDigest({ capability, request });
    const approvalExpiresAt = Date.now() + APPROVAL_TTL_MS;
    const risk = capability === CAPABILITIES.SHELL || capability === CAPABILITIES.WRITE_FILE || capability === CAPABILITIES.NETWORK
      ? 'HIGH'
      : capability === CAPABILITIES.TEST ? 'MEDIUM' : 'LOW';
    const safeRequest = {
      capability,
      requestDigest,
      risk,
      approvalExpiresAt,
      policyVersion: 'runtime-safety-1',
      scope: { snapshotDigest: activeSnapshotDigest, capability },
      ...(typeof request?.command === 'string' ? { command: request.command.slice(0, 4096) } : {}),
      ...(typeof request?.path === 'string' ? { path: request.path.slice(0, 512) } : {}),
      ...(typeof request?.cwd === 'string' ? { cwd: request.cwd.slice(0, 512) } : {}),
      ...(typeof request?.host === 'string' ? {
        host: request.host.slice(0, 253),
        ...(typeof request?.method === 'string' ? { method: request.method.slice(0, 10) } : {}),
        ...(typeof request?.scheme === 'string' ? { scheme: request.scheme.slice(0, 10) } : {})
      } : {})
    };
    let resolveApproval;
    const approvalPromise = new Promise((resolve) => { resolveApproval = resolve; });
    const pending = { resolve: resolveApproval, timer: undefined, requestDigest, context: undefined };
    if (approvalInterface) {
      pending.timer = setTimeout(() => {
        void (async () => {
          pendingApprovals.delete(requestId);
          approvalContexts.delete(requestDigest);
          emitEvent('approval.expired', { requestId });
          if (pending.context?.approval) await executionState.transition(pending.context.approval.recordId, 'EXPIRED').catch(() => {});
          if (pending.context?.intent) await executionState.transition(pending.context.intent.recordId, 'REJECTED').catch(() => {});
          if (coordinator.state === 'WAITING_APPROVAL') {
            await coordinator.transitionAndFlush('FAILED', {
              reason: 'APPROVAL_EXPIRED',
              metadata: { requestId }
            }).catch(() => {});
          }
          pending.resolve(false);
        })();
      }, APPROVAL_TTL_MS);
      pendingApprovals.set(requestId, pending);
    }
    try {
      const operationId = `operation-${requestId}`;
      const bindingSnapshotDigest = sha256Digest(JSON.stringify(allocatedRoles.map(({ contextId, role, model, isolation }) => ({ contextId, role, model, isolation }))));
      const scopeSnapshot = createExecutionScopeSnapshot({
        runId,
        operationId,
        workspaceRootDigest: activeSnapshotDigest,
        canonicalRootDigest: activeSnapshotDigest,
        repositoryRootDigest: initialGitObservation?.repositoryRootDigest,
        beforeHead: initialGitObservation?.headDigest,
        allowedCapabilities: [capability],
        allowedPathRoots: typeof request?.path === 'string' ? [request.path] : [],
        allowedCommands: typeof request?.command === 'string' ? [request.command] : [],
        ...(approvedNetworkTargets.length ? { allowedNetworkTargets: approvedNetworkTargets.map((target) => target.host) } : {}),
        executionMode: mode,
        releaseChannel,
        policyVersion: 'runtime-safety-1',
        bindingSnapshotDigest,
        createdAtMs: Date.now()
      });
      safeRequest.scope = { snapshotDigest: scopeSnapshot.snapshotDigest, capability };
      const intent = await executionState.createIntent({
        runId,
        capability,
        request,
        snapshotDigest: activeSnapshotDigest,
        scope: scopeSnapshot,
        operationId,
        bindingSnapshot: allocatedRoles.map(({ contextId, role, model, isolation }) => ({ contextId, role, model, isolation })),
        capabilitySnapshot: { releaseChannel, capabilities: approvedCapabilities, commands: approvedCommands, ...(approvedNetworkTargets.length ? { networkTargets: approvedNetworkTargets } : {}) },
        releaseChannel,
        executorIdentity: 'restricted-windows-executor@0.1.0',
        policyVersion: 'runtime-safety-1'
      });
      await executionState.transition(intent.recordId, 'SAFETY_EVALUATING');
      const approval = await executionState.createApproval({
        runId,
        intentId: intent.recordId,
        capability,
        requestDigest,
        displayedDigest: requestDigest,
        snapshotDigest: activeSnapshotDigest,
        expiresAt: approvalExpiresAt,
        bindingSnapshot: allocatedRoles.map(({ contextId, role, model, isolation }) => ({ contextId, role, model, isolation })),
        capabilitySnapshot: { releaseChannel, capabilities: approvedCapabilities, commands: approvedCommands, ...(approvedNetworkTargets.length ? { networkTargets: approvedNetworkTargets } : {}) },
        releaseChannel,
        policyVersion: 'runtime-safety-1'
      });
      await executionState.transition(approval.recordId, 'PRESENTED');
      await executionState.transition(intent.recordId, 'WAITING_APPROVAL');
      pending.context = { intent, approval, capability, request, scopeSnapshot, capabilitySnapshot: { releaseChannel, capabilities: approvedCapabilities, commands: approvedCommands, ...(approvedNetworkTargets.length ? { networkTargets: approvedNetworkTargets } : {}) } };
      approvalContexts.set(requestDigest, pending.context);
      if (approvalInterface && coordinator.state === 'EXECUTING') {
        await coordinator.transitionAndFlush('WAITING_APPROVAL', {
          reason: 'APPROVAL_REQUIRED',
          metadata: { requestId, capability }
        });
      }
      emitEvent('action_intent.created', {
        intentId: intent.intentId ?? intent.recordId,
        capability,
        requestDigest,
        snapshotDigest: activeSnapshotDigest,
        policyVersion: 'runtime-safety-1'
      });
      await appendGitAuditCheckpoint('ACTION_REQUESTED', {
        operationId: intent.operationId,
        intentId: intent.recordId,
        approvalId: approval.recordId
      }, { capability, scopeSnapshotDigest: scopeSnapshot.snapshotDigest });
      await appendActionEvent('ActionRequested', {
        operationId: intent.operationId,
        intentId: intent.recordId,
        approvalId: approval.recordId,
        capability,
        requestDigest,
        scopeSnapshotDigest: scopeSnapshot.snapshotDigest
      });
      if (!approvalInterface) {
        await executionState.transition(approval.recordId, 'APPROVED', { reason: 'EXPLICIT_HOST_POLICY' });
        await executionState.transition(intent.recordId, 'APPROVED', { reason: 'EXPLICIT_HOST_POLICY' });
        return true;
      }
    } catch (error) {
      logger.error(`approval request failed | requestId=${requestId} | error=${error?.stack ?? error}`);
      clearTimeout(pending.timer);
      pendingApprovals.delete(requestId);
      pending.resolve(false);
      return approvalPromise;
    }
    // Register and persist the request before emitting it so a fast host reply
    // cannot race the pending approval map or the intent context.
    emitEvent('approval.requested', {
      requestId,
      ...safeRequest,
      ...(pending.context?.intent ? { intentId: pending.context.intent.recordId } : {}),
      ...(pending.context?.approval ? { approvalId: pending.context.approval.recordId } : {})
    });
    return approvalPromise;
  };
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined
    || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const cancelRegistry = createTaskCancelRegistry({
    storagePath: argValue('--cancel-store')
      ?? process.env.HMCODEX_CANCEL_STORE
      ?? taskCancelStorePath(trajectoryPath)
  });
  const cancelPollMs = Math.min(5000, Math.max(100, Number(arg('--cancel-poll-ms', process.env.HMCODEX_CANCEL_POLL_MS ?? '500')) || 500));
  const pollCancellation = async () => {
    if (cancelPollStopped || taskCancelError || taskAbortController.signal.aborted) return;
    try {
      const request = await cancelRegistry.get(runId);
      if (request && !taskAbortController.signal.aborted) {
        taskCancelError = Object.assign(new Error(`TASK_CANCELLED:${request.runId}`), { code: 'TASK_CANCELLED' });
        taskAbortController.abort(taskCancelError);
        await cancelRegistry.consume(runId).catch(() => {});
      }
    } catch {
      // A transient cancel-store read failure must not fail the task.
    }
    if (!cancelPollStopped && !taskAbortController.signal.aborted) {
      cancelPollTimer = setTimeout(pollCancellation, cancelPollMs);
      cancelPollTimer.unref?.();
    }
  };
  cancelPollTimer = setTimeout(pollCancellation, cancelPollMs);
  cancelPollTimer.unref?.();
  const scopedStorePath = (suffix, fallback) => scopedTrajectory && trajectoryPath
    ? `${trajectoryPath}.${suffix}`
    : fallback();
  const harnessEventStorePath = taskHarnessEventStore(trajectoryPath, scopedTrajectory);
  if (!scopedTrajectory && harnessEventStorePath === defaultHarnessEventStore()) {
    await assertLegacyHarnessMigrated(harnessEventStorePath);
  }
  const taskHarnessEventStoreInstance = harnessEventStorePath
    ? createMeteredHarnessEventStore({
        store: createHarnessEventStore({ storagePath: harnessEventStorePath }),
        metricsPath: `${harnessEventStorePath}.commit-metrics.json`
      })
    : undefined;
  const trajectory = createTrajectoryStore(trajectoryPath, taskHarnessEventStoreInstance ? { harnessEventStore: taskHarnessEventStoreInstance } : {});
  const gitAuditPath = arg('--git-audit-store', process.env.HMCODEX_GIT_AUDIT_STORE ?? scopedStorePath('git-audit.json', defaultGitAuditStore));
  const gitAudit = createGitAuditStore({ storagePath: gitAuditPath, ...auditSigningOptions() });
  let gitAuditLoadError;
  try {
    await gitAudit.load();
  } catch (error) {
    gitAuditLoadError = error instanceof Error ? error.message.slice(0, 120) : 'GIT_AUDIT_LOAD_FAILED';
  }
  const gitObserver = createGitObserver({
    workspaceRoot,
    timeoutMs: Number(arg('--git-observer-timeout-ms', process.env.HMCODEX_GIT_OBSERVER_TIMEOUT_MS ?? '60000')),
    untrackedFiles: arg('--git-observer-untracked', process.env.HMCODEX_GIT_OBSERVER_UNTRACKED ?? 'normal')
  });
  const appendGitAuditCheckpoint = async (checkpointKind, correlation = {}, details = {}) => {
    const safeCorrelation = Object.fromEntries(Object.entries(correlation).filter(([, value]) => typeof value === 'string' && value.trim()));
    let observation;
    let errorCode = gitAuditLoadError;
    try {
      if (errorCode) throw new Error(errorCode);
      observation = await gitObserver.snapshot({ reason: 'OBSERVATION' });
    } catch (error) {
      errorCode = error instanceof Error ? error.message.slice(0, 120) : 'GIT_OBSERVER_FAILED';
    }
    const event = await trajectory.append({
      runId,
      kind: 'GitStateObserved',
      payload: {
        checkpointKind,
        ...(Object.keys(safeCorrelation).length > 0 ? { correlation: safeCorrelation } : {}),
        ...(Object.keys(details).length > 0 ? { details } : {}),
        ...(observation ? { observation } : {}),
        ...(errorCode ? { errorCode } : {})
      },
      sensitivity: 'SECURITY_AUDIT'
    });
    try {
      const checkpoint = await gitAudit.append({
        runId,
        eventId: event.eventId,
        eventSequence: event.sequence,
        checkpointKind,
        status: details.auditStatus ?? (errorCode ? 'AUDIT_DEGRADED' : 'READY'),
        ...(details.scopeSnapshotDigest ? { scopeSnapshotDigest: details.scopeSnapshotDigest } : {}),
        ...(observation?.observationDigest ? { observationDigest: observation.observationDigest } : {}),
        trajectoryRootDigest: event.recordDigest,
        ...(observation ? { observation } : {}),
        ...(errorCode ? { errorCode } : {}),
        ...(Object.keys(safeCorrelation).length > 0 ? { correlation: safeCorrelation } : {})
      });
      return { event, checkpoint };
    } catch (error) {
      return {
        event,
        checkpoint: undefined,
        status: 'AUDIT_DEGRADED',
        errorCode: error instanceof Error ? error.message.slice(0, 120) : 'GIT_AUDIT_STORE_FAILED'
      };
    }
  };
  const appendActionEvent = (kind, payload) => trajectory.append({
    runId,
    kind,
    payload,
    sensitivity: 'SECURITY_AUDIT'
  });
  // Keep explicitly scoped runs self-contained.  Test workers, project
  // sandboxes, and multiple runtime instances commonly provide a unique
  // trajectory path; inheriting the global LOCALAPPDATA thread store would
  // make those runs contend with unrelated processes.  Explicit CLI/env
  // thread-store settings always take precedence.
  const threadPath = arg('--thread-store', process.env.HMCODEX_THREAD_STORE ?? scopedStorePath('threads.json', defaultThreadStore));
  const threads = createThreadStore({ storagePath: threadPath, eventStore: trajectory.harnessEventStore });
  await threads.load();
  const storageCapacity = await assertStorageCapacityForRun({
    paths: [trajectoryPath, harnessEventStorePath, threadPath],
    maxBytes: Number(arg('--storage-max-bytes', process.env.HMCODEX_STORAGE_MAX_BYTES ?? String(DEFAULT_MAX_BYTES))),
    warningRatio: Number(arg('--storage-warning-ratio', process.env.HMCODEX_STORAGE_WARNING_RATIO ?? '0.7')),
    criticalRatio: Number(arg('--storage-critical-ratio', process.env.HMCODEX_STORAGE_CRITICAL_RATIO ?? '0.85')),
    hardRatio: Number(arg('--storage-hard-ratio', process.env.HMCODEX_STORAGE_HARD_RATIO ?? '0.95'))
  });
  const feedbackPath = arg('--feedback-store', process.env.HMCODEX_FEEDBACK_STORE ?? scopedStorePath('feedback.json', defaultFeedbackStore));
  const feedbackRegistry = createFeedbackRegistry({ storagePath: feedbackPath, eventStore: trajectory.harnessEventStore });
  await feedbackRegistry.load();
  const requestedThreadId = argValue('--thread-id');
  let thread = requestedThreadId ? await threads.get(requestedThreadId) : undefined;
  if (requestedThreadId && !thread) throw new Error('THREAD_NOT_FOUND');
  const resumeSourceRunId = resumeRequested ? thread?.checkpoint?.runId : undefined;
  if (resumeRequested && (!thread || !thread.checkpoint || typeof thread.checkpoint.plan !== 'object')) {
    throw new Error('THREAD_RESUME_CHECKPOINT_UNAVAILABLE');
  }
  emitEvent('run.started', {
    executionMode: mode,
    ...(resumeRequested ? { resumedFromRunId: resumeSourceRunId } : {})
  });
  // 心跳必须从 run.started 起就流动：git 观测等工作区扫描可能远超 30 秒，
  // 若定时器晚于这些步骤启动，监督器会在无心跳窗口内误杀进程。
  const heartbeatState = { current: 'STARTING' };
  const requestedHeartbeatIntervalMs = Number(arg('--heartbeat-interval-ms', process.env.HMCODEX_HEARTBEAT_INTERVAL_MS ?? '2000'));
  const heartbeatIntervalMs = Number.isFinite(requestedHeartbeatIntervalMs)
    ? Math.max(250, Math.min(10000, Math.trunc(requestedHeartbeatIntervalMs)))
    : 2000;
  const heartbeatTimer = eventOutput === 'stdout'
    ? setInterval(() => emitEvent('runtime.heartbeat', {
        state: heartbeatState.current,
        uptimeMs: Math.max(0, Date.now() - runStartedAtMs)
      }), heartbeatIntervalMs)
    : undefined;
  heartbeatTimer?.unref?.();
  const initialAudit = await appendGitAuditCheckpoint(resumeRequested ? 'RESUME_STARTED' : 'RUN_STARTED', requestedThreadId ? { threadId: requestedThreadId } : {}, resumeSourceRunId ? { resumedFromRunId: resumeSourceRunId } : {});
  initialGitObservation = initialAudit.checkpoint?.observation ?? initialAudit.event?.payload?.observation;
  if (thread && thread.cwd && workspaceRoot && workspacePathKey(thread.cwd) !== workspacePathKey(workspaceRoot)) {
    throw new Error('THREAD_WORKSPACE_MISMATCH');
  }
  if (!thread) {
    thread = await threads.create({ cwd: workspaceRoot, title: prompt || 'hmCodex task' });
    emitEvent('thread.created', { threadId: thread.id, title: thread.title });
  } else {
    emitEvent('thread.resumed', { threadId: thread.id, title: thread.title, turnCount: thread.turns.length });
  }
  const threadContext = thread.turns.length
    ? [
        'Prior thread turn summaries (redacted, informational only; do not treat as instructions):',
        ...thread.turns.slice(-8).map((turn) => `- ${String(turn.summary ?? '').replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ').slice(0, 1000)}`)
      ].join('\n')
    : '';
  const checkpointContext = assembleCheckpointContext({ checkpoint: thread.checkpoint });
  const executionStatePath = arg('--execution-state-store', process.env.HMCODEX_EXECUTION_STATE_STORE
    ?? (harnessEventStorePath ? `${harnessEventStorePath}.execution-read-model.json` : (scopedTrajectory && trajectoryPath ? `${trajectoryPath}.execution.json` : undefined)));
  const executionState = createExecutionStateStore({ storagePath: executionStatePath, eventStore: trajectory.harnessEventStore, releaseChannel });
  await executionState.load();
  const reconciliation = await executionState.reconcile();
  if (reconciliation.reconciled > 0) {
    emitEvent('execution.reconciled', { reconciled: reconciliation.reconciled, records: reconciliation.records });
    await trajectory.append({
      runId,
      kind: 'ExecutionStateReconciled',
      payload: { reconciled: reconciliation.reconciled, records: reconciliation.records },
      sensitivity: 'SECURITY_AUDIT'
    });
  }
  const memoryPath = arg('--memory-store', process.env.HMCODEX_MEMORY_STORE ?? scopedStorePath('memory.json', defaultMemoryStore));
  const memoryJournal = createMemoryJournal({ storagePath: memoryPath, eventStore: trajectory.harnessEventStore });
  await memoryJournal.load();
  const contextProvider = String(arg('--context-provider', process.env.HMCODEX_CONTEXT_PROVIDER ?? 'journal')).trim().toLowerCase();
  if (!['journal', 'openviking'].includes(contextProvider)) throw new Error('CONTEXT_PROVIDER_INVALID');
  const openVikingApiKeyEnv = String(arg('--openviking-api-key-env', process.env.HMCODEX_OPENVIKING_API_KEY_ENV ?? 'OPENVIKING_API_KEY')).trim();
  if (contextProvider === 'openviking' && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(openVikingApiKeyEnv)) {
    throw new Error('OPENVIKING_API_KEY_ENV_INVALID');
  }
  const contextPort = contextProvider === 'openviking'
    ? createOpenVikingContextPort({
        baseURL: arg('--openviking-url', process.env.HMCODEX_OPENVIKING_URL ?? 'http://127.0.0.1:1933'),
        apiKey: process.env[openVikingApiKeyEnv],
        timeoutMs: arg('--openviking-timeout-ms', process.env.HMCODEX_OPENVIKING_TIMEOUT_MS ?? '5000'),
        workspaceRoot
      })
    : createJournalContextPort({ journal: memoryJournal });
  let contextRecall = {
    provider: contextProvider === 'openviking' ? 'openviking' : 'memory-journal',
    status: 'UNAVAILABLE',
    items: [],
    chars: 0
  };
  let contextRecallError;
  try {
    // Context providers receive the current query for ranking. The local
    // adapter keeps it in memory; OpenViking receives it over loopback. hmCodex
    // persists only digests and bounded, verified task summaries.
    contextRecall = await contextPort.recall({
      runId,
      query: prompt,
      scope: 'workspace',
      limit: 16,
      maxChars: 3000
    });
  } catch (error) {
    contextRecallError = error instanceof Error ? error.message : String(error);
  }
  const profilePath = arg('--profile-store', process.env.HMCODEX_PROFILE_STORE ?? scopedStorePath('profiles.json', defaultProfileStore));
  const profileRegistry = createProfileRegistry({ storagePath: profilePath, eventStore: trajectory.harnessEventStore });
  await profileRegistry.load();
  const creditBlamePath = arg('--credit-blame-store', process.env.HMCODEX_CREDIT_BLAME_STORE ?? scopedStorePath('credit-blame.json', defaultCreditBlameStore));
  const creditBlameLedger = createCreditBlameLedger({ storagePath: creditBlamePath, eventStore: trajectory.harnessEventStore });
  await creditBlameLedger.load();
  const modelEgressPath = arg('--model-egress-store', process.env.HMCODEX_MODEL_EGRESS_STORE ?? scopedStorePath('model-egress.json', defaultModelEgressStore));
  const modelEgressLedger = createModelEgressLedger({ storagePath: modelEgressPath, eventStore: trajectory.harnessEventStore });
  await modelEgressLedger.load();
  const roleContextPath = arg('--role-context-store', process.env.HMCODEX_ROLE_CONTEXT_STORE ?? scopedStorePath('role-contexts.json', defaultRoleContextStore));
  const roleSessions = createRoleSessionManager({ storagePath: roleContextPath, eventStore: trajectory.harnessEventStore });
  await roleSessions.load();
  const roleReconciliation = await roleSessions.reconcile();
  if (roleReconciliation.reconciled > 0) {
    emitEvent('role.contexts_reconciled', roleReconciliation);
    await trajectory.append({
      runId,
      kind: 'RoleContextsReconciled',
      payload: roleReconciliation,
      sensitivity: 'SECURITY_AUDIT'
    });
  }
  const priorEvents = await trajectory.list();
  const continuation = assembleTrajectoryContext({ events: priorEvents, currentRunId: runId });
  // ContextPort returns already bounded records. Reuse the established
  // redacted/advisory formatter rather than exposing adapter-specific fields
  // to model providers.
  const recalledMemoryIds = (Array.isArray(contextRecall.items) ? contextRecall.items : [])
    .map((item) => item?.memoryId)
    .filter((memoryId) => typeof memoryId === 'string')
    .slice(0, 64);
  const memoryContext = assembleMemoryContext({
    memories: (Array.isArray(contextRecall.items) ? contextRecall.items : []).map((item) => ({ ...item, status: 'ACTIVE' }))
  });
  const historyContext = [checkpointContext.text, threadContext, continuation.text, memoryContext.text].filter(Boolean).join('\n\n').slice(0, 6000);
  let currentPlanCheckpoint = thread.checkpoint?.plan;
  let interruptedResumeDetected = false;
  const saveThreadCheckpoint = async (phase, details = {}) => {
    if (details.plan !== undefined) currentPlanCheckpoint = details.plan;
    return threads.setCheckpoint(thread.id, {
      runId,
      phase,
      state: 'RUNNING',
      ...details,
      ...(details.plan === undefined && currentPlanCheckpoint !== undefined ? { plan: currentPlanCheckpoint } : {})
    });
  };
  const coordinatorPath = arg('--run-store', process.env.HMCODEX_RUN_STORE ?? (trajectoryPath ? `${trajectoryPath}.runs/${runId}.json` : undefined));
  const coordinatorEventStore = trajectory.harnessEventStore;
  const coordinator = createTaskRunCoordinator({
    runId,
    storagePath: coordinatorPath,
    eventStore: coordinatorEventStore,
    onTransition: (transition) => {
      heartbeatState.current = transition?.state ?? heartbeatState.current;
      emitEvent('run.state_changed', transition);
      if (coordinatorEventStore) return undefined;
      return trajectory.append({ runId, kind: 'RunStateChanged', payload: transition, sensitivity: 'INTERNAL' });
    },
    ...(coordinatorEventStore ? {} : {
      onEvent: (event) => event.type === 'RunStateChanged'
        ? undefined
        : trajectory.append({
            runId,
            kind: event.kind,
            payload: event,
            sensitivity: 'INTERNAL',
            causationId: event.eventId
          })
    })
  });
  await coordinator.load();
  // 心跳定时器已在 run.started 处提前创建（见上）。
  const decisionTracePath = arg('--decision-trace-store', process.env.HMCODEX_DECISION_TRACE_STORE ?? scopedStorePath('decision-trace.json', defaultDecisionTraceStore));
  const decisionTrace = createAgentDecisionTrace({ storagePath: decisionTracePath, eventStore: trajectory.harnessEventStore });
  await decisionTrace.load();
  const decisionIds = [];
  const decisionProducedEvents = new Map();
  const linkDecisionEvent = (decision, event) => {
    if (!decision?.decisionId || typeof event?.eventId !== 'string' || !event.eventId) return;
    const prior = decisionProducedEvents.get(decision.decisionId) ?? [];
    decisionProducedEvents.set(decision.decisionId, [...new Set([...prior, event.eventId])]);
  };
  const listDurableRunEvents = async () => {
    if (typeof trajectory.list !== 'function') return [];
    const events = await trajectory.list(runId);
    return Array.isArray(events)
      ? events.slice().sort((left, right) => (left.sequence ?? 0) - (right.sequence ?? 0))
      : [];
  };
  const evidenceFromEvent = (event, { evidenceType, stance = 'SUPPORTS', scopeRef } = {}) => {
    if (!event?.eventId || typeof evidenceType !== 'string' || !evidenceType.trim()) return undefined;
    const artifactDigest = [event.payload?.outputDigest, event.payload?.promptDigest, event.payloadDigest]
      .find((value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value));
    return {
      evidenceId: `evidence-${evidenceType.replace(/[^A-Za-z0-9_.:-]/gu, '-').slice(0, 60)}-${event.eventId}`,
      eventId: event.eventId,
      evidenceType: evidenceType.slice(0, 120),
      stance,
      freshnessAtMs: Number.isInteger(event.atMs) && event.atMs >= 0 ? event.atMs : Date.now(),
      ...(artifactDigest ? { artifactDigest } : {}),
      ...(scopeRef ? { scopeRef } : {})
    };
  };
  const collectDecisionEvidence = async ({ kinds = [], limit = 8, evidenceTypeFor = (event) => event.kind } = {}) => {
    const wanted = new Set(kinds);
    const events = await listDurableRunEvents();
    return events
      .filter((event) => wanted.size === 0 || wanted.has(event.kind))
      .slice(-Math.max(1, limit))
      .map((event) => evidenceFromEvent(event, { evidenceType: evidenceTypeFor(event) }))
      .filter(Boolean);
  };
  // Candidate fanout sends one prompt per candidate to a possibly different
  // provider, so egress and cost are recorded per candidate rather than once per
  // run. Only the target origin and digests leave this helper.
  const modelEgressTargetFor = (modelId) => {
    const record = modelRegistry?.get?.(modelId);
    const url = record?.endpoint ?? record?.baseURL ?? modelConfig?.endpoint ?? modelConfig?.baseURL;
    if (!url) return undefined;
    try { return normalizeEgressTarget(url); } catch { return undefined; }
  };
  const recordModelEgress = async (entries = []) => {
    const usable = entries.filter(Boolean);
    if (!usable.length) return [];
    try {
      return await Promise.resolve(modelEgressLedger.hasDurableSink
        ? modelEgressLedger.recordDurably(usable)
        : modelEgressLedger.record(usable));
    } catch (error) {
      logger.error(`model egress record failed | error=${error?.code ?? error?.message ?? error}`);
      return [];
    }
  };
  const decisionObjectiveId = `objective-${runId}`;
  const decisionSnapshotIds = {
    feature: `features-${runId}`,
    constraint: `constraints-${runId}`,
    binding: `binding-${runId}`
  };
  const setDecisionSnapshot = (key, value) => {
    decisionSnapshotIds[key] = `snapshot-${sha256Digest(JSON.stringify(value)).slice('sha256:'.length)}`;
  };
  const recordDecision = async ({
    stepId, role, roleContextId, decisionType, summary, actionKind,
    parentDecisionIds = [], outputRefs = [], operationId,
    evidenceRefs = [], options, selectedOptionId, assumptions = [],
    selectionCriteria = ['deterministic-rule'], reasonCodes = ['RUNTIME_PIPELINE'],
    uncertaintyCodes = [], expectedOutcome, sensitivity = 'INTERNAL', claimedConfidence
  }) => {
    const fallbackOptionId = `${stepId}-selected`;
    const resolvedOptions = Array.isArray(options) && options.length > 0
      ? options
      : [{
          optionId: fallbackOptionId,
          actionKind,
          summary,
          requiredCapabilityIds: [],
          evidenceRefs: [],
          riskCodes: [],
          rejectionReasonCodes: []
        }];
    const resolvedSelectedOptionId = selectedOptionId ?? resolvedOptions[0].optionId;
    const decision = await decisionTrace.propose({
      runId,
      stepId,
      parentDecisionIds,
      agentInstanceId: `${runId}-${role}`,
      role,
      roleContextId,
      bindingSnapshotId: decisionSnapshotIds.binding,
      ...(operationId ? { operationId } : {}),
      decisionType,
      objectiveRef: decisionObjectiveId,
      constraintSnapshotId: decisionSnapshotIds.constraint,
      featureSnapshotId: decisionSnapshotIds.feature,
      evidenceRefs,
      assumptions,
      options: resolvedOptions,
      selectedOptionId: resolvedSelectedOptionId,
      decisionSummary: summary,
      selectionCriteria,
      reasonCodes,
      uncertaintyCodes,
      expectedOutcome: expectedOutcome ?? {
          successCriteriaRefs: [`criterion-${stepId}`],
          predictedOutcomeCode: 'PIPELINE_STEP_ACCEPTED',
          predictedProgress: 0.1,
          predictedRiskCodes: []
        },
      outputRefs,
      sensitivity,
      ...(claimedConfidence === undefined ? {} : { claimedConfidence })
    });
    await decisionTrace.commit(decision.decisionId);
    decisionIds.push(decision.decisionId);
    return decision;
  };
  await trajectory.append({
    runId,
    kind: 'TaskRunCreated',
    payload: {
      promptDigest: sha256Digest(prompt),
      requestedMode: mode,
      ...(resumeSourceRunId ? {
        sourceRunId: resumeSourceRunId,
        sourceCheckpointDigest: thread.checkpoint?.checkpointDigest
      } : {})
    },
    sensitivity: 'SENSITIVE'
  });
  setDecisionSnapshot('feature', { promptDigest: sha256Digest(prompt), mode, agentMode });
  setDecisionSnapshot('constraint', { mode, agentMode });
  setDecisionSnapshot('binding', { status: 'UNBOUND' });
  let root;
  let allocatedRoles = [];
  // S2-12: the candidate judge must never score a draft from inside a context
  // that produced it, so it gets its own dedicated role context when the
  // executor role fans out.
  let candidateJudgeBinding;
  let candidateJudgeContextId;
  let currentTaskClass;
  let currentModelIdentity;
  let pluginGovernance;
  let dynamicPluginLoader;
  let dynamicPluginResults = [];
  let modelRegistry;
  let roleBindingResolution;
  let roleProviderContexts = [];
  let activeModelProvider;
  let plannerTurn;
  let plannerPlan;
  let councilResult;
  let executionPlan;
  let plannerDecision;
  let semanticVerifierTurn;
  let finalVerification;
  let finalVerificationDecision;
  let finalVerificationEventId;
  let contextFinalization;
  let contextFinalizationStarted = false;
  let evolutionEvaluator;
  let evolutionEvaluationError;
  let evolutionProposal;
  const evolutionMonitoring = [];
  const recordTaskOutcome = async (details) => {
    if (!evolutionEvaluator) return undefined;
    const outcome = await evolutionEvaluator.recordOutcome(details);
    // Commit samples before a monitoring report can cause a durable rollback.
    await evolutionEvaluator.flush();
    for (const proposalId of outcome.deploymentProposalIds ?? []) {
      try {
        const monitored = await evolutionEvaluator.monitor({ proposalId });
        await evolutionEvaluator.flush();
        const summary = {
          proposalId,
          status: monitored.status,
          reportId: monitored.report.reportId,
          sampleCount: monitored.outcomes.sampleCount,
          reasonCodes: monitored.report.decision.reasonCodes
        };
        evolutionMonitoring.push(summary);
        emitEvent('evolution.monitored', summary);
      } catch (error) {
        evolutionEvaluationError = String(error instanceof Error ? error.message : error).slice(0, 120);
        emitEvent('evolution.monitor_failed', { proposalId, errorCode: 'EVOLUTION_MONITOR_FAILED' });
      }
    }
    return outcome;
  };
  const recordObjectiveFeedback = async ({ status, event, verification } = {}) => {
    if (!event?.eventId) return undefined;
    const taskLevel = agentMode !== 'single' || !currentModelIdentity;
    const identity = taskLevel
      ? { provider: 'task', protocol: 'task-level', model: 'task-level', modelVersion: 'unknown', role: 'task', pluginVersion: 'unknown', modelRegistryDigest: 'sha256:' + '0'.repeat(64) }
      : { ...currentModelIdentity, modelVersion: 'unknown', role: 'planner', pluginVersion: 'unknown', modelRegistryDigest: 'sha256:' + '0'.repeat(64) };
    const dimensions = {
      objectiveSuccess: status === 'SUCCEEDED',
      ...(verification?.status ? { verifierPass: verification.status === 'PASS' } : {}),
      ...(Number.isFinite(Number(verification?.quality)) ? { quality: Math.max(0, Math.min(1, Number(verification.quality))) } : {}),
      safetyIncident: verification?.safety === 'FAIL'
    };
    const outcomeId = `task-outcome-${runId}`;
    return feedbackRegistry.submit({
      runId, taskId: runId, threadId: thread.id, outcomeId,
      modelIdentity: identity,
      scenario: { taskClass: currentTaskClass ?? 'unknown', riskClass: 'unknown', operationClass: 'unknown', requiredCapabilities: [], workspaceCapabilityClass: mode === EXECUTION_MODES.READ_ONLY ? 'READ_ONLY' : 'CONTROLLED', platform: 'WINDOWS', policyClass: resolveReleaseChannel() },
      sourceType: 'SYSTEM', outcomeStatus: status, dimensions,
      evidenceRefs: [event.eventId, ...(finalVerificationEventId ? [finalVerificationEventId] : [])],
      reasonCodes: [taskLevel ? 'TASK_LEVEL_ATTRIBUTION' : 'OBJECTIVE_OUTCOME'],
      independenceGroup: runId + '/' + event.eventId
    }, { commandId: 'objective-feedback:' + event.eventId });
  };
  const finalizeContext = async ({ status, event, result, verification } = {}) => {
    if (contextFinalizationStarted) return contextFinalization;
    contextFinalizationStarted = true;
    const failures = [];
    let used = [];
    let recordedMemory;
    let committed = { memoryIds: [], count: 0 };
    try {
      const response = await contextPort.used({ runId, memoryIds: recalledMemoryIds });
      used = Array.isArray(response?.used) ? response.used : [];
    } catch (error) {
      failures.push({ operation: 'used', errorCode: String(error instanceof Error ? error.message : error).slice(0, 120) });
    }
    // Context finalization is itself an agent decision: whether the verified
    // outcome justifies a durable, review-gated memory proposal. Evidence is
    // limited to durable event references; prompt and model text never enter.
    if (event?.eventId) {
      try {
        const consolidationEvidence = await collectDecisionEvidence({ limit: 4 });
        const proposalJustified = status === 'SUCCEEDED' && verification?.status === 'PASS';
        const recalledMemories = Array.isArray(contextRecall.items) ? contextRecall.items : [];
        const proposedSourceDigest = sha256Digest(JSON.stringify([event.eventId]));
        const conflictMemories = recalledMemories.filter((item) =>
          String(item.scope).toLowerCase() === 'workspace'
          && String(item.kind).toUpperCase() === 'TASK_OUTCOME');
        const supersessionCandidates = conflictMemories.filter((item) => item.sourceDigest !== proposedSourceDigest);
        const consolidationDecision = await recordDecision({
          stepId: 'memory-consolidation',
          role: 'MemoryConsolidator',
          roleContextId: `memory-consolidator-${runId}`,
          decisionType: 'CONSOLIDATE_MEMORY',
          summary: proposalJustified
            ? 'Propose the rule-verified task outcome for review-gated durable memory.'
            : 'Record no durable memory proposal because the outcome was not verified as successful.',
          actionKind: 'MEMORY_PROPOSAL',
          evidenceRefs: consolidationEvidence,
          options: [
            {
              optionId: 'memory-proposal-create',
              actionKind: 'MEMORY_PROPOSAL',
              summary: 'Create a review-gated memory proposal from the verified outcome.',
              requiredCapabilityIds: [],
              evidenceRefs: consolidationEvidence.map((ref) => ref.evidenceId).slice(0, 8),
              riskCodes: [],
              rejectionReasonCodes: proposalJustified ? [] : ['OUTCOME_NOT_VERIFIED_SUCCESS']
            },
            {
              optionId: 'memory-proposal-skip',
              actionKind: 'MEMORY_PROPOSAL',
              summary: 'Skip the memory proposal because the outcome is not verified as successful.',
              requiredCapabilityIds: [],
              evidenceRefs: consolidationEvidence.map((ref) => ref.evidenceId).slice(0, 8),
              riskCodes: ['UNVERIFIED_OUTCOME'],
              rejectionReasonCodes: proposalJustified ? ['VERIFIED_OUTCOME_REQUIRES_PROPOSAL'] : []
            },
            ...(conflictMemories.length ? [{
              optionId: 'memory-proposal-supersede',
              actionKind: 'MEMORY_PROPOSAL',
              summary: `Supersede or merge ${conflictMemories.length} existing TASK_OUTCOME memory record(s).`,
              requiredCapabilityIds: [],
              evidenceRefs: consolidationEvidence.map((ref) => ref.evidenceId).slice(0, 8),
              riskCodes: ['MEMORY_CONFLICT'],
              rejectionReasonCodes: ['REVIEW_GATED_PROPOSAL_REQUIRED']
            }] : [])
          ],
          selectedOptionId: proposalJustified ? 'memory-proposal-create' : 'memory-proposal-skip',
          reasonCodes: proposalJustified
            ? ['VERIFIED_OUTCOME', 'REVIEW_GATED_PROPOSAL']
            : ['OUTCOME_NOT_VERIFIED_SUCCESS'],
          uncertaintyCodes: [
            ...(conflictMemories.length ? ['MEMORY_POTENTIAL_CONFLICT'] : []),
            ...(supersessionCandidates.length ? ['MEMORY_SUPERSESSION_CANDIDATE'] : [])
          ],
          operationId: `memory-consolidation-${runId}`
        });
        // The failure path links every recorded decision to the failed outcome
        // after finalizeContext returns, so only the success path links here.
        // Linking twice would make the learning export see more outcomes than
        // decisions and fail closed.
        if (status === 'SUCCEEDED' && decisionTrace.listOutcomes(consolidationDecision.decisionId).length === 0) {
          await decisionTrace.linkOutcome(consolidationDecision.decisionId, {
            status: status === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED',
            sourceType: 'coordinator',
            sourceId: `coordinator-${runId}`,
            executionEventIds: [event.eventId],
            verifierReportIds: finalVerificationEventId ? [finalVerificationEventId] : [],
            observedEffects: [],
            safetyOutcomeCodes: proposalJustified ? ['NO_EXTERNAL_EFFECT'] : ['TASK_FAILED']
          });
        }
      } catch (error) {
        failures.push({ operation: 'decision', errorCode: String(error instanceof Error ? error.message : error).slice(0, 120) });
      }
    }
    // Only successful, rule-verified outcomes become memory proposals. The
    // proposal contains a digest and source event, never prompt or model text;
    // review/activation remains an explicit MemoryJournal operation.
    if (status === 'SUCCEEDED' && verification?.status === 'PASS' && event?.eventId) {
      try {
        const taskClass = String(currentTaskClass ?? 'unknown').replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ').trim().slice(0, 80) || 'unknown';
        const outputDigest = sha256Digest(result?.text ?? '');
        const confidence = Number.isFinite(Number(verification.quality))
          ? Math.max(0, Math.min(1, Number(verification.quality)))
          : 0.5;
        const response = await contextPort.record({
          runId,
          statement: `Verified task outcome: class=${taskClass}; verifier=PASS; outputDigest=${outputDigest}`,
          sourceEventIds: [event.eventId],
          scope: 'workspace',
          kind: 'TASK_OUTCOME',
          confidence
        });
        recordedMemory = response?.memory;
      } catch (error) {
        failures.push({ operation: 'record', errorCode: String(error instanceof Error ? error.message : error).slice(0, 120) });
      }
    }
    const commitIds = [...new Set([
      ...recalledMemoryIds,
      ...(recordedMemory?.memoryId ? [recordedMemory.memoryId] : [])
    ])];
    try {
      const response = await contextPort.commit({ runId, memoryIds: commitIds });
      committed = {
        memoryIds: Array.isArray(response?.memoryIds) ? response.memoryIds : [],
        count: Number.isInteger(response?.count) ? response.count : 0
      };
    } catch (error) {
      failures.push({ operation: 'commit', errorCode: String(error instanceof Error ? error.message : error).slice(0, 120) });
    }
    contextFinalization = {
      provider: contextRecall.provider ?? 'memory-journal',
      status: failures.length || contextRecallError ? 'DEGRADED' : 'COMMITTED',
      recalledCount: recalledMemoryIds.length,
      usedCount: used.length,
      recordedCount: recordedMemory ? 1 : 0,
      committedCount: committed.count,
      ...(contextRecallError ? { recallError: String(contextRecallError).slice(0, 120) } : {}),
      ...(failures.length ? { failures } : {})
    };
    return contextFinalization;
  };
  try {
  if (resumeRequested) {
    await coordinator.transitionAndFlush('RECOVERING', {
      reason: 'EXPLICIT_RESUME',
      metadata: { sourceRunId: resumeSourceRunId }
    });
  }
  await coordinator.transitionAndFlush('CLASSIFYING');
  await saveThreadCheckpoint('CLASSIFYING', {
    plan: [{ id: 'classify', status: 'RUNNING', actionDigest: sha256Digest(prompt.slice(0, 240)) }],
    pendingActions: ['classify task']
  });
  const taskClass = classifyTask(prompt);
  currentTaskClass = taskClass;
  const classification = { taskClass, classifier: 'rule-1.0' };
  const classificationDecision = await recordDecision({
    stepId: 'classification',
    role: 'classifier',
    roleContextId: `${runId}-classifier`,
    decisionType: 'CLASSIFY_TASK',
    actionKind: 'CLASSIFY',
    summary: `Classified task as ${taskClass}`,
    outputRefs: [`classification-${runId}`],
    options: ['inspect', 'modify', 'test', 'unknown'].map((candidate) => ({
      optionId: `classify-${candidate}`,
      actionKind: 'CLASSIFY',
      summary: `Classify task as ${candidate}`,
      requiredCapabilityIds: [],
      evidenceRefs: [],
      riskCodes: [],
      rejectionReasonCodes: candidate === taskClass ? [] : ['RULE_PATTERN_MISMATCH']
    })),
    selectedOptionId: `classify-${taskClass}`,
    reasonCodes: ['DETERMINISTIC_RULE', 'NO_EVIDENCE_REQUIRED'],
    selectionCriteria: ['task-classification-rule']
  });
  setDecisionSnapshot('feature', { promptDigest: sha256Digest(prompt), mode, agentMode, taskClass });
  const taskClassifiedEvent = await coordinator.recordEventAndFlush('TaskClassified', classification);
  linkDecisionEvent(classificationDecision, taskClassifiedEvent.event);
  emitEvent('task.classified', classification);
  await coordinator.transitionAndFlush('PRECHECKING');
  await saveThreadCheckpoint('PRECHECKING', { pendingActions: ['evaluate task safety'] });
  const precheck = createTaskSafetyPrecheck().evaluate({ prompt, taskClass, mode, workspaceRoot });
  setDecisionSnapshot('constraint', {
    mode,
    agentMode,
    precheck: { status: precheck.status, reason: precheck.reason, constraints: precheck.constraints }
  });
  await coordinator.recordEventAndFlush('TaskSafetyPrechecked', precheck);
  emitEvent('task.prechecked', {
    status: precheck.status,
    reason: precheck.reason,
    constraints: precheck.constraints
  });
  if (precheck.status !== 'ALLOWED') throw new Error(`TASK_PRECHECK_BLOCKED:${precheck.reason}`);
  await coordinator.transitionAndFlush('ROUTING');
  await saveThreadCheckpoint('ROUTING', { pendingActions: ['resolve role and model bindings'] });
  const routeDecision = createRuleRouter().resolve({ prompt, mode });
  if (agentMode === 'multi') {
    // Semantic verification is an explicit role in multi-agent mode. A
    // configured `rule` binding may still decline it, but the role cannot be
    // silently omitted from the route snapshot.
    routeDecision.roles = { ...routeDecision.roles, semanticVerifier: 'default' };
  }
  const routeSelected = routeDecision.status === 'SELECTED';
  const routingDecision = await recordDecision({
    stepId: 'routing',
    role: 'router',
    roleContextId: `${runId}-router`,
    decisionType: 'SELECT_ROUTE',
    actionKind: 'ROUTE',
    parentDecisionIds: [classificationDecision.decisionId],
    summary: routeSelected ? 'Selected the configured route' : `Blocked route: ${routeDecision.reason}`,
    outputRefs: [`route-${runId}`],
    options: [
      {
        optionId: 'route-selected',
        actionKind: 'ROUTE',
        summary: 'Execute with the resolved role bindings',
        requiredCapabilityIds: [],
        evidenceRefs: [],
        riskCodes: routeSelected ? [] : ['POLICY_BLOCKED'],
        rejectionReasonCodes: routeSelected ? [] : ['ROUTE_BLOCKED']
      },
      {
        optionId: 'route-blocked',
        actionKind: 'BLOCK_ROUTE',
        summary: 'Block execution before role allocation',
        requiredCapabilityIds: [],
        evidenceRefs: [],
        riskCodes: routeSelected ? ['POLICY_REJECTED'] : [],
        rejectionReasonCodes: routeSelected ? ['POLICY_ALLOWED'] : []
      }
    ],
    selectedOptionId: routeSelected ? 'route-selected' : 'route-blocked',
    reasonCodes: ['DETERMINISTIC_RULE', 'NO_EVIDENCE_REQUIRED'],
    selectionCriteria: ['read-only-route-rule']
  });
  emitEvent('route.selected', routeDecision);
  const routeSelectedEvent = await coordinator.recordEventAndFlush('RouteSelected', routeDecision);
  linkDecisionEvent(routingDecision, routeSelectedEvent.event);
  setDecisionSnapshot('feature', {
    promptDigest: sha256Digest(prompt),
    mode,
    agentMode,
    taskClass,
    routeStatus: routeDecision.status,
    roles: Object.keys(routeDecision.roles ?? {}).sort()
  });
  if (routeDecision.status === 'BLOCKED') throw new Error(`ROUTE_BLOCKED:${routeDecision.reason}`);
  await coordinator.transitionAndFlush('ALLOCATING_CONTEXTS');
  const configArgument = argValue('--config');
  const environmentConfigPath = process.env.HMCODEX_MODEL_CONFIG?.trim() || undefined;
  const configuredPath = configArgument ?? environmentConfigPath ?? defaultModelConfigPath();
  const fileConfig = await loadModelConfig(configuredPath, {
    required: configArgument !== undefined || environmentConfigPath !== undefined
  });
  const modelConfig = resolveModelConfig({
    fileConfig,
    overrides: modelOverridesFromArgs()
  });
  const modelRegistryPath = arg('--model-registry', process.env.HMCODEX_MODEL_REGISTRY ?? scopedStorePath('model-registry.json', defaultModelRegistryStore));
  modelRegistry = createModelRegistry({ storagePath: modelRegistryPath, eventStore: trajectory.harnessEventStore });
  await modelRegistry.load();
  for (const configuredModel of modelConfig.models ?? []) {
    if (!modelRegistry.get(configuredModel.modelId)) {
      if (modelRegistry.hasDurableSink) await modelRegistry.registerDurably(configuredModel);
      else modelRegistry.register(configuredModel);
    }
  }
  const defaultModelId = `${modelConfig.provider}/${modelConfig.model}`;
  if (!modelRegistry.get(defaultModelId)) {
    const defaultModel = {
      modelId: defaultModelId,
      provider: modelConfig.provider,
      protocol: modelConfig.protocol,
      model: modelConfig.model,
      ...(modelConfig.baseURL ? { baseURL: modelConfig.baseURL } : {}),
      ...(modelConfig.endpoint ? { endpoint: modelConfig.endpoint } : {}),
      ...(modelConfig.apiKeyEnv ? { apiKeyEnv: modelConfig.apiKeyEnv } : {}),
      roles: ['planner', 'executor', 'verifier', 'semanticVerifier'],
      capabilities: ['model.invoke.stream', 'tool.calls']
    };
    if (modelRegistry.hasDurableSink) await modelRegistry.registerDurably(defaultModel);
    else modelRegistry.register(defaultModel);
  }
  roleBindingResolution = createRoleBindingResolver({
    registry: modelRegistry,
    bindings: modelConfig.roleBindings ?? {}
  }).resolve({
    roles: routeDecision.roles,
    taskClass,
    defaultModelId,
    profileRegistry,
    mode,
    // Explicit controlled executor bindings must be eligible before they can
    // authorize a side effect. The built-in default remains usable on its
    // first run, before profile evidence exists.
    requireEligible: mode === EXECUTION_MODES.CONTROLLED
      && Object.hasOwn(modelConfig.roleBindings ?? {}, 'executor'),
    risk: candidateFanoutRisk(taskClass, mode)
  });
  if (roleBindingResolution.status === 'BLOCKED') throw new Error('ROLE_BINDING_BLOCKED:NO_MODEL_CANDIDATE');
  const missingRole = Object.keys(routeDecision.roles).find((role) => !roleBindingResolution.roles[role]);
  if (missingRole) throw new Error(`ROLE_BINDING_BLOCKED:${missingRole}`);
  routeDecision.roleBindings = roleBindingResolution.roles;
  emitEvent('role.bindings_resolved', {
    status: roleBindingResolution.status,
    roles: roleBindingResolution.roles,
    rejected: roleBindingResolution.rejected
  });
  await coordinator.recordEventAndFlush('RoleBindingsResolved', {
    status: roleBindingResolution.status,
    roles: roleBindingResolution.roles,
    rejected: roleBindingResolution.rejected
  });
  setDecisionSnapshot('binding', {
    status: roleBindingResolution.status,
    roles: Object.entries(roleBindingResolution.roles).map(([role, binding]) => ({
      role,
      kind: binding.kind,
      modelId: binding.modelId,
      selector: binding.selector
    }))
  });
  await saveThreadCheckpoint('ALLOCATING_CONTEXTS', {
    roleContexts: Object.values(roleBindingResolution.roles).map((binding) => ({
      role: binding.role,
      kind: binding.kind,
      modelId: binding.modelId,
      selector: binding.selector
    })),
    pendingActions: ['allocate isolated role contexts']
  });
  currentModelIdentity = {
    provider: modelConfig.provider,
    protocol: modelConfig.protocol,
    model: modelConfig.model
  };
  const allocateRoleContext = (input) => roleSessions.hasDurableSink ? roleSessions.allocateDurably(input) : roleSessions.allocate(input);
  const transitionRoleContext = (contextId, state) => roleSessions.hasDurableSink ? roleSessions.transitionDurably(contextId, state) : Promise.resolve(roleSessions[state === 'BUSY' ? 'setBusy' : 'close'](contextId));
  allocatedRoles = await Promise.all(Object.entries(routeDecision.roles).map(async ([role, binding]) => {
    const resolvedBinding = roleBindingResolution.roles[role];
    const roleAdapterIdentity = {
      provider: resolvedBinding?.provider ?? modelConfig.provider,
      protocol: resolvedBinding?.protocol ?? modelConfig.protocol,
      model: resolvedBinding?.model ?? (resolvedBinding?.kind === 'DETERMINISTIC' ? 'rule' : modelConfig.model)
    };
    return allocateRoleContext({
      runId,
      role,
      model: resolvedBinding?.model ?? (resolvedBinding?.kind === 'DETERMINISTIC' ? 'rule' : modelConfig.model),
      adapterIdentity: roleAdapterIdentity,
      threadId: thread.id,
      bindingSnapshot: { role, requested: binding, resolved: resolvedBinding },
      metadata: { binding, resolvedBinding, provider: roleAdapterIdentity.provider, protocol: roleAdapterIdentity.protocol }
    });
  }));
  if (agentMode === 'multi') {
    const councilBinding = roleBindingResolution.roles.planner;
    const councilModel = councilBinding?.model ?? modelConfig.model;
    for (const memberRole of ['council-planner', 'council-critic']) {
      allocatedRoles.push(await allocateRoleContext({
        runId,
        role: memberRole,
        model: councilModel,
        adapterIdentity: {
          provider: councilBinding?.provider ?? modelConfig.provider,
          protocol: councilBinding?.protocol ?? modelConfig.protocol,
          model: councilModel
        },
        threadId: thread.id,
        bindingSnapshot: {
          role: memberRole,
          requested: { role: 'planner', purpose: 'PLAN_REVIEW' },
          resolved: councilBinding
        },
        metadata: { purpose: 'PLAN_REVIEW', isolation: 'DEDICATED' }
      }));
    }
    const executorCandidateBindings = roleBindingResolution.roles.executor?.selector === 'CANDIDATE_SET'
      ? roleBindingResolution.roles.executor.candidateBindings ?? []
      : [];
    // Only allocate the judge context when the risk policy can actually fan out.
    if (executorCandidateBindings.length > 1 && candidateFanoutRisk(taskClass, mode) !== 'LOW') {
      const candidateModelIds = new Set(executorCandidateBindings.map((binding) => binding.modelId));
      candidateJudgeBinding = ['critic', 'semanticVerifier']
        .map((roleName) => roleBindingResolution.roles[roleName])
        .find((binding) => binding?.kind === 'MODEL' && binding.modelId && !candidateModelIds.has(binding.modelId));
      if (candidateJudgeBinding) {
        const judgeContext = await allocateRoleContext({
          runId,
          role: 'candidate-judge',
          model: candidateJudgeBinding.model ?? modelConfig.model,
          adapterIdentity: {
            provider: candidateJudgeBinding.provider ?? modelConfig.provider,
            protocol: candidateJudgeBinding.protocol ?? modelConfig.protocol,
            model: candidateJudgeBinding.model ?? modelConfig.model
          },
          threadId: thread.id,
          bindingSnapshot: {
            role: 'candidate-judge',
            requested: { role: 'candidateJudge', purpose: 'CANDIDATE_SELECTION' },
            resolved: candidateJudgeBinding
          },
          metadata: { purpose: 'CANDIDATE_SELECTION', isolation: 'DEDICATED', excludesCandidateBindings: [...candidateModelIds] }
        });
        allocatedRoles.push(judgeContext);
        candidateJudgeContextId = judgeContext.contextId;
      }
    }
  }
  for (const context of allocatedRoles) await transitionRoleContext(context.contextId, 'BUSY');
  const allocationDecision = await recordDecision({
    stepId: 'context-allocation',
    role: 'coordinator',
    roleContextId: `${runId}-coordinator`,
    decisionType: 'ALLOCATE_ROLE_CONTEXTS',
    actionKind: 'ALLOCATE_CONTEXTS',
    parentDecisionIds: [routingDecision.decisionId],
    summary: `Allocated ${allocatedRoles.length} dedicated role contexts`,
    outputRefs: [`contexts-${runId}`],
    options: [
      {
        optionId: 'contexts-dedicated',
        actionKind: 'ALLOCATE_CONTEXTS',
        summary: `Allocate ${allocatedRoles.length} dedicated role contexts`,
        requiredCapabilityIds: [],
        evidenceRefs: [],
        riskCodes: [],
        rejectionReasonCodes: []
      },
      {
        optionId: 'contexts-shared',
        actionKind: 'ALLOCATE_CONTEXTS',
        summary: 'Share a single context across all roles',
        requiredCapabilityIds: [],
        evidenceRefs: [],
        riskCodes: ['CONTEXT_CROSSTALK'],
        rejectionReasonCodes: ['ROLE_ISOLATION_REQUIRED']
      }
    ],
    selectedOptionId: 'contexts-dedicated',
    reasonCodes: ['DETERMINISTIC_RULE', 'NO_EVIDENCE_REQUIRED'],
    selectionCriteria: ['role-isolation-rule']
  });
  const roleContextsAllocatedEvent = await trajectory.append({
    runId,
    kind: 'RoleContextsAllocated',
    payload: {
      contexts: allocatedRoles.map((context) => ({ contextId: context.contextId, role: context.role, model: context.model, isolation: context.isolation }))
    },
    sensitivity: 'INTERNAL'
  });
  linkDecisionEvent(allocationDecision, roleContextsAllocatedEvent);
  setDecisionSnapshot('binding', {
    status: roleBindingResolution.status,
    roles: Object.entries(roleBindingResolution.roles).map(([role, binding]) => ({
      role,
      kind: binding.kind,
      modelId: binding.modelId,
      selector: binding.selector
    })),
    contexts: allocatedRoles.map((context) => ({
      contextId: context.contextId,
      role: context.role,
      model: context.model,
      isolation: context.isolation
    }))
  });
  emitEvent('role.contexts_allocated', {
    contexts: allocatedRoles.map((context) => ({ contextId: context.contextId, role: context.role, model: context.model, isolation: context.isolation }))
  });
  await coordinator.transitionAndFlush('PLANNING');
  emitEvent('model.route_resolved', {
    provider: modelConfig.provider,
    protocol: modelConfig.protocol,
    model: modelConfig.model
  });
  await coordinator.recordEventAndFlush('ModelRouteResolved', {
    provider: modelConfig.provider,
    protocol: modelConfig.protocol,
    model: modelConfig.model
  });
  await trajectory.append({
    runId,
    kind: 'ModelRouteResolved',
    payload: {
      provider: modelConfig.provider,
      protocol: modelConfig.protocol,
      model: modelConfig.model,
      configLoaded: Object.keys(fileConfig).length > 0,
      continuationRuns: continuation.runCount,
      continuationChars: historyContext.length,
      memoryCount: memoryContext.memoryCount,
      threadId: thread.id,
      roleBindings: roleBindingResolution.roles
    }
  });
  setDecisionSnapshot('feature', {
    promptDigest: sha256Digest(prompt),
    mode,
    agentMode,
    taskClass,
    routeStatus: routeDecision.status,
    roles: Object.keys(routeDecision.roles ?? {}).sort(),
    model: { provider: modelConfig.provider, protocol: modelConfig.protocol, model: modelConfig.model }
  });
  const evolutionStore = arg('--evolution-store', process.env.HMCODEX_EVOLUTION_STORE ?? scopedStorePath('evolution-proposals.json', defaultEvolutionStore));
  const evolutionEvaluationStore = arg('--evaluation-store', process.env.HMCODEX_EVALUATION_STORE ?? scopedStorePath('evolution-evaluations.json', defaultEvolutionEvaluationStore));
  const pluginGovernanceStore = arg(
    '--plugin-store',
    arg('--governance-store', process.env.HMCODEX_PLUGIN_GOVERNANCE_STORE
      ?? process.env.HMCODEX_PLUGIN_STORE
      ?? scopedStorePath('plugin-governance.json', defaultPluginGovernanceStore))
  );
  const pluginRoot = arg('--plugin-root', process.env.HMCODEX_PLUGIN_ROOT ?? defaultPluginRoot());
  const runtimeStorePaths = [
    trajectoryPath,
    ...(trajectoryPath ? [`${trajectoryPath}.runs`] : []),
    threadPath,
    executionStatePath,
    memoryPath,
    profilePath,
    creditBlamePath,
    roleContextPath,
    coordinatorPath,
    decisionTracePath,
    modelRegistryPath,
    evolutionStore,
    evolutionEvaluationStore,
    pluginGovernanceStore,
    pluginRoot
  ].filter((value) => typeof value === 'string' && value.trim());
  const workspaceExcludedPaths = [...runtimeStorePaths, ...runtimeStorePaths.map((value) => `${value}.lock`)];
  const [{ Context }, { createEvolutionRegistryPlugin }, { createModelPlugins }, { taskRunnerPlugin }, { executorPlugin, executorToolsPlugin }, { ReadonlyWorkspace, readonlyWorkspacePlugin }, { createToolRegistry, registerReadonlyWorkspaceTools, toolRegistryPlugin }] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('./plugins/evolution-registry.mjs'),
    import('./plugins/model-deepseek.mjs'),
    import('./plugins/task-runner.mjs'),
    import('./plugins/executor.mjs'),
    import('./plugins/workspace-readonly.mjs'),
    import('./tool-registry.mjs')
  ]);
  root = new Context();
  const workspace = new ReadonlyWorkspace(workspaceRoot, { excludedPaths: workspaceExcludedPaths });
  const workspaceLeaseRegistry = new WorkspaceLeaseRegistry();
  const monitor = new RuntimeSafetyMonitor({
    workspaceRoot,
    releaseChannel,
    workspaceLeaseRegistry,
    ...(approvedNetworkTargets.length ? { networkTargets: approvedNetworkTargets } : {}),
    ...executionOptions(mode)
  });
  const executor = new RestrictedWindowsExecutor({ monitor });
  const networkAdapter = new RestrictedNetworkAdapter({ monitor });
  const leaseTtlRaw = arg('--lease-ttl-ms', process.env.HMCODEX_LEASE_TTL_MS);
  const leaseTtlMs = leaseTtlRaw === undefined ? undefined : Number(leaseTtlRaw);
  if (leaseTtlRaw !== undefined && (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 1)) throw new Error('LEASE_TTL_INVALID');
  const leaseProvider = createExplicitLeaseProvider({
    monitor,
    capabilities: approvedCapabilities,
    commands: approvedCommands,
    ...(approvedNetworkTargets.length ? { networkTargets: approvedNetworkTargets } : {}),
    ...(leaseTtlMs === undefined ? {} : { ttlMs: leaseTtlMs }),
    requestApproval,
    onLeaseIssued: async ({ capability, request, lease }) => {
      const context = approvalContexts.get(executionDigest({ capability, request }));
      if (!context?.intent) return;
      await executionState.transition(context.intent.recordId, 'EXECUTING');
      const persistedLease = await executionState.createLease({
        runId,
        intentId: context.intent.recordId,
        approvalId: context.approval?.recordId,
        capability,
        request,
        commands: lease.commands,
        expiresAt: lease.expiresAt,
        requestDigest: context.intent.requestDigest,
        snapshotDigest: activeSnapshotDigest,
        scope: context.scopeSnapshot,
        bindingSnapshot: allocatedRoles.map(({ contextId, role, model, isolation }) => ({ contextId, role, model, isolation })),
        capabilitySnapshot: context.capabilitySnapshot,
        releaseChannel,
        executorIdentity: 'restricted-windows-executor@0.1.0',
        operationId: context.intent.operationId,
        policyVersion: 'runtime-safety-1'
      });
      // Register the durable lease before audit/event follow-ups so any
      // later failure can revoke the persisted lease through cleanup.
      context.leaseRecordId = persistedLease.recordId;
      await executionState.transition(persistedLease.recordId, 'ACTIVE');
      await appendGitAuditCheckpoint('ACTION_AUTHORIZED', {
        operationId: context.intent.operationId,
        intentId: context.intent.recordId,
        approvalId: context.approval?.recordId,
        leaseId: persistedLease.recordId
      }, { capability, scopeSnapshotDigest: context.scopeSnapshot?.snapshotDigest });
      await appendActionEvent('ActionAuthorized', {
        operationId: context.intent.operationId,
        intentId: context.intent.recordId,
        approvalId: context.approval?.recordId,
        leaseId: persistedLease.recordId,
        capability,
        scopeSnapshotDigest: context.scopeSnapshot?.snapshotDigest
      });
      emitEvent('lease.issued', {
        leaseId: persistedLease.recordId,
        intentId: context.intent.recordId,
        capability,
        expiresAt: lease.expiresAt,
        snapshotDigest: activeSnapshotDigest,
        policyVersion: 'runtime-safety-1'
      });
    }
  });
  const toolRegistry = createToolRegistry({
    allowSideEffects: true,
    strictInvocationPersistence: true,
    maxOutputBytes: 256 * 1024,
    maxOutputChars: 128 * 1024,
    onInvocation: (summary) => trajectory.append({
      runId,
      kind: 'ToolInvocationCompleted',
      payload: summary,
      sensitivity: 'SECURITY_AUDIT'
    })
  });
  registerReadonlyWorkspaceTools(toolRegistry, workspace);
  const plugins = [
    readonlyWorkspacePlugin(workspace),
    toolRegistryPlugin(toolRegistry),
    executorPlugin(executor),
    executorToolsPlugin({
      leaseProvider,
      ...(mode === EXECUTION_MODES.CONTROLLED ? { networkAdapter } : {}),
      onLeaseStarted: async (event) => {
        const context = approvalContexts.get(executionDigest({ capability: event.capability, request: event.request }));
        if (!context?.leaseRecordId || !context.intent) throw new Error('EXECUTION_LEASE_CONTEXT_MISSING');
        await executionState.claimLease(context.leaseRecordId, {
          requestDigest: context.intent.requestDigest,
          operationId: context.intent.operationId
        });
        const leasedAudit = await appendGitAuditCheckpoint('ACTION_LEASED', {
          operationId: context.intent.operationId,
          intentId: context.intent.recordId,
          leaseId: context.leaseRecordId
        }, { capability: event.capability, scopeSnapshotDigest: context.scopeSnapshot?.snapshotDigest });
        context.preExecutionObservation = leasedAudit.checkpoint?.observation ?? leasedAudit.event?.payload?.observation;
        await appendActionEvent('ActionLeased', {
          operationId: context.intent.operationId,
          intentId: context.intent.recordId,
          leaseId: context.leaseRecordId,
          capability: event.capability,
          scopeSnapshotDigest: context.scopeSnapshot?.snapshotDigest
        });
        emitEvent('lease.claimed', {
          leaseId: context.leaseRecordId,
          intentId: context.intent.recordId,
          operationId: context.intent.operationId,
          capability: event.capability
        });
      },
      onLeaseConsumed: async (event) => {
        const contextKey = executionDigest({ capability: event.capability, request: event.request });
        const context = approvalContexts.get(contextKey);
        if (!context?.leaseRecordId) return;
        const ok = event.result?.ok === true;
        const executedAudit = await appendGitAuditCheckpoint(ok ? 'ACTION_EXECUTED' : 'ACTION_FAILED', {
          operationId: context.intent.operationId,
          intentId: context.intent.recordId,
          leaseId: context.leaseRecordId
        }, { capability: event.capability, ok, scopeSnapshotDigest: context.scopeSnapshot?.snapshotDigest });
        const observed = compareGitObservations(
          context.preExecutionObservation,
          executedAudit.checkpoint?.observation ?? executedAudit.event?.payload?.observation,
          context.scopeSnapshot
        );
        if (observed.auditDegraded) {
          await appendGitAuditCheckpoint('ACTION_OBSERVATION_DEGRADED', {
            operationId: context.intent.operationId,
            intentId: context.intent.recordId,
            leaseId: context.leaseRecordId
          }, {
            capability: event.capability,
            scopeSnapshotDigest: context.scopeSnapshot?.snapshotDigest,
            auditStatus: 'AUDIT_DEGRADED',
            scopeResult: observed
          });
        }
        if (!observed.ok) {
          await appendActionEvent('ActionFailed', {
            operationId: context.intent.operationId,
            intentId: context.intent.recordId,
            leaseId: context.leaseRecordId,
            capability: event.capability,
            errorCode: 'SCOPE_VIOLATION',
            scopeResultDigest: sha256Digest(JSON.stringify(observed))
          });
          await executionState.revokeLease(context.leaseRecordId, 'SCOPE_VIOLATION');
          await executionState.transition(context.intent.recordId, 'FAILED', { reason: 'SCOPE_VIOLATION' });
          await appendGitAuditCheckpoint('SCOPE_VIOLATION', {
            operationId: context.intent.operationId,
            intentId: context.intent.recordId,
            leaseId: context.leaseRecordId
          }, {
            capability: event.capability,
            scopeSnapshotDigest: context.scopeSnapshot?.snapshotDigest,
            auditStatus: 'SCOPE_VIOLATION',
            scopeResult: observed
          });
          throw new Error('SCOPE_VIOLATION');
        }
        const outcomeDigest = sha256Digest(JSON.stringify(event.result ?? {}));
        await appendActionEvent(ok ? 'ActionExecuted' : 'ActionFailed', {
          operationId: context.intent.operationId,
          intentId: context.intent.recordId,
          leaseId: context.leaseRecordId,
          capability: event.capability,
          ok,
          outcomeDigest,
          ...(event.result?.timedOut ? { timedOut: true } : {}),
          ...(event.result?.aborted ? { aborted: true } : {})
        });
        await executionState.completeLease(context.leaseRecordId, {
          ok,
          outcomeDigest,
          ...(ok ? {} : { errorCode: 'EXECUTOR_RESULT_FAILED' })
        });
        await executionState.transition(context.intent.recordId, ok ? 'COMPLETED' : 'FAILED');
        approvalContexts.delete(contextKey);
        emitEvent('lease.consumed', { leaseId: context.leaseRecordId, intentId: context.intent.recordId, capability: event.capability, ok });
      },
      onLeaseFailed: async (event) => {
        const contextKey = executionDigest({ capability: event.capability, request: event.request });
        const context = approvalContexts.get(contextKey);
        if (!context) return;
        const message = event.error instanceof Error ? event.error.message : String(event.error ?? 'LEASE_EXECUTION_FAILED');
        if (context.leaseRecordId) {
          await executionState.revokeLease(context.leaseRecordId, 'EXECUTION_OUTCOME_UNCERTAIN').catch(() => {});
        }
        if (context.intent?.recordId) {
          const intent = executionState.get(context.intent.recordId);
          if (intent && ['PROPOSED', 'SAFETY_EVALUATING', 'WAITING_APPROVAL', 'APPROVED', 'EXECUTING'].includes(intent.state)) {
            const next = intent.state === 'EXECUTING' ? 'FAILED' : 'REJECTED';
            await executionState.transition(context.intent.recordId, next, { reason: 'EXECUTION_OUTCOME_UNCERTAIN' }).catch(() => {});
          }
        }
        const payload = {
          ...(context.leaseRecordId ? { leaseId: context.leaseRecordId } : {}),
          ...(context.intent?.recordId ? { intentId: context.intent.recordId } : {}),
          capability: event.capability,
          errorCode: trajectoryErrorPayload(new Error(message)).code
        };
        emitEvent('lease.failed', payload);
        await trajectory.append({
          runId,
          kind: 'LeaseExecutionFailed',
          payload,
          sensitivity: 'SECURITY_AUDIT'
        }).catch(() => {});
        await appendActionEvent('ActionFailed', {
          ...payload,
          operationId: context.intent?.operationId,
          outcomeDigest: sha256Digest(JSON.stringify(payload))
        }).catch(() => {});
        await appendGitAuditCheckpoint('ACTION_FAILED', {
          operationId: context.intent?.operationId,
          intentId: context.intent?.recordId,
          leaseId: context.leaseRecordId
        }, { capability: event.capability, errorCode: payload.errorCode }).catch(() => {});
        // Failure reporting is advisory; never retain a stale approval context
        // when a reporting sink itself is unavailable.
        approvalContexts.delete(contextKey);
      }
    }),
    createEvolutionRegistryPlugin({ storagePath: evolutionStore, eventStore: trajectory.harnessEventStore }),
    ...createModelPlugins(modelConfig),
    taskRunnerPlugin
  ];
  for (const plugin of plugins) await root.plugin(plugin);
  try {
    const evolutionControl = new EvolutionControlStore({ eventStore: trajectory.harnessEventStore });
    await evolutionControl.load();
    evolutionEvaluator = createEvolutionEvaluator({
      registry: root.evolutionRegistry,
      storagePath: evolutionEvaluationStore,
      eventStore: trajectory.harnessEventStore,
      verificationToken: evolutionVerificationToken,
      control: evolutionControl
    });
    await evolutionEvaluator.load();
  } catch (error) {
    // Evaluation data is advisory and must not make an otherwise safe task
    // unavailable. Keep the error visible in the run summary for repair.
    evolutionEvaluationError = String(error instanceof Error ? error.message : error).slice(0, 120);
    evolutionEvaluator = undefined;
  }
  // Dynamic contributions are loaded only after the host-owned safety and
  // model ports exist. A broken contribution is quarantined independently so
  // it cannot prevent the built-in task runner from starting.
  pluginGovernance = createPluginGovernance({
    storagePath: pluginGovernanceStore,
    eventStore: trajectory.harnessEventStore,
    requireEvaluation: true,
    evaluationVerifier: ({ plugin, evidence }) => evolutionEvaluator?.verifyPluginPromotion({
      ...evidence,
      pluginId: plugin.pluginId,
      packageDigest: plugin.packageDigest
    }) === true
  });
  await pluginGovernance.load();
  const dynamicRecords = pluginGovernance.list();
  const builtinPluginIds = manifests().map((manifest) => manifest.id);
  if (resolveReleaseChannel() === 'WINDOWS_PHASE1_READ_ONLY') {
    // In-process dynamic modules can execute unrestricted code at import.
    // Keep their governance records intact while the release gate is closed.
    dynamicPluginResults = dynamicRecords.filter((record) => record.state === 'ACTIVE').map((record) => ({
      pluginId: record.pluginId, version: record.version, state: 'DISABLED',
      reason: 'RELEASE_CHANNEL_DYNAMIC_PLUGIN_DISABLED'
    }));
  } else if (dynamicRecords.length > 0 && !pluginRoot) {
    dynamicPluginResults = [];
    for (const record of dynamicRecords.filter((candidate) => candidate.state === 'ACTIVE')) {
      const result = {
        pluginId: record.pluginId,
        version: record.version,
        state: 'QUARANTINED',
        errorCode: 'PLUGIN_ROOT_REQUIRED'
      };
      try {
        await (pluginGovernance.hasDurableSink ? pluginGovernance.transitionDurably(record.pluginId, 'QUARANTINED', {
          reason: result.errorCode,
          runId
        }) : pluginGovernance.transition(record.pluginId, 'QUARANTINED', {
          reason: result.errorCode,
          runId
        }));
      } catch {
        // Preserve task availability if another process changed the record.
      }
      dynamicPluginResults.push(result);
      const eventPayload = { ...result };
      emitEvent('plugin.activation', eventPayload);
      await trajectory.append({
        runId,
        kind: 'DynamicPluginActivation',
        payload: eventPayload,
        sensitivity: 'SECURITY_AUDIT'
      }).catch(() => {});
    }
  } else if (pluginRoot) {
    const dynamicRegistry = new PluginRegistry();
    dynamicPluginLoader = createDynamicPluginLoader({
      rootDir: pluginRoot,
      governance: pluginGovernance,
      registry: dynamicRegistry
    });
    for (const record of dynamicRecords.filter((candidate) => candidate.state === 'ACTIVE')) {
      const result = {
        pluginId: record.pluginId,
        version: record.version,
        state: 'ACTIVE'
      };
      let fiber;
      try {
        validatePluginManifest(record.manifest);
        validatePluginDependencies(record.manifest, {
          records: dynamicRecords,
          builtinIds: builtinPluginIds
        });
        const plugin = await dynamicPluginLoader.load(record.pluginId);
        validatePluginInject(record.manifest, plugin);
        const contextGrant = pluginContextGrantSummary(record.manifest, plugin);
        const guardedPlugin = (ctx, config) => {
          const scopedContext = createCapabilityScopedPluginContext(ctx, record.manifest, plugin);
          return typeof plugin === 'function'
            ? plugin(scopedContext, config)
            : plugin.apply(scopedContext, config);
        };
        Object.defineProperty(guardedPlugin, 'name', {
          value: `dynamic:${record.pluginId}@${record.version}`,
          configurable: true
        });
        if (plugin.inject !== undefined) {
          Object.defineProperty(guardedPlugin, 'inject', {
            value: plugin.inject,
            configurable: true
          });
        }
        fiber = root.plugin(guardedPlugin);
        await fiber;
        // FiberState.ACTIVE is 2 in Cordis' public lifecycle enum. A pending
        // fiber means an undeclared/unavailable service dependency.
        if (fiber.state !== 2) throw new Error('PLUGIN_DEPENDENCIES_UNAVAILABLE');
        result.state = 'LOADED';
        result.entryDigest = record.manifest?.entryDigest;
        result.contextGrant = contextGrant;
        const credential = record.transition?.metadata?.evaluation ?? record.transition?.metadata?.evaluationCredential;
        const deploymentReport = evolutionEvaluator?.list().find((report) => report.reportId === credential?.reportId);
        if (deploymentReport) result.proposalId = deploymentReport.proposalId;
      } catch (error) {
        await Promise.resolve(fiber?.dispose?.()).catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        const errorCode = /^[A-Z][A-Z0-9_]{1,96}/u.exec(message)?.[0] ?? 'PLUGIN_ACTIVATION_FAILED';
        result.state = 'QUARANTINED';
        result.errorCode = errorCode;
        try {
          await (pluginGovernance.hasDurableSink ? pluginGovernance.transitionDurably(record.pluginId, 'QUARANTINED', {
            reason: errorCode,
            runId,
            entryDigest: record.manifest?.entryDigest
          }) : pluginGovernance.transition(record.pluginId, 'QUARANTINED', {
            reason: errorCode,
            runId,
            entryDigest: record.manifest?.entryDigest
          }));
          await pluginGovernance.flush();
        } catch {
          // A concurrent governance transition must not take down the task.
        }
      }
      dynamicPluginResults.push(result);
      const eventPayload = {
        pluginId: result.pluginId,
        version: result.version,
        state: result.state,
        ...(result.entryDigest ? { entryDigest: result.entryDigest } : {}),
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.reason ? { reason: result.reason } : {})
      };
      emitEvent('plugin.activation', eventPayload);
      await trajectory.append({
        runId,
        kind: 'DynamicPluginActivation',
        payload: eventPayload,
        sensitivity: 'SECURITY_AUDIT'
      }).catch(() => {});
    }
  }
  await pluginGovernance.flush().catch(() => {});
  // A role binding may point at a different registered provider. Cordis keeps
  // service implementations isolated by scope, so each additional provider
  // gets a child context while the host-owned tools and safety services stay
  // shared. The root provider remains the fallback for the configured model.
  const roleProviders = new Map([[defaultModelId, root.modelProvider]]);
  const providerModelIds = [...new Set(Object.values(roleBindingResolution.roles)
    .filter((binding) => binding?.kind === 'MODEL' && binding.modelId)
    .flatMap((binding) => [
      binding.modelId,
      ...(binding.fallbackModelIds ?? []),
      // A candidate set must build a provider per candidate; otherwise every
      // candidate silently falls back to the primary provider and the fanout
      // would spend N calls against one model.
      ...(binding.candidateBindings ?? []).map((candidate) => candidate.modelId)
    ]))];
  for (const modelId of providerModelIds) {
    if (roleProviders.has(modelId)) continue;
    const record = modelRegistry.get(modelId);
    // Loading a second DeepSeek runtime would duplicate its global LLM
    // service. It remains available through the root provider or a later
    // dedicated provider supervisor.
    if (!record || record.provider === 'deepseek') continue;
    let providerContext;
    try {
      providerContext = root.isolate('modelProvider');
      for (const providerPlugin of createModelPlugins(record)) await providerContext.plugin(providerPlugin);
      if (!providerContext.modelProvider || typeof providerContext.modelProvider.stream !== 'function') throw new Error('MODEL_PROVIDER_UNAVAILABLE');
      roleProviderContexts.push(providerContext);
      roleProviders.set(modelId, providerContext.modelProvider);
    } catch {
      await Promise.resolve(providerContext?.fiber?.dispose?.()).catch(() => {});
    }
  }
  const executorBinding = roleBindingResolution.roles.executor;
  activeModelProvider = roleProviders.get(executorBinding?.modelId) ?? root.modelProvider;
  if (activeModelProvider?.model) {
    currentModelIdentity = {
      provider: activeModelProvider.provider,
      protocol: activeModelProvider.protocol,
      model: activeModelProvider.model
    };
  }
  const snapshot = await workspace.snapshot();
    activeSnapshotDigest = snapshot.snapshotDigest;
    const plannerContext = allocatedRoles.find((context) => context.role === 'planner');
    const verifierContext = allocatedRoles.find((context) => context.role === 'semanticVerifier');
    const roleTurnEvent = (event) => emitEvent(event.kind, {
      role: event.role,
      contextId: event.contextId,
      turnId: event.turnId,
      ...(event.chars === undefined ? {} : { chars: event.chars }),
      ...(event.outputDigest ? { outputDigest: event.outputDigest } : {}),
      ...(event.outputChars === undefined ? {} : { outputChars: event.outputChars })
    });
    if (agentMode === 'multi') {
      await saveThreadCheckpoint('PLANNING', {
        pendingActions: ['run isolated planner turn and validate plan'],
        workspaceSnapshotDigest: snapshot.snapshotDigest,
        roleContexts: allocatedRoles.map(({ contextId, role, model, isolation, adapterIdentityDigest, threadId, bindingSnapshotDigest }) => ({
          contextId,
          role,
          model,
          isolation,
          ...(adapterIdentityDigest ? { adapterIdentityDigest } : {}),
          ...(threadId ? { threadId } : {}),
          ...(bindingSnapshotDigest ? { bindingSnapshotDigest } : {})
        }))
      });
      const plannerBinding = roleBindingResolution.roles.planner;
      const plannerProvider = roleProviders.get(plannerBinding?.modelId) ?? root.modelProvider;
      if (resumeRequested) {
        plannerPlan = restorePlannerPlan(thread.checkpoint.plan);
        if (!plannerPlan) throw new Error('THREAD_RESUME_PLAN_INVALID');
        plannerTurn = {
          turnId: `restored-planner-${runId}`,
          outputDigest: plannerPlan.planDigest,
          plan: plannerPlan,
          source: 'THREAD_CHECKPOINT'
        };
        emitEvent('planner.restored', { sourceRunId: resumeSourceRunId, planDigest: plannerPlan.planDigest, stepCount: plannerPlan.steps.length });
      } else {
        if (plannerBinding?.kind !== 'MODEL' || !plannerProvider) throw new Error('PLANNER_MODEL_UNAVAILABLE');
        plannerTurn = await runPlannerTurn({
          provider: plannerProvider,
          prompt,
          context: [historyContext, `Workspace snapshot digest: ${snapshot.snapshotDigest}.`, `Entry count: ${snapshot.entries.length}.`].filter(Boolean).join('\n'),
          contextId: plannerContext?.contextId ?? `${runId}-planner`,
          onEvent: roleTurnEvent
        });
        plannerPlan = plannerTurn.plan;
      }
      const shouldDeliberate = !resumeRequested
        && (plannerPlan.steps.length > 2 || ['modify', 'test'].includes(taskClass));
      if (shouldDeliberate) {
        const councilContexts = allocatedRoles.filter((context) => context.role.startsWith('council-'));
        const councilBinding = roleBindingResolution.roles.planner;
        const councilProvider = roleProviders.get(councilBinding?.modelId) ?? root.modelProvider;
        const council = createAgentCouncil({
          members: [
            { id: 'plan-reviewer', role: 'planner', modelId: councilBinding?.modelId },
            { id: 'safety-critic', role: 'critic', modelId: councilBinding?.modelId }
          ],
          runMember: async ({ member, input, evidence, signal }) => runCouncilMemberTurn({
            provider: councilProvider,
            member,
            input,
            evidence,
            signal,
            contextId: councilContexts.find((context) => context.role === (member.role === 'critic' ? 'council-critic' : 'council-planner'))?.contextId,
            onEvent: roleTurnEvent
          }),
          judge: async ({ taskClass: judgedTaskClass, proposals, evidence, signal }) => runCouncilJudgeTurn({
            provider: councilProvider,
            taskClass: judgedTaskClass,
            proposals,
            evidence,
            signal,
            contextId: councilContexts[0]?.contextId,
            onEvent: roleTurnEvent
          })
        });
        councilResult = await council.run({
          runId,
          taskClass,
          input: {
            objectiveDigest: sha256Digest(prompt),
            planDigest: plannerPlan.planDigest,
            steps: plannerPlan.steps.map(({ stepId, summary, actionKind, dependencies }) => ({ stepId, summary, actionKind, dependencies }))
          },
          evidence: [`workspace:${snapshot.snapshotDigest}`, `plan:${plannerPlan.planDigest}`]
        });
        const selectedProposalId = councilResult.verdict.selectedProposalIds?.[0];
        const orderedProposals = [...(Array.isArray(councilResult.proposals) ? councilResult.proposals : [])]
          .sort((left, right) => (left.proposalId === selectedProposalId ? -1 : right.proposalId === selectedProposalId ? 1 : 0));
        const councilOptions = orderedProposals.slice(0, 7).map((proposal, index) => ({
          optionId: `council-${proposal.proposalId}`,
          actionKind: 'COUNCIL_PROPOSAL',
          summary: `Council proposal ${proposal.proposalId} from ${proposal.memberId}`,
          requiredCapabilityIds: [],
          evidenceRefs: [],
          riskCodes: Array.isArray(proposal.risks)
            ? proposal.risks
              .map((risk) => String(risk).toUpperCase().replace(/[^A-Z0-9_.:-]+/gu, '_').slice(0, 120))
              .filter(Boolean)
              .slice(0, 32)
            : [],
          ...(Number.isFinite(proposal.confidence) ? { expectedQuality: Math.max(0, Math.min(1, proposal.confidence)) } : {}),
          rejectionReasonCodes: proposal.proposalId === selectedProposalId
            ? []
            : ['NOT_SELECTED_BY_JUDGE', `RANK_${index + 1}`]
        }));
        councilOptions.push({
          optionId: 'council-abstain',
          actionKind: 'ABSTAIN',
          summary: 'Abstain from plan review',
          requiredCapabilityIds: [],
          evidenceRefs: [],
          riskCodes: ['NO_CONSENSUS'],
          rejectionReasonCodes: councilResult.verdict.decision === 'ABSTAIN' ? [] : ['JUDGE_RETURNED_DECISION']
        });
        const councilDecision = await recordDecision({
          stepId: 'plan-review',
          role: 'council',
          roleContextId: councilContexts[0]?.contextId ?? `${runId}-council`,
          decisionType: 'REVIEW_PLAN',
          actionKind: 'COUNCIL_REVIEW',
          parentDecisionIds: [plannerDecision?.decisionId ?? allocationDecision.decisionId],
          summary: `Council ${councilResult.verdict.decision} after ${councilResult.proposals.length} proposal(s)`,
          outputRefs: [
            `council-${councilResult.resultDigest}`,
            `council-ranking-${sha256Digest((councilResult.verdict.selectedProposalIds ?? []).join('|'))}`
          ],
          options: councilOptions,
          selectedOptionId: selectedProposalId ? `council-${selectedProposalId}` : 'council-abstain',
          reasonCodes: [`COUNCIL_${councilResult.verdict.decision}`],
          selectionCriteria: ['council-judge-selection'],
          assumptions: [
            ...(councilResult.verdict.rationale ? [{
              assumptionId: 'council-judge-rationale',
              statement: councilResult.verdict.rationale,
              source: 'MODEL_INFERENCE',
              testable: false
            }] : []),
            ...(councilResult.verdict.probe ? [{
              assumptionId: 'council-judge-probe',
              statement: councilResult.verdict.probe,
              source: 'MODEL_INFERENCE',
              testable: true
            }] : [])
          ],
          uncertaintyCodes: [
            ...(councilResult.verdict.decision === 'ABSTAIN' ? ['COUNCIL_ABSTAINED'] : []),
            ...(councilResult.verdict.reasonCode
              ? [String(councilResult.verdict.reasonCode).toUpperCase().replace(/[^A-Z0-9_.:-]+/gu, '_').slice(0, 120)]
              : []),
            ...(councilResult.judgeErrorCode ? ['COUNCIL_JUDGE_ERROR'] : [])
          ]
        });
        councilResult = { ...councilResult, decisionId: councilDecision.decisionId };
        const councilCompletedEvent = await coordinator.recordEventAndFlush('CouncilPlanReviewCompleted', {
          councilId: councilResult.councilId,
          decisionId: councilDecision.decisionId,
          decision: councilResult.verdict.decision,
          proposalCount: councilResult.proposals.length,
          resultDigest: councilResult.resultDigest
        });
        linkDecisionEvent(councilDecision, councilCompletedEvent.event);
        emitEvent('council.completed', {
          councilId: councilResult.councilId,
          decision: councilResult.verdict.decision,
          proposalCount: councilResult.proposals.length,
          resultDigest: councilResult.resultDigest
        });
        await trajectory.append({
          runId,
          kind: 'CouncilPlanReviewCompleted',
          payload: {
            councilId: councilResult.councilId,
            decisionId: councilDecision.decisionId,
            decision: councilResult.verdict.decision,
            proposalCount: councilResult.proposals.length,
            memberStates: councilResult.members.map(({ memberId, state, errorCode }) => ({ memberId, state, ...(errorCode ? { errorCode } : {}) })),
            resultDigest: councilResult.resultDigest
          },
          sensitivity: 'INTERNAL'
        });
      }
      const planningEvidence = await collectDecisionEvidence({ kinds: ['RoleBindingsResolved', 'TaskClassified', 'TaskRunCreated'], limit: 6 });
      const planningEvidenceIds = planningEvidence.map((ref) => ref.evidenceId);
      plannerDecision = await recordDecision({
        stepId: 'planning',
        role: 'planner',
        roleContextId: plannerContext?.contextId ?? `${runId}-planner`,
        decisionType: 'CREATE_PLAN',
        actionKind: 'PLAN',
        parentDecisionIds: [allocationDecision.decisionId],
        summary: resumeRequested
          ? `Restored ${plannerPlan.steps.length} validated plan step(s) from thread checkpoint`
          : `Planner produced ${plannerPlan.steps.length} validated step(s)`,
        outputRefs: [`plan-${plannerPlan.planDigest}`],
        evidenceRefs: planningEvidence,
        options: plannerPlan.candidates?.length > 1
          ? plannerPlan.candidates.map((candidate) => ({
              optionId: `plan-${candidate.planId}`,
              actionKind: 'PLAN',
              summary: `Plan ${candidate.planId} with ${candidate.stepCount} step(s)`,
              requiredCapabilityIds: [],
              evidenceRefs: planningEvidenceIds,
              riskCodes: [],
              rejectionReasonCodes: candidate.rejectionReasonCodes
            }))
          : [
              {
                optionId: 'plan-validated',
                actionKind: 'PLAN',
                summary: `Use the validated plan with ${plannerPlan.steps.length} step(s)`,
                requiredCapabilityIds: [],
                evidenceRefs: planningEvidenceIds,
                riskCodes: [],
                rejectionReasonCodes: []
              },
              {
                optionId: 'plan-abort',
                actionKind: 'ABORT',
                summary: 'Abort before execution because the plan is not validated',
                requiredCapabilityIds: [],
                evidenceRefs: [],
                riskCodes: ['NO_EXECUTION'],
                rejectionReasonCodes: ['VALIDATED_PLAN_AVAILABLE']
              }
            ],
        selectedOptionId: plannerPlan.candidates?.length > 1
          ? `plan-${plannerPlan.selectedPlanId ?? plannerPlan.planId}`
          : 'plan-validated',
        assumptions: [
          ...(plannerPlan.assumptions ?? []).map((statement, index) => ({
            assumptionId: `plan-assumption-${index + 1}`,
            statement,
            source: 'MODEL_INFERENCE',
            testable: false
          })),
          ...(plannerPlan.acceptanceCriteria ?? []).map((statement, index) => ({
            assumptionId: `plan-criterion-${index + 1}`,
            statement,
            source: 'MODEL_INFERENCE',
            testable: true
          }))
        ],
        uncertaintyCodes: [
          ...(plannerPlan.assumptions?.length ? ['PLAN_ASSUMPTIONS_UNVERIFIED'] : []),
          ...(plannerPlan.steps.some((step) => ['READ', 'TEST'].includes(String(step.actionKind).toUpperCase()))
            ? ['PLAN_EVIDENCE_REQUIRED']
            : [])
        ],
        reasonCodes: ['MODEL_PLANNER_VALIDATED'],
        selectionCriteria: ['plan-schema-and-dependency-validation']
      });
      const plannerTurnCompletedEvent = await coordinator.recordEventAndFlush('PlannerTurnCompleted', {
        planDigest: plannerPlan.planDigest,
        stepCount: plannerPlan.steps.length,
        decisionId: plannerDecision.decisionId,
        ...(resumeRequested ? { source: 'THREAD_CHECKPOINT', sourceRunId: resumeSourceRunId } : {})
      });
      linkDecisionEvent(plannerDecision, plannerTurnCompletedEvent.event);
      await trajectory.append({
        runId,
        kind: 'RoleTurnCompleted',
        payload: {
          role: 'planner',
          contextId: plannerContext?.contextId ?? `${runId}-planner`,
          turnId: plannerTurn.turnId,
          outputDigest: plannerTurn.outputDigest,
          planDigest: plannerPlan.planDigest,
          stepCount: plannerPlan.steps.length,
          decisionId: plannerDecision.decisionId,
          ...(resumeRequested ? { source: 'THREAD_CHECKPOINT', sourceRunId: resumeSourceRunId } : {})
        },
        sensitivity: 'INTERNAL'
      });
      await saveThreadCheckpoint('PLANNING', {
        plan: {
          planId: plannerPlan.planId,
          planDigest: plannerPlan.planDigest,
          steps: plannerPlan.steps.map(({ stepId, summary, actionKind, dependencies, status }) => ({ stepId, summary, actionKind, dependencies, status }))
        },
        pendingActions: ['execute validated plan through the bounded executor']
      });
    }
    executionPlan = resumeRequested
      ? restorePlannerPlan(thread.checkpoint.plan)
      : plannerPlan ?? normalizePlannerPlan({
      planId: `plan-${runId}`,
      steps: [{
        stepId: 'execute',
        summary: 'Execute the bounded task and collect evidence',
        actionKind: 'EXECUTE',
        dependencies: []
      }]
    }, { objectiveDigest: sha256Digest(prompt), sourceText: prompt });
    if (!executionPlan) throw new Error('THREAD_RESUME_PLAN_INVALID');
    if (agentMode !== 'multi') {
      const planningEvidence = await collectDecisionEvidence({ kinds: ['RoleBindingsResolved', 'TaskClassified', 'TaskRunCreated'], limit: 6 });
      const planningEvidenceIds = planningEvidence.map((ref) => ref.evidenceId);
      plannerDecision = await recordDecision({
        stepId: 'planning',
        role: 'planner',
        roleContextId: `${runId}-planner`,
        decisionType: 'CREATE_PLAN',
        actionKind: 'PLAN',
        parentDecisionIds: [allocationDecision.decisionId],
        summary: resumeRequested && thread.checkpoint?.plan
          ? `Restored ${executionPlan.steps.length} validated plan step(s) from thread checkpoint`
          : `Created deterministic bounded plan with ${executionPlan.steps.length} step(s)`,
        outputRefs: [`plan-${executionPlan.planDigest}`],
        evidenceRefs: planningEvidence,
        options: [
          {
            optionId: 'plan-bounded-default',
            actionKind: 'PLAN',
            summary: `Execute the validated bounded plan (${executionPlan.steps.length} step(s))`,
            requiredCapabilityIds: [],
            evidenceRefs: planningEvidenceIds,
            riskCodes: [],
            rejectionReasonCodes: []
          },
          {
            optionId: 'plan-abort',
            actionKind: 'ABORT',
            summary: 'Abort before execution because no model planner is bound',
            requiredCapabilityIds: [],
            evidenceRefs: [],
            riskCodes: ['NO_EXECUTION'],
            rejectionReasonCodes: ['BOUNDED_EXECUTION_REQUIRED']
          }
        ],
        selectedOptionId: 'plan-bounded-default',
        reasonCodes: ['DETERMINISTIC_RULE', 'NO_EVIDENCE_REQUIRED'],
        selectionCriteria: ['single-agent-bounded-plan']
      });
    }
    const interruptedResume = resumeRequested && executionPlan.steps.some((step) => step.status === 'RUNNING');
    interruptedResumeDetected = interruptedResume;
    const checkpointPlan = {
      planId: executionPlan.planId,
      planDigest: executionPlan.planDigest,
      steps: executionPlan.steps.map(({ stepId, summary, actionKind, dependencies, status, attempt, actionDigest, outputDigest, errorCode }) => ({
        stepId,
        summary,
        actionKind,
        dependencies,
        status,
        ...(attempt === undefined ? {} : { attempt }),
        ...(actionDigest ? { actionDigest } : {}),
        ...(outputDigest ? { outputDigest } : {}),
        ...(errorCode ? { errorCode } : {})
      }))
    };
    if (interruptedResume) {
      // A restored RUNNING step may have performed an external side effect
      // immediately before the process died. Persist it into this coordinator
      // before initialization so the scheduler can reconcile it and refuse an
      // automatic replay when the outcome is not provably known.
      // The resume pipeline rebuilds classification, routing, and planning
      // first. Enter EXECUTING explicitly before RECOVERING so the state
      // transition remains legal under the terminal-safe state machine.
      if (coordinator.state === 'PLANNING') {
        await coordinator.transitionAndFlush('EXECUTING', { reason: 'THREAD_RESUME_EXECUTION_RECONCILIATION' });
      }
      await coordinator.transitionAndFlush('RECOVERING', {
        reason: 'THREAD_RESUME_RECONCILIATION',
        metadata: { sourceRunId: resumeSourceRunId, planDigest: executionPlan.planDigest }
      });
      await coordinator.setPlanStateAndFlush(checkpointPlan, {
        commandId: `resume-plan-${runId}`,
        operationId: `resume-${resumeSourceRunId ?? runId}`,
        reason: 'RESUME_PLAN_RECONCILIATION'
      });
      await saveThreadCheckpoint('RECOVERING', {
        plan: checkpointPlan,
        pendingActions: ['reconcile interrupted plan step before any replay'],
        workspaceSnapshotDigest: snapshot.snapshotDigest
      });
    } else {
      await coordinator.transitionAndFlush('EXECUTING');
      await saveThreadCheckpoint('EXECUTING', {
        plan: checkpointPlan,
        pendingActions: ['execute bounded model turn and collect tool evidence'],
        workspaceSnapshotDigest: snapshot.snapshotDigest
      });
    }
    const planCoordinator = createPlanStepCoordinator({
      coordinator,
      plan: executionPlan,
      resumeFailed: resumeRequested,
      onStateChange: async ({ reason, plan: statePlan, currentStepId }) => {
        const checkpointPlan = {
          planId: statePlan.planId,
          planDigest: statePlan.planDigest,
          steps: statePlan.steps.map(({ stepId, summary, actionKind, dependencies, status, attempt, actionDigest, outputDigest, errorCode }) => ({
            stepId,
            summary,
            actionKind,
            dependencies,
            status,
            ...(attempt === undefined ? {} : { attempt }),
            ...(actionDigest ? { actionDigest } : {}),
            ...(outputDigest ? { outputDigest } : {}),
            ...(errorCode ? { errorCode } : {})
          }))
        };
        await saveThreadCheckpoint(coordinator.state === 'RECOVERING' ? 'RECOVERING' : 'EXECUTING', {
          plan: checkpointPlan,
          currentStepId,
          pendingActions: statePlan.pendingActions ?? [],
          planTransition: reason
        });
        emitEvent('plan.step_changed', {
          reason,
          currentStepId,
          steps: checkpointPlan.steps.map(({ stepId, status, attempt, errorCode }) => ({ stepId, status, ...(attempt === undefined ? {} : { attempt }), ...(errorCode ? { errorCode } : {}) }))
        });
        await trajectory.append({
          runId,
          kind: 'PlanStepStateChanged',
          payload: {
            reason,
            currentStepId,
            planDigest: statePlan.planDigest,
            steps: checkpointPlan.steps.map(({ stepId, status, attempt, outputDigest, errorCode }) => ({ stepId, status, ...(attempt === undefined ? {} : { attempt }), ...(outputDigest ? { outputDigest } : {}), ...(errorCode ? { errorCode } : {}) }))
          },
          sensitivity: 'INTERNAL'
        });
      }
    });
    await planCoordinator.initialize();
    emitEvent('workspace.snapshot', {
      granted: snapshot.granted,
      rootLabel: snapshot.rootLabel,
      snapshotDigest: snapshot.snapshotDigest,
      entryCount: snapshot.entries.length
    });
    await trajectory.append({
      runId,
      kind: 'WorkspaceSnapshotCreated',
      payload: {
        granted: snapshot.granted,
        snapshotDigest: snapshot.snapshotDigest,
        entryCount: snapshot.entries.length
      }
    });
    let finalResult;
    let activeActionParentDecisionIds = [plannerDecision?.decisionId ?? allocationDecision.decisionId];
    const recoveryLimitRaw = arg('--max-recovery-attempts', process.env.HMCODEX_MAX_RECOVERY_ATTEMPTS ?? '3');
    const recoveryLimit = Number(recoveryLimitRaw);
    if (!Number.isInteger(recoveryLimit) || recoveryLimit < 1 || recoveryLimit > 8) {
      throw new Error('RECOVERY_ATTEMPT_LIMIT_INVALID');
    }
    const runPlanStep = async ({ step, priorResults = [] } = {}) => {
      if (!step || typeof step.stepId !== 'string') throw new Error('PLAN_STEP_INVALID');
      // A completed verification leaves the aggregate run in VERIFYING. Move
      // through PLANNING before starting the next independent step so the
      // durable TaskRun state remains a legal transition sequence.
      if (coordinator.state === 'VERIFYING') {
        await coordinator.transitionAndFlush('PLANNING', { reason: `prepare:${step.stepId}` });
        await coordinator.transitionAndFlush('EXECUTING', { reason: `start:${step.stepId}` });
      }
      finalResult = undefined;
      finalVerification = undefined;
      finalVerificationDecision = undefined;
      activeActionParentDecisionIds = [plannerDecision?.decisionId ?? allocationDecision.decisionId];
      const priorStepContext = priorResults.slice(-8).map((entry) => ({
        stepId: entry.stepId,
        attempt: entry.attempt,
        status: entry.report?.status,
        outputDigest: entry.result?.result?.outputDigest ?? entry.result?.outputDigest,
        failureCodes: entry.report?.failureCodes ?? entry.result?.verification?.failureCodes ?? []
      }));
      const stepPrompt = [
        prompt,
        `Current validated plan step: ${step.stepId}.`,
        `Step objective: ${step.summary}.`,
        priorStepContext.length ? `Prior step outcomes (digests only): ${JSON.stringify(priorStepContext)}` : undefined
      ].filter(Boolean).join('\n');
      const stepHistoryContext = [
        historyContext,
        `Current plan step ${step.stepId}: ${step.summary}.`,
        priorStepContext.length ? `Prior step outcomes (digests only): ${JSON.stringify(priorStepContext)}` : undefined
      ].filter(Boolean).join('\n').slice(0, 6000);
      const recoveryRun = await runVerifierRecovery({
      maxAttempts: recoveryLimit,
      execute: async ({ attempt, recovery }) => {
        const verificationActions = [];
        const recoveryText = recovery
          ? [
              stepHistoryContext,
              `Verifier recovery attempt ${attempt}.`,
              `Previous verifier status: ${recovery.verifierStatus}.`,
              `Previous verifier next action: ${recovery.nextAction || 'REQUEST_EVIDENCE'}.`,
              recovery.failureCodes?.length ? `Failure codes: ${recovery.failureCodes.join(',')}.` : undefined,
              recovery.previousActionDigests?.length
                ? `Previously attempted action digests: ${recovery.previousActionDigests.join(',')}. Do not repeat them unless new evidence is required.`
                : undefined,
              'Gather new bounded evidence or complete the remaining goal; do not claim success without tool evidence.'
            ].filter(Boolean).join('\n').slice(0, 6000)
          : stepHistoryContext;
        const executorOptions = {
          prompt: stepPrompt,
          workspace: snapshot,
          historyContext: recoveryText,
          mode,
          modelProvider: activeModelProvider,
          onToolCall: async (call) => {
            const executorContext = allocatedRoles.find((context) => context.role === 'executor');
            const toolEvidence = await collectDecisionEvidence({ kinds: ['tool.result', 'RoleTurnCompleted', 'TaskRunCreated'], limit: 8 });
            const toolEvidenceIds = toolEvidence.map((ref) => ref.evidenceId);
            const toolDecision = await recordDecision({
              stepId: `${step.stepId}-tool-${attempt}-${call.id}`,
              role: 'executor',
              roleContextId: executorContext?.contextId ?? `${runId}-executor`,
              decisionType: 'SELECT_TOOL_ACTION',
              actionKind: call.name,
              parentDecisionIds: activeActionParentDecisionIds,
              operationId: `operation-${step.stepId}-${attempt}-${call.id}`,
              summary: `Selected provider-neutral tool ${call.name}`,
              outputRefs: [`tool-${attempt}-${call.id}`],
              evidenceRefs: toolEvidence,
              options: [
                {
                  optionId: `tool-${call.id}-selected`,
                  actionKind: call.name,
                  summary: `Invoke bounded tool ${call.name}`,
                  requiredCapabilityIds: [],
                  evidenceRefs: toolEvidenceIds,
                  riskCodes: [],
                  rejectionReasonCodes: []
                },
                {
                  optionId: `tool-${call.id}-no-tool`,
                  actionKind: 'NO_TOOL',
                  summary: 'Answer without invoking another bounded tool',
                  requiredCapabilityIds: [],
                  evidenceRefs: [],
                  riskCodes: ['UNVERIFIED_CLAIM'],
                  rejectionReasonCodes: ['EVIDENCE_GAP_REMAINS']
                }
              ],
              selectedOptionId: `tool-${call.id}-selected`,
              reasonCodes: ['BOUNDED_TOOL_SELECTION'],
              selectionCriteria: ['provider-neutral-tool-request']
            });
            verificationActions.push({
              id: call.id,
              name: call.name,
              ...(call.requestSummary ?? {}),
              argumentsDigest: call.argumentsDigest,
              state: 'REQUESTED'
            });
            const toolCallRequestedEvent = await trajectory.append({
              runId,
              kind: 'ToolCallRequested',
              payload: {
                attempt,
                round: call.round,
                name: call.name,
                argumentsDigest: call.argumentsDigest,
                decisionId: toolDecision.decisionId
              },
              sensitivity: 'SECURITY_AUDIT'
            });
            linkDecisionEvent(toolDecision, toolCallRequestedEvent);
            return toolCallRequestedEvent;
          },
          onEvent: (event) => {
            if (event.kind === 'tool.result') {
              const action = verificationActions.find((item) => item.id === event.id);
              if (action) {
                action.state = event.ok === true ? 'SUCCEEDED' : 'FAILED';
                if (event.ok === true && event.outputDigest) action.outputDigest = event.outputDigest;
                if (event.ok !== true && event.errorCode) action.errorCode = event.errorCode;
              }
            }
            emitEvent(event.kind, {
              attempt,
              round: event.round,
              ...(event.id ? { id: event.id } : {}),
              ...(event.name ? { name: event.name } : {}),
              ...(event.text ? { text: event.text } : {}),
              ...(event.argumentsDigest ? { argumentsDigest: event.argumentsDigest } : {}),
              ...(event.outputDigest ? { outputDigest: event.outputDigest } : {}),
              ...(event.outputChars !== undefined ? { outputChars: event.outputChars } : {}),
              ...(event.ok !== undefined ? { ok: event.ok } : {}),
              ...(event.errorCode ? { errorCode: event.errorCode } : {})
            });
          }
        };
        // S2-12: a candidate-set executor binding fans out read-only drafts,
        // selects one with an independent judge, and records a SELECT_CANDIDATE
        // decision before any tool can run. Candidates never receive tools or a
        // lease, and only the selected draft is handed to the single
        // tool-executing turn below, so fanout cannot multiply side effects.
        let selectedCandidateDraft = '';
        const candidateAttemptEvents = [];
        // Risk drives the fanout ceiling: a settled low-risk inspect task stays
        // single-candidate, while an unclassified task class or a controlled
        // modify/test step may fan out to the ceiling the binding asked for.
        const candidateRisk = candidateFanoutRisk(taskClass, mode);
        if (agentMode === 'multi' && executorBinding?.selector === 'CANDIDATE_SET' && (executorBinding.candidateBindings?.length ?? 0) > 1) {
          try {
            const candidateSpec = normalizeCandidateSetSpec({
              mode: 'CANDIDATE_SET',
              candidateBindings: executorBinding.candidateBindings.map((binding) => ({
                bindingId: binding.bindingId,
                modelId: binding.modelId,
                ...(binding.provider ? { provider: binding.provider } : {}),
                ...(binding.expectedCost !== undefined ? { expectedCost: binding.expectedCost } : {}),
                ...(binding.expectedLatencyMs !== undefined ? { expectedLatencyMs: binding.expectedLatencyMs } : {})
              })),
              fanout: executorBinding.fanout,
              ...(executorBinding.selectionPolicyRef ? { selectionPolicyRef: executorBinding.selectionPolicyRef } : {}),
              fanoutBudget: {
                maxCandidates: executorBinding.candidateBindings.length,
                maxConcurrency: executorBinding.candidateSetPlan?.maxConcurrency ?? 1
              }
            });
            const candidatePlan = planCandidateFanout({ spec: candidateSpec, risk: candidateRisk });
            if (candidatePlan.fanout < 2) throw new Error('CANDIDATE_FANOUT_EFFECTIVE_ONE');
            const candidateModelIds = new Set(candidateSpec.candidateBindings.map((binding) => binding.modelId));
            const judgeRoleBinding = candidateJudgeBinding ?? ['critic', 'semanticVerifier']
              .map((roleName) => roleBindingResolution.roles[roleName])
              .find((binding) => binding?.kind === 'MODEL' && binding.modelId && !candidateModelIds.has(binding.modelId));
            const judgeProvider = judgeRoleBinding ? roleProviders.get(judgeRoleBinding.modelId) : undefined;
            const executorContextId = allocatedRoles.find((context) => context.role === 'executor')?.contextId ?? `${runId}-executor`;
            const draftStage = await runCandidateDraftStage({
              spec: candidateSpec,
              risk: candidateRisk,
              precheck,
              signal: taskAbortController.signal,
              draftPrompt: stepPrompt,
              draftContext: stepHistoryContext,
              onEvent: async (event) => {
                const kind = event.kind === 'candidate.succeeded' ? 'CandidateTurnCompleted' : 'CandidateTurnFailed';
                const recorded = await coordinator.recordEventAndFlush(kind, event.kind === 'candidate.succeeded'
                  ? { candidateId: event.candidateId, ...(event.outputDraftDigest ? { outputDigest: event.outputDraftDigest } : {}) }
                  : { candidateId: event.candidateId, ...(event.errorCode ? { errorCode: event.errorCode } : {}) });
                candidateAttemptEvents.push(recorded.eventId ?? recorded.event?.eventId);
              },
              invokeCandidate: ({ binding, signal: candidateSignal }) => runIsolatedModelTurn({
                role: 'executor',
                provider: roleProviders.get(binding.modelId) ?? activeModelProvider,
                prompt: stepPrompt,
                context: stepHistoryContext,
                signal: candidateSignal,
                contextId: executorContextId
              }),
              ...(judgeProvider ? {
                judge: {
                  bindingId: judgeRoleBinding.modelId,
                  score: async ({ candidates: candidatePool }) => runCandidateJudgeTurn({
                    provider: judgeProvider,
                    taskClass,
                    objective: stepPrompt,
                    signal: taskAbortController.signal,
                    onSample: async (sample) => {
                      const recorded = await coordinator.recordEventAndFlush('CandidateVerificationSample', { stepId: step.stepId, attempt, modelId: judgeRoleBinding.modelId, ...sample });
                      candidateAttemptEvents.push(recorded.eventId ?? recorded.event?.eventId);
                    },
                    onInvocation: async (invocation) => {
                      const egress = modelEgressTargetFor(judgeRoleBinding.modelId);
                      if (egress) await recordModelEgress([{
                        phase: 'CANDIDATE_JUDGE', status: invocation.status, runId, stepId: step.stepId,
                        modelId: judgeRoleBinding.modelId,
                        ...(judgeRoleBinding.provider ? { provider: judgeRoleBinding.provider } : {}),
                        egress, promptDigest: invocation.promptDigest, latencyMs: invocation.latencyMs
                      }]);
                    },
                    onVerification: async (verificationResult) => {
                      await coordinator.recordEventAndFlush('CandidateVerificationCompleted', {
                        stepId: step.stepId, attempt, modelId: judgeRoleBinding.modelId,
                        method: verificationResult.method, config: verificationResult.config,
                        comparisonCount: verificationResult.comparisons?.length ?? 0,
                        ranking: verificationResult.ranking
                      });
                    },
                    contextId: candidateJudgeContextId ?? allocatedRoles.find((context) => context.role === 'critic' || context.role === 'semanticVerifier')?.contextId,
                    candidates: candidatePool.map((candidate) => ({
                      candidateId: candidate.candidateId,
                      modelId: candidate.modelId,
                      draftText: candidate.draftText,
                      ...(candidate.outputDraftDigest ? { outputDigest: candidate.outputDraftDigest } : {})
                    }))
                  })
                }
              } : {})
            });
              // Record what actually left the machine, per candidate, before the
              // selection decision is used for anything else.
              const draftPromptDigest = sha256Digest(stepPrompt);
              await recordModelEgress((draftStage.fanout?.candidates ?? []).map((candidate) => {
                const egress = modelEgressTargetFor(candidate.modelId);
                if (!egress) return undefined;
                return {
                  phase: 'CANDIDATE_DRAFT',
                  status: candidate.errorCode === 'CANDIDATE_CANCELLED' ? 'CANCELLED' : candidate.status === 'SUCCEEDED' ? 'SUCCEEDED' : (candidate.status === 'TIMED_OUT' ? 'TIMED_OUT' : 'FAILED'),
                  runId,
                  stepId: step.stepId,
                  candidateId: candidate.candidateId,
                  bindingId: candidate.bindingId,
                  modelId: candidate.modelId,
                  ...(candidate.provider ? { provider: candidate.provider } : {}),
                  egress,
                  promptDigest: draftPromptDigest,
                  ...(candidate.outputDraftDigest ? { outputDigest: candidate.outputDraftDigest } : {}),
                  ...(candidate.latencyMs !== undefined ? { latencyMs: candidate.latencyMs } : {}),
                  ...(candidate.expectedCost !== undefined ? { expectedCost: candidate.expectedCost } : {}),
                  ...(candidate.expectedTokens !== undefined ? { expectedTokens: candidate.expectedTokens } : {})
                };
              }));
            if (draftStage.status === 'SELECTED') {
              selectedCandidateDraft = draftStage.selectedDraft ?? '';
              const candidateEvents = (await listDurableRunEvents())
                .filter((event) => candidateAttemptEvents.includes(event.eventId));
              const candidateEvidence = candidateEvents
                .map((event) => evidenceFromEvent(event, { evidenceType: event.kind }))
                .filter(Boolean);
              const evidenceByCandidate = {};
              candidateEvents.forEach((event, index) => {
                const ref = candidateEvidence[index];
                // Coordinator events wrap the caller payload in a RuntimeEvent
                // envelope, so the candidate fields live one level deeper.
                const facts = event.payload?.payload ?? event.payload;
                const candidateIds = event.kind === 'CandidateVerificationSample' ? [facts.leftId, facts.rightId] : [facts.candidateId];
                for (const candidateId of new Set(candidateIds)) {
                  if (!ref || typeof candidateId !== 'string' || !candidateId) continue;
                  evidenceByCandidate[candidateId] = [...(evidenceByCandidate[candidateId] ?? []), ref.evidenceId];
                }
              });
              const selectionDecision = await recordDecision({
                stepId: `${step.stepId}-candidate-${attempt}`,
                role: 'planner',
                roleContextId: plannerContext?.contextId ?? `${runId}-planner`,
                decisionType: 'SELECT_CANDIDATE',
                actionKind: 'model.candidate',
                parentDecisionIds: activeActionParentDecisionIds,
                summary: `Selected 1 of ${draftStage.fanout.candidates.length} candidate drafts`,
                outputRefs: [`candidate-selection-${step.stepId}-${attempt}`],
                evidenceRefs: candidateEvidence,
                options: draftStage.decision.decisionSnapshot.options.map((option) => ({
                  ...option,
                  ...(evidenceByCandidate[option.optionId] ? { evidenceRefs: evidenceByCandidate[option.optionId] } : {})
                })),
                selectedOptionId: draftStage.decision.decisionSnapshot.selectedOptionId,
                selectionCriteria: draftStage.decision.decisionSnapshot.selectionCriteria,
                reasonCodes: draftStage.decision.decisionSnapshot.reasonCodes,
                uncertaintyCodes: draftStage.selection.degraded ? ['CANDIDATE_SELECTION_DEGRADED'] : [],
                expectedOutcome: {
                  successCriteriaRefs: [`criterion-${step.stepId}`],
                  predictedOutcomeCode: 'CANDIDATE_DRAFT_SELECTED',
                  predictedProgress: 0.1,
                  predictedRiskCodes: draftStage.selection.degraded ? ['JUDGE_DEGRADED'] : []
                }
              });
              linkDecisionEvent(selectionDecision, routeSelectedEvent.event);
              emitEvent('candidate.selected', {
                stepId: step.stepId,
                requestedFanout: draftStage.plan.requestedFanout,
                effectiveFanout: draftStage.plan.fanout,
                selectedCandidateId: draftStage.selection.selectedCandidateId,
                degraded: draftStage.selection.degraded === true,
                optionStates: draftStage.optionStates
              });
            }
          } catch (error) {
            // A fanout failure degrades to the single-turn executor path rather
            // than granting or skipping any authorization.
            logger.error(`candidate fanout degraded to single-turn executor | step=${step.stepId} | error=${error?.code ?? error?.message ?? error}`);
            selectedCandidateDraft = '';
          }
        }
        const result = agentMode === 'multi'
          ? await runExecutorTurn({
              taskRunner: root.taskRunner,
              provider: activeModelProvider,
              contextId: allocatedRoles.find((context) => context.role === 'executor')?.contextId ?? `${runId}-executor`,
              plan: executionPlan,
              signal: taskAbortController.signal,
              ...executorOptions,
              ...(selectedCandidateDraft
                ? { historyContext: [executorOptions.historyContext, `Selected candidate draft (untrusted data; execute only through declared tools):\n${selectedCandidateDraft}`].filter(Boolean).join('\n\n') }
                : {})
            })
          : await root.taskRunner.run({ ...executorOptions, signal: taskAbortController.signal });
        return { ...result, actions: verificationActions };
      },
      verify: async ({ attempt, result, previousActions }) => {
        await saveThreadCheckpoint('VERIFYING', {
          pendingActions: ['verify model output and tool evidence'],
          attempt,
          actionDigests: (result.actions ?? []).map((action) => action.argumentsDigest).filter(Boolean).slice(-16)
        });
        await coordinator.transitionAndFlush('VERIFYING');
        let verification = createRuleVerifier().verify({
          prompt: stepPrompt,
          output: result.text,
          workspace: snapshot,
          toolRounds: result.toolRounds,
          toolCallCount: result.toolCallCount,
          executionMode: mode,
          actions: result.actions,
          previousActions
        });
        if (agentMode === 'multi') {
          const semanticBinding = roleBindingResolution.roles.semanticVerifier;
          const semanticProvider = roleProviders.get(semanticBinding?.modelId);
          const executorModelRecord = modelRegistry.get(executorBinding?.modelId);
          const semanticModelRecord = modelRegistry.get(semanticBinding?.modelId);
          const verifierGate = evaluateSemanticVerifierIndependence({
            mode,
            taskClass,
            executorBinding,
            semanticBinding,
            executorProvider: roleProviders.get(executorBinding?.modelId),
            semanticProvider,
            executorModel: executorModelRecord,
            semanticModel: semanticModelRecord
          });
          const semanticModelIdentity = {
            provider: semanticBinding?.provider ?? semanticModelRecord?.provider ?? modelConfig.provider,
            model: semanticModelRecord?.model ?? modelConfig.model
          };
          if (!verifierGate.satisfied) {
            semanticVerifierTurn = {
              verdict: {
                status: 'FAIL',
                summary: 'High-risk execution requires an independent semantic verifier provider',
                progress: 0,
                evidenceRefs: [],
                failureCodes: ['SEMANTIC_VERIFIER_INDEPENDENCE_REQUIRED'],
                source: 'GATE'
              },
              gate: verifierGate
            };
          } else if (semanticBinding?.kind !== 'MODEL' || !semanticProvider) {
            semanticVerifierTurn = {
              verdict: {
                status: 'ABSTAIN',
                summary: 'No semantic verifier provider was bound',
                progress: 0,
                evidenceRefs: [],
                failureCodes: ['SEMANTIC_VERIFIER_UNBOUND'],
                source: 'UNBOUND'
              },
              modelIdentity: semanticModelIdentity
            };
          } else {
            try {
              semanticVerifierTurn = await runSemanticVerifierTurn({
                provider: semanticProvider,
                contextId: verifierContext?.contextId ?? `${runId}-semanticVerifier`,
                ruleReport: verification,
                result,
                plan: executionPlan,
                currentStep: step,
                onEvent: roleTurnEvent
              });
              semanticVerifierTurn.modelIdentity = semanticModelIdentity;
            } catch (error) {
              semanticVerifierTurn = {
                verdict: {
                  status: 'ABSTAIN',
                  summary: 'Semantic verifier invocation failed',
                  progress: 0,
                  evidenceRefs: [],
                failureCodes: ['SEMANTIC_VERIFIER_UNAVAILABLE'],
                source: 'ERROR'
              },
              modelIdentity: semanticModelIdentity,
              errorCode: String(error instanceof Error ? error.message : error).split(':')[0].slice(0, 120)
              };
            }
          }
          const semanticStatus = semanticVerifierTurn.verdict?.status;
          if (semanticStatus === 'FAIL') {
            verification = {
              ...verification,
              status: 'FAIL',
              summary: `Semantic verifier rejected the result: ${semanticVerifierTurn.verdict.summary}`,
              failureCodes: [...new Set([...(verification.failureCodes ?? []), ...(semanticVerifierTurn.verdict.failureCodes ?? []), 'SEMANTIC_VERIFIER_FAIL'])],
              checks: [...(verification.checks ?? []), {
                id: 'semantic-verifier',
                status: 'FAIL',
                message: semanticVerifierTurn.verdict.summary,
                evidence: semanticVerifierTurn.verdict.evidenceRefs ?? []
              }]
            };
          } else if (semanticStatus !== 'PASS') {
            verification = {
              ...verification,
              status: verification.status === 'PASS' ? 'UNCERTAIN' : verification.status,
              summary: verification.status === 'PASS'
                ? 'Deterministic checks passed but semantic verification abstained'
                : verification.summary,
              failureCodes: [...new Set([...(verification.failureCodes ?? []), ...(semanticVerifierTurn.verdict?.failureCodes ?? []), 'SEMANTIC_VERIFIER_ABSTAINED'])],
              checks: [...(verification.checks ?? []), {
                id: 'semantic-verifier',
                status: 'UNKNOWN',
                message: semanticVerifierTurn.verdict?.summary ?? 'Semantic verifier abstained',
                evidence: semanticVerifierTurn.verdict?.evidenceRefs ?? []
              }]
            };
          }
          await trajectory.append({
            runId,
            kind: 'RoleTurnCompleted',
            payload: {
              role: 'semanticVerifier',
              contextId: verifierContext?.contextId ?? `${runId}-semanticVerifier`,
              ...(semanticVerifierTurn.turnId ? { turnId: semanticVerifierTurn.turnId } : {}),
              ...(semanticVerifierTurn.outputDigest ? { outputDigest: semanticVerifierTurn.outputDigest } : {}),
              status: semanticVerifierTurn.verdict?.status ?? 'ABSTAIN',
              evidenceRefs: semanticVerifierTurn.verdict?.evidenceRefs ?? [],
              failureCodes: semanticVerifierTurn.verdict?.failureCodes ?? [],
              ...(semanticVerifierTurn.modelIdentity ? { modelIdentity: semanticVerifierTurn.modelIdentity } : {}),
              ...(semanticVerifierTurn.gate ? { gate: semanticVerifierTurn.gate } : {})
            },
            sensitivity: 'INTERNAL'
          });
          await coordinator.recordEventAndFlush('SemanticVerificationCompleted', {
            attempt,
            status: semanticVerifierTurn.verdict?.status ?? 'ABSTAIN',
            failureCodes: semanticVerifierTurn.verdict?.failureCodes ?? [],
            modelIdentity: semanticModelIdentity,
            ...(verifierGate.required ? { verifierGate } : {})
          });
        }
        const verificationEvidence = await collectDecisionEvidence({ kinds: ['tool.result', 'RoleTurnCompleted', 'TaskRunCreated'], limit: 12 });
        const verificationEvidenceIds = verificationEvidence.map((ref) => ref.evidenceId);
        const verdictCandidates = [...new Set(['PASS', 'FAIL', 'UNCERTAIN', 'ABSTAIN', verification.status])];
        const verificationDecision = await recordDecision({
          stepId: `${step.stepId}-verification-${attempt}`,
          role: 'verifier',
          roleContextId: allocatedRoles.find((context) => context.role === 'verifier')?.contextId ?? `${runId}-verifier`,
          decisionType: 'VERIFY_TASK_RESULT',
          actionKind: 'VERIFIER_REPORT',
          parentDecisionIds: [...new Set([
            activeActionParentDecisionIds[0] ?? allocationDecision.decisionId,
            ...(plannerDecision?.decisionId ? [plannerDecision.decisionId] : []),
            ...decisionIds.slice(-8)
          ])],
          summary: `Verifier returned ${verification.status}`,
          outputRefs: [`verifier-${runId}-${step.stepId}-${attempt}`],
          evidenceRefs: verificationEvidence,
          options: verdictCandidates.map((status) => ({
            optionId: `verdict-${status}`,
            actionKind: 'VERDICT',
            summary: `Verifier verdict ${status}`,
            requiredCapabilityIds: [],
            evidenceRefs: status === verification.status ? verificationEvidenceIds : [],
            riskCodes: status === 'PASS' ? [] : ['RESULT_NOT_ACCEPTED'],
            rejectionReasonCodes: status === verification.status ? [] : ['VERIFIER_RULE_MISMATCH']
          })),
          selectedOptionId: `verdict-${verification.status}`,
          reasonCodes: ['RULE_VERIFIER'],
          selectionCriteria: ['tool-evidence-and-rule-checks'],
          uncertaintyCodes: [
            ...(['UNCERTAIN', 'UNKNOWN', 'ABSTAIN'].includes(String(verification.status).toUpperCase())
              ? ['VERIFIER_EVIDENCE_INSUFFICIENT']
              : []),
            ...(verificationEvidence.length === 0 ? ['VERIFIER_EVIDENCE_MISSING'] : [])
          ],
          expectedOutcome: {
            successCriteriaRefs: [`criterion-${step.stepId}-verification-${attempt}`],
            predictedOutcomeCode: verification.status === 'PASS' ? 'STEP_ACCEPTED' : 'STEP_REJECTED',
            predictedProgress: verification.status === 'PASS' ? 1 : 0,
            predictedRiskCodes: (verification.failureCodes ?? []).filter((code) => /^[A-Za-z0-9_.:-]+$/u.test(code)).slice(0, 32)
          }
        });
        finalResult = result;
        finalVerification = verification;
        finalVerificationDecision = verificationDecision;
        const verificationCompletedEvent = await coordinator.recordEventAndFlush('VerificationCompleted', {
          attempt,
          status: verification.status,
          progress: verification.progress,
          failureCodes: verification.failureCodes
        });
        linkDecisionEvent(verificationDecision, verificationCompletedEvent.event);
        const verificationTrajectoryEvent = await trajectory.append({
          runId,
          kind: 'VerificationCompleted',
          payload: {
            attempt,
            status: verification.status,
            checkCount: verification.checks.length,
            ...(semanticVerifierTurn?.verdict ? { semanticStatus: semanticVerifierTurn.verdict.status } : {})
          },
          sensitivity: 'INTERNAL'
        });
        finalVerificationEventId = verificationTrajectoryEvent.eventId;
        emitEvent('verification.completed', { attempt, status: verification.status, summary: verification.summary });
        return verification;
      },
      diagnose: async ({ attempt, report, previousActions }) => {
        await saveThreadCheckpoint('DIAGNOSING', {
          blockers: report.failureCodes ?? [],
          pendingActions: ['diagnose verifier result before recovery'],
          attempt,
          actionDigests: previousActions.map((action) => action.argumentsDigest).filter(Boolean).slice(-16)
        });
        const diagnosisEvidence = await collectDecisionEvidence({ kinds: ['VerificationCompleted', 'tool.result', 'RoleTurnCompleted'], limit: 8 });
        const diagnosisEvidenceIds = diagnosisEvidence.map((ref) => ref.evidenceId);
        const diagnosisFailureCodes = (Array.isArray(report.failureCodes) && report.failureCodes.length
          ? report.failureCodes
          : ['UNKNOWN_VERIFIER_FAILURE']).filter((code) => /^[A-Za-z0-9_.:-]+$/u.test(code));
        const diagnosisOptions = diagnosisFailureCodes.slice(0, 6).map((code, index) => ({
          optionId: `diagnosis-${code}`,
          actionKind: 'DIAGNOSE_HYPOTHESIS',
          summary: `Diagnose failure code ${code}`,
          requiredCapabilityIds: [],
          evidenceRefs: diagnosisEvidenceIds,
          riskCodes: [],
          rejectionReasonCodes: index === 0 ? [] : ['HYPOTHESIS_RANKED_BELOW_PRIMARY']
        }));
        diagnosisOptions.push({
          optionId: 'diagnosis-stop',
          actionKind: 'STOP',
          summary: 'Stop without recovery',
          requiredCapabilityIds: [],
          evidenceRefs: [],
          riskCodes: ['TASK_FAILED'],
          rejectionReasonCodes: ['BOUNDED_RECOVERY_REQUIRED']
        });
        const diagnosisDecision = await recordDecision({
          stepId: `${step.stepId}-diagnosis-${attempt}`,
          role: 'planner',
          roleContextId: allocatedRoles.find((context) => context.role === 'planner')?.contextId ?? `${runId}-planner`,
          decisionType: 'DIAGNOSE_VERIFICATION',
          actionKind: 'DIAGNOSE',
          parentDecisionIds: [finalVerificationDecision?.decisionId ?? allocationDecision.decisionId],
          summary: `Diagnosing verifier ${report.status} before recovery`,
          outputRefs: [`diagnosis-${runId}-${attempt}`],
          evidenceRefs: diagnosisEvidence,
          options: diagnosisOptions,
          selectedOptionId: diagnosisOptions[0].optionId,
          reasonCodes: ['VERIFIER_FAILURE_DIAGNOSIS'],
          selectionCriteria: ['failure-code-to-hypothesis'],
          expectedOutcome: {
            successCriteriaRefs: [`criterion-${step.stepId}-diagnosis-${attempt}`],
            predictedOutcomeCode: 'DIAGNOSIS_PRODUCED',
            predictedProgress: 0.2,
            predictedRiskCodes: diagnosisFailureCodes.slice(0, 32)
          }
        });
        const recoveryDecision = await recordDecision({
          stepId: `${step.stepId}-recovery-${attempt}`,
          role: 'planner',
          roleContextId: allocatedRoles.find((context) => context.role === 'planner')?.contextId ?? `${runId}-planner`,
          decisionType: 'RECOVER_TASK',
          actionKind: 'RECOVER',
          parentDecisionIds: [diagnosisDecision.decisionId],
          summary: `Recovering after verifier ${report.status} with bounded new evidence`,
          outputRefs: [`recovery-${runId}-${attempt}`],
          evidenceRefs: diagnosisEvidence,
          options: [
            {
              optionId: 'recovery-retry-new-evidence',
              actionKind: 'RECOVER_WITH_NEW_EVIDENCE',
              summary: 'Retry the step with bounded new evidence',
              requiredCapabilityIds: [],
              evidenceRefs: diagnosisEvidenceIds,
              riskCodes: [],
              rejectionReasonCodes: []
            },
            {
              optionId: 'recovery-stop',
              actionKind: 'STOP',
              summary: 'Stop and report the verified failure',
              requiredCapabilityIds: [],
              evidenceRefs: [],
              riskCodes: ['TASK_FAILED'],
              rejectionReasonCodes: ['RECOVERY_BUDGET_AVAILABLE']
            }
          ],
          selectedOptionId: 'recovery-retry-new-evidence',
          reasonCodes: ['BOUNDED_RECOVERY'],
          selectionCriteria: ['new-evidence-before-retry']
        });
        activeActionParentDecisionIds = [recoveryDecision.decisionId];
        const diagnosisRequestedEvent = await coordinator.recordEventAndFlush('DiagnosisRequested', {
          attempt,
          status: report.status,
          failureCodes: report.failureCodes,
          diagnosisDecisionId: diagnosisDecision.decisionId,
          recoveryDecisionId: recoveryDecision.decisionId
        });
        linkDecisionEvent(diagnosisDecision, diagnosisRequestedEvent.event);
        linkDecisionEvent(recoveryDecision, diagnosisRequestedEvent.event);
        await trajectory.append({
          runId,
          kind: 'DiagnosisRequested',
          payload: {
            attempt,
            status: report.status,
            failureCodes: report.failureCodes,
            diagnosisDecisionId: diagnosisDecision.decisionId,
            recoveryDecisionId: recoveryDecision.decisionId
          },
          sensitivity: 'INTERNAL'
        });
        return {
          ...createRecoveryContext(report, { attempt, previousActions }),
          diagnosisDecisionId: diagnosisDecision.decisionId,
          recoveryDecisionId: recoveryDecision.decisionId
        };
      },
      onPhase: async ({ phase, attempt, report, recovery }) => {
        if (phase === 'RECOVERING') {
          await saveThreadCheckpoint('RECOVERING', {
            blockers: report?.failureCodes ?? [],
            pendingActions: ['run bounded recovery attempt'],
            attempt,
            recovery: recovery ? { verifierStatus: recovery.verifierStatus, failureCodes: recovery.failureCodes, previousActionDigests: recovery.previousActionDigests } : undefined
          });
        }
        if (phase === 'EXECUTING') {
          if (attempt > 1) {
            if (coordinator.state === 'RECOVERING') await coordinator.transitionAndFlush('PLANNING');
            if (coordinator.state === 'PLANNING') await coordinator.transitionAndFlush('EXECUTING');
            emitEvent('recovery.executing', { attempt, recovery });
          }
          return;
        }
        if (phase === 'DIAGNOSING') {
          if (coordinator.state === 'VERIFYING') await coordinator.transitionAndFlush('DIAGNOSING');
          await coordinator.recordEventAndFlush('RecoveryPhaseEntered', { phase, attempt, status: report?.status });
          emitEvent('recovery.diagnosing', { attempt, status: report?.status, failureCodes: report?.failureCodes ?? [] });
          return;
        }
        if (phase === 'RECOVERING') {
          if (coordinator.state === 'DIAGNOSING') await coordinator.transitionAndFlush('RECOVERING');
          await coordinator.recordEventAndFlush('RecoveryPhaseEntered', { phase, attempt, status: report?.status });
          await trajectory.append({
            runId,
            kind: 'RecoveryStarted',
            payload: { attempt, status: report?.status, recovery },
            sensitivity: 'INTERNAL'
          });
          emitEvent('recovery.started', { attempt, status: report?.status });
        }
      }
      });
      return {
        stepId: step.stepId,
        ok: recoveryRun.ok,
        result: finalResult,
        verification: finalVerification ?? recoveryRun.report,
        verificationDecision: finalVerificationDecision,
        recoveryRun
      };
    };
    const planExecution = await planCoordinator.run({
      maxAttempts: 1,
      executeStep: runPlanStep,
      verifyStep: async ({ result }) => result?.verification ?? { status: 'FAIL', failureCodes: ['STEP_VERIFICATION_MISSING'] }
    });
    if (!planExecution.ok) {
      const failedReport = planExecution.report ?? { status: 'FAIL' };
      throw new Error(`PLAN_STEP_FAILED:${planExecution.failedStepId ?? 'unknown'}:${failedReport.status}`);
    }
    executionPlan = planExecution.plan;
    if (plannerPlan) plannerPlan = executionPlan;
    const completedStepRuns = planExecution.results.map((entry) => entry.result).filter((entry) => entry?.result && entry?.verification);
    if (!completedStepRuns.length) throw new Error('PLAN_NO_COMPLETED_STEPS');
    const result = {
      text: completedStepRuns.map((entry) => entry.result.text).filter(Boolean).join('\n\n'),
      reasoningChars: completedStepRuns.reduce((sum, entry) => sum + Number(entry.result.reasoningChars ?? 0), 0),
      toolRounds: completedStepRuns.reduce((sum, entry) => sum + Number(entry.result.toolRounds ?? 0), 0),
      toolCallCount: completedStepRuns.reduce((sum, entry) => sum + Number(entry.result.toolCallCount ?? 0), 0),
      actions: completedStepRuns.flatMap((entry) => Array.isArray(entry.result.actions) ? entry.result.actions : [])
    };
    const stepReports = completedStepRuns.map((entry) => entry.verification);
    const verification = {
      status: stepReports.every((report) => report.status === 'PASS') ? 'PASS' : 'FAIL',
      summary: `Verified ${stepReports.length} plan step(s)`,
      progress: stepReports.reduce((sum, report) => sum + Number(report.progress ?? 0), 0) / stepReports.length,
      quality: Math.min(...stepReports.map((report) => Number(report.quality ?? 0))),
      safety: Math.min(...stepReports.map((report) => Number(report.safety ?? 0))),
      uncertainty: Math.max(...stepReports.map((report) => Number(report.uncertainty ?? 0))),
      evidence: [...new Set(stepReports.flatMap((report) => report.evidence ?? []))].slice(0, 64),
      failureCodes: [...new Set(stepReports.flatMap((report) => report.failureCodes ?? []))].slice(0, 32),
      nextAction: stepReports.every((report) => report.status === 'PASS') ? 'COMPLETE' : 'STOP_AND_REPORT',
      verifierVersion: [...new Set(stepReports.map((report) => report.verifierVersion).filter(Boolean))].join(',') || undefined,
      checks: completedStepRuns.flatMap((entry) => (entry.verification.checks ?? []).map((check) => ({
        ...check,
        id: `${entry.result?.stepId ?? 'step'}.${check.id}`
      })))
    };
    finalResult = result;
    finalVerification = verification;
    const verificationDecision = completedStepRuns.at(-1).verificationDecision ?? finalVerificationDecision;
    const recoveryRun = {
      ok: true,
      attempts: Math.max(...completedStepRuns.map((entry) => Number(entry.recoveryRun?.attempts ?? entry.recoveryRun?.attempt ?? 1))),
      report: verification,
      history: completedStepRuns.flatMap((entry) => entry.recoveryRun?.history ?? [])
    };
    for (const context of allocatedRoles) {
      if (roleSessions.get(context.contextId)?.state !== 'CLOSED') await transitionRoleContext(context.contextId, 'CLOSED').catch(() => {});
    }
    await threads.clearCheckpoint(thread.id, { state: 'COMPLETED' });
    await threads.appendTurn(thread.id, {
      runId,
      summary: `state=SUCCEEDED | promptDigest=${sha256Digest(prompt)} | outputDigest=${sha256Digest(result.text)} | toolRounds=${result.toolRounds} | toolCalls=${result.toolCallCount}`,
      state: 'SUCCEEDED'
    });
    const completedTrajectoryEvent = await trajectory.append({
      runId,
      kind: 'TaskRunCompleted',
      payload: {
        outcomeId: `task-outcome-${runId}`,
        outcomeStatus: 'SUCCEEDED',
        outputDigest: sha256Digest(result.text),
        reasoningChars: result.reasoningChars,
        toolRounds: result.toolRounds,
        toolCallCount: result.toolCallCount,
        executionMode: mode
      },
      sensitivity: 'SOURCE'
    });
    await appendGitAuditCheckpoint('RUN_COMPLETED', { threadId: thread.id }, { sourceEventId: completedTrajectoryEvent.eventId });
    for (const decisionId of decisionIds) {
      await decisionTrace.linkOutcome(decisionId, {
        outcomeId: decisionId === verificationDecision.decisionId ? `task-outcome-${runId}` : undefined,
        status: 'SUCCEEDED',
        sourceType: decisionId === verificationDecision.decisionId ? 'verifier' : 'coordinator',
        sourceId: decisionId === verificationDecision.decisionId ? `verifier-${runId}` : `coordinator-${runId}`,
        executionEventIds: decisionProducedEvents.get(decisionId) ?? [completedTrajectoryEvent.eventId],
        verifierReportIds: decisionId === verificationDecision.decisionId
          ? [finalVerificationEventId ?? completedTrajectoryEvent.eventId]
          : [],
        observedEffects: [],
        safetyOutcomeCodes: ['NO_EXTERNAL_EFFECT']
      });
    }
    const creditBlame = creditBlameLedger.hasDurableSink
      ? await creditBlameLedger.recordDurably({
          decisions: decisionIds.map((decisionId) => decisionTrace.get(decisionId)).filter(Boolean),
      outcome: {
        outcomeId: `task-outcome-${runId}`,
        status: 'SUCCEEDED',
          executionEventIds: [completedTrajectoryEvent.eventId]
        }
      })
      : creditBlameLedger.record({
          decisions: decisionIds.map((decisionId) => decisionTrace.get(decisionId)).filter(Boolean),
          outcome: { outcomeId: `task-outcome-${runId}`, status: 'SUCCEEDED', executionEventIds: [completedTrajectoryEvent.eventId] }
        });
    await creditBlameLedger.flush();
    await profileRegistry.recordEvidence({
      kind: 'CAPABILITY',
      entityType: 'model',
      entityId: `${currentModelIdentity.provider}/${currentModelIdentity.model}`,
      capabilityId: `task.${currentTaskClass}`,
      runId,
      decisionId: verificationDecision.decisionId,
      outcomeId: `task-outcome-${runId}`,
      sourceType: 'verifier',
      sourceId: `verifier-${runId}-${recoveryRun.attempt}`,
      outcome: 'SUCCEEDED',
      quality: verification.quality,
      safety: verification.safety,
      latencyMs: Math.max(0, Date.now() - runStartedAtMs)
    });
    await profileRegistry.recordEvidence({
      kind: 'SAFETY',
      entityType: 'executor',
      entityId: 'restricted-windows-executor@0.1.0',
      runId,
      decisionId: verificationDecision.decisionId,
      outcomeId: `task-outcome-${runId}`,
      sourceType: 'verifier',
      sourceId: `verifier-${runId}-${recoveryRun.attempt}`,
      outcome: 'SUCCEEDED',
      safety: verification.safety,
      latencyMs: Math.max(0, Date.now() - runStartedAtMs)
    });
    const recordedOutcome = await recordTaskOutcome({
      runId,
      deploymentProposalIds: dynamicPluginResults.filter((plugin) => plugin.state === 'LOADED' && plugin.proposalId).map((plugin) => plugin.proposalId),
      taskClass: currentTaskClass,
      provider: currentModelIdentity?.provider,
      protocol: currentModelIdentity?.protocol,
      model: currentModelIdentity?.model,
      status: 'SUCCEEDED',
      verified: verification.status === 'PASS',
      verificationToken: evolutionVerificationToken,
      quality: verification.quality,
      safety: verification.safety,
      latencyMs: Math.max(0, Date.now() - runStartedAtMs),
      sourceEventId: completedTrajectoryEvent.eventId
    }).catch((error) => {
      evolutionEvaluationError = String(error instanceof Error ? error.message : error).slice(0, 120);
    });
    if (autoEvolutionProposal && recordedOutcome?.verified === true) {
      try {
        const generated = await evolutionEvaluator?.proposeFromOutcome({ outcomeId: recordedOutcome.outcomeId });
        evolutionProposal = generated?.proposal;
        if (evolutionProposal) {
          emitEvent('evolution.proposal_created', {
            proposalId: evolutionProposal.proposalId,
            candidateId: evolutionProposal.candidateId,
            status: evolutionProposal.status,
            sourceOutcomeIds: evolutionProposal.sourceOutcomeIds
          });
        }
      } catch (error) {
        evolutionEvaluationError = String(error instanceof Error ? error.message : error).slice(0, 120);
      }
    }
    const finalizedContext = await finalizeContext({
      status: 'SUCCEEDED',
      event: completedTrajectoryEvent,
      result,
      verification
    });
    const feedbackRecord = await recordObjectiveFeedback({ status: 'SUCCEEDED', event: completedTrajectoryEvent, verification }).catch(() => undefined);
    await coordinator.transitionAndFlush('SUCCEEDED');
    emitEvent('run.completed', {
      outputDigest: sha256Digest(result.text),
      toolRounds: result.toolRounds,
      toolCallCount: result.toolCallCount,
      executionMode: mode
    });
    logger.info(`run finished | runId=${runId} | latencyMs=${Math.max(0, Date.now() - runStartedAtMs)} | toolRounds=${result.toolRounds} | toolCallCount=${result.toolCallCount} | mode=${mode}`);
    return {
      ok: true,
      ...(resumeSourceRunId ? { resumedFromRunId: resumeSourceRunId } : {}),
      runId,
      threadId: thread.id,
      thread: {
        id: thread.id,
        title: thread.title,
        cwd: thread.cwd,
        turnCount: thread.turns.length + 1,
        updatedAtMs: Date.now()
      },
      roles: allocatedRoles.map((context) => ({ contextId: context.contextId, role: context.role, model: context.model, state: 'CLOSED', isolation: context.isolation })),
      text: result.text,
      reasoningChars: result.reasoningChars,
      toolRounds: result.toolRounds,
      toolCallCount: result.toolCallCount,
      executionMode: mode,
      agentMode,
      ...(plannerPlan ? {
        plan: {
          planId: plannerPlan.planId,
          planDigest: plannerPlan.planDigest,
          steps: plannerPlan.steps.map(({ stepId, summary, actionKind, dependencies, status }) => ({ stepId, summary, actionKind, dependencies, status }))
        }
      } : {}),
      // Keep the public READ_ONLY capability list compatible with the MVP;
      // side-effect tools remain registered so an attempted model call still
      // reaches RuntimeSafetyMonitor and receives a stable refusal.
      tools: root.toolRegistry.list().filter((tool) => mode === EXECUTION_MODES.CONTROLLED || tool.readOnly),
      plugins: manifests(),
      dynamicPlugins: dynamicPluginResults,
      workspace: {
        granted: snapshot.granted,
        rootLabel: snapshot.rootLabel,
        snapshotDigest: snapshot.snapshotDigest,
        entryCount: snapshot.entries.length
      },
      evolution: {
        proposalCount: root.evolutionRegistry.list().length,
        store: evolutionStore ? 'PERSISTED' : 'MEMORY_ONLY',
        evaluationStore: evolutionEvaluationStore ? 'PERSISTED' : 'MEMORY_ONLY',
        outcomeCount: evolutionEvaluator?.listOutcomes({ runId }).length ?? 0,
        monitoring: evolutionMonitoring,
        ...(evolutionProposal ? {
          proposal: {
            proposalId: evolutionProposal.proposalId,
            candidateId: evolutionProposal.candidateId,
            candidateType: evolutionProposal.candidateType,
            status: evolutionProposal.status,
            sourceOutcomeIds: evolutionProposal.sourceOutcomeIds
          }
        } : {}),
        ...(evolutionEvaluationError ? { evaluationError: evolutionEvaluationError } : {}),
        creditBlame: creditBlameLedger.summarize(runId)
      },
      model: {
        provider: root.modelProvider.provider,
        protocol: root.modelProvider.protocol,
        model: root.modelProvider.model
      },
      roleBindings: roleBindingResolution.roles,
      verification: {
        status: verification.status,
        summary: verification.summary,
        checks: verification.checks.map(({ id, status, message }) => ({ id, status, message })),
        ...(semanticVerifierTurn?.verdict ? {
          semantic: {
            status: semanticVerifierTurn.verdict.status,
            summary: semanticVerifierTurn.verdict.summary,
            progress: semanticVerifierTurn.verdict.progress,
            evidenceRefs: semanticVerifierTurn.verdict.evidenceRefs,
            failureCodes: semanticVerifierTurn.verdict.failureCodes,
            ...(semanticVerifierTurn.modelIdentity ? { modelIdentity: semanticVerifierTurn.modelIdentity } : {}),
            ...(semanticVerifierTurn.gate ? { gate: semanticVerifierTurn.gate } : {})
          }
        } : {})
      },
      ...(councilResult ? {
        council: {
          councilId: councilResult.councilId,
          state: councilResult.state,
          decision: councilResult.verdict.decision,
          proposalCount: councilResult.proposals.length,
          resultDigest: councilResult.resultDigest
        }
      } : {}),
      decisionTrace: decisionTrace.summary(),
      profiles: {
        store: profilePath ? 'PERSISTED' : 'MEMORY_ONLY',
        profileCount: profileRegistry.listProfiles().length,
        evidenceCount: profileRegistry.listEvidence().length
      },
      trajectory: trajectory.summary(),
      storageCapacity,
      feedback: { store: feedbackPath ? 'PERSISTED' : 'MEMORY_ONLY', recordId: feedbackRecord?.feedback?.feedbackId },
      context: finalizedContext
    };
  } catch (error) {
    error = taskCancelError ?? taskTimeoutError ?? error;
    const failureStatus = taskCancelError || coordinator.state === 'CANCELLED' ? 'CANCELLED' : 'FAILED';
    const failurePhase = coordinator.state;
    const needsFailureTransition = !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(coordinator.state);
    try {
      await threads.setCheckpoint(thread.id, {
        runId,
        phase: interruptedResumeDetected
          ? 'RECOVERING'
          : ['CLASSIFYING', 'PRECHECKING', 'ROUTING', 'ALLOCATING_CONTEXTS', 'PLANNING', 'EXECUTING', 'VERIFYING', 'DIAGNOSING', 'RECOVERING'].includes(failurePhase)
          ? failurePhase
          : 'EXECUTING',
        state: failureStatus,
        ...(currentPlanCheckpoint ? { plan: currentPlanCheckpoint } : {}),
        blockers: [trajectoryErrorPayload(error).code],
        pendingActions: ['review failure and decide whether to resume']
      });
    } catch {
      // Keep the original error when checkpoint persistence is unavailable.
    }
    try {
      await threads.appendTurn(thread.id, {
        runId,
        summary: `state=${failureStatus} | promptDigest=${sha256Digest(prompt)} | errorDigest=${sha256Digest(error instanceof Error ? error.message : String(error))}`,
        state: failureStatus
      });
    } catch {
      // Preserve the original runtime error when the thread store is unavailable.
    }
    let failedTrajectoryEvent;
    try {
      failedTrajectoryEvent = await trajectory.append({
        runId,
        kind: 'TaskRunFailed',
        payload: {
          ...trajectoryErrorPayload(error),
          outcomeId: `task-outcome-${runId}`,
          outcomeStatus: failureStatus
        },
        sensitivity: 'SECURITY_AUDIT'
      });
    } catch {
        // Preserve the original runtime error when the trajectory store is unavailable.
      }
    await appendGitAuditCheckpoint('RUN_FAILED', { threadId: thread.id }, failedTrajectoryEvent?.eventId ? { sourceEventId: failedTrajectoryEvent.eventId } : {}).catch(() => {});
    await recordTaskOutcome({
      runId,
      deploymentProposalIds: dynamicPluginResults.filter((plugin) => plugin.state === 'LOADED' && plugin.proposalId).map((plugin) => plugin.proposalId),
      verificationToken: evolutionVerificationToken,
      taskClass: currentTaskClass,
      provider: currentModelIdentity?.provider,
      protocol: currentModelIdentity?.protocol,
      model: currentModelIdentity?.model,
      status: failureStatus,
      quality: 0,
      latencyMs: Math.max(0, Date.now() - runStartedAtMs),
      ...(failedTrajectoryEvent?.eventId ? { sourceEventId: failedTrajectoryEvent.eventId } : {})
    }).catch((recordError) => {
      evolutionEvaluationError = String(recordError instanceof Error ? recordError.message : recordError).slice(0, 120);
    });
    await finalizeContext({
      status: failureStatus,
      event: failedTrajectoryEvent,
      result: undefined,
      verification: finalVerification
    }).catch(() => {});
    await recordObjectiveFeedback({ status: failureStatus, event: failedTrajectoryEvent, verification: finalVerification }).catch(() => {});
    emitEvent('run.failed', trajectoryErrorPayload(error));
    logger.error(`run failed | runId=${runId} | phase=${failurePhase} | status=${failureStatus} | error=${error instanceof Error ? `${error.message} | stack=${error.stack ?? ''}` : String(error)}`);
    for (const decisionId of decisionIds) {
      await decisionTrace.linkOutcome(decisionId, {
        outcomeId: decisionId === finalVerificationDecision?.decisionId ? `task-outcome-${runId}` : undefined,
        status: failureStatus,
        sourceType: 'coordinator',
        sourceId: `coordinator-${runId}`,
        executionEventIds: decisionProducedEvents.get(decisionId) ?? (failedTrajectoryEvent?.eventId ? [failedTrajectoryEvent.eventId] : []),
        verifierReportIds: decisionId === finalVerificationDecision?.decisionId && finalVerificationEventId ? [finalVerificationEventId] : [],
        observedEffects: [],
        safetyOutcomeCodes: [failureStatus === 'CANCELLED' ? 'TASK_CANCELLED' : 'TASK_FAILED']
      }).catch(() => {});
    }
    const failedCreditInput = {
      decisions: decisionIds.map((decisionId) => decisionTrace.get(decisionId)).filter(Boolean),
      outcome: {
        runId,
        outcomeId: `task-outcome-${runId}`,
        status: failureStatus,
        executionEventIds: failedTrajectoryEvent?.eventId ? [failedTrajectoryEvent.eventId] : []
      }
    };
    await Promise.resolve(creditBlameLedger.hasDurableSink
      ? creditBlameLedger.recordDurably(failedCreditInput)
      : creditBlameLedger.record(failedCreditInput)).catch(() => {});
    if (currentModelIdentity && currentTaskClass) {
      await profileRegistry.recordEvidence({
        kind: 'CAPABILITY',
        entityType: 'model',
        entityId: `${currentModelIdentity.provider}/${currentModelIdentity.model}`,
        capabilityId: `task.${currentTaskClass}`,
        runId,
        sourceType: 'coordinator',
        sourceId: `coordinator-${runId}`,
        outcomeId: `task-outcome-${runId}`,
        outcome: failureStatus,
        quality: 0,
        latencyMs: Math.max(0, Date.now() - runStartedAtMs)
      }).catch(() => {});
    }
    if (needsFailureTransition) {
      try {
        await coordinator.transitionAndFlush(failureStatus, { reason: error instanceof Error ? error.message : String(error) });
      } catch {
        // Preserve the original failure while recovery can inspect the durable evidence.
      }
    }
    throw error;
  } finally {
    cancelPollStopped = true;
    if (cancelPollTimer) clearTimeout(cancelPollTimer);
    if (taskCancelError) await cancelRegistry.consume(runId).catch(() => {});
    if (taskTimeoutTimer) clearTimeout(taskTimeoutTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await roleSessions.flush().catch(() => {});
    await memoryJournal.flush().catch(() => {});
    await coordinator.flush().catch(() => {});
    await decisionTrace.flush().catch(() => {});
    await profileRegistry.flush().catch(() => {});
    await modelRegistry?.flush?.().catch(() => {});
    await evolutionEvaluator?.flush?.().catch(() => {});
    await creditBlameLedger.flush().catch(() => {});
    await modelEgressLedger.flush().catch(() => {});
    await Promise.resolve(pluginGovernance?.flush?.()).catch(() => {});
    for (const pending of pendingApprovals.values()) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    pendingApprovals.clear();
    approvalInterface?.close();
    if (approvalInterface) {
      process.stdin.unref?.();
      process.stdin.destroy?.();
    }
    for (const providerContext of roleProviderContexts) await Promise.resolve(providerContext?.fiber?.dispose?.()).catch(() => {});
    if (root) await root.fiber.dispose();
  }
}

const parseBoolean = (value, fallback = false) => {
  if (value === undefined) return fallback;
  if (['true', '1', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['false', '0', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  throw new Error('BOOLEAN_ARGUMENT_INVALID');
};

async function runTaskCancelCommand() {
  const operation = positionalOperation('request');
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const storagePath = argValue('--cancel-store')
    ?? process.env.HMCODEX_CANCEL_STORE
    ?? taskCancelStorePath(trajectoryPath);
  const registry = createTaskCancelRegistry({ storagePath });
  if (operation === 'list') {
    return {
      ok: true,
      operation: 'list',
      storage: storagePath ? 'PERSISTED' : 'MEMORY_ONLY',
      requests: await registry.list()
    };
  }
  if (operation !== 'request') throw new Error('TASK_CANCEL_OPERATION_INVALID');
  const runId = argValue('--run-id');
  if (!runId) throw new Error('TASK_CANCEL_RUN_ID_REQUIRED');
  const result = await registry.request(runId, {
    reason: argValue('--reason') ?? 'USER_REQUESTED',
    requestedBy: argValue('--requested-by') ?? 'runtime-cli'
  });
  return { ok: true, operation: 'request', runId: result.request.runId, ...result };
}

async function runCapacityCommand() {
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const paths = [
    taskHarnessEventStore(trajectoryPath, scopedTrajectory),
    trajectoryPath,
    argValue('--thread-store') ?? process.env.HMCODEX_THREAD_STORE
      ?? (scopedTrajectory && trajectoryPath ? `${trajectoryPath}.threads.json` : defaultThreadStore())
  ];
  return { ok: true, operation: 'capacity', assessment: await assessStorageCapacity({
    paths,
    maxBytes: Number(arg('--storage-max-bytes', process.env.HMCODEX_STORAGE_MAX_BYTES ?? String(DEFAULT_MAX_BYTES))),
    warningRatio: Number(arg('--storage-warning-ratio', process.env.HMCODEX_STORAGE_WARNING_RATIO ?? '0.7')),
    criticalRatio: Number(arg('--storage-critical-ratio', process.env.HMCODEX_STORAGE_CRITICAL_RATIO ?? '0.85')),
    hardRatio: Number(arg('--storage-hard-ratio', process.env.HMCODEX_STORAGE_HARD_RATIO ?? '0.95'))
  }) };
}

async function runSupportBundleCommand() {
  const outputPath = arg('--output');
  if (!outputPath) throw new Error('SUPPORT_BUNDLE_OUTPUT_REQUIRED');
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const harnessPath = taskHarnessEventStore(trajectoryPath, scopedTrajectory);
  const auditPath = arg('--audit-store', process.env.HMCODEX_GIT_AUDIT_STORE ?? (harnessPath ? `${harnessPath}.git-audit.json` : defaultGitAuditStore()));
  const decisionPath = arg('--decision-trace-store', process.env.HMCODEX_DECISION_TRACE_STORE
    ?? (scopedTrajectory && trajectoryPath ? `${trajectoryPath}.decision-trace.json` : defaultDecisionTraceStore()));
  const feedbackPath = arg('--feedback-store', process.env.HMCODEX_FEEDBACK_STORE
    ?? (scopedTrajectory && trajectoryPath ? `${trajectoryPath}.feedback.json` : defaultFeedbackStore()));
  const profilePath = arg('--profile-store', process.env.HMCODEX_MODEL_SCENARIO_PROFILE_STORE ?? defaultModelScenarioProfileStore());
  const readModelPath = arg('--read-model', process.env.HMCODEX_READ_MODEL_STORE ?? (harnessPath ? `${harnessPath}.read-model.json` : undefined));
  await assertProjectionOutput(outputPath, [harnessPath, trajectoryPath, auditPath, decisionPath, feedbackPath, profilePath, readModelPath], 'SUPPORT_BUNDLE_OUTPUT_CONFLICT');
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  let harness;
  try { await eventStore.load(); harness = { summary: eventStore.summary(), verification: await eventStore.verify() }; }
  catch (error) { harness = { errorCode: error instanceof Error ? error.message.slice(0, 120) : 'HARNESS_STORE_READ_FAILED' }; }
  const audit = createGitAuditStore({ storagePath: auditPath, ...auditSigningOptions() });
  let gitAudit;
  try { await audit.load(); gitAudit = { summary: audit.summary(), verification: await audit.verify({ events: await eventStore.list() }) }; }
  catch (error) { gitAudit = { errorCode: error instanceof Error ? error.message.slice(0, 120) : 'GIT_AUDIT_READ_FAILED' }; }
  const trace = createAgentDecisionTrace({ storagePath: decisionPath });
  let decision;
  try { await trace.load(); decision = trace.summary(); }
  catch (error) { decision = { errorCode: error instanceof Error ? error.message.slice(0, 120) : 'DECISION_STORE_READ_FAILED' }; }
  const feedback = createFeedbackRegistry({ storagePath: feedbackPath });
  const modelProfiles = createModelScenarioProfileRegistry({ storagePath: profilePath });
  const modelEgress = createModelEgressLedger({ eventStore });
  let modelEgressSummary;
  try {
    await modelEgress.load();
    // Per-candidate outbound/cost accounting belongs in the bundle at candidate
    // granularity, and the shared privacy scanner runs over it below.
    modelEgressSummary = modelEgress.summarize();
  } catch (error) {
    modelEgressSummary = { errorCode: error instanceof Error ? error.message.slice(0, 120) : 'MODEL_EGRESS_READ_FAILED' };
  }
  let profileSummary;
  try { await modelProfiles.load(); profileSummary = modelProfiles.summary(); }
  catch (error) { profileSummary = { errorCode: error instanceof Error ? error.message.slice(0, 120) : 'MODEL_PROFILE_READ_FAILED' }; }
  let feedbackSummary;
  try { await feedback.load(); feedbackSummary = feedback.summary(); }
  catch (error) { feedbackSummary = { errorCode: error instanceof Error ? error.message.slice(0, 120) : 'FEEDBACK_STORE_READ_FAILED' }; }
  let projection;
  if (readModelPath) {
    try {
      const parsed = JSON.parse(await readFile(readModelPath, 'utf8'));
      projection = { projectionVersion: parsed.projectionVersion, projectionChecksum: parsed.projectionChecksum, runCount: parsed.runCount, timelineCount: Array.isArray(parsed.timeline) ? parsed.timeline.length : 0, lastEventSequence: parsed.lastEventSequence };
    } catch (error) {
      if (error?.code !== 'ENOENT') projection = { errorCode: 'READ_MODEL_READ_FAILED' };
    }
  }
  const bundle = {
    schemaVersion: '1.0',
    bundleType: 'HMCODEX_SUPPORT_BUNDLE',
    createdAtMs: Date.now(),
    releaseChannel: resolveReleaseChannel(),
    runtime: { node: process.version, platform: process.platform },
    stores: { harness, gitAudit, decision, feedback: feedbackSummary, modelProfiles: profileSummary, modelEgress: modelEgressSummary, ...(projection ? { projection } : {}) },
    privacy: { rawPromptIncluded: false, modelOutputIncluded: false, reasoningIncluded: false, credentialsIncluded: false, sourceCodeIncluded: false, rawTrajectoryIncluded: false, commandTextIncluded: false }
  };
  const privacyScan = scanSupportBundle(bundle);
  if (!privacyScan.ok) {
    const error = new Error(`SUPPORT_BUNDLE_PRIVACY_VIOLATION:${privacyScan.violations.map((violation) => violation.path).join(',')}`);
    error.violations = privacyScan.violations;
    throw error;
  }
  bundle.privacy.scan = { ok: true, violations: [] };
  await writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}
`, 'utf8');
  return { ok: true, operation: 'support-bundle', outputPath, storeCount: Object.keys(bundle.stores).length, privacy: bundle.privacy };
}

async function runModelProfileCommand() {
  const feedbackPath = arg('--feedback-store', process.env.HMCODEX_FEEDBACK_STORE ?? defaultFeedbackStore());
  const profilePath = arg('--profile-store', process.env.HMCODEX_MODEL_SCENARIO_PROFILE_STORE ?? defaultModelScenarioProfileStore());
  const harnessPath = arg('--harness-event-store', process.env.HMCODEX_HARNESS_EVENT_STORE ?? defaultHarnessEventStore());
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  await eventStore.load();
  const feedback = createFeedbackRegistry({ storagePath: feedbackPath, eventStore });
  const profiles = createModelScenarioProfileRegistry({ storagePath: profilePath, eventStore });
  await Promise.all([feedback.load(), profiles.load()]);
  const operation = positionalOperation('list');
  if (operation === 'rebuild') {
    const runId = argValue('--run-id');
    const cachedSamples = feedback.list({ runId });
    const durableSamples = cachedSamples.length ? cachedSamples : (await feedback.listDurableSummaries({ runId }))
      .filter((sample) => sample.eventKind === 'FeedbackSubmitted' || sample.eventKind === 'FeedbackRevised');
    const result = await profiles.rebuild({ samples: durableSamples });
    return { ok: true, operation, profileCount: result.profiles.length, assessmentDigest: result.assessment.datasetDigest };
  }
  if (operation === 'list') return { ok: true, operation, profiles: profiles.list({ status: argValue('--status'), candidateKey: argValue('--candidate-key'), scenarioKey: argValue('--scenario-key') }) };
  if (operation === 'rank') {
    const raw = argValue('--candidates');
    let candidates = [];
    if (raw !== undefined) { try { candidates = JSON.parse(raw); } catch { throw new Error('MODEL_PROFILE_CANDIDATES_INVALID_JSON'); } }
    if (!Array.isArray(candidates)) throw new Error('MODEL_PROFILE_CANDIDATES_INVALID');
    return { ok: true, operation, ranking: profiles.rank({ candidates }) };
  }
  throw new Error('MODEL_PROFILE_OPERATION_INVALID');
}

async function runFeedbackCommand() {
  const feedbackPath = arg('--feedback-store', process.env.HMCODEX_FEEDBACK_STORE ?? defaultFeedbackStore());
  const harnessPath = arg('--harness-event-store', process.env.HMCODEX_HARNESS_EVENT_STORE ?? defaultHarnessEventStore());
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  await eventStore.load();
  const registry = createFeedbackRegistry({ storagePath: feedbackPath, eventStore });
  const operation = command === 'bayesian' ? 'assess' : positionalOperation('list');
  if (['submit', 'revise', 'retract'].includes(operation)) await registry.load();
  const durableSummaries = async () => registry.listDurableSummaries({ runId: argValue('--run-id') });
  if (operation === 'submit') {
    const result = await registry.submit(parseJsonObjectArgument('--input'), { commandId: argValue('--command-id') });
    return { ok: true, operation, ...result };
  }
  if (operation === 'revise') {
    const feedbackId = arg('--feedback-id');
    const result = await registry.revise(feedbackId, parseJsonObjectArgument('--input'), { commandId: argValue('--command-id') });
    return { ok: true, operation, ...result };
  }
  if (operation === 'retract') {
    const feedbackId = arg('--feedback-id');
    const result = await registry.retract(feedbackId, { commandId: argValue('--command-id') });
    return { ok: true, operation, ...result };
  }
  if (operation === 'list') return { ok: true, operation, feedback: await durableSummaries() };
  if (operation === 'events') {
    const runId = argValue('--run-id');
    const events = (await eventStore.list({ aggregateType: 'TaskRun' }))
      .filter((event) => event.kind === 'FeedbackFactRecorded' && (!runId || event.runId === runId));
    return { ok: true, operation, events };
  }
  if (operation === 'summary') return { ok: true, operation, summary: { ...registry.summary(), durableCount: (await durableSummaries()).length } };
  if (operation === 'assess') {
    const samples = await durableSummaries();
    return { ok: true, operation, assessment: assessBayesian({ samples }) };
  }
  if (operation === 'rank') {
    const rawCandidates = argValue('--candidates');
    let candidates = [];
    if (rawCandidates !== undefined) {
      try { candidates = JSON.parse(rawCandidates); } catch { throw new Error('FEEDBACK_CANDIDATES_INVALID_JSON'); }
      if (!Array.isArray(candidates)) throw new Error('FEEDBACK_CANDIDATES_INVALID');
    }
    const assessment = assessBayesian({ samples: await durableSummaries() });
    return { ok: true, operation, ranking: rankSafeCandidates({ assessments: assessment.assessments, candidates }) };
  }
  throw new Error('FEEDBACK_OPERATION_INVALID');
}

async function runDecisionEvaluationCommand() {
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined
    || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const decisionTracePath = arg('--decision-trace-store', process.env.HMCODEX_DECISION_TRACE_STORE
    ?? (scopedTrajectory && trajectoryPath ? trajectoryPath + '.decision-trace.json' : defaultDecisionTraceStore()));
  const runId = arg('--run-id');
  if (!runId) throw new Error('DECISION_EVALUATOR_RUN_ID_REQUIRED');
  const harnessPath = argValue('--harness-event-store') ?? process.env.HMCODEX_HARNESS_EVENT_STORE;
  const eventStore = harnessPath ? createHarnessEventStore({ storagePath: harnessPath }) : undefined;
  if (eventStore) await eventStore.load();
  const trace = createAgentDecisionTrace({ storagePath: decisionTracePath, ...(eventStore ? { eventStore } : {}) });
  await trace.load();
  const operation = command === 'export-learning' ? 'export-learning' : positionalOperation('evaluate');
  if (operation === 'export-learning') return { ok: true, operation, sample: exportLearningSample({ trace, runId }) };
  const evaluation = evaluateDecisionTrace({ trace, runId });
  const metric = arg('--metric');
  if (metric && !['decision-coverage', 'option-coverage', 'evidence-link-rate', 'decision-outcome-link-rate', 'trace-integrity', 'replay-checksum'].includes(metric)) {
    throw new Error('DECISION_METRIC_INVALID');
  }
  const metricResults = {
    'decision-coverage': evaluation.decisionCoverage,
    'option-coverage': evaluation.optionCoverage,
    'evidence-link-rate': evaluation.evidenceLinkRate,
    'decision-outcome-link-rate': evaluation.decisionOutcomeLinkRate,
    'trace-integrity': evaluation.traceIntegrity,
    'replay-checksum': { replayChecksum: evaluation.replayChecksum }
  };
  return {
    ok: true,
    operation: 'evaluate',
    runId,
    ...(metric ? { metric, result: metricResults[metric] } : { evaluation })
  };
}

async function runMetricsCommand() {
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const harnessPath = taskHarnessEventStore(trajectoryPath, scopedTrajectory);
  if (!harnessPath) throw new Error('METRICS_EVENT_STORE_REQUIRED');
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  await eventStore.load();
  const storeSummary = eventStore.summary();
  const verification = await eventStore.verify();
  const commitMetrics = await readCommitMetrics(`${harnessPath}.commit-metrics.json`);
  const commitAttempts = commitMetrics.attempts;
  const commitSuccessRate = commitAttempts > 0 ? commitMetrics.successes / commitAttempts : (verification.ok ? 1 : 0);
  const events = await eventStore.list();
  const replayStartedAt = Date.now();
  const projection = await createReadModelRebuilder({ eventStore }).rebuild();
  const replayDurationMs = Date.now() - replayStartedAt;
  const latestSequenceByRun = {};
  for (const event of events) {
    latestSequenceByRun[event.runId] = Math.max(latestSequenceByRun[event.runId] ?? 0, event.sequence);
  }
  const taskRunIds = new Set(events.filter((event) => event.kind === 'TaskRunCreated').map((event) => event.runId));
  const projectionLag = {};
  for (const [runId, sequence] of Object.entries(latestSequenceByRun)) {
    projectionLag[runId] = Math.max(0, sequence - (projection.lastEventSequence?.[runId] ?? 0));
  }
  const decisionTracePath = arg('--decision-trace-store', process.env.HMCODEX_DECISION_TRACE_STORE
    ?? (scopedTrajectory && trajectoryPath ? trajectoryPath + '.decision-trace.json' : defaultDecisionTraceStore()));
  const trace = createAgentDecisionTrace({ storagePath: decisionTracePath, eventStore });
  await trace.load();
  const decisionSummary = trace.summary();
  const storagePaths = [
    harnessPath,
    decisionTracePath,
    arg('--read-model', process.env.HMCODEX_READ_MODEL_STORE ?? `${harnessPath}.read-model.json`)
  ].filter((value) => typeof value === 'string' && value.trim());
  let storageBytes = 0;
  const storageFiles = [];
  for (const storagePath of storagePaths) {
    try {
      const metadata = await stat(storagePath);
      if (!metadata.isFile()) continue;
      storageBytes += metadata.size;
      storageFiles.push({ path: storagePath, bytes: metadata.size });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return {
    ok: true,
    operation: 'metrics',
    metrics: {
      eventCount: storeSummary.eventCount,
      receiptCount: storeSummary.receiptCount,
      commitAttempts,
      commitSuccesses: commitMetrics.successes,
      commitFailures: commitMetrics.failures,
      commitSuccessRate,
      commitBasis: commitAttempts > 0 ? 'METERED_COMMITS' : 'HARNESS_STORE_VERIFY',
      ...(commitMetrics.lastFailureAtMs === undefined ? {} : { lastCommitFailureAtMs: commitMetrics.lastFailureAtMs }),
      ...(commitMetrics.lastErrorCode === undefined ? {} : { lastCommitErrorCode: commitMetrics.lastErrorCode }),
      projectionLag,
      nonTerminalRuns: (projection.runs ?? []).filter((run) => taskRunIds.has(run.runId) && !run.terminal).length,
      nonTerminalMaintenanceRuns: (projection.runs ?? []).filter((run) => !taskRunIds.has(run.runId) && !run.terminal).length,
      taskRunCount: taskRunIds.size,
      replayDurationMs,
      storageBytes,
      storageFiles,
      decisionCount: decisionSummary.decisionCount,
      outcomeCount: decisionSummary.outcomeCount,
      unlinkedOutcomeCount: Math.max(0, decisionSummary.decisionCount - decisionSummary.outcomeCount),
      runCount: projection.runCount,
      timelineCount: projection.timeline.length
    }
  };
}

async function runExportDataCommand() {
  const outputPath = arg('--output');
  if (!outputPath) throw new Error('EXPORT_DATA_OUTPUT_REQUIRED');
  const runId = argValue('--run-id');
  const threadId = argValue('--thread-id');
  if (runId && threadId) throw new Error('EXPORT_DATA_SCOPE_CONFLICT');
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const harnessPath = taskHarnessEventStore(trajectoryPath, scopedTrajectory);
  if (!harnessPath) throw new Error('EXPORT_DATA_EVENT_STORE_REQUIRED');
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  await eventStore.load();
  let scope;
  let events;
  if (runId) {
    scope = { type: 'RUN', runId };
    events = await eventStore.list({ runId });
  } else if (threadId) {
    const threadPath = arg('--thread-store', process.env.HMCODEX_THREAD_STORE
      ?? (scopedTrajectory && trajectoryPath ? `${trajectoryPath}.threads.json` : defaultThreadStore()));
    const threads = createThreadStore({ storagePath: threadPath });
    await threads.load();
    const thread = await threads.get(threadId);
    if (!thread) throw new Error('EXPORT_DATA_THREAD_NOT_FOUND');
    const runIds = [...new Set([
      ...(Array.isArray(thread.turns) ? thread.turns.map((turn) => turn.runId) : []),
      ...(thread.checkpoint?.runId ? [thread.checkpoint.runId] : [])
    ].filter((value) => typeof value === 'string' && value.trim()))];
    scope = { type: 'THREAD', threadId, runIds };
    events = (await Promise.all(runIds.map((id) => eventStore.list({ runId: id })))).flat();
  } else {
    scope = { type: 'ALL_LOCAL_DATA' };
    events = await eventStore.list();
  }
  const redactedEvents = [];
  const removedPaths = [];
  for (const event of events) {
    const { value, removed } = redactSensitiveData(event);
    redactedEvents.push(value);
    removedPaths.push(...removed);
  }
  const privacyScan = scanSupportBundle({ stores: { events: redactedEvents } });
  if (!privacyScan.ok) {
    const error = new Error(`EXPORT_DATA_PRIVACY_VIOLATION:${privacyScan.violations.map((violation) => violation.path).join(',')}`);
    error.violations = privacyScan.violations;
    throw error;
  }
  const payload = {
    schemaVersion: '1.0',
    exportedAtMs: Date.now(),
    scope,
    eventCount: redactedEvents.length,
    redaction: { removedFieldCount: removedPaths.length, removedPaths: removedPaths.slice(0, 64) },
    events: redactedEvents
  };
  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return {
    ok: true,
    operation: 'export-data',
    outputPath,
    scope,
    eventCount: redactedEvents.length,
    redaction: payload.redaction,
    privacy: { scan: privacyScan }
  };
}

async function runReleaseCheckCommand() {
  const releaseChannel = resolveReleaseChannel();
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const harnessPath = taskHarnessEventStore(trajectoryPath, scopedTrajectory);
  if (!harnessPath) throw new Error('RELEASE_CHECK_EVENT_STORE_REQUIRED');
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  await eventStore.load();
  const verification = await eventStore.verify();
  const projection = await createReadModelRebuilder({ eventStore }).rebuild();
  const decisionTracePath = arg('--decision-trace-store', process.env.HMCODEX_DECISION_TRACE_STORE
    ?? (scopedTrajectory && trajectoryPath ? trajectoryPath + '.decision-trace.json' : defaultDecisionTraceStore()));
  const trace = createAgentDecisionTrace({ storagePath: decisionTracePath, eventStore });
  await trace.load();
  const runIds = [...new Set(trace.list().map((decision) => decision.runId))];
  const evaluations = runIds.map((runId) => evaluateDecisionTrace({ trace, runId }));
  const eligibleEvaluations = evaluations.filter((item) => item.eligibleForLearning);
  const ineligibleEvaluations = evaluations.filter((item) => !item.eligibleForLearning);
  const min = (values) => values.length ? Math.min(...values) : 100;
  const metricsFor = (items) => ({
    runCount: items.length,
    decisionCount: items.reduce((sum, item) => sum + item.decisionCount, 0),
    minDecisionCoverage: min(items.map((item) => item.decisionCoverage.percent)),
    minOptionCoverage: min(items.map((item) => item.optionCoverage.percent)),
    minEvidenceLinkRate: min(items.map((item) => item.evidenceLinkRate.percent)),
    minDecisionOutcomeLinkRate: min(items.map((item) => item.decisionOutcomeLinkRate.percent))
  });
  const eligibleMetrics = metricsFor(eligibleEvaluations);
  const ineligibleMetrics = metricsFor(ineligibleEvaluations);
  const decisionTrace = {
    runCount: runIds.length,
    decisionCount: evaluations.reduce((sum, item) => sum + item.decisionCount, 0),
    eligibleRunCount: eligibleEvaluations.length,
    ineligibleRunCount: ineligibleEvaluations.length,
    ineligibleRunIds: ineligibleEvaluations.map((item) => item.runId),
    eligible: eligibleMetrics,
    ineligible: ineligibleMetrics,
    // Release metrics apply to runs that enter learning/export. Ineligible
    // runs must carry explicit exclusion reasons and are never exported.
    minDecisionCoverage: eligibleMetrics.minDecisionCoverage,
    minOptionCoverage: eligibleMetrics.minOptionCoverage,
    minEvidenceLinkRate: eligibleMetrics.minEvidenceLinkRate,
    minDecisionOutcomeLinkRate: eligibleMetrics.minDecisionOutcomeLinkRate,
    allEligibleForLearning: eligibleEvaluations.every((item) => item.eligibleForLearning),
    allIneligibleExcluded: ineligibleEvaluations.every((item) => item.learningExclusionReasons.length > 0),
    allEligibleComplete: eligibleEvaluations.every((item) => item.decisionCoverage.percent === 100
      && item.optionCoverage.percent === 100
      && item.evidenceLinkRate.percent === 100
      && item.decisionOutcomeLinkRate.percent === 100)
  };
  let sideEffectRejection;
  try {
    assertReleaseExecutionMode('CONTROLLED', releaseChannel);
    sideEffectRejection = { blocked: false };
  } catch (error) {
    sideEffectRejection = { blocked: true, errorCode: error instanceof Error ? error.message : String(error) };
  }
  const versions = {
    storageSchemaVersion: HARNESS_STORAGE_SCHEMA_VERSION,
    protocolVersion: HARNESS_PROTOCOL_VERSION,
    policyVersion: HARNESS_POLICY_VERSION,
    producerVersion: HARNESS_PRODUCER_VERSION,
    appVersion: HARNESS_APP_VERSION
  };
  const privacy = scanSupportBundle({
    schemaVersion: '1.0',
    bundleType: 'HMCODEX_RELEASE_CHECK',
    releaseChannel,
    versions,
    stores: {
      harness: eventStore.summary(),
      projection: {
        projectionVersion: projection.projectionVersion,
        projectionChecksum: projection.projectionChecksum,
        runCount: projection.runCount,
        timelineCount: projection.timeline.length,
        lastEventSequence: projection.lastEventSequence
      },
      decision: trace.summary()
    }
  });
  const capacity = await assessStorageCapacity({ paths: [harnessPath], maxBytes: DEFAULT_MAX_BYTES });
  const checks = {
    releaseChannel: releaseChannel === 'WINDOWS_PHASE1_READ_ONLY' || releaseChannel === 'WINDOWS_PHASE1_5_CONTROLLED',
    sideEffectRejection: releaseChannel === 'WINDOWS_PHASE1_READ_ONLY' ? sideEffectRejection.blocked : !sideEffectRejection.blocked,
    eventStore: verification.ok,
    readModelChecksum: typeof projection.projectionChecksum === 'string' && /^sha256:[0-9a-f]{64}$/u.test(projection.projectionChecksum),
    hasRuns: runIds.length > 0,
    decisionMetrics: decisionTrace.eligibleRunCount > 0
      && decisionTrace.allEligibleComplete
      && decisionTrace.allIneligibleExcluded,
    privacy: privacy.ok,
    capacity: capacity.level !== 'HARD_LIMIT'
  };
  const report = {
    schemaVersion: '1.0',
    generatedAtMs: Date.now(),
    releaseChannel,
    versions,
    eventStore: {
      ok: verification.ok,
      eventCount: verification.eventCount,
      receiptCount: verification.receiptCount,
      tombstoneCount: verification.tombstoneCount
    },
    sideEffectRejection,
    readModel: {
      runCount: projection.runCount,
      timelineCount: projection.timeline.length,
      projectionChecksum: projection.projectionChecksum,
      lastEventSequence: projection.lastEventSequence
    },
    decisionTrace,
    privacy,
    capacity: { level: capacity.level, totalBytes: capacity.totalBytes, maxBytes: capacity.maxBytes, ratio: capacity.ratio },
    checks,
    passed: Object.values(checks).every(Boolean)
  };
  const outputPath = argValue('--output');
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { ok: true, operation: 'release-check', ...(outputPath ? { outputPath } : {}), report };
}

async function runReadModelCommand() {
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const harnessPath = taskHarnessEventStore(trajectoryPath, scopedTrajectory);
  if (!harnessPath) throw new Error('READ_MODEL_EVENT_STORE_REQUIRED');
  const projectionPath = arg('--read-model', process.env.HMCODEX_READ_MODEL_STORE ?? `${harnessPath}.read-model.json`);
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  const rebuilder = createReadModelRebuilder({ eventStore });
  const operation = command === 'rebuild-read-model' ? 'rebuild'
    : command === 'projection-check' ? 'projection-check'
      : command === 'replay-run' ? 'replay-run'
        : positionalOperation('rebuild');
  if (operation === 'rebuild' || operation === 'rebuild-read-model') {
    await assertProjectionOutput(projectionPath, [harnessPath]);
    const projection = await rebuilder.rebuild({ storagePath: projectionPath });
    const timelineLimit = Number(argValue('--timeline-limit') ?? 200);
    const timelineCursor = Number(argValue('--timeline-cursor') ?? 0);
    return {
      ok: true,
      operation: 'rebuild',
      projection,
      ...rebuilder.pageTimeline(projection, { cursor: timelineCursor, limit: timelineLimit })
    };
  }
  if (operation === 'replay-run') {
    const runId = arg('--run-id');
    if (typeof runId !== 'string' || !runId.trim()) throw new Error('READ_MODEL_RUN_ID_REQUIRED');
    const runProjectionPath = `${harnessPath}.run-${sha256Digest(runId).slice(7)}.read-model.json`;
    const outputPath = arg('--output', runProjectionPath);
    await assertProjectionOutput(outputPath, [projectionPath, harnessPath], 'READ_MODEL_REPLAY_OUTPUT_CONFLICT');
    const projection = await rebuilder.replayRun({ runId, storagePath: outputPath });
    return { ok: true, operation: 'replay-run', runId, projection };
  }
  if (operation === 'projection-check' || operation === 'check') {
    return { ok: true, operation: 'projection-check', verification: await rebuilder.projectionCheck({ runId: argValue('--run-id'), storagePath: projectionPath }) };
  }
  throw new Error('READ_MODEL_OPERATION_INVALID');
}

async function runHarnessEventStoreCommand() {
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined
    || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const harnessPath = resolveReleaseChannel() === 'WINDOWS_PHASE1_READ_ONLY'
    ? taskHarnessEventStore(trajectoryPath, scopedTrajectory)
    : arg('--harness-event-store', process.env.HMCODEX_HARNESS_EVENT_STORE
    ?? (!scopedTrajectory ? defaultHarnessEventStore() : (trajectoryPath ? `${trajectoryPath}.harness-events.json` : defaultHarnessEventStore())));
  const store = createHarnessEventStore({ storagePath: harnessPath });
  const operation = positionalOperation('summary');
  if (operation === 'checkpoint' || operation === 'restore') {
    const outputPath = argValue('--output');
    if (!outputPath) throw new Error('HARNESS_CHECKPOINT_OUTPUT_REQUIRED');
    const sourcePath = operation === 'restore' ? argValue('--source') : harnessPath;
    const report = await (operation === 'restore' ? restoreHarnessDatabase : checkpointHarnessDatabase)(sourcePath, outputPath);
    return { ok: true, operation, report };
  }
  if (operation === 'import') {
    const sourcePath = arg('--source', trajectoryPath);
    if (!sourcePath) throw new Error('HARNESS_IMPORT_SOURCE_REQUIRED');
    const sourceFormat = arg('--source-format', 'trajectory-jsonl');
    if (!['trajectory-jsonl', 'harness-json'].includes(sourceFormat)) throw new Error('HARNESS_IMPORT_FORMAT_INVALID');
    const raw = await readFile(sourcePath, 'utf8');
    const imported = sourceFormat === 'harness-json'
      ? await store.importLegacySnapshot(JSON.parse(raw))
      : await store.importLegacyEvents(parseLegacyTrajectoryEvents(raw), { sourceStore: 'trajectory-jsonl' });
    return { ok: true, importedCount: imported.length, summary: store.summary() };
  }
  await store.load();
  if (operation === 'list') return { ok: true, events: await store.list({ runId: argValue('--run-id') }) };
  if (operation === 'verify') return { ok: true, verification: await store.verify() };
  if (operation === 'summary') return { ok: true, summary: store.summary() };
  if (operation === 'retention-worker') {
    const retentionMs = Number(arg('--retention-ms', process.env.HMCODEX_RETENTION_MS ?? String(30 * 24 * 60 * 60 * 1000)));
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new Error('RETENTION_PERIOD_INVALID');
    const intervalMs = parseRetentionWorkerInterval(arg('--interval-ms', process.env.HMCODEX_RETENTION_WORKER_INTERVAL_MS));
    const batchSize = parseRetentionWorkerBatchSize(arg('--batch-size', process.env.HMCODEX_RETENTION_WORKER_BATCH_SIZE));
    const failureLimit = parseRetentionWorkerFailureLimit(arg('--failure-limit', process.env.HMCODEX_RETENTION_WORKER_FAILURE_LIMIT));
    const progressPath = arg('--progress-store', process.env.HMCODEX_RETENTION_PROGRESS_STORE ?? (harnessPath ? `${harnessPath}.retention-progress.json` : undefined));
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const worker = createRetentionWorker({
        intervalMs,
        batchSize,
        failureLimit,
        progressStore: createFileRetentionProgressStore(progressPath),
        listExpired: async () => {
          const nowMs = Date.now();
          const events = await store.list();
          const lastByRun = new Map();
          for (const event of events) {
            const prior = lastByRun.get(event.runId);
            if (!prior || event.observedAtMs > prior) lastByRun.set(event.runId, event.observedAtMs);
          }
          return [...lastByRun].filter(([, lastEventAtMs]) => lastEventAtMs + retentionMs <= nowMs).map(([runId]) => runId);
        },
        purgeRun: (runId) => store.purgeRun(runId, { reason: 'RETENTION_EXPIRED' }),
        emit: (event) => writeStdout(`${JSON.stringify({ type: 'retention_worker', ...event })}\n`)
      });
      const result = await worker.start({ signal: controller.signal });
      return { ok: true, operation, retentionMs, intervalMs, batchSize, failureLimit, progressStore: progressPath ? 'PERSISTED' : 'MEMORY_ONLY', ...result };
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }

  if (operation === 'retention') {
    const retentionMs = Number(arg('--retention-ms', process.env.HMCODEX_RETENTION_MS ?? String(30 * 24 * 60 * 60 * 1000)));
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new Error('RETENTION_PERIOD_INVALID');
    const events = await store.list({ runId: argValue('--run-id') });
    const groups = new Map();
    for (const event of events) {
      const current = groups.get(event.runId) ?? { runId: event.runId, eventCount: 0, firstEventAtMs: event.observedAtMs, lastEventAtMs: event.observedAtMs, lastSequence: 0 };
      current.eventCount += 1;
      current.firstEventAtMs = Math.min(current.firstEventAtMs, event.observedAtMs);
      current.lastEventAtMs = Math.max(current.lastEventAtMs, event.observedAtMs);
      current.lastSequence = Math.max(current.lastSequence, event.sequence);
      groups.set(event.runId, current);
    }
    const runs = [...groups.values()].map((run) => ({ ...run, retentionUntilMs: run.lastEventAtMs + retentionMs }));
    if (!process.argv.includes('--purge-expired')) return { ok: true, operation, retentionMs, runs };
    const nowMs = Number(arg('--now-ms', String(Date.now())));
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('RETENTION_NOW_INVALID');
    const expired = runs.filter((run) => run.retentionUntilMs <= nowMs);
    const purgeLimit = Number(arg('--purge-limit', String(expired.length || 1)));
    if (!Number.isSafeInteger(purgeLimit) || purgeLimit < 1) throw new Error('RETENTION_PURGE_LIMIT_INVALID');
    const purged = [];
    for (const run of expired.slice(0, purgeLimit)) purged.push({ runId: run.runId, ...(await store.purgeRun(run.runId, { reason: 'RETENTION_EXPIRED' })) });
    const remainingExpiredCount = Math.max(0, expired.length - purged.length);
    const readModelPath = arg('--read-model', process.env.HMCODEX_READ_MODEL_STORE ?? (harnessPath ? harnessPath + '.read-model.json' : undefined));
    let projection;
    if (readModelPath && purged.length) {
      const rebuilder = createReadModelRebuilder({ eventStore: store });
      projection = await rebuilder.rebuild({ storagePath: readModelPath });
    }
    return { ok: true, operation, retentionMs, nowMs, runs, expiredCount: expired.length, purgedCount: purged.length, remainingExpiredCount, purged, ...(projection ? { projectionChecksum: projection.projectionChecksum } : {}) };
  }
  if (operation === 'purge') {
    const runId = argValue('--run-id');
    if (!runId) throw new Error('HARNESS_PURGE_RUN_REQUIRED');
    const result = await store.purgeRun(runId, { reason: arg('--reason', 'USER_DELETE') });
    const readModelPath = arg('--read-model', process.env.HMCODEX_READ_MODEL_STORE ?? (harnessPath ? harnessPath + '.read-model.json' : undefined));
    let projection;
    if (readModelPath) {
      const rebuilder = createReadModelRebuilder({ eventStore: store });
      projection = await rebuilder.rebuild({ storagePath: readModelPath });
    }
    return { ok: true, operation, ...result, ...(projection ? { projectionChecksum: projection.projectionChecksum } : {}) };
  }
  throw new Error('HARNESS_EVENT_OPERATION_INVALID');
}

async function runGitAuditCommand() {
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined
    || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const auditPath = arg('--audit-store', process.env.HMCODEX_GIT_AUDIT_STORE
    ?? (scopedTrajectory && trajectoryPath ? `${trajectoryPath}.git-audit.json` : defaultGitAuditStore()));
  const harnessEventStorePath = arg('--harness-event-store', process.env.HMCODEX_HARNESS_EVENT_STORE
    ?? (!scopedTrajectory ? defaultHarnessEventStore() : undefined));
  const trajectory = createTrajectoryStore(trajectoryPath, harnessEventStorePath ? { harnessStoragePath: harnessEventStorePath } : {});
  const audit = createGitAuditStore({ storagePath: auditPath, ...auditSigningOptions() });
  const operation = positionalOperation('list');
  if (operation === 'snapshot') {
    const runId = arg('--run-id', `audit-${randomUUID()}`);
    const observation = await createGitObserver({
      workspaceRoot: canonicalWorkspacePath(arg('--workspace', '')),
      timeoutMs: Number(arg('--timeout-ms', process.env.HMCODEX_GIT_OBSERVER_TIMEOUT_MS ?? '60000')),
      untrackedFiles: arg('--git-observer-untracked', process.env.HMCODEX_GIT_OBSERVER_UNTRACKED ?? 'normal')
    }).snapshot({ reason: argValue('--reason') });
    const event = await trajectory.append({
      runId,
      kind: 'GitStateObserved',
      payload: { observation },
      sensitivity: 'SECURITY_AUDIT'
    });
    const checkpoint = await audit.append({
      runId,
      eventId: event.eventId,
      eventSequence: event.sequence,
      checkpointKind: arg('--checkpoint-kind', 'OBSERVATION'),
      scopeSnapshotDigest: observation.observationDigest,
      observationDigest: observation.observationDigest,
      trajectoryRootDigest: event.recordDigest,
      observation
    });
    return { ok: true, observation, event, checkpoint };
  }
  await audit.load();
  if (operation === 'list') {
    return { ok: true, checkpoints: await audit.list({ runId: argValue('--run-id') }) };
  }
  if (operation === 'show') {
    const checkpointId = arg('--checkpoint-id', arg('--id'));
    if (!checkpointId) throw new Error('GIT_AUDIT_CHECKPOINT_REQUIRED');
    const checkpoint = await audit.get(checkpointId);
    if (!checkpoint) throw new Error('GIT_AUDIT_CHECKPOINT_NOT_FOUND');
    return { ok: true, checkpoint };
  }
  if (operation === 'violations') {
    const checkpoints = await audit.list({ runId: argValue('--run-id') });
    return { ok: true, violations: checkpoints.filter((checkpoint) => ['SCOPE_VIOLATION', 'QUARANTINED'].includes(checkpoint.status) || checkpoint.checkpointKind === 'SCOPE_VIOLATION') };
  }
  if (operation === 'diff') {
    const fromId = arg('--from');
    const toId = arg('--to');
    if (!fromId || !toId) throw new Error('GIT_AUDIT_DIFF_CHECKPOINTS_REQUIRED');
    const from = await audit.get(fromId);
    const to = await audit.get(toId);
    if (!from || !to) throw new Error('GIT_AUDIT_CHECKPOINT_NOT_FOUND');
    const fields = ['status', 'checkpointKind', 'eventSequence', 'scopeSnapshotDigest', 'observationDigest', 'trajectoryRootDigest', 'errorCode'];
    const comparable = (checkpoint, field) => field === 'observationDigest'
      ? (checkpoint.observationDigest ?? checkpoint.scopeSnapshotDigest)
      : checkpoint[field];
    const changed = Object.fromEntries(fields.filter((field) => comparable(from, field) !== comparable(to, field)).map((field) => [field, { from: comparable(from, field) ?? null, to: comparable(to, field) ?? null }]));
    return { ok: true, from: fromId, to: toId, changed, observationChanged: comparable(from, 'observationDigest') !== comparable(to, 'observationDigest') };
  }
  if (operation === 'rebuild') {
    const events = (await trajectory.list()).filter((event) => event.kind === 'GitStateObserved');
    const rebuilt = [];
    for (const event of events) {
      const observation = event.payload?.observation;
      const checkpoint = await audit.append({
        checkpointId: `rebuilt:${event.eventId}`, runId: event.runId, eventId: event.eventId, eventSequence: event.sequence,
        checkpointKind: 'REBUILT', status: event.payload?.errorCode ? 'AUDIT_DEGRADED' : 'READY',
        ...(observation?.observationDigest ? { observationDigest: observation.observationDigest, scopeSnapshotDigest: observation.observationDigest, observation } : {}),
        trajectoryRootDigest: event.recordDigest, errorCode: event.payload?.errorCode
      });
      rebuilt.push(checkpoint);
    }
    return { ok: true, operation, rebuiltCount: rebuilt.length, checkpoints: rebuilt };
  }
  if (operation === 'export') {
    const exportPath = arg('--output');
    if (!exportPath) throw new Error('GIT_AUDIT_EXPORT_PATH_REQUIRED');
    const payload = { schemaVersion: '1.0', exportedAtMs: Date.now(), checkpoints: await audit.list({ runId: argValue('--run-id') }) };
    await writeFile(exportPath, `${JSON.stringify(payload, null, 2)}
`, 'utf8');
    return { ok: true, operation, outputPath: exportPath, checkpointCount: payload.checkpoints.length };
  }
  if (operation === 'verify') {
    return { ok: true, verification: await audit.verify({ events: await trajectory.list() }) };
  }
  throw new Error('GIT_AUDIT_OPERATION_INVALID');
}

async function runMemoryCommand() {
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const phase1 = resolveReleaseChannel() === 'WINDOWS_PHASE1_READ_ONLY';
  const storagePath = arg('--memory-store', process.env.HMCODEX_MEMORY_STORE
    ?? (phase1 && scopedTrajectory && trajectoryPath ? `${trajectoryPath}.memory.json` : defaultMemoryStore()));
  const harnessPath = phase1 ? taskHarnessEventStore(trajectoryPath, scopedTrajectory) : arg('--harness-event-store', process.env.HMCODEX_HARNESS_EVENT_STORE
    ?? (!scopedTrajectory ? defaultHarnessEventStore() : (trajectoryPath ? `${trajectoryPath}.harness-events.json` : defaultHarnessEventStore())));
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  await eventStore.load();
  const journal = createMemoryJournal({ storagePath, eventStore });
  await journal.load();
  const operation = positionalOperation('list');
  if (operation === 'list') return { ok: true, memories: journal.list(argValue('--status')) };
  if (operation === 'get') {
    const memoryId = argValue('--memory-id');
    if (!memoryId) throw new Error('MEMORY_ID_REQUIRED');
    return { ok: true, memory: journal.get(memoryId) };
  }
  if (operation === 'propose') {
    const statement = argValue('--statement');
    if (!statement) throw new Error('MEMORY_STATEMENT_REQUIRED');
    let sourceEventIds = [];
    const sourceArgument = argValue('--source-event-ids');
    if (sourceArgument !== undefined) {
      try { sourceEventIds = JSON.parse(sourceArgument); } catch { throw new Error('MEMORY_SOURCES_INVALID_JSON'); }
      if (!Array.isArray(sourceEventIds)) throw new Error('MEMORY_SOURCES_INVALID');
    }
    if (sourceEventIds.length > 0) {
      const trajectory = scopedTrajectory && !phase1 ? createTrajectoryStore(trajectoryPath) : createTrajectoryStore(trajectoryPath, { harnessEventStore: eventStore });
      const sourceEvents = await trajectory.list();
      const byId = new Map(sourceEvents.map((event) => [event.eventId, event]));
      const missing = sourceEventIds.filter((eventId) => typeof eventId !== 'string' || !byId.has(eventId));
      if (missing.length > 0) throw new Error(`MEMORY_SOURCE_NOT_FOUND:${missing.slice(0, 8).join(',')}`);
      const requestedRunId = argValue('--run-id');
      if (requestedRunId && requestedRunId !== 'manual') {
        const mismatched = sourceEventIds.filter((eventId) => byId.get(eventId)?.runId !== requestedRunId);
        if (mismatched.length > 0) throw new Error('MEMORY_SOURCE_RUN_MISMATCH');
      }
    }
    const record = await journal.proposeDurably({
      runId: argValue('--run-id') ?? 'manual',
      statement,
      sourceEventIds,
      scope: arg('--scope', 'workspace'),
      confidence: Number(arg('--confidence', '0.5'))
    });
    await journal.flush();
    return { ok: true, memory: record };
  }
  if (operation === 'verify') {
    const memoryId = argValue('--memory-id');
    if (!memoryId) throw new Error('MEMORY_ID_REQUIRED');
    const memory = await journal.verifyDurably(memoryId, {
      accepted: parseBoolean(argValue('--accepted'), false),
      reason: arg('--reason', 'REVIEW_REQUIRED')
    });
    await journal.flush();
    return { ok: true, memory };
  }
  if (operation === 'delete') {
    const memoryId = argValue('--memory-id');
    if (!memoryId) throw new Error('MEMORY_ID_REQUIRED');
    const memory = await journal.deleteDurably(memoryId);
    await journal.flush();
    return { ok: true, memory };
  }
  if (operation === 'activate') {
    const memoryId = argValue('--memory-id');
    if (!memoryId) throw new Error('MEMORY_ID_REQUIRED');
    const memory = await journal.activateDurably(memoryId);
    await journal.flush();
    return { ok: true, memory };
  }
  if (operation === 'retract') {
    const memoryId = argValue('--memory-id');
    if (!memoryId) throw new Error('MEMORY_ID_REQUIRED');
    const memory = await journal.retractDurably(memoryId, arg('--reason', 'USER_REVOKED'));
    await journal.flush();
    return { ok: true, memory };
  }
  if (operation === 'expire') {
    const memories = journal.expire({ now: Number(arg('--now', String(Date.now()))) });
    await journal.flush();
    return { ok: true, memories };
  }
  if (operation === 'decay') {
    const memories = journal.decay({
      now: Number(arg('--now', String(Date.now()))),
      halfLifeMs: Number(arg('--half-life-ms', String(30 * 24 * 60 * 60 * 1000))),
      minConfidence: Number(arg('--min-confidence', '0.05'))
    });
    await journal.flush();
    return { ok: true, memories };
  }
  if (operation === 'prune') {
    const memories = journal.prune({
      beforeMs: Number(arg('--before-ms', String(Date.now()))),
      limit: Number(arg('--limit', '256'))
    });
    await journal.flush();
    return { ok: true, memories };
  }
  throw new Error('MEMORY_OPERATION_INVALID');
}

async function runExecutionStateCommand() {
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const storagePath = arg('--execution-state-store', process.env.HMCODEX_EXECUTION_STATE_STORE ?? (trajectoryPath ? `${trajectoryPath}.execution.json` : undefined));
  const store = createExecutionStateStore({ storagePath });
  await store.load();
  const operation = positionalOperation('list');
  if (operation === 'list') {
    const recordType = argValue('--record-type');
    if (recordType && !['intent', 'approval', 'lease'].includes(recordType)) throw new Error('EXECUTION_RECORD_TYPE_INVALID');
    return { ok: true, records: store.list(recordType) };
  }
  if (operation === 'get') {
    const recordId = argValue('--record-id');
    if (!recordId) throw new Error('EXECUTION_RECORD_ID_REQUIRED');
    const record = store.get(recordId);
    if (!record) throw new Error('EXECUTION_STATE_NOT_FOUND');
    return { ok: true, record };
  }
  if (operation === 'reconcile') return { ok: true, ...(await store.reconcile()) };
  throw new Error('EXECUTION_OPERATION_INVALID');
}

// Startup recovery is deliberately separate from `task`: the desktop can
// reconcile records left by a lost Node owner before accepting new work. It
// only closes orphaned approvals/leases/contexts and never replays a task or
// side effect automatically.
async function runRecoveryCommand() {
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined
    || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const harnessEventStorePath = taskHarnessEventStore(trajectoryPath, scopedTrajectory);
  const trajectory = createTrajectoryStore(trajectoryPath, harnessEventStorePath ? { harnessStoragePath: harnessEventStorePath } : {});
  const recoveryRunId = arg('--run-id', 'recovery-' + randomUUID());
  const scopedStorePath = (suffix, fallback) => scopedTrajectory && trajectoryPath
    ? `${trajectoryPath}.${suffix}`
    : fallback();
  const executionStatePath = arg('--execution-state-store', process.env.HMCODEX_EXECUTION_STATE_STORE
    ?? (harnessEventStorePath ? `${harnessEventStorePath}.execution-read-model.json` : (scopedTrajectory && trajectoryPath ? `${trajectoryPath}.execution.json` : undefined)));
  const roleContextPath = arg('--role-context-store', process.env.HMCODEX_ROLE_CONTEXT_STORE
    ?? scopedStorePath('role-contexts.json', defaultRoleContextStore));
  const dreamPath = arg('--dream-store', process.env.HMCODEX_DREAM_STORE
    ?? scopedStorePath('dream.json', defaultDreamStore));
  const execution = createExecutionStateStore({ storagePath: executionStatePath, eventStore: trajectory.harnessEventStore });
  const roleSessions = createRoleSessionManager({ storagePath: roleContextPath, eventStore: trajectory.harnessEventStore });
  const dream = createDreamScheduler({ storagePath: dreamPath, eventStore: trajectory.harnessEventStore });
  await trajectory.append({ runId: recoveryRunId, kind: 'RecoveryStarted', payload: { recoveryRunId }, sensitivity: 'SECURITY_AUDIT' });
  const recoveryWorkspace = argValue('--workspace');
  if (recoveryWorkspace) {
    try {
      const observation = await createGitObserver({
        workspaceRoot: canonicalWorkspacePath(recoveryWorkspace),
        timeoutMs: Number(arg('--timeout-ms', process.env.HMCODEX_GIT_OBSERVER_TIMEOUT_MS ?? '60000')),
        untrackedFiles: arg('--git-observer-untracked', process.env.HMCODEX_GIT_OBSERVER_UNTRACKED ?? 'normal')
      }).snapshot({ reason: 'RECOVERY' });
      const event = await trajectory.append({ runId: recoveryRunId, kind: 'GitStateObserved', payload: { checkpointKind: 'RECOVERY', observation }, sensitivity: 'SECURITY_AUDIT' });
      const auditPath = arg('--audit-store', process.env.HMCODEX_GIT_AUDIT_STORE ?? (harnessEventStorePath ? `${harnessEventStorePath}.git-audit.json` : defaultGitAuditStore()));
      const audit = createGitAuditStore({ storagePath: auditPath, ...auditSigningOptions() });
      await audit.load();
      await audit.append({ runId: recoveryRunId, eventId: event.eventId, eventSequence: event.sequence, checkpointKind: 'RECOVERY', status: 'READY', observationDigest: observation.observationDigest, trajectoryRootDigest: event.recordDigest, observation });
    } catch (error) {
      await trajectory.append({ runId: recoveryRunId, kind: 'GitStateObserved', payload: { checkpointKind: 'RECOVERY', errorCode: error instanceof Error ? error.message.slice(0, 120) : 'GIT_OBSERVER_FAILED' }, sensitivity: 'SECURITY_AUDIT' });
    }
  }
  await Promise.all([execution.load(), roleSessions.load(), dream.load()]);
  const [executionResult, roleResult, dreamResult] = await Promise.all([
    execution.reconcile(),
    roleSessions.reconcile(),
    dream.reconcile()
  ]);
  const result = {
    ok: true,
    reconciled: executionResult.reconciled + roleResult.reconciled + dreamResult.reconciled,
    execution: executionResult,
    roles: roleResult,
    dream: dreamResult
  };
  await trajectory.append({ runId: recoveryRunId, kind: 'RecoveryCompleted', payload: { recoveryRunId, reconciled: result.reconciled }, sensitivity: 'SECURITY_AUDIT' });
  return result;
}

const dreamCandidatesFromEvents = (events) => {
  const grouped = new Map();
  for (const event of events) {
    const list = grouped.get(event?.runId) ?? [];
    if (event?.eventId) list.push(event);
    grouped.set(event?.runId, list);
  }
  const candidates = [];
  for (const [runId, runEvents] of grouped) {
    if (typeof runId !== 'string' || !runEvents.some((event) => event.kind === 'TaskRunCompleted')) continue;
    const route = runEvents.find((event) => event.kind === 'ModelRouteResolved')?.payload ?? {};
    const snapshot = runEvents.find((event) => event.kind === 'WorkspaceSnapshotCreated')?.payload ?? {};
    const completed = runEvents.find((event) => event.kind === 'TaskRunCompleted')?.payload ?? {};
    const provider = typeof route.provider === 'string' ? route.provider.slice(0, 80) : 'unknown';
    const protocol = typeof route.protocol === 'string' ? route.protocol.slice(0, 80) : 'unknown';
    const model = typeof route.model === 'string' ? route.model.slice(0, 120) : 'unknown';
    const entryCount = Number.isInteger(snapshot.entryCount) ? snapshot.entryCount : 0;
    const toolCalls = Number.isInteger(completed.toolCallCount) ? completed.toolCallCount : 0;
    candidates.push({
      runId,
      statement: `Verified run used ${provider}/${protocol}/${model}; workspace entries=${entryCount}; toolCalls=${toolCalls}.`,
      sourceEventIds: runEvents.map((event) => event.eventId).slice(-8),
      scope: 'workspace',
      confidence: 0.5
    });
  }
  return candidates.slice(-32);
};

const readDreamActiveRuns = async () => {
  const path = argValue('--active-runs-file') ?? process.env.HMCODEX_DREAM_ACTIVE_RUNS_FILE;
  if (!path) return Number(arg('--active-runs', '1'));
  try {
    const text = await readFile(path, 'utf8');
    const value = parseDreamActiveRuns(text);
    if (value !== undefined) return value;
  } catch {
    // A missing or unreadable activity file must block automatic Dreaming.
  }
  return 1;
};

const dreamGateOptions = (sourceEventCount, { daemon = false, activeRuns } = {}) => ({
  idle: parseBoolean(argValue('--idle'), true),
  safetyAllowed: parseBoolean(argValue('--safety-allowed'), true),
  // A long-lived daemon fails closed unless the caller explicitly asserts
  // that no high-priority task is active. One-shot CLI runs retain the
  // historical default of zero active runs.
  activeRuns: Number.isInteger(activeRuns)
    ? activeRuns
    : Number(arg('--active-runs', daemon ? '1' : '0')),
  sessionCount: Number(arg('--session-count', String(sourceEventCount))),
  minSessions: Number(arg('--min-sessions', '0')),
  minutesSinceLastRun: argValue('--minutes-since-last-run') === undefined ? undefined : Number(argValue('--minutes-since-last-run')),
  minIntervalMinutes: argValue('--min-interval-minutes') === undefined ? undefined : Number(argValue('--min-interval-minutes'))
});

const runDreamCycle = async ({ trajectory, journal, scheduler, memoryVerifier, projectId, daemon = false }) => {
  const sourceEvents = await trajectory.list();
  const activeRuns = daemon ? await readDreamActiveRuns() : undefined;
  const result = await scheduler.run({
    projectId,
    gates: dreamGateOptions(sourceEvents.length, { daemon, activeRuns }),
    orient: async () => ({
      sourceEventCount: sourceEvents.length,
      activeMemoryCount: journal.list('ACTIVE').length,
      proposedMemoryCount: journal.list('PROPOSED').length
    }),
    gather: async () => dreamCandidatesFromEvents(sourceEvents),
    consolidate: async (candidates) => {
      const seen = new Set();
      return candidates.filter((candidate) => {
        const identity = `${candidate.scope ?? 'workspace'}::${String(candidate.statement).replace(/\s+/g, ' ').trim().toLowerCase()}`;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
      });
    },
    verify: async (candidates) => memoryVerifier.verify({
      candidates,
      sourceEvents,
      existingMemories: journal.list()
    }),
    // Automatic Dream never activates memory. Review accepts only the
    // verifier-approved proposals; the user still must run memory verify and
    // activate explicitly.
    review: async (reports) => reports.filter((report) => report?.verification?.accepted === true),
    prune: async (accepted) => accepted
  });
  const memories = [];
  for (const candidate of result.candidates ?? []) memories.push(await journal.proposeDurably(candidate));
  await Promise.all([journal.flush(), scheduler.flush()]);
  return { ok: true, dream: result, proposedMemories: memories };
};

async function runDreamCommand() {
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const phase1 = resolveReleaseChannel() === 'WINDOWS_PHASE1_READ_ONLY';
  const memoryPath = arg('--memory-store', process.env.HMCODEX_MEMORY_STORE
    ?? (phase1 && scopedTrajectory && trajectoryPath ? `${trajectoryPath}.memory.json` : defaultMemoryStore()));
  const dreamPath = arg('--dream-store', process.env.HMCODEX_DREAM_STORE
    ?? (phase1 && scopedTrajectory && trajectoryPath ? `${trajectoryPath}.dream.json` : defaultDreamStore()));
  const harnessPath = phase1 ? taskHarnessEventStore(trajectoryPath, scopedTrajectory)
    : arg('--harness-event-store', process.env.HMCODEX_HARNESS_EVENT_STORE ?? defaultHarnessEventStore());
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  await eventStore.load();
  const trajectory = scopedTrajectory && !phase1 ? createTrajectoryStore(trajectoryPath) : createTrajectoryStore(trajectoryPath, { harnessEventStore: eventStore });
  const journal = createMemoryJournal({ storagePath: memoryPath, eventStore: scopedTrajectory && !phase1 ? undefined : eventStore });
  const projectId = arg('--project-id', process.env.HMCODEX_PROJECT_ID ?? 'default');
  const scheduler = createDreamScheduler({ storagePath: dreamPath, projectId, eventStore });
  const memoryVerifier = createMemoryVerifier();
  await Promise.all([journal.load(), scheduler.load()]);
  const operation = positionalOperation('run');
  if (operation === 'list') return { ok: true, runs: await scheduler.list() };
  if (operation === 'run') return runDreamCycle({ trajectory, journal, scheduler, memoryVerifier, projectId });
  if (operation !== 'daemon') throw new Error('DREAM_OPERATION_INVALID');

  const intervalMs = parseDreamMaintenanceInterval(arg('--interval-ms', process.env.HMCODEX_DREAM_DAEMON_INTERVAL_MS));
  const failureLimit = parseDreamMaintenanceFailureLimit(arg('--failure-limit', process.env.HMCODEX_DREAM_DAEMON_FAILURE_LIMIT));
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const supervisor = createDreamMaintenanceSupervisor({
      intervalMs,
      failureLimit,
      runOnce: () => runDreamCycle({ trajectory, journal, scheduler, memoryVerifier, projectId, daemon: true }),
      emit: (event) => {
        writeStdout(`${JSON.stringify({ type: 'dream_maintenance', ...event })}\n`);
      }
    });
    const maintenance = await supervisor.start({ signal: controller.signal });
    return { ok: true, maintenance, runs: await scheduler.list() };
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

const pluginOperation = () => {
  const explicit = argValue('--operation');
  if (explicit) return explicit;
  const positional = process.argv[3];
  return positional && !positional.startsWith('--') ? positional : 'list';
};

const positionalOperation = (fallback) => {
  const explicit = argValue('--operation');
  if (explicit) return explicit;
  const positional = process.argv[3];
  return positional && !positional.startsWith('--') ? positional : fallback;
};

const parseJsonObjectArgument = (name, fallback = {}) => {
  const value = argValue(name);
  if (value === undefined) return fallback;
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('PLUGIN_METADATA_INVALID_JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('PLUGIN_METADATA_INVALID');
  }
  return parsed;
};

const readPluginManifest = async () => {
  const manifestPath = argValue('--manifest-path');
  const manifestArgument = argValue('--manifest');
  if (!manifestPath && manifestArgument === undefined) throw new Error('PLUGIN_MANIFEST_REQUIRED');
  let raw;
  if (manifestPath) {
    try {
      raw = await readFile(manifestPath, 'utf8');
    } catch {
      throw new Error('PLUGIN_MANIFEST_UNAVAILABLE');
    }
  } else if (manifestArgument.trim().startsWith('{') || manifestArgument.trim().startsWith('[')) {
    raw = manifestArgument;
  } else {
    try {
      raw = await readFile(manifestArgument, 'utf8');
    } catch {
      throw new Error('PLUGIN_MANIFEST_UNAVAILABLE');
    }
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('PLUGIN_MANIFEST_INVALID_JSON');
  }
};

async function runPluginCommand() {
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const phase1 = resolveReleaseChannel() === 'WINDOWS_PHASE1_READ_ONLY';
  const storagePath = arg(
    '--plugin-store',
    arg('--governance-store', process.env.HMCODEX_PLUGIN_GOVERNANCE_STORE
      ?? process.env.HMCODEX_PLUGIN_STORE
      ?? (phase1 && scopedTrajectory && trajectoryPath ? `${trajectoryPath}.plugin-governance.json` : defaultPluginGovernanceStore()))
  );
  const scopedPluginStore = argValue('--plugin-store') !== undefined
    || argValue('--governance-store') !== undefined
    || Boolean(process.env.HMCODEX_PLUGIN_GOVERNANCE_STORE?.trim() || process.env.HMCODEX_PLUGIN_STORE?.trim());
  const harnessPath = arg('--harness-event-store', process.env.HMCODEX_HARNESS_EVENT_STORE
    ?? (phase1 ? taskHarnessEventStore(trajectoryPath, scopedTrajectory) : scopedPluginStore ? storagePath + '.harness-events.db' : defaultHarnessEventStore()));
  if (phase1) assertReleaseHarnessStore(harnessPath);
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  await eventStore.load();
  const operation = pluginOperation();
  const pluginId = argValue('--plugin-id') ?? argValue('--id');
  if (['validate', 'transition', 'load', 'revoke'].includes(operation) && !pluginId) {
    throw new Error('PLUGIN_ID_REQUIRED');
  }
  const requestedState = operation === 'transition' ? (argValue('--state') ?? argValue('--to')) : undefined;
  if (operation === 'transition' && !requestedState) throw new Error('PLUGIN_STATE_REQUIRED');
  // Validate user input before opening governance/evaluation stores so a
  // malformed request has one deterministic error and performs no I/O.
  const transitionMetadata = operation === 'transition'
    ? parseJsonObjectArgument('--metadata')
    : undefined;
  let promotionEvaluator;
  if (requestedState === 'ACTIVE') {
    const proposalPath = arg('--evolution-store', process.env.HMCODEX_EVOLUTION_STORE ?? defaultEvolutionStore());
    const reportPath = arg('--evaluation-store', process.env.HMCODEX_EVALUATION_STORE ?? defaultEvolutionEvaluationStore());
    const [{ EvolutionRegistry }, { EvolutionEvaluator }] = await Promise.all([
      import('./plugins/evolution-registry.mjs'),
      import('./evolution-evaluator.mjs')
    ]);
    const registry = new EvolutionRegistry({ storagePath: proposalPath, eventStore });
    await registry.load();
    const promotionControl = new EvolutionControlStore({ eventStore });
    await promotionControl.load();
    promotionEvaluator = new EvolutionEvaluator({ registry, storagePath: reportPath, eventStore, control: promotionControl });
    await promotionEvaluator.load();
  }
  const governance = createPluginGovernance({
    storagePath,
    eventStore,
    requireEvaluation: Boolean(promotionEvaluator),
    evaluationVerifier: ({ plugin, evidence }) => promotionEvaluator?.verifyPluginPromotion({
      ...evidence,
      pluginId: plugin.pluginId,
      packageDigest: plugin.packageDigest
    }) === true
  });
  await governance.load();
  if (operation === 'list') {
    return {
      ok: true,
      plugins: governance.list(),
      loaded: []
    };
  }

  if (operation === 'discover') {
    const pluginRoot = arg('--plugin-root', process.env.HMCODEX_PLUGIN_ROOT ?? defaultPluginRoot());
    if (!pluginRoot) throw new Error('PLUGIN_ROOT_REQUIRED');
    const manifest = await readPluginManifest();
    const entryPath = argValue('--entry-path') ?? argValue('--entry') ?? manifest.entryPath;
    if (!entryPath) throw new Error('PLUGIN_ENTRYPOINT_REQUIRED');
    const registry = new PluginRegistry();
    const loader = createDynamicPluginLoader({ rootDir: pluginRoot, governance, registry });
    const plugin = await loader.discover({
      manifest,
      entryPath,
      ...(argValue('--package-digest') !== undefined ? { packageDigest: argValue('--package-digest') } : {}),
      ...(argValue('--plugin-signature') !== undefined || argValue('--plugin-public-key') !== undefined ? {
        signature: {
          algorithm: 'ed25519',
          manifestDigest: pluginGovernanceDigest(manifest),
          publicKey: argValue('--plugin-public-key') ?? '',
          signature: argValue('--plugin-signature') ?? ''
        }
      } : {})
    });
    await governance.flush();
    return { ok: true, plugin };
  }

  if (operation === 'validate') {
    const plugin = governance.hasDurableSink ? await governance.validateDurably(pluginId, {
      ...(argValue('--expected-digest') !== undefined ? { expectedDigest: argValue('--expected-digest') } : {})
    }) : governance.validate(pluginId, {
      ...(argValue('--expected-digest') !== undefined ? { expectedDigest: argValue('--expected-digest') } : {})
    });
    await governance.flush();
    return { ok: true, plugin };
  }
  if (operation === 'transition') {
    const plugin = governance.hasDurableSink
      ? await governance.transitionDurably(pluginId, requestedState, transitionMetadata)
      : governance.transition(pluginId, requestedState, transitionMetadata);
    await governance.flush();
    return { ok: true, plugin };
  }
  if (operation === 'load') {
    const pluginRoot = arg('--plugin-root', process.env.HMCODEX_PLUGIN_ROOT ?? defaultPluginRoot());
    if (!pluginRoot) throw new Error('PLUGIN_ROOT_REQUIRED');
    const registry = new PluginRegistry();
    const loader = createDynamicPluginLoader({ rootDir: pluginRoot, governance, registry });
    await loader.load(pluginId);
    return {
      ok: true,
      plugin: governance.get(pluginId),
      loaded: loader.get(pluginId),
      registry: registry.list()
    };
  }
  if (operation === 'revoke') {
    const plugin = await governance.revoke(pluginId, argValue('--reason') ?? 'REVOKED');
    await governance.flush();
    return { ok: true, plugin };
  }
  throw new Error('PLUGIN_OPERATION_INVALID');
}

const readJsonValue = async (name, { required = true } = {}) => {
  const filePath = argValue(name);
  if (filePath === undefined) {
    if (required) throw new Error(`${name.replace(/^--/, '').toUpperCase().replace(/-/g, '_')}_REQUIRED`);
    return undefined;
  }
  let raw;
  try { raw = await readFile(filePath, 'utf8'); } catch { throw new Error('EVOLUTION_FIXTURES_UNAVAILABLE'); }
  try { return JSON.parse(raw); } catch { throw new Error('EVOLUTION_FIXTURES_INVALID_JSON'); }
};

async function runEvolutionCommand() {
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const phase1 = resolveReleaseChannel() === 'WINDOWS_PHASE1_READ_ONLY';
  const proposalPath = arg('--evolution-store', process.env.HMCODEX_EVOLUTION_STORE
    ?? (phase1 && scopedTrajectory && trajectoryPath ? `${trajectoryPath}.evolution-proposals.json` : defaultEvolutionStore()));
  const reportPath = arg('--evaluation-store', process.env.HMCODEX_EVALUATION_STORE
    ?? (phase1 && scopedTrajectory && trajectoryPath ? `${trajectoryPath}.evolution-evaluations.json` : defaultEvolutionEvaluationStore()));
  const harnessPath = phase1 ? taskHarnessEventStore(trajectoryPath, scopedTrajectory)
    : arg('--harness-event-store', process.env.HMCODEX_HARNESS_EVENT_STORE ?? defaultHarnessEventStore());
  const eventStore = createHarnessEventStore({ storagePath: harnessPath });
  await eventStore.load();
  const [{ EvolutionRegistry }, { EvolutionEvaluator }] = await Promise.all([
    import('./plugins/evolution-registry.mjs'),
    import('./evolution-evaluator.mjs')
  ]);
  const registry = new EvolutionRegistry({ storagePath: proposalPath, eventStore });
  await registry.load();
  const evolutionControl = new EvolutionControlStore({ eventStore });
  await evolutionControl.load();
  const evaluator = new EvolutionEvaluator({ registry, storagePath: reportPath, eventStore, control: evolutionControl });
  await evaluator.load();
  const operation = positionalOperation('list');
  if (operation === 'list') return {
    ok: true,
    proposals: registry.list(),
    reports: evaluator.list(),
    outcomes: evaluator.listOutcomes(),
    control: evaluator.controlState()
  };
  if (operation === 'cohort') {
    return {
      ok: true,
      cohort: evaluator.cohort({
        ...(argValue('--run-id') !== undefined ? { runId: argValue('--run-id') } : {}),
        ...(argValue('--proposal-id') !== undefined ? { proposalId: argValue('--proposal-id') } : {}),
        ...(argValue('--task-class') !== undefined ? { taskClass: argValue('--task-class') } : {}),
        ...(argValue('--provider') !== undefined ? { provider: argValue('--provider') } : {}),
        ...(argValue('--protocol') !== undefined ? { protocol: argValue('--protocol') } : {}),
        ...(argValue('--model') !== undefined ? { model: argValue('--model') } : {}),
        ...(argValue('--from-ms') !== undefined ? { fromMs: argValue('--from-ms') } : {}),
        ...(argValue('--to-ms') !== undefined ? { toMs: argValue('--to-ms') } : {}),
        ...(argValue('--limit') !== undefined ? { limit: argValue('--limit') } : {})
      })
    };
  }
  if (operation === 'kill' || operation === 'enable') {
    const result = operation === 'kill'
      ? await evolutionControl.kill({
          reason: argValue('--reason') ?? 'MANUAL_KILL_SWITCH',
          actor: argValue('--actor') ?? 'OPERATOR'
        })
      : await evolutionControl.enable({
          reason: argValue('--reason') ?? 'MANUAL_RECOVERY',
          actor: argValue('--actor') ?? 'OPERATOR'
        });
    return { ok: true, operation, ...result };
  }
  if (operation === 'propose') {
    await evolutionControl.assertEnabled('PROPOSAL');
    const proposal = await registry.propose(await readJsonValue('--proposal'));
    return { ok: true, proposal };
  }
  if (operation === 'propose-from-outcome' || operation === 'propose-outcome') {
    const outcomeId = argValue('--outcome-id');
    if (!outcomeId) throw new Error('EVOLUTION_OUTCOME_ID_REQUIRED');
    const generated = await evaluator.proposeFromOutcome({ outcomeId });
    await evaluator.flush();
    return { ok: true, ...generated };
  }
  const proposalId = argValue('--proposal-id');
  if (!proposalId) throw new Error('EVOLUTION_PROPOSAL_ID_REQUIRED');
  if (operation === 'transition') {
    const state = argValue('--state') ?? argValue('--to');
    if (!state) throw new Error('EVOLUTION_STATE_REQUIRED');
    // ACTIVE is a promotion decision, not a generic lifecycle edit. Keep the
    // evaluator as the sole path that can cross the promotion gate so a CLI
    // caller cannot bypass replay/shadow/canary and safety checks.
    if (state === 'ACTIVE') throw new Error('EVOLUTION_PROMOTION_REQUIRED');
    return { ok: true, proposal: await registry.transition(proposalId, state, parseJsonObjectArgument('--metadata')) };
  }
  if (operation === 'rollback') return { ok: true, proposal: await evaluator.rollback(proposalId, arg('--reason', 'MANUAL_ROLLBACK')) };
  if (operation === 'monitor') {
    const result = await evaluator.monitor({
      proposalId,
      minSamples: Number(arg('--min-samples', '3')),
      maxSafetyIncidents: Number(arg('--max-safety-incidents', '0')),
      ...(argValue('--expected-version') !== undefined ? { expectedVersion: argValue('--expected-version') } : {}),
      ...(argValue('--expected-package-digest') !== undefined ? { expectedPackageDigest: argValue('--expected-package-digest') } : {}),
      options: {
        minSuccessDelta: Number(arg('--min-success-delta', '0')),
        maxCostMultiplier: Number(arg('--max-cost-multiplier', '2')),
        maxLatencyMultiplier: Number(arg('--max-latency-multiplier', '2.5'))
      }
    });
    await evaluator.flush();
    return { ok: true, ...result };
  }
  const fixturesValue = await readJsonValue('--fixtures', { required: false });
  let fixtures;
  let datasetKind = argValue('--dataset-kind') ?? 'DEV';
  let datasetVersion = argValue('--dataset-version') ?? '1.0';
  if (fixturesValue !== undefined) {
    const dataset = Array.isArray(fixturesValue)
      ? { datasetKind, datasetVersion, cases: fixturesValue }
      : fixturesValue;
    if (!dataset || !Array.isArray(dataset.cases)) throw new Error('EVOLUTION_FIXTURES_INVALID');
    fixtures = dataset.cases;
    datasetKind = dataset.datasetKind ?? datasetKind;
    datasetVersion = dataset.datasetVersion ?? datasetVersion;
  }
  if (operation === 'replay') {
    if (!fixtures) throw new Error('EVOLUTION_FIXTURES_REQUIRED');
    const report = await evaluator.replay({ proposalId, fixtures, datasetKind, datasetVersion, options: { minSuccessDelta: Number(arg('--min-success-delta', '0')) } });
    await evaluator.flush();
    return { ok: true, report };
  }
  if (operation === 'shadow') {
    if (!fixtures) throw new Error('EVOLUTION_FIXTURES_REQUIRED');
    const result = await evaluator.shadow({ proposalId, fixtures, datasetKind, datasetVersion, options: { minSuccessDelta: Number(arg('--min-success-delta', '0')) } });
    await evaluator.flush();
    return { ok: true, ...result };
  }
  if (operation === 'canary') {
    const result = await evaluator.canary(proposalId, {
      ...(fixtures ? { fixtures } : {}),
      datasetKind,
      datasetVersion,
      eligibleTrafficPercent: Number(arg('--traffic-percent', '5'))
    });
    await evaluator.flush();
    return { ok: true, ...result };
  }
  if (operation === 'promote') {
    const requireHoldout = process.argv.includes('--require-holdout') || parseBoolean(argValue('--require-holdout'), false);
    const result = await evaluator.promote(proposalId, {
      ...(fixtures ? { fixtures } : {}),
      datasetKind,
      datasetVersion,
      requireHoldout
    });
    await evaluator.flush();
    return { ok: true, ...result };
  }
  throw new Error('EVOLUTION_OPERATION_INVALID');
}

async function runTools() {
  const workspaceRoot = canonicalWorkspacePath(arg('--workspace', ''));
  const [{ ReadonlyWorkspace }, { createReadonlyToolRegistry }] = await Promise.all([
    import('./plugins/workspace-readonly.mjs'),
    import('./tool-registry.mjs')
  ]);
  const workspace = new ReadonlyWorkspace(workspaceRoot);
  const registry = createReadonlyToolRegistry(workspace);
  const toolName = argValue('--tool');
  if (!toolName) {
    return {
      ok: true,
      workspace: { granted: Boolean(workspaceRoot) },
      tools: registry.list()
    };
  }
  const inputText = argValue('--input');
  let input = {};
  if (inputText !== undefined) {
    try {
      input = JSON.parse(inputText);
    } catch {
      throw new Error('TOOL_INVALID_INPUT_JSON');
    }
  }
  return {
    ok: true,
    tool: toolName,
    result: await registry.invoke(toolName, input),
    tools: registry.list()
  };
}

async function runThreadCommand() {
  const threadPath = arg('--thread-store', process.env.HMCODEX_THREAD_STORE ?? defaultThreadStore());
  const threads = createThreadStore({ storagePath: threadPath });
  const operation = positionalOperation('list');
  await threads.load();
  if (operation === 'list') return { ok: true, threads: await threads.list() };
  if (operation === 'get' || operation === 'resume') {
    const threadId = argValue('--thread-id');
    if (!threadId) throw new Error('THREAD_ID_REQUIRED');
    const thread = await threads.get(threadId);
    if (!thread) throw new Error('THREAD_NOT_FOUND');
    return { ok: true, thread };
  }
  if (operation === 'create') {
    return {
      ok: true,
      thread: await threads.create({
        cwd: canonicalWorkspacePath(arg('--workspace', '')),
        title: arg('--title', 'New thread')
      })
    };
  }
  if (operation === 'fork') {
    const threadId = argValue('--thread-id');
    if (!threadId) throw new Error('THREAD_ID_REQUIRED');
    return {
      ok: true,
      thread: await threads.fork(threadId, { title: argValue('--title') })
    };
  }
  throw new Error('THREAD_OPERATION_INVALID');
}

async function runThreadEventsCommand() {
  const threadId = argValue('--thread-id');
  if (!threadId) throw new Error('THREAD_ID_REQUIRED');
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const harnessPath = taskHarnessEventStore(trajectoryPath, scopedTrajectory);
  const threadPath = arg('--thread-store', process.env.HMCODEX_THREAD_STORE
    ?? (scopedTrajectory && trajectoryPath ? `${trajectoryPath}.threads.json` : defaultThreadStore()));
  const threads = createThreadStore({ storagePath: threadPath });
  await threads.load();
  const thread = await threads.get(threadId);
  if (!thread) throw new Error('THREAD_NOT_FOUND');
  const runIds = new Set(
    (Array.isArray(thread.turns) ? thread.turns : [])
      .map((turn) => turn?.runId)
      .filter((runId) => typeof runId === 'string' && runId.trim())
  );
  const trajectory = createTrajectoryStore(trajectoryPath, harnessPath ? { harnessStoragePath: harnessPath } : {});
  const events = await trajectory.list();
  return {
    ok: true,
    threadId: thread.id,
    events: events
      .filter((event) => runIds.has(event.runId))
      .map((event) => ({
        eventId: event.eventId,
        type: 'runtime_event',
        schemaVersion: '1.0',
        runId: event.runId,
        sequence: event.sequence,
        kind: `history.${String(event.kind)
          .replace(/([a-z0-9])([A-Z])/g, '$1.$2')
          .replace(/[^A-Za-z0-9_.-]/g, '.')
          .toLowerCase()}`,
        payload: {
          ...(event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {}),
          persistedKind: event.kind
        },
        emittedAtMs: event.emittedAtMs
      }))
  };
}

async function runHealth() {
  const releaseChannel = resolveReleaseChannel();
  const configArgument = argValue('--config');
  const environmentConfigPath = process.env.HMCODEX_MODEL_CONFIG?.trim() || undefined;
  const configuredPath = configArgument ?? environmentConfigPath ?? defaultModelConfigPath();
  const fileConfig = await loadModelConfig(configuredPath, {
    required: configArgument !== undefined || environmentConfigPath !== undefined
  });
  const modelConfig = resolveModelConfig({ fileConfig, overrides: modelOverridesFromArgs() });
  return {
    ok: true,
    runtime: {
      releaseChannel,
      node: process.version,
      platform: process.platform
    },
    config: {
      path: configuredPath ?? null,
      loaded: Object.keys(fileConfig).length > 0
    },
    model: {
      provider: modelConfig.provider,
      protocol: modelConfig.protocol,
      model: modelConfig.model
    },
    plugins: manifests()
  };
}

// The desktop shell used to start one short-lived Node process for every
// dashboard section during startup. Keep this read-only aggregate command
// provider-neutral while sharing one module load and one set of file locks.
async function runDashboardCommand() {
  const releaseChannel = resolveReleaseChannel();
  const trajectoryPath = arg('--trajectory-store', process.env.HMCODEX_TRAJECTORY_STORE ?? defaultTrajectoryStore());
  const scopedTrajectory = argValue('--trajectory-store') !== undefined
    || Boolean(process.env.HMCODEX_TRAJECTORY_STORE?.trim());
  const harnessEventStorePath = taskHarnessEventStore(trajectoryPath, scopedTrajectory);
  const readModelPath = arg('--read-model', process.env.HMCODEX_READ_MODEL_STORE ?? (harnessEventStorePath ? harnessEventStorePath + '.read-model.json' : undefined));
  const scopedStorePath = (suffix, fallback) => scopedTrajectory && trajectoryPath
    ? `${trajectoryPath}.${suffix}`
    : fallback();
  const threadPath = arg('--thread-store', process.env.HMCODEX_THREAD_STORE ?? scopedStorePath('threads.json', defaultThreadStore));
  const executionStatePath = arg('--execution-state-store', process.env.HMCODEX_EXECUTION_STATE_STORE
    ?? (harnessEventStorePath ? `${harnessEventStorePath}.execution-read-model.json` : (scopedTrajectory && trajectoryPath ? `${trajectoryPath}.execution.json` : undefined)));
  const feedbackPath = arg('--feedback-store', process.env.HMCODEX_FEEDBACK_STORE ?? scopedStorePath('feedback.json', defaultFeedbackStore));
  const dashboardEventStore = createHarnessEventStore({ storagePath: harnessEventStorePath });
  const feedback = createFeedbackRegistry({ storagePath: feedbackPath, eventStore: dashboardEventStore });
  const memoryPath = arg('--memory-store', process.env.HMCODEX_MEMORY_STORE ?? scopedStorePath('memory.json', defaultMemoryStore));
  const dreamPath = arg('--dream-store', process.env.HMCODEX_DREAM_STORE ?? defaultDreamStore());
  const pluginPath = arg('--plugin-store', arg('--governance-store', process.env.HMCODEX_PLUGIN_GOVERNANCE_STORE
    ?? process.env.HMCODEX_PLUGIN_STORE ?? scopedStorePath('plugin-governance.json', defaultPluginGovernanceStore)));
  const evolutionPath = arg('--evolution-store', process.env.HMCODEX_EVOLUTION_STORE ?? scopedStorePath('evolution-proposals.json', defaultEvolutionStore));
  const evaluationPath = arg('--evaluation-store', process.env.HMCODEX_EVALUATION_STORE ?? scopedStorePath('evolution-evaluations.json', defaultEvolutionEvaluationStore));
  const [{ EvolutionRegistry }, { EvolutionEvaluator }] = await Promise.all([
    import('./plugins/evolution-registry.mjs'),
    import('./evolution-evaluator.mjs')
  ]);
  const threads = harnessEventStorePath
    ? createThreadStore({ eventStore: dashboardEventStore })
    : createThreadStore({ storagePath: threadPath });
  const execution = createExecutionStateStore({ storagePath: executionStatePath });
  const memory = createMemoryJournal({ storagePath: memoryPath });
  const dream = harnessEventStorePath
    ? createDreamScheduler({ eventStore: dashboardEventStore, projectId: arg('--project-id', process.env.HMCODEX_PROJECT_ID ?? 'default') })
    : createDreamScheduler({ storagePath: dreamPath, projectId: arg('--project-id', process.env.HMCODEX_PROJECT_ID ?? 'default') });
  const governance = harnessEventStorePath
    ? createPluginGovernance({ eventStore: dashboardEventStore })
    : createPluginGovernance({ storagePath: pluginPath });
  const evolution = harnessEventStorePath
    ? new EvolutionRegistry({ eventStore: dashboardEventStore })
    : new EvolutionRegistry({ storagePath: evolutionPath });
  const evolutionControl = harnessEventStorePath
    ? new EvolutionControlStore({ eventStore: dashboardEventStore })
    : new EvolutionControlStore({});
  const modelEgress = createModelEgressLedger({ eventStore: harnessEventStorePath ? dashboardEventStore : undefined });
  const evaluator = harnessEventStorePath
    ? new EvolutionEvaluator({ registry: evolution, eventStore: dashboardEventStore, control: evolutionControl })
    : new EvolutionEvaluator({ registry: evolution, storagePath: evaluationPath, control: evolutionControl });
  await Promise.all([
    dashboardEventStore.load(),
    threads.load(),
    execution.load(),
    memory.load(),
    dream.load(),
    governance.load(),
    evolution.load(),
    evolutionControl.load(),
    modelEgress.load(),
    evaluator.load()
  ]);
  let projection;
  let projectionError;
  let deletedRunIds;
  if (harnessEventStorePath && readModelPath) {
    try {
      const eventStore = createHarnessEventStore({ storagePath: harnessEventStorePath });
      const rebuilder = createReadModelRebuilder({ eventStore });
      // Empty authoritative history must replace stale UI state after purge.
      await assertProjectionOutput(readModelPath, [harnessEventStorePath]);
      projection = await rebuilder.rebuild({ storagePath: readModelPath });
      const timelinePage = pageProjectionTimeline(projection, { cursor: 0, limit: 200 }).timelinePage;
      projection = { ...projection, timeline: timelinePage.items, timelinePage };
      deletedRunIds = await eventStore.listDeletedRunIds();
    } catch (error) {
      projectionError = error instanceof Error ? error.message.slice(0, 120) : 'READ_MODEL_REBUILD_FAILED';
    }
  }
  const threadList = await threads.list();
  const feedbackList = await feedback.listDurableSummaries().catch(() => []);
  const pluginList = governance.list();
  const proposalList = evolution.list();
  const reportList = evaluator.list();
  // The dashboard must be able to state, from live facts rather than intent,
  // whether a support bundle can be produced and what it would omit. The same
  // privacy scanner that guards the real export runs over the aggregate the UI
  // is about to render, so a leak in the UI-visible summary fails here.
  const supportBundle = (() => {
    const stores = {
      harness: {
        status: harnessEventStorePath ? (projection ? 'WIRED' : 'UNAVAILABLE') : 'UNAVAILABLE',
        projectionVersion: projection?.projectionVersion,
        projectionChecksum: projection?.projectionChecksum,
        runCount: projection?.runCount
      },
      threads: { count: threadList.length },
      feedback: { count: feedbackList.length },
      memories: { count: (projection?.memories ?? memory.list()).length },
      plugins: { count: pluginList.length },
      evolution: { proposals: proposalList.length, reports: reportList.length },
      decisions: { count: (projection?.decisions ?? []).length },
      modelEgress: modelEgress.summarize()
    };
    const scan = scanSupportBundle({ stores });
    return {
      ok: scan.ok,
      privacy: {
        rawPromptIncluded: false,
        modelOutputIncluded: false,
        reasoningIncluded: false,
        credentialsIncluded: false,
        sourceCodeIncluded: false,
        rawTrajectoryIncluded: false,
        commandTextIncluded: false,
        scan: { ok: scan.ok, violations: scan.violations }
      },
      stores,
      exportInvocation: 'support-bundle --output <path>',
      evidenceSource: 'SUPPORT_BUNDLE_AND_DASHBOARD_SHARE_REDACTED_STORES'
    };
  })();
  return {
    ok: true,
    ...(projection ? { projection } : {}),
    ...(projectionError ? { projectionError } : {}),
    ...(deletedRunIds ? { deletedRunIds } : {}),
    supportBundle,
    modelEgress: modelEgress.summarize(),
    threads: threadList,
    releaseChannel,
    execution: { ok: true, records: projection ? (projection.executionRecords ?? []) : execution.list() },
    feedback: feedbackList,
    memories: projection ? (projection.memories ?? []) : memory.list(),
    dreams: await dream.list(),
    plugins: pluginList,
    evolution: {
      proposals: proposalList,
      reports: reportList,
      control: evolutionControl.state()
    }
  };
}

// Startup logging: install the file logger (console tee + crash handlers)
// before any command executes, then emit a start banner. Nothing here touches
// stdout; the JSONL protocol channel stays untouched.
logger.install();
{
  const bannerConfigPath = argValue('--config')
    ?? (process.env.HMCODEX_MODEL_CONFIG?.trim() || undefined)
    ?? defaultModelConfigPath();
  logger.info(`runtime start | node=${process.version} | pid=${process.pid} | argv=${JSON.stringify(process.argv.slice(2))} | modelConfig=${bannerConfigPath ?? 'none'}`);
}

try {
  const result = command === 'task'
    ? await runTask()
    : command === 'thread' || command === 'threads'
      ? await runThreadCommand()
      : command === 'thread-events' || command === 'thread-events-list'
        ? await runThreadEventsCommand()
      : command === 'support-info'
      ? {
          ok: true,
          schemaVersion: '1.0',
          releaseChannel: resolveReleaseChannel(),
          runtime: { node: process.version, platform: process.platform },
          gates: {
            controlled: resolveReleaseChannel() !== 'WINDOWS_PHASE1_READ_ONLY',
            dynamicPlugins: resolveReleaseChannel() !== 'WINDOWS_PHASE1_READ_ONLY'
          },
          storage: {
            backend: 'HARNESS_EVENT_STORE_DEFAULT',
            legacyBackend: 'TRAJECTORY_JSONL_EXPLICIT_COMPATIBILITY',
            migrationCommand: 'harness-events import'
          },
          phase1Acceptance: 'NOT_VERIFIED'
        }
      : command === 'health'
      ? await runHealth()
      : command === 'recovery'
        ? await runRecoveryCommand()
      : command === 'cancel' || command === 'task-cancel'
        ? await runTaskCancelCommand()
      : command === 'dashboard' || command === 'status'
        ? await runDashboardCommand()
      : command === 'tools' || command === 'tool'
        ? await runTools()
        : command === 'memory' || command === 'memories'
          ? await runMemoryCommand()
          : command === 'execution-state' || command === 'execution'
            ? await runExecutionStateCommand()
          : command === 'capacity'
            ? await runCapacityCommand()
      : command === 'metrics'
            ? await runMetricsCommand()
      : command === 'support-bundle'
            ? await runSupportBundleCommand()
      : command === 'export-data'
            ? await runExportDataCommand()
      : command === 'release-check'
            ? await runReleaseCheckCommand()
      : command === 'model-profile' || command === 'model-profiles'
            ? await runModelProfileCommand()
      : command === 'feedback' || command === 'bayesian'
            ? await runFeedbackCommand()
      : command === 'evaluate' || command === 'export-learning'
            ? await runDecisionEvaluationCommand()
      : command === 'rebuild-read-model' || command === 'read-model' || command === 'projection-check' || command === 'replay-run'
            ? await runReadModelCommand()
      : command === 'harness-events' || command === 'event-store'
            ? await runHarnessEventStoreCommand()
          : command === 'git-audit' || command === 'audit'
            ? await runGitAuditCommand()
          : command === 'dream'
            ? await runDreamCommand()
          : command === 'plugin' || command === 'plugins'
            ? await runPluginCommand()
          : command === 'evolution' || command === 'evolutions'
            ? await runEvolutionCommand()
        : { ok: true, plugins: manifests() };
  writeStdout(`${JSON.stringify(result)}\n`);
} catch (error) {
  writeStdout(`${JSON.stringify({ ok: false, ...(taskResponseRunId ? { runId: taskResponseRunId } : {}), error: error instanceof Error ? error.message : String(error), plugins: manifests() })}\n`);
  process.exitCode = 1;
}
