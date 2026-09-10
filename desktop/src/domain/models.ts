export type ConnectionState = 'DISCONNECTED' | 'CONNECTING' | 'READY' | 'ERROR';
export type ConnectionMode = 'MOCK' | 'LOCAL_RUNTIME';
export type RuntimeExecutionMode = 'READ_ONLY' | 'CONTROLLED';
export type RunState =
  | 'CREATED'
  | 'CLASSIFYING'
  | 'PRECHECKING'
  | 'ROUTING'
  | 'ALLOCATING_CONTEXTS'
  | 'PLANNING'
  | 'EXECUTING_READ'
  | 'SAFETY_EVALUATING'
  | 'WAITING_APPROVAL'
  | 'EXECUTING'
  | 'VERIFYING'
  | 'DIAGNOSING'
  | 'RECOVERING'
  | 'PAUSING'
  | 'PAUSED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'PAUSED_UNSUPPORTED';
export type TimelineKind = 'USER' | 'AGENT' | 'STATUS' | 'WORKSPACE' | 'ERROR';
export type TimelineStatus = 'PENDING' | 'STREAMING' | 'COMPLETE' | 'ERROR';

export interface ConnectionReadModel {
  state: ConnectionState;
  mode: ConnectionMode;
  label: string;
}

export interface RuntimeReadModel {
  releaseChannel?: string;
  platform: 'WINDOWS' | 'WEB_PREVIEW';
  version: string;
  readOnly: true;
  workspaceRead: boolean;
  commandExecution: boolean;
  networkSideEffects: boolean;
  runtimeReady?: boolean;
  nodeVersion?: string | null;
  model?: RuntimeModelSummary | null;
  configLoaded?: boolean;
  contextSidecar?: RuntimeContextSidecarStatus;
  dreamMaintenance?: RuntimeDreamMaintenanceStatus;
}

export interface ModelConfig {
  schemaVersion: '1.0';
  provider: 'openai' | 'openai-responses' | 'openai-chat' | 'compatible' | 'deepseek';
  protocol: 'responses' | 'chat-completions' | 'deepseek-harness';
  model: string;
  baseURL?: string;
  endpoint?: string;
  apiKeyEnv: string;
  sessionHeader?: string;
}

export interface ModelConfigResponse {
  config: ModelConfig;
  configPath: string;
  exists: boolean;
}

export type RuntimeContextSidecarState =
  | 'DISABLED'
  | 'MISCONFIGURED'
  | 'UNAVAILABLE'
  | 'STARTING'
  | 'READY'
  | 'EXTERNAL'
  | 'DEGRADED'
  | 'STOPPED';

export interface RuntimeContextSidecarStatus {
  enabled: boolean;
  state: RuntimeContextSidecarState | string;
  managed: boolean;
  running: boolean;
  ready: boolean;
  pid?: number | null;
  startedAtMs?: number | null;
  errorCode?: string | null;
}

export interface RuntimeDreamMaintenanceStatus {
  enabled: boolean;
  state: string;
  running: boolean;
  pid?: number | null;
  projectId?: string | null;
  intervalMs?: number;
  failureLimit?: number;
  startedAtMs?: number | null;
  lastEventAtMs?: number | null;
  cycleCount?: number;
  consecutiveFailures?: number;
  lastErrorCode?: string | null;
}

export interface RunReadModel {
  runId: string;
  title: string;
  state: RunState;
  startedAtMs: number;
}

export interface ThreadReadModel {
  id: string;
  title: string;
  cwd: string;
  turnCount: number;
  createdAtMs: number;
  updatedAtMs: number;
  forkedFrom?: string;
  state?: 'IDLE' | 'RUNNING' | 'PAUSED' | 'FAILED' | 'COMPLETED';
  checkpoint?: {
    runId?: string;
    phase?: string;
    state?: string;
    plan?: unknown;
  };
}

export type SubAgentState = 'STARTING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface SubAgentReadModel {
  agentId: string;
  name: string;
  task: string;
  state: SubAgentState;
  startedAtMs: number;
  updatedAtMs: number;
}

export interface TimelineItem {
  itemId: string;
  runId?: string;
  kind: TimelineKind;
  title: string;
  body: string;
  status: TimelineStatus;
  createdAtMs: number;
}

export interface ApprovalReadModel {
  requestId: string;
  capability: string;
  requestDigest: string;
  intentId?: string;
  approvalId?: string;
  risk?: 'LOW' | 'MEDIUM' | 'HIGH';
  scope?: {
    capability?: string;
    snapshotDigest?: string;
  };
  policyVersion?: string;
  approvalExpiresAt?: number;
  leaseId?: string;
  leaseExpiresAt?: number;
  command?: string;
  path?: string;
  cwd?: string;
  host?: string;
  port?: number;
  scheme?: string;
  method?: string;
  state: 'REQUESTED' | 'APPROVED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED';
  createdAtMs: number;
}

export interface WorkspaceEntry {
  name: string;
  relativePath: string;
  kind: 'DIRECTORY' | 'FILE';
  sizeBytes: number;
}

export interface WorkspaceFile {
  relativePath: string;
  content: string;
  contentDigest: string;
  totalBytes: number;
  truncated: boolean;
  binary: boolean;
}

export interface WorkspaceReadModel {
  granted: boolean;
  rootLabel: string;
  currentPath: string;
  entries: WorkspaceEntry[];
  stale: boolean;
  selectedFile?: WorkspaceFile;
}

export interface ComposerReadModel {
  mode: RuntimeExecutionMode;
  enabled: boolean;
  placeholder: string;
}

export interface HarnessReadModel {
  schemaVersion: '1.0';
  projectionVersion: number;
  connection: ConnectionReadModel;
  runtime: RuntimeReadModel;
  activeRun?: RunReadModel;
  activeThreadId?: string;
  resumeThreadId?: string;
  threads: ThreadReadModel[];
  subAgents: SubAgentReadModel[];
  approvals: ApprovalReadModel[];
  feedback: RuntimeFeedbackSummary[];
  memories: RuntimeMemoryRecord[];
  dreamRuns: RuntimeDreamRun[];
  plugins: RuntimePluginGovernanceRecord[];
  evolutionProposals: RuntimeEvolutionProposal[];
  evolutionReports: RuntimeEvolutionReport[];
  evolutionControl?: EvolutionControlState;
  decisions: RuntimeDecisionNode[];
  continuousVerification?: ContinuousVerificationRecord[];
  supportBundle?: RuntimeSupportBundleReadiness;
  modelEgress?: RuntimeModelEgressSummary;
  timeline: TimelineItem[];
  workspace: WorkspaceReadModel;
  composer: ComposerReadModel;
}

export interface ContinuousVerificationRecord {
  eventId: string;
  runId: string;
  stepId?: string;
  kind: 'CandidateVerificationSample' | 'CandidateVerificationCompleted';
  modelId?: string;
  eventSequence: number;
  leftId?: string;
  rightId?: string;
  leftScore?: number;
  rightScore?: number;
  leftVariance?: number;
  rightVariance?: number;
  config?: Record<string, unknown>;
  comparisonCount?: number;
  ranking?: Array<{ candidateId?: string; score?: number }>;
}

export interface RuntimeSnapshot {
  releaseChannel?: string;
  platform: 'WINDOWS';
  version: string;
  readOnly: true;
  workspaceRead: true;
  commandExecution: false;
  networkSideEffects: false;
  runtimeReady?: boolean;
  nodeVersion?: string | null;
  model?: RuntimeModelSummary | null;
  configLoaded?: boolean;
  contextSidecar?: RuntimeContextSidecarStatus;
  dreamMaintenance?: RuntimeDreamMaintenanceStatus;
}

export interface WorkspaceGrant {
  rootLabel: string;
}

export interface RuntimePluginSummary {
  id: string;
  name: string;
  version: string;
  lifecycle: string;
  source: string;
  digest: string;
}

export interface RuntimeToolSummary {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface RuntimeWorkspaceSummary {
  granted: boolean;
  rootLabel?: string;
  snapshotDigest?: string;
  entryCount?: number;
}

export interface RuntimeEvolutionSummary {
  proposalCount: number;
  store: 'PERSISTED' | 'MEMORY_ONLY';
  evaluationStore?: 'PERSISTED' | 'MEMORY_ONLY';
  outcomeCount?: number;
  evaluationError?: string;
}

export interface RuntimeTrajectorySummary {
  store: 'PERSISTED' | 'MEMORY_ONLY';
  eventCount: number;
}

export interface RuntimeVerificationSummary {
  status: 'PASS' | 'FAIL' | 'UNKNOWN';
  summary: string;
  checks: Array<{ id: string; status: string; message: string }>;
  semantic?: {
    status: 'PASS' | 'FAIL' | 'ABSTAIN';
    summary: string;
    progress?: number;
    evidenceRefs?: string[];
    failureCodes?: string[];
    modelIdentity?: Record<string, unknown>;
    gate?: Record<string, unknown>;
  };
}

export interface RuntimeContextSummary {
  provider: string;
  status: 'COMMITTED' | 'DEGRADED' | string;
  recalledCount?: number;
  usedCount?: number;
  recordedCount?: number;
  committedCount?: number;
  recallError?: string;
  failures?: Array<{ operation?: string; errorCode?: string }>;
}

export interface RuntimeCancellation {
  cancelled: boolean;
}

export interface RuntimeProcessStatus {
  running: boolean;
  pid?: number | null;
  startedAtMs?: number | null;
  lastHeartbeatAtMs?: number | null;
  healthy: boolean;
}

export interface RuntimeRecoveryResponse {
  ok: true;
  reconciled: number;
  execution: {
    reconciled: number;
    records: Array<Record<string, unknown>>;
  };
  roles: {
    reconciled: number;
    contexts: Array<Record<string, unknown>>;
  };
}

export interface RuntimeTaskOptions {
  threadId?: string;
  resume?: boolean;
  executionMode?: RuntimeExecutionMode;
  leaseCapabilities?: string[];
  leaseCommands?: string[];
  leaseNetworkTargets?: NetworkTargetOption[];
}

export interface NetworkTargetOption {
  host: string;
  port?: number;
  scheme?: 'https' | 'http';
  methods?: string[];
}

export interface RuntimeExecutionRecord {
  recordId: string;
  recordType: 'intent' | 'approval' | 'lease';
  state: string;
  capability?: string;
  operationId?: string;
  createdAtMs: number;
  updatedAtMs: number;
  requestSummary?: Record<string, unknown>;
  expiresAt?: number;
}

export interface RuntimeExecutionStateResponse {
  ok: true;
  records: RuntimeExecutionRecord[];
}

export interface RuntimeProjection {
  schemaVersion: '1.0';
  projectionVersion: number;
  projectionChecksum: string;
  lastEventSequence: Record<string, number>;
  runCount: number;
  runs: Array<{ runId: string; title: string; state: string; startedAtMs: number; lastEventSequence: number; terminal: boolean }>;
  timeline: Array<{ itemId: string; runId: string; kind: string; title: string; status: string; createdAtMs: number; eventId: string; eventSequence: number }>;
  approvals: Array<Record<string, unknown>>;
  decisions?: RuntimeDecisionNode[];
  continuousVerification?: ContinuousVerificationRecord[];
  workspace: Record<string, unknown>;
  verifier: Record<string, unknown>;
  unknownEventKinds: string[];
  timelinePage?: RuntimeTimelinePage;
}

export interface RuntimeDecisionNode {
  decisionId: string;
  runId?: string;
  decisionType?: string;
  role?: string;
  stepId?: string;
  agentInstanceId?: string;
  parentDecisionIds?: string[];
  supersedesDecisionId?: string;
  status: string;
  optionCount: number;
  options?: RuntimeDecisionOption[];
  selectedOptionId?: string;
  reasonCodes?: string[];
  selectionCriteria?: string[];
  outcomeStatus?: string;
  eventId?: string;
  eventSequence?: number;
  updatedAtMs?: number;
}

export interface RuntimeDecisionOption {
  optionId: string;
  actionKind?: string;
  expectedQuality?: number;
  expectedCost?: number;
  expectedLatencyMs?: number;
  rejectionReasonCodes: string[];
}

export interface RuntimeTimelinePage {
  items: RuntimeProjection['timeline'];
  cursor: number;
  limit: number;
  total: number;
  hasMore: boolean;
  nextCursor?: number;
}

export interface RuntimeFeedbackSummary {
  feedbackId?: string;
  runId?: string;
  outcomeStatus?: string;
  eventId?: string;
  eventSequence?: number;
  scenarioKey?: string;
  candidateKey?: string;
  [key: string]: unknown;
}

export interface RuntimeDashboardResponse {
  ok: true;
  deletedRunIds?: string[];
  projection?: RuntimeProjection;
  projectionError?: string;
  supportBundle?: RuntimeSupportBundleReadiness;
  modelEgress?: RuntimeModelEgressSummary;
  threads: ThreadReadModel[];
  execution: RuntimeExecutionStateResponse;
  feedback: RuntimeFeedbackSummary[];
  memories: RuntimeMemoryRecord[];
  dreams: RuntimeDreamRun[];
  plugins: RuntimePluginGovernanceRecord[];
  evolution: {
    proposals: RuntimeEvolutionProposal[];
    reports: RuntimeEvolutionReport[];
    control: EvolutionControlState;
  };
}

export interface RuntimeSupportBundleReadiness {
  ok: boolean;
  privacy: {
    rawPromptIncluded: false;
    modelOutputIncluded: false;
    reasoningIncluded: false;
    credentialsIncluded: false;
    sourceCodeIncluded: false;
    rawTrajectoryIncluded: false;
    commandTextIncluded: false;
    scan: { ok: boolean; violations: Array<{ path: string; reason: string }> };
  };
  stores: Record<string, Record<string, unknown>>;
  exportInvocation: string;
  evidenceSource: string;
}

export interface RuntimeModelEgressBucket {
  calls: number;
  failures: number;
  expectedCost: number | null;
  actualCost: number | null;
  expectedCostKnown: number;
  actualCostKnown: number;
  expectedTokens: number;
  actualTokens: number;
  latencyMs: number;
}

export interface RuntimeModelEgressSummary {
  schemaVersion: string;
  recordCount: number;
  totals: RuntimeModelEgressBucket;
  byProvider: Record<string, RuntimeModelEgressBucket>;
  byPhase: Record<string, RuntimeModelEgressBucket>;
  byCandidate: Record<string, RuntimeModelEgressBucket & { provider?: string; modelId?: string }>;
  redaction: { promptIncluded: false; outputIncluded: false; credentialsIncluded: false };
}

export interface EvolutionControlState {
  enabled: boolean;
  reason?: string;
  actor?: string;
  changedAtMs: number;
  commandId?: string;
}

export interface RuntimeMemoryRecord {
  memoryId: string;
  runId?: string;
  statement: string;
  scope: string;
  kind?: string;
  confidence: number;
  status: string;
  sourceEventIds?: string[];
  createdAtMs: number;
  updatedAtMs: number;
  verifiedAtMs?: number;
  expiresAtMs?: number;
  lastUsedAtMs?: number;
  untrainable?: boolean;
  untrainableAtMs?: number;
}

export interface RuntimeDreamRun {
  runId: string;
  projectId: string;
  state: string;
  phase?: string;
  startedAtMs: number;
  ownerPid?: number;
  runtimeInstanceId?: string;
  finishedAtMs?: number;
  phaseUpdatedAtMs?: number;
  candidateCount?: number;
  gateReasons?: string[];
  errorCode?: string;
  checkpoint?: Record<string, unknown>;
}

export interface RuntimePluginGovernanceRecord {
  pluginId: string;
  version: string;
  manifest: Record<string, unknown>;
  source: string;
  packageDigest: string;
  state: string;
  createdAtMs: number;
  updatedAtMs: number;
  history?: Array<Record<string, unknown>>;
}

export interface RuntimeEvolutionProposal {
  proposalId: string;
  candidateId: string;
  status: string;
  proposalDigest: string;
  createdAtMs: number;
  updatedAtMs: number;
  lastTransition?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RuntimeEvolutionReport {
  reportId: string;
  proposalId: string;
  stage: string;
  baseline?: Record<string, unknown>;
  candidate?: Record<string, unknown>;
  decision?: Record<string, unknown>;
  evaluatedAtMs: number;
  reportDigest: string;
}

export interface RuntimeEvent {
  type: 'runtime_event';
  schemaVersion: '1.0';
  eventId?: string;
  runId: string;
  sequence: number;
  kind: string;
  payload: Record<string, unknown>;
  aggregateType?: string;
  aggregateId?: string;
  actorType?: string;
  actorId?: string;
  payloadDigest?: string;
  recordDigest?: string;
  sensitivity?: string;
  redactionState?: string;
  emittedAtMs: number;
  observedAtMs?: number;
}

export interface RuntimeModelSummary {
  provider: string;
  protocol: string;
  model: string;
}

export type RuntimeTaskResponse =
  | {
      ok: true;
      runId?: string;
      threadId: string;
      thread: ThreadReadModel;
      text: string;
      reasoningChars: number;
      toolRounds?: number;
      toolCallCount?: number;
      executionMode?: 'READ_ONLY' | 'CONTROLLED';
      plugins: RuntimePluginSummary[];
      tools?: RuntimeToolSummary[];
      workspace: RuntimeWorkspaceSummary;
      evolution?: RuntimeEvolutionSummary;
      trajectory?: RuntimeTrajectorySummary;
      model?: RuntimeModelSummary;
      verification?: RuntimeVerificationSummary;
      context?: RuntimeContextSummary;
      decisionTrace?: {
        store: 'PERSISTED' | 'MEMORY_ONLY';
        decisionCount: number;
        outcomeCount: number;
        eventCount: number;
      };
    }
  | {
      ok: false;
      runId?: string;
      error: string;
      plugins: RuntimePluginSummary[];
      tools?: RuntimeToolSummary[];
    };
