import { memoryLessonKey, memoryWorkspaceKey } from './memory-workspace.mjs';
import { experiencePlacement } from './experience-placement.mjs';

const SECRET_TEXT = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|bearer|private\s+key|secret)\s*[:=]/i;
const FIXTURE_PATH_RE = /(?:hmcodex-(?:ui-model-fixture|goal-|runtime-|memory-db-|jev-)|[\\/]temp[\\/]|[\\/]tmp[\\/]|missing(?:-evidence)?\.txt|missing\/file-\d+)/i;
const TRIVIAL_SHELL_RE = /^(?:git\s+(?:status|diff|log|rev-parse|show)|(?:node|npm|npx|cargo|rustc|python|pip|dotnet|powershell|pwsh|cmd|where|which)\s+(?:--version|-v|-V|\/c\s+ver)|(?:where|which|echo|ver|hostname|whoami)(\s|$))/i;
const INLINE_INTERPRETER_RE = /(?:^|\s)(?:-e|--eval|-c|-Command|-EncodedCommand|-enc)(?:\s|$)/i;

const clean = (value, max = 240) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f\r\n<>]+/gu, ' ')
  .replace(/\s+/gu, ' ')
  .trim()
  .slice(0, max);

const uniqueIds = (ids) => [...new Set(
  (Array.isArray(ids) ? ids : [])
    .filter((id) => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim().slice(0, 240))
)].slice(0, 16);

const formatCommandLine = (command, args = []) => {
  const base = clean(command, 200);
  if (!base) return '';
  const parts = Array.isArray(args)
    ? args.slice(0, 24).map((part) => {
        const text = clean(part, 120);
        return /\s/u.test(text) ? `"${text}"` : text;
      }).filter(Boolean)
    : [];
  return clean([base, ...parts].join(' '), 320);
};

const isReusableCommand = (cmdLine) => {
  if (!cmdLine || cmdLine.length < 3) return false;
  if (SECRET_TEXT.test(cmdLine) || FIXTURE_PATH_RE.test(cmdLine)) return false;
  if (TRIVIAL_SHELL_RE.test(cmdLine) || INLINE_INTERPRETER_RE.test(cmdLine)) return false;
  if (/\.codex-tmp/i.test(cmdLine)) return false;
  return true;
};

const durationPhrase = (durationMs) => {
  if (!Number.isFinite(durationMs) || durationMs < 30_000) return '';
  return durationMs >= 120_000
    ? `约 ${Math.round(durationMs / 60_000)} 分钟`
    : `约 ${Math.max(1, Math.round(durationMs / 1000))} 秒`;
};

const recommendedTimeoutMs = (durationMs) => {
  if (!Number.isFinite(durationMs) || durationMs < 30_000) return undefined;
  return Math.min(1_800_000, Math.max(120_000, Math.ceil((durationMs * 2) / 60_000) * 60_000));
};

const cleanRelativeCwd = (cwd) => {
  const text = clean(cwd, 120).replaceAll('\\', '/').replace(/^\.\//u, '').replace(/\/+$/u, '');
  if (!text || text === '.' || /^[A-Za-z]:/u.test(text) || text.startsWith('/')) return '工作区根目录';
  return `工作区 \`${text}\` 目录`;
};

const cleanTitle = (title, taskClass) => {
  const text = clean(title, 60);
  if (text && !/^(?:Thread\s+[a-f0-9-]+|dda task|new thread|hello)$/iu.test(text) && !FIXTURE_PATH_RE.test(text)) {
    return text;
  }
  const map = { modify: '文件修改', test: '构建与测试', code: '代码实现', inspect: '项目检查' };
  return map[String(taskClass ?? '').toLowerCase()] ?? '';
};

const isScratchFile = (filePath) => {
  const normalized = clean(filePath, 200).replaceAll('\\', '/');
  if (!normalized || FIXTURE_PATH_RE.test(normalized)) return true;
  return /(?:^|\/)(?:\.codex-tmp|node_modules|target|dist|\.git)(?:\/|$)|\.tmp\./iu.test(normalized);
};

const makeCandidate = ({ runId, statement, sourceEventIds, key, confidence = 0.85, kind = 'PROJECT', scope = 'workspace' }) => {
  const text = String(statement ?? '').replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 1200);
  const sources = uniqueIds(sourceEventIds);
  if (!text || SECRET_TEXT.test(text) || sources.length === 0) return undefined;
  return {
    runId: clean(runId, 240) || 'unknown',
    statement: text,
    sourceEventIds: sources,
    scope,
    kind,
    ...(key ? { key: clean(key, 240) } : {}),
    confidence: Math.max(0.5, Math.min(0.98, Number.isFinite(confidence) ? confidence : 0.8))
  };
};

export const extractRunReusableExperience = ({
  runId,
  taskClass,
  threadTitle,
  threadCwd,
  actions = [],
  events = [],
  verificationChecks = [],
  terminalEventId
} = {}) => {
  if (threadCwd && FIXTURE_PATH_RE.test(String(threadCwd))) return [];
  const fallbackIds = uniqueIds([
    terminalEventId,
    ...events.filter((e) => e?.kind === 'TaskRunCompleted' || e?.kind === 'VerificationCompleted').map((e) => e?.eventId).slice(-2)
  ]);

  // Merge rich tool facts from both live actions and durable events.
  const toolFacts = [];
  const failedCommands = [];
  const succeededCommandKeys = new Set();
  const writtenFiles = new Map();
  let usedBinaryInspectEventId;
  let protectedPathEventId;
  let ambiguousFocusEventId;
  let executorFailedEventId;
  let repeatedActionEventId;
  let maxTimedOutMs = 0;
  let timedOutEventId;
  let maxSucceededShellDurationMs = 0;
  let maxSucceededShellEventId;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const payload = event.payload ?? {};
    if (event.kind === 'TaskFileWritten' && typeof payload.path === 'string' && !isScratchFile(payload.path)) {
      writtenFiles.set(clean(payload.path, 160).replaceAll('\\', '/'), event.eventId);
    }
    if (event.kind === 'ToolInvocationCompleted') {
      const name = String(payload.name ?? '');
      const errorCode = String(payload.errorCode ?? '');
      if (payload.ok === true && (name === 'workspace.inspect_binary' || name === 'kernel.workspace_inspect_binary')) {
        usedBinaryInspectEventId = event.eventId;
      }
      if (errorCode.includes('SAFETY_PROTECTED_PATH')) protectedPathEventId = event.eventId;
      if (errorCode === 'EXCERPT_AMBIGUOUS') ambiguousFocusEventId = event.eventId;
      if (errorCode === 'EXECUTOR_RESULT_FAILED') executorFailedEventId = event.eventId;
      if ((name === 'shell.execute' || name === 'test.execute') && payload.timedOut === true) {
        const tms = Number(payload.timeoutMs) || 0;
        if (tms >= maxTimedOutMs) { maxTimedOutMs = tms; timedOutEventId = event.eventId; }
      }
      if ((name === 'shell.execute' || name === 'test.execute') && payload.ok === true) {
        const dur = Number(payload.durationMs) || 0;
        if (dur >= maxSucceededShellDurationMs) { maxSucceededShellDurationMs = dur; maxSucceededShellEventId = event.eventId; }
        if (typeof payload.command === 'string') {
          const cmdLine = formatCommandLine(payload.command, payload.args);
          if (isReusableCommand(cmdLine)) succeededCommandKeys.add(`${cleanRelativeCwd(payload.cwd)}::${cmdLine.toLowerCase()}`);
          toolFacts.push({
            name,
            command: payload.command,
            args: payload.args,
            cwd: payload.cwd,
            durationMs: dur,
            eventId: event.eventId
          });
        }
      }
      if ((name === 'shell.execute' || name === 'test.execute') && payload.ok !== true && typeof payload.command === 'string') {
        failedCommands.push({
          name,
          command: payload.command,
          args: payload.args,
          cwd: payload.cwd,
          errorCode: payload.errorCode,
          message: payload.message,
          outputTail: payload.outputTail,
          exitCode: payload.exitCode,
          timedOut: payload.timedOut === true,
          timeoutMs: payload.timeoutMs,
          eventId: event.eventId
        });
      }
    }
  }

  for (const action of Array.isArray(actions) ? actions : []) {
    if (!action || typeof action !== 'object') continue;
    const name = String(action.name ?? '');
    if (action.state === 'SUCCEEDED' && (name === 'file.write' || name === 'file.patch') && typeof action.path === 'string' && !isScratchFile(action.path)) {
      const norm = clean(action.path, 160).replaceAll('\\', '/');
      if (!writtenFiles.has(norm)) writtenFiles.set(norm, fallbackIds[0]);
    }
    if (action.state === 'SUCCEEDED' && (name === 'workspace.inspect_binary' || name === 'kernel.workspace_inspect_binary')) {
      usedBinaryInspectEventId ??= fallbackIds[0];
    }
    if (String(action.errorCode ?? '').includes('SAFETY_PROTECTED_PATH')) protectedPathEventId ??= fallbackIds[0];
    if (String(action.errorCode ?? '') === 'EXCERPT_AMBIGUOUS') ambiguousFocusEventId ??= fallbackIds[0];
    if (String(action.errorCode ?? '') === 'EXECUTOR_RESULT_FAILED') executorFailedEventId ??= fallbackIds[0];
    if ((name === 'shell.execute' || name === 'test.execute') && typeof action.command === 'string') {
      const cmdLine = formatCommandLine(action.command, action.args);
      const commandKey = isReusableCommand(cmdLine) ? `${cleanRelativeCwd(action.cwd)}::${cmdLine.toLowerCase()}` : '';
      if (action.state === 'SUCCEEDED') {
        if (commandKey) succeededCommandKeys.add(commandKey);
        toolFacts.push({
          name,
          command: action.command,
          args: action.args,
          cwd: action.cwd,
          durationMs: Number(action.durationMs) || 0,
          eventId: fallbackIds[0]
        });
      } else if (action.state === 'FAILED') {
        failedCommands.push({
          name,
          command: action.command,
          args: action.args,
          cwd: action.cwd,
          errorCode: action.errorCode,
          message: action.errorMessage,
          exitCode: action.exitCode,
          timedOut: action.timedOut === true,
          timeoutMs: action.timeoutMs,
          eventId: fallbackIds[0]
        });
      }
    }
  }

  const results = [];
  const diagnostics = [];
  const label = cleanTitle(threadTitle, taskClass);
  const pushLesson = (candidate, target = results) => {
    if (!candidate) return;
    const placement = experiencePlacement(candidate);
    if (placement === 'skip') return;
    const workspacePath = clean(threadCwd, 1024);
    target.push({
      ...candidate,
      kind: placement === 'skill' ? 'SKILL' : 'MEMORY',
      ...(workspacePath ? { workspacePath } : {})
    });
  };
  // A failing test or ordinary nonzero exit is a task observation. A concrete
  // launcher diagnostic can be reused after its environment is checked.
  for (const item of failedCommands) {
    if (item.name !== 'shell.execute' || item.timedOut || !/\bspawn(?:Sync)?\b[^\n]{0,160}\bEINVAL\b/iu.test([item.message, item.outputTail].join(' '))) continue;
    const cmdLine = formatCommandLine(item.command, item.args);
    if (!isReusableCommand(cmdLine)) continue;
    const key = cleanRelativeCwd(item.cwd) + '::' + cmdLine.toLowerCase();
    if (succeededCommandKeys.has(key)) continue;
    pushLesson(makeCandidate({
      runId, key: 'pitfall:spawn-einval:' + key,
      statement: '当 ' + cmdLine + ' 启动时报告 spawn EINVAL，请核对启动器与参数。修正后重新运行原命令验证。',
      sourceEventIds: [item.eventId, ...fallbackIds]
    }), diagnostics);
  }

  // 1. Verified build/test commands (highest reusability).
  const byCmd = new Map();
  for (const item of toolFacts) {
    const cmdLine = formatCommandLine(item.command, item.args);
    if (!isReusableCommand(cmdLine)) continue;
    const cwdLabel = cleanRelativeCwd(item.cwd);
    const mapKey = `${cwdLabel}::${cmdLine.toLowerCase()}`;
    const prev = byCmd.get(mapKey);
    if (!prev || item.durationMs > prev.durationMs) {
      byCmd.set(mapKey, { ...item, cmdLine, cwdLabel });
    }
  }
  for (const item of [...byCmd.values()].sort((a, b) => b.durationMs - a.durationMs).slice(0, 3)) {
    const budget = recommendedTimeoutMs(item.durationMs);
    const kindText = item.name === 'test.execute' ? '测试验证' : '命令/构建';
    const timingNote = budget
      ? `（实测耗时${durationPhrase(item.durationMs)}，后续调用建议显式设置 timeoutMs >= ${budget}）`
      : '';
    const candidate = makeCandidate({
      runId,
      statement: `项目命令经验${label ? `（${label}）` : ''}：在${item.cwdLabel}执行 \`${item.cmdLine}\` 已核验可成功完成${kindText}${timingNote}。`,
      sourceEventIds: [item.eventId, ...fallbackIds],
      key: `workflow:cmd:${item.cwdLabel}:${item.cmdLine.toLowerCase().slice(0, 120)}`,
      confidence: 0.9
    });
    pushLesson(candidate);
  }

  // 2. Long-running build timeout -> recovery budget lesson (works even on older runs without plaintext commands).
  if (maxTimedOutMs > 0 && maxSucceededShellDurationMs >= 45_000) {
    const timeoutSec = Math.round(maxTimedOutMs / 1000);
    const suggested = recommendedTimeoutMs(Math.max(maxTimedOutMs, maxSucceededShellDurationMs)) ?? 1_200_000;
    const candidate = makeCandidate({
      runId,
      statement: `构建时限经验${label ? `（${label}）` : ''}：本项目长耗时构建/命令曾因 timeoutMs=${timeoutSec}s 提前超时停止，完整执行实测耗时${durationPhrase(maxSucceededShellDurationMs)}；后续全量构建建议直接设置 timeoutMs=${suggested}（上限 1800000ms），若遇超时先核对已有产物再决定下一步。`,
      sourceEventIds: [timedOutEventId, maxSucceededShellEventId, ...fallbackIds],
      key: `workflow:timeout:${label || 'build'}`,
      confidence: 0.88
    });
    pushLesson(candidate);
  }

  // 3. Verified modified project files mapped to task goal.
  if (writtenFiles.size > 0) {
    const entries = [...writtenFiles.entries()].slice(0, 6);
    const fileNames = entries.map(([p]) => `\`${p}\``).join('、');
    const candidate = makeCandidate({
      runId,
      statement: `项目改动经验${label ? `（${label}）` : ''}：完成该类需求并通过规则核验时，关键修改文件包括 ${fileNames}${writtenFiles.size > 6 ? ` 等 ${writtenFiles.size} 个文件` : ''}。`,
      sourceEventIds: [...entries.map(([, id]) => id), ...fallbackIds],
      key: `project:files:${(label || entries[0][0]).toLowerCase().slice(0, 120)}`,
      confidence: 0.84
    });
    pushLesson(candidate);
  }

  // 4. Binary inspection pattern (avoids inline node -e high-risk approval).
  if (usedBinaryInspectEventId) {
    const candidate = makeCandidate({
      runId,
      statement: '产物核验经验：检查 Windows .exe/.dll 构建产物的 PE 头、目标架构与子系统信息时，直接使用只读工具 `workspace.inspect_binary`，避免使用 `node -e` 等内联脚本触发高危审批。',
      sourceEventIds: [usedBinaryInspectEventId, ...fallbackIds],
      key: 'tool:workspace.inspect_binary',
      confidence: 0.92
    });
    pushLesson(candidate);
  }

  // 5. Protected host state & ambiguous focus pitfalls.
  if (protectedPathEventId) {
    const candidate = makeCandidate({
      runId,
      statement: '安全边界经验：宿主受保护目录（如应用安装与运行时状态目录）即使开启完全访问模式仍禁止访问；核验构建结果应直接检查工作区内的输出目录，不要反复探测受保护路径。',
      sourceEventIds: [protectedPathEventId, ...fallbackIds],
      key: 'pitfall:safety-protected-path',
      confidence: 0.9
    });
    pushLesson(candidate);
  }
  if (ambiguousFocusEventId) {
    const candidate = makeCandidate({
      runId,
      statement: '工具定位经验：调用 `workspace.focus` 若返回 `EXCERPT_AMBIGUOUS`（定位文本不唯一），应改用包含上下文的更长唯一字面字符串，或改用带 `offsetChars`/`maxChars` 的 `workspace.read` 分段读取。',
      sourceEventIds: [ambiguousFocusEventId, ...fallbackIds],
      key: 'pitfall:excerpt-ambiguous',
      confidence: 0.85
    });
    pushLesson(candidate);
  }

  // 6. Failed verification lessons. These are general rules, not project procedures.
  // The Jev RULE_VERIFIER_FAILED line is only a rewrite of the checks below.
  const checks = [
    ...(Array.isArray(verificationChecks) ? verificationChecks : []),
    ...events.flatMap((event) => event?.kind === 'VerificationCompleted' && Array.isArray(event.payload?.checks) ? event.payload.checks : [])
  ];
  const failedCheck = (id) => checks.find((item) => item && item.id === id && String(item.status ?? '').toUpperCase() === 'FAIL');
  const progressFail = failedCheck('actions.progress');
  if (!executorFailedEventId && progressFail && /EXECUTOR_RESULT_FAILED/u.test(String(progressFail.message ?? ''))) {
    executorFailedEventId = fallbackIds[0];
  }
  if (failedCheck('actions.duplicates')) repeatedActionEventId = fallbackIds[0];
  if (executorFailedEventId) {
    pushLesson(makeCandidate({
      runId,
      statement: '动作失败经验：命令或工具返回 EXECUTOR_RESULT_FAILED 后，不要用相同参数立刻再执行一次。先看失败原因和已经留下的产物，换一条路径或修正命令后再试。',
      sourceEventIds: [executorFailedEventId, ...fallbackIds],
      key: 'pitfall:executor-result-failed',
      confidence: 0.86
    }));
  }
  if (repeatedActionEventId) {
    pushLesson(makeCandidate({
      runId,
      statement: '重复动作经验：同一动作已经执行过就不要原样再做。换成能带来新证据的检查，或根据上一次的失败原因改命令，而不是重复刚才的调用。',
      sourceEventIds: [repeatedActionEventId, ...fallbackIds],
      key: 'pitfall:repeated-action',
      confidence: 0.86
    }));
  }

  const terminal = events.findLast(event => event?.kind === 'TaskRunFailed');
  if (terminal && (terminal.payload?.outcomeStatus ?? 'FAILED') === 'FAILED') {
    const payload = terminal.payload ?? {};
    const verification = events.findLast(event => event?.kind === 'VerificationCompleted');
    const missingSources = [payload.failureCodes, verification?.payload?.failureCodes]
      .some(codes => Array.isArray(codes) && codes.includes('EXTERNAL_EVIDENCE_MISSING'));
    // Persist machine identifiers only. Error messages can include provider
    // responses, paths, credentials or user-controlled text.
    const code = typeof payload.code === 'string' && /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(payload.code) && payload.code.length <= 80
      ? payload.code : undefined;
    const taskLabel = cleanTitle('', taskClass);
    const detail = missingSources
      ? '外部资料检索缺少可核验来源。筛选帖子或文章前，先打开候选页面，核对正文与链接，再依据已读内容回答。'
      : code === 'ROLE_BINDING_BLOCKED'
        ? '执行前先核对所选模型、角色绑定和该任务类别的可用资格，确认绑定成功后再继续。'
        : '重试前先检查失败步骤的输入与执行记录，确认触发条件已经改变，再用小范围验证决定是否继续。';
    if (missingSources || code) pushLesson(makeCandidate({
      runId, key: 'pitfall:terminal:' + (missingSources ? 'EXTERNAL_EVIDENCE_MISSING' : code) + (taskLabel ? ':' + taskClass : ''),
      statement: (taskLabel || '任务') + '曾因 ' + (missingSources ? 'EXTERNAL_EVIDENCE_MISSING' : code) + ' 未完成。' + detail,
      sourceEventIds: [terminal.eventId, ...(missingSources ? [verification?.eventId] : [])]
    }), diagnostics);
  }
  return [...results, ...diagnostics];
};

// Count only recommendations visible in the selected model context with
// corroborating tool receipts. Recalling a statement alone proves no use.
export const appliedMemoryIds = (memories, historyContext, actions = []) => {
  const commands = new Set();
  const tools = new Set();
  for (const action of actions) {
    if (action.state !== 'SUCCEEDED' || action.invocationAttempted === false) continue;
    tools.add(action.name);
    if (action.name !== 'shell.execute' && action.name !== 'test.execute') continue;
    const line = formatCommandLine(action.command, action.args).toLowerCase();
    if (line && line.length <= 120) commands.add('workflow:cmd:' + cleanRelativeCwd(action.cwd) + ':' + line);
  }
  return memories.filter(memory => memory.statement && historyContext.includes(memory.statement)
    && (commands.has(memory.key) || (memory.key === 'tool:workspace.inspect_binary'
      && (tools.has('workspace.inspect_binary') || tools.has('kernel.workspace_inspect_binary')))))
    .map(memory => memory.memoryId);
};

export const selectRunLesson = (candidates = [], { existingKeys = new Set(), verified = true } = {}) => {
  const fresh = [];
  for (const item of Array.isArray(candidates) ? candidates : []) {
    if (!item?.statement) continue;
    if (item.key && existingKeys.has(memoryLessonKey(item))) continue;
    fresh.push(item);
  }
  if (!fresh.length) return undefined;
  if (!verified) {
    return fresh.find((item) => String(item.key ?? '').startsWith('pitfall:'));
  }
  return fresh.find((item) => item.kind === 'SKILL')
    ?? fresh[0];
};

export const extractDreamExperienceCandidates = (events = [], { threads = [], existingMemories = [] } = {}) => {
  if (!Array.isArray(events) || events.length === 0) return [];
  const activeKeys = new Set(
    (Array.isArray(existingMemories) ? existingMemories : [])
      .filter((m) => m && ['PROPOSED', 'VERIFIED', 'ACTIVE'].includes(m.status) && typeof m.key === 'string' && m.key.trim())
      .map(memoryLessonKey)
  );
  const threadByRunId = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    if (!thread || typeof thread !== 'object') continue;
    for (const runId of [...(Array.isArray(thread.runIds) ? thread.runIds : []), thread.checkpoint?.runId]) {
      if (typeof runId === 'string') threadByRunId.set(runId, { title: thread.title, cwd: thread.cwd });
    }
    for (const turn of Array.isArray(thread.turns) ? thread.turns : []) {
      if (typeof turn?.runId === 'string') {
        threadByRunId.set(turn.runId, { title: thread.title, cwd: thread.cwd });
      }
    }
    if (typeof thread.activeRunId === 'string' && !threadByRunId.has(thread.activeRunId)) {
      threadByRunId.set(thread.activeRunId, { title: thread.title, cwd: thread.cwd });
    }
  }

  const grouped = new Map();
  for (const event of events) {
    if (!event || typeof event.runId !== 'string' || !event.eventId) continue;
    const list = grouped.get(event.runId) ?? [];
    list.push(event);
    grouped.set(event.runId, list);
  }

  const byKey = new Map();
  for (const [runId, runEvents] of grouped) {
    const completedEvent = runEvents.find((event) =>
      event.kind === 'TaskRunCompleted' && (event.payload?.outcomeStatus ?? 'SUCCEEDED') === 'SUCCEEDED'
    );
    // Allow pitfall extraction from verified runs first; also allow recurring pitfall rules from real project runs.
    const threadMeta = threadByRunId.get(runId);
    if (threadMeta?.cwd && FIXTURE_PATH_RE.test(String(threadMeta.cwd))) continue;

    if (!completedEvent) {
      // Only extract deterministic tool/safety pitfall lessons from non-completed real runs when thread metadata confirms a real workspace.
      const terminal = runEvents.findLast(event => event.kind === 'TaskRunFailed');
      if (!threadMeta?.cwd || !terminal || terminal.payload?.outcomeStatus === 'CANCELLED') continue;
      const classified = runEvents.find((e) => e.kind === 'TaskClassified')?.payload?.taskClass;
      const lesson = selectRunLesson(extractRunReusableExperience({
        runId,
        taskClass: classified,
        threadTitle: threadMeta.title,
        threadCwd: threadMeta.cwd,
        events: runEvents,
        terminalEventId: terminal.eventId
      }), { existingKeys: activeKeys, verified: false });
      if (lesson) {
        if (lesson.key) activeKeys.add(memoryLessonKey(lesson));
        byKey.set(memoryLessonKey(lesson), lesson);
      }
      continue;
    }

    const classified = runEvents.find((e) => e.kind === 'TaskClassified')?.payload?.taskClass;
    const lesson = selectRunLesson(extractRunReusableExperience({
      runId,
      taskClass: classified,
      threadTitle: threadMeta?.title,
      threadCwd: threadMeta?.cwd,
      events: runEvents,
      terminalEventId: completedEvent.eventId
    }), { existingKeys: activeKeys, verified: true });
    if (lesson) {
      if (lesson.key) activeKeys.add(memoryLessonKey(lesson));
      byKey.set(memoryLessonKey(lesson), lesson);
    }
  }

  return [...byKey.values()].slice(-32);
};

// Older skill records only stored scope "workspace". The thread that produced
// the run still has the directory, so the card can name that project.
export const attachMemoryWorkspacePaths = (memories, threads = []) => {
  const byRun = new Map();
  for (const thread of Array.isArray(threads) ? threads : []) {
    const cwd = clean(thread?.cwd, 1024);
    if (!cwd || FIXTURE_PATH_RE.test(cwd)) continue;
    const runIds = [...(Array.isArray(thread.runIds) ? thread.runIds : [])];
    if (typeof thread?.activeRunId === 'string') runIds.push(thread.activeRunId);
    if (typeof thread?.checkpoint?.runId === 'string') runIds.push(thread.checkpoint.runId);
    for (const turn of Array.isArray(thread?.turns) ? thread.turns : []) {
      if (typeof turn?.runId === 'string') runIds.push(turn.runId);
    }
    for (const runId of runIds) {
      if (!runId) continue;
      if (!byRun.has(runId)) byRun.set(runId, cwd);
      else if (memoryWorkspaceKey(byRun.get(runId)) !== memoryWorkspaceKey(cwd)) byRun.set(runId, undefined);
    }
  }
  return (Array.isArray(memories) ? memories : []).map((memory) => {
    if (!memory || typeof memory !== 'object') return memory;
    const existing = clean(memory.workspacePath, 1024);
    if (existing) return memory.workspacePath === existing ? memory : { ...memory, workspacePath: existing };
    const cwd = typeof memory.runId === 'string' ? byRun.get(memory.runId) : undefined;
    return cwd ? { ...memory, workspacePath: cwd } : memory;
  });
};
