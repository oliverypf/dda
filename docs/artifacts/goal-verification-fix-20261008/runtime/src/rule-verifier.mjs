import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve } from 'node:path';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED']);
const REPORT_STATUSES = new Set(['PASS', 'FAIL', 'UNKNOWN', 'CONTINUE', 'STALLED', 'UNCERTAIN']);
const CHECK_STATUSES = new Set(['PASS', 'FAIL', 'UNKNOWN', 'SKIPPED']);
const VERIFIER_VERSION = 'rule-1.1';
// 与 task-runner 的 MAX_TOOL_ROUNDS 保持同一上限来源，避免执行侧放开后
// 验证侧仍然按 4 轮判定 FAIL。
// 与 task-runner 的上限来源保持一致（HMCODEX_MAX_TOOL_ROUNDS）。
// 未设置 / 0 => 不限制（Infinity）。惰性求值，便于测试在运行前覆盖。
const defaultMaxToolRounds = () => {
  const raw = process.env.HMCODEX_MAX_TOOL_ROUNDS;
  if (raw === undefined || String(raw).trim() === '') return Infinity;
  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested <= 0) return Infinity;
  return Math.max(1, Math.trunc(requested));
};
const defaultMaxToolCalls = () => {
  const raw = process.env.HMCODEX_MAX_TOOL_CALLS;
  if (raw === undefined || String(raw).trim() === '') return Infinity;
  const requested = Number(raw);
  if (!Number.isFinite(requested) || requested <= 0) return Infinity;
  return Math.max(1, Math.trunc(requested));
};
const MAX_CHECKS = 64;
const MAX_EVIDENCE_REFS = 64;

const oneLine = (value, max = 500) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

const clamp = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : fallback;
};

const isObject = (value) => value !== null && typeof value === 'object';

// Stable digests let the verifier refer to evidence without copying command,
// source, or model output contents into a report.
const canonical = (value, seen = new WeakSet()) => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value) ?? 'null';
  }
  if (seen.has(value)) return '"[Circular]"';
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = `[${value.map((item) => canonical(item, seen)).join(',')}]`;
  } else {
    result = `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return result;
};

export const verifierDigest = (value) =>
  `sha256:${createHash('sha256').update(canonical(value), 'utf8').digest('hex')}`;

const digestRef = (prefix, value) => `${prefix}:${verifierDigest(value)}`;

const normalizeRef = (value, index = 0) => {
  if (typeof value === 'string' && value.trim()) {
    const text = oneLine(value, 200);
    if (/^sha256:[0-9a-f]{64}$/.test(text) || /^[A-Za-z][A-Za-z0-9_.-]{0,48}:[^\s]{1,140}$/.test(text)) {
      return text;
    }
    return digestRef(`evidence-${index}`, text);
  }
  if (isObject(value)) {
    for (const key of ['ref', 'evidenceRef', 'evidenceId', 'id', 'digest', 'contentDigest', 'outputDigest']) {
      if (typeof value[key] === 'string' && value[key].trim()) return normalizeRef(value[key], index);
    }
    const kind = oneLine(value.kind ?? value.type ?? 'evidence', 48).replace(/[^A-Za-z0-9_.-]/g, '_') || 'evidence';
    return digestRef(kind, value);
  }
  return digestRef(`evidence-${index}`, value);
};

const normalizeRefs = (values, limit = 16) => [...new Set((Array.isArray(values) ? values : values === undefined ? [] : [values])
  .map((value, index) => normalizeRef(value, index)))]
  .slice(0, limit);

const check = (id, status, message, evidence = []) => ({
  id: oneLine(id, 120),
  status: CHECK_STATUSES.has(status) ? status : 'UNKNOWN',
  message: oneLine(message),
  evidence: normalizeRefs(evidence)
});

const asArray = (value) => value === undefined || value === null
  ? []
  : Array.isArray(value) ? value : [value];

const statusFromEvidence = (value) => {
  if (value === undefined || value === null) return 'UNKNOWN';
  if (typeof value === 'boolean') return value ? 'PASS' : 'FAIL';
  if (typeof value === 'string') {
    const status = value.toUpperCase();
    if (REPORT_STATUSES.has(status)) return status === 'CONTINUE' ? 'UNKNOWN' : status;
    return value.trim() ? 'PASS' : 'UNKNOWN';
  }
  if (!isObject(value)) return 'UNKNOWN';
  for (const key of ['status', 'result', 'state']) {
    if (typeof value[key] === 'string') {
      const status = value[key].toUpperCase();
      if (['PASS', 'PASSED', 'SUCCESS', 'SUCCEEDED', 'OK', 'COMPLETE', 'COMPLETED', 'DONE'].includes(status)) return 'PASS';
      if (['FAIL', 'FAILED', 'ERROR', 'REJECTED', 'CANCELLED', 'TIMEOUT'].includes(status)) return 'FAIL';
      if (['UNKNOWN', 'UNCERTAIN', 'PENDING', 'RUNNING', 'IN_PROGRESS'].includes(status)) return 'UNKNOWN';
    }
  }
  for (const key of ['ok', 'passed', 'success', 'succeeded', 'complete', 'completed']) {
    if (typeof value[key] === 'boolean') return value[key] ? 'PASS' : 'FAIL';
  }
  if (Number.isInteger(value.exitCode)) return value.exitCode === 0 ? 'PASS' : 'FAIL';
  return 'UNKNOWN';
};

const statusEvidenceRefs = (value, label) => {
  if (value === undefined) return [];
  if (typeof value === 'string') return [digestRef(label, value)];
  if (isObject(value) && (value.digest || value.ref || value.evidenceRef || value.outputDigest)) return normalizeRefs([value]);
  return [digestRef(label, value)];
};

const normalizeGoal = (goal) => {
  if (typeof goal === 'string') return { description: goal };
  return isObject(goal) ? goal : undefined;
};

const normalizeAction = (action) => {
  if (typeof action === 'string') return { name: action };
  return isObject(action) ? action : { value: action };
};

const actionFingerprint = (action) => {
  const value = normalizeAction(action);
  for (const key of ['fingerprint', 'actionDigest']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const key of ['argumentsDigest', 'requestDigest']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return verifierDigest({
        name: value.name ?? value.tool ?? value.action ?? value.command,
        path: value.path ?? value.paths,
        digest: value[key]
      });
    }
  }
  return verifierDigest({
    type: value.type,
    name: value.name ?? value.tool ?? value.action ?? value.command,
    path: value.path ?? value.paths,
    args: value.args ?? value.arguments,
    input: value.input,
    operation: value.operation
  });
};

const actionEvidence = (action) => {
  const value = normalizeAction(action);
  return [value.evidence, value.evidenceRefs, value.evidenceDigest, value.resultDigest, value.outputDigest]
    .flatMap((item) => asArray(item).filter((entry) => entry !== undefined));
};

const actionSucceeded = (action) => {
  const value = normalizeAction(action);
  const status = statusFromEvidence(value);
  return status === 'PASS' || value.done === true;
};

const actionFailed = (action) => {
  const value = normalizeAction(action);
  return statusFromEvidence(value) === 'FAIL' || value.failed === true || value.error !== undefined;
};

// Only an explicit host observation before ToolRegistry.invoke is a deferred
// proposal. An error code alone, an actual invocation, BLOCK or a permission
// failure must keep its existing failure semantics.
const actionDeferred = action => actionFailed(action)
  && action.errorCode === 'TOOL_ACTION_REQUIRES_EVIDENCE'
  && action.gateDecision === 'REQUEST_EVIDENCE' && action.invocationAttempted === false;

// Tool errors that the model can recover from by choosing another path or
// another file. They are evidence of progress (the model learned the request
// was invalid), not a hard failure that must terminate the plan step.
const RECOVERABLE_TOOL_ERROR_CODES = new Set([
  'TEST_CHECK_FAILED',
  'WORKSPACE_NOT_FOUND',
  'WORKSPACE_NOT_DIRECTORY',
  'WORKSPACE_UNSUPPORTED_FILE',
  'WORKSPACE_BINARY_FILE',
  'WORKSPACE_FILE_TOO_LARGE',
  'WORKSPACE_PATH_NOT_FOUND',
  'WORKSPACE_PATH_INVALID',
  'WORKSPACE_INVALID_PATH',
  'WORKSPACE_PATH_FORBIDDEN',
  'WORKSPACE_READ_LIMIT',
  'TOOL_ARGUMENTS_INVALID',
  'TOOL_DUPLICATE_REQUEST'
]);
const actionRecoverableFailure = (action) => {
  const value = normalizeAction(action);
  const code = typeof value.errorCode === 'string' ? value.errorCode : '';
  return actionFailed(value) && RECOVERABLE_TOOL_ERROR_CODES.has(code);
};

const actionPaths = (action) => {
  const value = normalizeAction(action);
  return [value.path, value.paths, value.file, value.files, value.cwd, value.workingDirectory]
    .flatMap((item) => asArray(item))
    .filter((item) => typeof item === 'string' && item.trim());
};

const artifactFiles = (artifact) => {
  if (!isObject(artifact)) return [];
  return [artifact.path, artifact.paths, artifact.file, artifact.files, artifact.changedFiles, artifact.addedFiles, artifact.removedFiles]
    .flatMap((item) => asArray(item))
    .flatMap((item) => isObject(item) ? [item.path ?? item.file] : [item])
    .filter((item) => typeof item === 'string' && item.trim());
};

const pathText = (value) => oneLine(value, 1024).replace(/\\/g, '/');
const absolutePathLike = (value) => isAbsolute(value) || /^[A-Za-z]:\//.test(value) || value.startsWith('//');

const pathWithin = (candidate, root) => {
  const candidateText = pathText(candidate);
  const rootText = pathText(root);
  if (!candidateText || !rootText) return false;
  try {
    const candidateAbsolute = absolutePathLike(candidateText) ? resolve(candidateText) : resolve(rootText, candidateText);
    const rootAbsolute = resolve(rootText);
    const remainder = relative(rootAbsolute, candidateAbsolute).replace(/\\/g, '/');
    return remainder === '' || (remainder !== '..' && !remainder.startsWith('../') && !absolutePathLike(remainder));
  } catch {
    return false;
  }
};

const relativePath = (value) => pathText(value).replace(/^\.\//, '');

const pathAllowedByList = (candidate, allowed) => {
  const normalized = relativePath(candidate);
  return asArray(allowed).some((entry) => {
    const listed = relativePath(isObject(entry) ? entry.path ?? entry.name : entry);
    if (!listed) return false;
    return normalized === listed || normalized.startsWith(`${listed.replace(/\/$/, '')}/`);
  });
};

const workspaceAllowedPaths = (workspace = {}) => [
  workspace.allowedPaths,
  workspace.scope?.allowedPaths,
  workspace.scope?.paths,
  workspace.entries
].flatMap((value) => asArray(value)).filter(Boolean);

const evaluateArtifact = (artifact, label) => {
  if (artifact === undefined || artifact === null) return { status: 'SKIPPED', refs: [] };
  if (Array.isArray(artifact)) {
    const refs = statusEvidenceRefs(artifact, label);
    if (!artifact.length) return { status: 'UNKNOWN', refs };
    const parts = artifact.map((item) => evaluateArtifact(item, label));
    if (parts.some((part) => part.status === 'FAIL')) return { status: 'FAIL', refs };
    if (parts.some((part) => part.status === 'UNKNOWN')) return { status: 'UNKNOWN', refs };
    return { status: 'PASS', refs };
  }
  const status = statusFromEvidence(artifact);
  const refs = statusEvidenceRefs(artifact, label);
  if (status !== 'UNKNOWN') return { status, refs };
  if (typeof artifact === 'string') return artifact.trim() ? { status: 'PASS', refs } : { status: 'UNKNOWN', refs };
  if (isObject(artifact)) {
    if (artifact.clean === true || artifact.withinScope === true || artifact.valid === true) return { status: 'PASS', refs };
    if (artifact.clean === false || artifact.withinScope === false || artifact.valid === false) return { status: 'FAIL', refs };
    // Presence of an evidence-shaped key is not itself evidence. Empty
    // output/log/file collections must remain UNKNOWN so a caller cannot
    // manufacture a passing report with `{ output: '' }` or `{ files: [] }`.
    const meaningful = [artifact.files, artifact.changedFiles, artifact.logs, artifact.output, artifact.stdout, artifact.stderr]
      .some((value) => Array.isArray(value) ? value.length > 0
        : typeof value === 'string' ? value.trim().length > 0
          : value && typeof value === 'object' ? Object.keys(value).length > 0
            : value !== undefined && value !== null);
    if (meaningful) return { status: 'PASS', refs };
  }
  return { status: 'UNKNOWN', refs };
};

/**
 * Deterministic, provider-neutral checks used before a run can be successful.
 *
 * The original arguments remain valid. Additional evidence is deliberately
 * optional so older clients still receive the same PASS/FAIL/UNKNOWN result.
 */
export class RuleVerifier {
  verify({
    prompt = '',
    output = '',
    workspace,
    toolRounds = 0,
    toolCallCount = 0,
    executionMode = 'READ_ONLY',
    goal,
    objective,
    taskGoal,
    actions,
    actionTrace,
    actionHistory,
    trajectory,
    toolCalls,
    previousActions,
    priorActions,
    evidence,
    verifierEvidence,
    evidenceRefs,
    result,
    executionResult,
    executionEvidence,
    observedResult,
    diff,
    diffEvidence,
    diffResult,
    build,
    buildEvidence,
    buildResult,
    tests,
    test,
    testEvidence,
    testResult,
    testResults,
    progress: requestedProgress,
    quality: requestedQuality,
    safety: requestedSafety,
    uncertainty: requestedUncertainty,
    maxToolRounds = defaultMaxToolRounds(),
    maxToolCallCount = defaultMaxToolCalls()
  } = {}) {
    const checks = [];
    const topEvidence = [];
    const signals = { hardFailure: false, stalled: false, shouldContinue: false, uncertain: false };
    const add = (item) => {
      if (checks.length < MAX_CHECKS) checks.push(item);
      topEvidence.push(...item.evidence);
      return item;
    };

    const hasOutput = typeof output === 'string' && output.trim().length > 0;
    add(hasOutput
      ? check('output.non_empty', 'PASS', '模型返回了非空结果', [digestRef('output', output)])
      : check('output.non_empty', 'FAIL', '模型没有返回可验证结果'));

    const workspaceCheck = workspace?.granted === true
      ? check('workspace.authorized', 'PASS', '工作区已授权', [workspace.snapshotDigest].filter(Boolean))
      : check('workspace.authorized', 'UNKNOWN', '没有授权工作区，无法核对文件范围');
    add(workspaceCheck);

    const roundsValid = Number.isInteger(toolRounds) && toolRounds >= 0 && (maxToolRounds === Infinity || (Number.isInteger(maxToolRounds) && toolRounds <= maxToolRounds));
    const callsValid = Number.isInteger(toolCallCount) && toolCallCount >= 0 && (maxToolCallCount === Infinity || (Number.isInteger(maxToolCallCount) && toolCallCount <= maxToolCallCount));
    add(roundsValid
      ? check('tools.bounded_rounds', 'PASS', `工具调用轮数为 ${toolRounds}`)
      : check('tools.bounded_rounds', 'FAIL', `工具调用超过安全轮数上限（${maxToolRounds}）`));
    add(callsValid
      ? check('tools.bounded_count', 'PASS', `工具调用次数为 ${toolCallCount}`)
      : check('tools.bounded_count', 'FAIL', `工具调用超过安全次数上限（${maxToolCallCount}）`));

    if (executionMode === 'CONTROLLED') {
      add(check('controlled.audit_boundary', 'PASS', '受控执行由安全监控和租约边界处理'));
    }

    const normalizedGoal = normalizeGoal(goal ?? objective ?? taskGoal);
    let goalProgress;
    if (normalizedGoal === undefined) {
      add(check('goal.coverage', 'SKIPPED', '没有提供可核对的任务目标'));
    } else {
      const explicitProgress = normalizedGoal.progress ?? normalizedGoal.coverage ?? normalizedGoal.completion;
      const criteria = [normalizedGoal.criteria, normalizedGoal.requirements, normalizedGoal.acceptanceCriteria]
        .flatMap((item) => asArray(item)).filter((item) => typeof item === 'string' && item.trim());
      const completed = normalizedGoal.completed ?? normalizedGoal.complete ?? normalizedGoal.met ?? normalizedGoal.satisfied;
      const failed = normalizedGoal.failed === true || normalizedGoal.status?.toUpperCase?.() === 'FAIL';
      if (Number.isFinite(Number(explicitProgress))) goalProgress = clamp(explicitProgress);
      else if (completed === true) goalProgress = 1;
      else if (completed === false) goalProgress = 0;
      else if (criteria.length) {
        const text = String(output ?? '').toLocaleLowerCase();
        goalProgress = criteria.filter((item) => text.includes(item.toLocaleLowerCase())).length / criteria.length;
      } else if (normalizedGoal.expectedActions && Array.isArray(actions) && actions.length) {
        const expected = asArray(normalizedGoal.expectedActions).length;
        goalProgress = expected ? Math.min(1, actions.filter(actionSucceeded).length / expected) : undefined;
      }
      const refs = [normalizedGoal.evidence, normalizedGoal.evidenceRefs].flatMap((item) => asArray(item));
      const goalStatus = failed ? 'FAIL' : completed === true || goalProgress === 1
        ? 'PASS' : goalProgress !== undefined ? 'UNKNOWN' : 'UNKNOWN';
      add(check('goal.coverage', goalStatus,
        failed ? '任务目标明确标记为失败' : goalStatus === 'PASS' ? '任务目标有完成证据' : '任务目标尚未有足够的完成证据', refs));
      if (failed) signals.hardFailure = true;
      if (goalProgress !== undefined && goalProgress < 1) signals.shouldContinue = true;
    }

    const normalizedActions = asArray(actions ?? actionTrace ?? actionHistory ?? trajectory ?? toolCalls).map(normalizeAction);
    let actionProgress;
    if (!normalizedActions.length) {
      add(check('actions.progress', 'SKIPPED', '没有提供动作轨迹'));
      add(check('actions.duplicates', 'SKIPPED', '没有动作可用于重复检测'));
    } else {
      const deferredIndexes = new Set(normalizedActions.flatMap((action, index) => actionDeferred(action) ? [index] : []));
      const attemptedActions = normalizedActions.filter((_, index) => !deferredIndexes.has(index));
      const attemptedCount = attemptedActions.length;
      // A later successful rerun resolves only the exact failed test command.
      // Keep both observations for audit; unrelated tests and hard errors do
      // not resolve it. Require the runner's argument digest and new evidence.
      const resolvedTests = new Set(normalizedActions.flatMap((action, index) =>
        actionFailed(action) && action.errorCode === 'TEST_CHECK_FAILED'
          && action.name === 'test.execute' && typeof action.argumentsDigest === 'string'
          && normalizedActions.slice(index + 1).some(later => later.name === action.name
            && later.argumentsDigest === action.argumentsDigest && actionSucceeded(later)
            && actionEvidence(later).length > 0) ? [index] : []));
      const doneCount = normalizedActions.filter((action, index) => !deferredIndexes.has(index) && (actionSucceeded(action) || resolvedTests.has(index))).length;
      const recoverableFailureCount = normalizedActions.filter((action, index) => actionRecoverableFailure(action) && !resolvedTests.has(index)).length;
      const hardFailureIndexes = normalizedActions.flatMap((action, index) => !deferredIndexes.has(index) && actionFailed(action) && !actionRecoverableFailure(action) ? [index] : []);
      const hardFailureCount = hardFailureIndexes.length;
      const hardFailureCodes = [...new Set(hardFailureIndexes.map((index) => normalizedActions[index].errorCode)
        .filter((code) => typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,96}$/u.test(code)))].slice(0, 4);
      actionProgress = attemptedCount ? doneCount / attemptedCount : 0;
      const actionRefs = normalizedActions.map((action, index) => `action:${index}:${actionFingerprint(action).slice(7, 23)}`);
      add(check('actions.progress', hardFailureCount
        ? 'FAIL' : recoverableFailureCount
          ? 'UNKNOWN' : attemptedCount > 0 && doneCount === attemptedCount ? 'PASS' : 'UNKNOWN',
      hardFailureCount ? `${hardFailureCount} 个动作执行失败${hardFailureCodes.length ? `（${hardFailureCodes.join('、')}）` : ''}` : recoverableFailureCount
        ? `${recoverableFailureCount} 个动作返回可恢复工具错误，允许模型换路径重试` : attemptedCount > 0 && doneCount === attemptedCount
          ? '实际执行动作均有完成证据' : `仅 ${doneCount}/${attemptedCount} 个实际执行动作有完成证据；${deferredIndexes.size} 个提案在执行前请求补证据`,
      hardFailureCount ? hardFailureIndexes.map((index) => actionRefs[index]) : actionRefs));
      if (hardFailureCount) signals.hardFailure = true;
      if (recoverableFailureCount || doneCount < attemptedCount || !attemptedCount) signals.shouldContinue = true;

      const fingerprints = normalizedActions.map(actionFingerprint);
      const duplicateIndexes = [];
      const seen = new Map();
      let workspaceWriteEpoch = 0;
      fingerprints.forEach((fingerprint, index) => {
        if (resolvedTests.has(index) || deferredIndexes.has(index)) return;
        const action = normalizedActions[index];
        const actualOutput = actionSucceeded(action) && /^sha256:[0-9a-f]{64}$/u.test(action.outputDigest ?? '');
        // The same read before and after a write can verify both the repair
        // and preservation of untouched tests. A changed actual read digest
        // is also new evidence. Side effects retain their original identity.
        const readObservation = ['workspace.read', 'workspace.list', 'file.diff'].includes(action.name ?? action.tool)
          && actualOutput;
        const key = readObservation ? `${fingerprint}:${workspaceWriteEpoch}:${action.outputDigest}` : fingerprint;
        if (seen.has(key)) duplicateIndexes.push(`${seen.get(key)}-${index}`);
        else seen.set(key, index);
        if (actualOutput && ['file.write', 'file.patch'].includes(action.name ?? action.tool)) workspaceWriteEpoch += 1;
      });
      // A single repeated restricted Node syntax check is historical lack of
      // progress, not a permanent stall after a distinct actual full test.
      // Keep the trace and report recovery. Other repeated commands, writes,
      // ambiguous observations and multiple repetitions remain stalled.
      const actualProcess = (action, kind) => action?.name === 'test.execute' && actionSucceeded(action)
        && action.invocationAttempted !== false && action.verifiedResult?.processIntent?.kind === kind
        && action.verifiedResult.executionOk === true && action.verifiedResult.exitCode === 0
        && /^sha256:[0-9a-f]{64}$/u.test(action.outputDigest ?? '')
        && action.verifiedResult.outputDigest === action.outputDigest;
      const duplicateCounts = new Map();
      for (const pair of duplicateIndexes) {
        const index = Number(pair.split('-')[1]);
        duplicateCounts.set(fingerprints[index], (duplicateCounts.get(fingerprints[index]) ?? 0) + 1);
      }
      const recoveredDiagnostics = duplicateIndexes.filter(pair => {
        const [first, last] = pair.split('-').map(Number);
        return duplicateCounts.get(fingerprints[last]) === 1
          && actualProcess(normalizedActions[first], 'NODE_SYNTAX_CHECK') && actualProcess(normalizedActions[last], 'NODE_SYNTAX_CHECK')
          && normalizedActions.slice(last + 1).some(action => actualProcess(action, 'NODE_TEST')
            && actionFingerprint(action) !== fingerprints[last]);
      });
      const unresolvedDuplicates = duplicateIndexes.filter(pair => !recoveredDiagnostics.includes(pair));
      if (recoveredDiagnostics.length) add(check('actions.recovered_diagnostics', 'PASS',
        '一次重复的受限语法诊断之后，实际执行了不同的完整测试并成功；历史重复记录保留',
        recoveredDiagnostics.map(pair => `actions:duplicate:${pair}`)));
      const baseline = asArray(previousActions ?? priorActions).filter(action => !actionDeferred(normalizeAction(action))).map(actionFingerprint);
      const baselineSet = new Set(baseline);
      const noNewEvidence = attemptedActions.every((action) => {
        const value = normalizeAction(action);
        return value.newEvidence !== true && value.changed !== true && actionEvidence(value).length === 0;
      });
      const repeatedFromPrior = baselineSet.size > 0 && attemptedActions.length > 0
        && attemptedActions.map(actionFingerprint).every((fingerprint) => baselineSet.has(fingerprint)) && noNewEvidence;
      const duplicate = unresolvedDuplicates.length > 0;
      if (duplicate || repeatedFromPrior) {
        const evidenceRefs = unresolvedDuplicates.map((pair) => `actions:duplicate:${pair}`);
        if (repeatedFromPrior) evidenceRefs.push('actions:no-new-evidence');
        add(check('actions.duplicates', 'FAIL', repeatedFromPrior
          ? '动作与上一轮完全重复且没有新证据' : '检测到重复动作指纹', evidenceRefs));
        signals.stalled = true;
      } else {
        add(check('actions.duplicates', 'PASS', '未检测到重复动作指纹'));
      }
      const progressMarkers = attemptedActions.some((action) => {
        const value = normalizeAction(action);
        return value.newEvidence === true || value.changed === true || actionEvidence(value).length > 0
          || actionRecoverableFailure(value);
      });
      if (!progressMarkers && normalizedActions.length > 1 && doneCount === 0) {
        add(check('actions.new_evidence', 'FAIL', '动作轨迹没有产生新的结果证据'));
        signals.stalled = true;
      } else {
        add(check('actions.new_evidence', progressMarkers || doneCount > 0 ? 'PASS' : 'SKIPPED',
          progressMarkers ? '动作产生了新的结果证据' : '没有足够动作供证据增量检查'));
      }
    }

    const paths = [
      ...normalizedActions.flatMap(actionPaths),
      ...artifactFiles(diff ?? diffEvidence ?? diffResult),
      ...artifactFiles(evidence ?? verifierEvidence ?? evidenceRefs),
      ...artifactFiles(result ?? executionResult ?? executionEvidence ?? observedResult)
    ];
    if (!paths.length) {
      add(check('paths.scope', 'SKIPPED', '没有提供需要核对的路径'));
    } else {
      const root = workspace?.rootPath ?? workspace?.root ?? workspace?.currentPath;
      const allowed = workspaceAllowedPaths(workspace ?? {});
      const invalid = paths.filter((candidate) => {
        const candidateText = pathText(candidate);
        if (!candidateText || candidateText.includes('\0')) return true;
        if (candidateText.split('/').includes('..') && !root) return true;
        // An absolute path cannot be proven to belong to a workspace when the
        // caller omitted its canonical root. Fail closed instead of accepting
        // an arbitrary drive or UNC path.
        if (!root && absolutePathLike(candidateText)) return true;
        if (root && !pathWithin(candidateText, root)) return true;
        if (!root && allowed.length && !pathAllowedByList(candidateText, allowed)) return true;
        return false;
      });
      if (invalid.length) {
        add(check('paths.scope', 'FAIL', `${invalid.length} 个路径超出工作区范围`, invalid.map((path) => digestRef('path', pathText(path)))));
        signals.hardFailure = true;
      } else if (!workspace?.granted) {
        add(check('paths.scope', 'UNKNOWN', '工作区未授权，无法确认路径范围', paths.map((path) => digestRef('path', pathText(path)))));
        signals.uncertain = true;
      } else {
        add(check('paths.scope', 'PASS', `${paths.length} 个路径均在工作区范围内`, [workspace.snapshotDigest].filter(Boolean)));
      }
    }

    const providedEvidence = asArray(evidence ?? verifierEvidence ?? evidenceRefs);
    if (!providedEvidence.length) {
      add(check('evidence.result', 'SKIPPED', '没有提供额外结果证据'));
    } else {
      const evidenceStatus = providedEvidence.reduce((current, item) => {
        const next = statusFromEvidence(item);
        return next === 'FAIL' ? 'FAIL' : next === 'UNKNOWN' && current === 'PASS' ? 'UNKNOWN' : current === 'UNKNOWN' ? 'UNKNOWN' : next;
      }, 'PASS');
      add(check('evidence.result', evidenceStatus, evidenceStatus === 'PASS'
        ? '结果证据可核对' : evidenceStatus === 'FAIL' ? '结果证据明确表示失败' : '结果证据不足以确定结果', normalizeRefs(providedEvidence)));
      if (evidenceStatus === 'FAIL') signals.hardFailure = true;
      if (evidenceStatus === 'UNKNOWN') signals.uncertain = true;
    }

    const resultEvidence = result ?? executionResult ?? executionEvidence ?? observedResult;
    if (resultEvidence !== undefined) {
      const evaluated = evaluateArtifact(resultEvidence, 'result');
      add(check('evidence.execution_result', evaluated.status, evaluated.status === 'PASS'
        ? '执行结果包含可验证证据' : evaluated.status === 'FAIL' ? '执行结果明确失败' : '执行结果证据不完整', evaluated.refs));
      if (evaluated.status === 'FAIL') signals.hardFailure = true;
      if (evaluated.status === 'UNKNOWN') signals.uncertain = true;
    }

    const artifacts = [
      ['evidence.diff', diff ?? diffEvidence ?? diffResult],
      ['evidence.build', build ?? buildEvidence ?? buildResult],
      ['evidence.tests', tests ?? test ?? testEvidence ?? testResult ?? testResults]
    ];
    for (const [id, artifact] of artifacts) {
      const evaluated = evaluateArtifact(artifact, id.replace('evidence.', ''));
      add(check(id, evaluated.status,
        evaluated.status === 'SKIPPED' ? '没有提供可选证据' : evaluated.status === 'PASS'
          ? '证据检查通过' : evaluated.status === 'FAIL' ? '证据检查失败' : '证据不足以确定结果', evaluated.refs));
      if (evaluated.status === 'FAIL') signals.hardFailure = true;
      if (evaluated.status === 'UNKNOWN' && artifact !== undefined) signals.uncertain = true;
    }

    const failedChecks = checks.filter((item) => item.status === 'FAIL');
    // A repeated action is a control-flow stop, not permission to continue and
    // not a generic task failure. All other failed checks remain fail-closed.
    const hardByCheck = failedChecks.some((item) => !['actions.duplicates', 'actions.new_evidence'].includes(item.id));
    const hardFailure = signals.hardFailure || hardByCheck;
    const unknownCount = checks.filter((item) => item.status === 'UNKNOWN').length;
    const explicitProgress = Number.isFinite(Number(requestedProgress)) ? clamp(requestedProgress)
      : Number.isFinite(Number(normalizedGoal?.progress))
      ? clamp(normalizedGoal.progress)
      : Number.isFinite(Number(normalizedGoal?.coverage)) ? clamp(normalizedGoal.coverage) : undefined;
    const progress = explicitProgress ?? goalProgress ?? actionProgress ?? (hasOutput ? 1 : 0);
    const status = hardFailure ? 'FAIL' : signals.stalled ? 'STALLED' : signals.shouldContinue
      ? 'CONTINUE' : signals.uncertain ? 'UNCERTAIN' : unknownCount ? 'UNKNOWN' : 'PASS';
    const qualityInputs = [hasOutput ? 1 : 0];
    for (const id of ['evidence.diff', 'evidence.build', 'evidence.tests']) {
      const item = checks.find((entry) => entry.id === id);
      if (item?.status === 'PASS') qualityInputs.push(1);
      if (item?.status === 'FAIL') qualityInputs.push(0);
    }
    const safety = Number.isFinite(Number(requestedSafety)) ? clamp(requestedSafety)
      : workspace?.granted === true
      ? (checks.find((item) => item.id === 'paths.scope')?.status === 'FAIL' ? 0 : 1)
      : 0;
    const quality = Number.isFinite(Number(requestedQuality)) ? clamp(requestedQuality)
      : qualityInputs.reduce((sum, value) => sum + value, 0) / qualityInputs.length;
    const uncertainty = Number.isFinite(Number(requestedUncertainty)) ? clamp(requestedUncertainty)
      : clamp(unknownCount / Math.max(1, checks.filter((item) => item.status !== 'SKIPPED').length));
    const failureCodeByCheck = {
      'output.non_empty': 'OUTPUT_EMPTY',
      'tools.bounded_rounds': 'TOOL_ROUNDS_EXCEEDED',
      'tools.bounded_count': 'TOOL_CALLS_EXCEEDED',
      'goal.coverage': 'GOAL_NOT_MET',
      'actions.progress': 'ACTION_FAILED',
      'actions.duplicates': 'REPEATED_ACTION',
      'actions.new_evidence': 'NO_NEW_EVIDENCE',
      'paths.scope': 'PATH_OUT_OF_SCOPE',
      'evidence.result': 'RESULT_EVIDENCE_FAILED',
      'evidence.execution_result': 'EXECUTION_RESULT_FAILED',
      'evidence.diff': 'DIFF_FAILED',
      'evidence.build': 'BUILD_FAILED',
      'evidence.tests': 'TESTS_FAILED'
    };
    const failureCodes = [...new Set(failedChecks.map((item) =>
      failureCodeByCheck[item.id] ?? item.id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')))].slice(0, 16);
    const nextAction = status === 'PASS' ? 'COMPLETE' : status === 'FAIL' ? 'STOP_AND_REPORT'
      : status === 'STALLED' ? 'DIAGNOSE_OR_REQUEST_NEW_EVIDENCE'
        : status === 'UNCERTAIN' || status === 'UNKNOWN' ? 'REQUEST_EVIDENCE'
          : 'CONTINUE_EXECUTION';
    return {
      status,
      summary: status === 'PASS' ? '确定性检查通过' : status === 'FAIL' ? '确定性检查未通过'
        : status === 'STALLED' ? '检测到重复动作或没有新证据，运行已停滞'
          : status === 'CONTINUE' ? '任务尚未完成，仍需继续执行' : status === 'UNCERTAIN'
            ? '证据不足以确定运行结果' : '存在未能确定的检查项',
      progress: clamp(progress),
      quality: clamp(quality),
      safety: clamp(safety),
      uncertainty,
      evidence: [...new Set(topEvidence.concat(normalizeRefs(providedEvidence)))].slice(0, MAX_EVIDENCE_REFS),
      failureCodes,
      nextAction,
      verifierVersion: VERIFIER_VERSION,
      checks,
      ...(prompt ? { promptDigest: verifierDigest(String(prompt)) } : {})
    };
  }
}

export const createRuleVerifier = () => new RuleVerifier();

export const isTerminalRunState = (state) => TERMINAL.has(state);
