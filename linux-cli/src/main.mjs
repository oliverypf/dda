import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskCancelRegistry } from '../../runtime/src/task-cancel-registry.mjs';
import { buildRuntimeEnv, redactText } from '../../runtime/src/platform/environment-policy.mjs';
import { createPlatformPaths, directoryPermission, ensurePlatformDirs } from '../../runtime/src/platform/paths.mjs';
import { releaseChannelForPolicy, resolvePlatformIdentity } from '../../runtime/src/platform/platform-identity.mjs';
import { createProcessSupervisor, reclaimRecordedProcesses } from '../../runtime/src/platform/process-supervisor.mjs';
import { describeApproval } from './approval.mjs';
import { EXIT, errorResult, exitCodeForError, messageForCode } from './exit-codes.mjs';
import { migrateDataDirectory } from './migrate.mjs';
import { parseCli } from './parse-args.mjs';
import { humanEventLine, isRuntimeEvent } from './render.mjs';
import { runRuntimeCommand } from './runtime-bridge.mjs';
import { resolveWorkspace } from './workspace.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_ENTRY = join(HERE, '../../runtime/src/index.mjs');
const CLI_VERSION = '0.1.0';
const PROTOCOL_VERSION = '1.0';
const COMMANDS = new Set([
  'health', 'task', 'thread', 'thread-events', 'recovery', 'tools',
  'support-info', 'support-bundle', 'dashboard', 'metrics', 'capacity', 'migrate-data'
]);
const THREAD_COMMANDS = new Set(['list', 'get', 'create', 'fork']);

const HELP = `dda <command> [subcommand] [options]

命令：
  health                         检查 runtime、配置和数据目录
  task --workspace PATH --prompt TEXT
  thread list|get|create|fork
  thread-events --thread-id ID
  recovery [--workspace PATH]
  tools --workspace PATH [--tool NAME]
  support-info | support-bundle --output PATH
  dashboard | metrics | capacity
  migrate-data --from PATH [--apply]

公共选项：
  --format human|jsonl   --config PATH   --data-dir PATH
  --workspace PATH       --timeout-ms N  --events stdout
  --quiet --verbose --help --version

默认执行模式是 READ_ONLY。CONTROLLED 必须显式指定，并且在没有终端时只能使用
--approval-mode jsonl 或 deny。
`;

async function runtimePackageVersion() {
  try {
    const parsed = JSON.parse(await readFile(join(HERE, '../../runtime/package.json'), 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : '0.1.0';
  } catch {
    return '0.1.0';
  }
}

async function providerKeyNames(configPath) {
  if (!configPath) return [];
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    const names = [];
    if (typeof parsed.apiKeyEnv === 'string') names.push(parsed.apiKeyEnv);
    if (typeof parsed.decision?.apiKeyEnv === 'string') names.push(parsed.decision.apiKeyEnv);
    if (Array.isArray(parsed.models)) {
      for (const model of parsed.models) {
        if (typeof model?.apiKeyEnv === 'string') names.push(model.apiKeyEnv);
      }
    }
    return names.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name));
  } catch {
    return [];
  }
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const isTTY = io.isTTY ?? Boolean(stderr.isTTY);
  const emitJson = (value) => writeJson(stdout, value);

  let parsed;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    const code = error?.code ?? 'ARGUMENT_INVALID';
    const format = argv?.includes?.('--format') && argv[argv.indexOf('--format') + 1] === 'jsonl' ? 'jsonl' : 'human';
    if (format === 'jsonl') emitJson(errorResult(code));
    else stderr.write(`错误  ${code}  ${messageForCode(code)}\n`);
    return EXIT.USAGE_ERROR;
  }
  const format = parsed.options.format ?? (isTTY ? 'human' : 'jsonl');
  io.format = format;
  const reportError = (code, extras = {}) => {
    const result = errorResult(code, extras);
    if (format === 'jsonl') emitJson(result);
    else stderr.write(redactText(`错误  ${code}  ${result.error.message}\n`));
    return exitCodeForError(code);
  };

  if (parsed.options.help || parsed.command === 'help' || (!parsed.command && !parsed.options.version)) {
    stdout.write(HELP);
    return EXIT.SUCCESS;
  }
  if (parsed.options.version || parsed.command === 'version') {
    const version = {
      cli: CLI_VERSION,
      runtime: await runtimePackageVersion(),
      protocol: PROTOCOL_VERSION,
      platform: 'linux-cli'
    };
    if (format === 'jsonl') emitJson({ ok: true, ...version });
    else stdout.write(`dda ${version.cli}\nruntime ${version.runtime}\nprotocol ${version.protocol}\nplatform ${version.platform}\n`);
    return EXIT.SUCCESS;
  }
  if (!COMMANDS.has(parsed.command)) return reportError('UNKNOWN_COMMAND');

  const pathEnv = {
    ...env,
    HMCODEX_PLATFORM: 'linux-cli',
    ...(parsed.options.dataDir ? { HMCODEX_DATA_DIR: parsed.options.dataDir } : {}),
    ...(parsed.options.config ? { HMCODEX_MODEL_CONFIG: parsed.options.config } : {})
  };
  const paths = createPlatformPaths(pathEnv);
  if (!paths.dataDir() || !paths.configDir()) return reportError('STORAGE_ERROR');
  try {
    await ensurePlatformDirs(paths);
  } catch (error) {
    return reportError(error?.code === 'ENOSPC' ? 'ENOSPC' : 'STORAGE_ERROR');
  }

  if (parsed.command === 'migrate-data') {
    if (!parsed.options.from) return reportError('ARGUMENT_INVALID');
    const report = await migrateDataDirectory({
      sourceRoot: parsed.options.from,
      targetRoot: paths.dataDir(),
      apply: parsed.options.apply === true
    });
    emitJson(report);
    if (report.status === 'FAILED') return EXIT.STORAGE_ERROR;
    if (report.status === 'STOPPED') return EXIT.STORAGE_ERROR;
    return EXIT.SUCCESS;
  }

  const executionMode = parsed.options.executionMode ?? 'READ_ONLY';
  let workspace;
  if (parsed.command === 'task' || parsed.command === 'tools' || (parsed.command === 'thread' && parsed.subcommand === 'create')) {
    if (!parsed.options.workspace) return reportError(parsed.command === 'task' ? 'ARGUMENT_INVALID' : 'WORKSPACE_NOT_FOUND');
    try {
      workspace = resolveWorkspace(parsed.options.workspace);
    } catch (error) {
      return reportError(error.code ?? 'WORKSPACE_NOT_FOUND');
    }
  } else if (parsed.options.workspace) {
    try {
      workspace = resolveWorkspace(parsed.options.workspace);
    } catch (error) {
      return reportError(error.code ?? 'WORKSPACE_NOT_FOUND');
    }
  }
  if (parsed.command === 'task' && !parsed.options.prompt?.trim()) return reportError('PROMPT_REQUIRED');
  if (parsed.command === 'thread' && !THREAD_COMMANDS.has(parsed.subcommand ?? 'list')) return reportError('UNKNOWN_COMMAND');
  if ((parsed.command === 'thread' && ['get', 'fork'].includes(parsed.subcommand)) || parsed.command === 'thread-events') {
    if (!parsed.options.threadId) return reportError('ARGUMENT_INVALID');
  }
  if (parsed.command === 'support-bundle' && !parsed.options.output) return reportError('ARGUMENT_INVALID');

  let approvalMode;
  if (parsed.command === 'task' && executionMode === 'CONTROLLED') {
    approvalMode = parsed.options.approvalMode ?? (isTTY ? 'prompt' : undefined);
    if (!approvalMode || (approvalMode === 'prompt' && !isTTY)) return reportError('APPROVAL_UNAVAILABLE');
  }

  const configPath = parsed.options.config ?? (env.HMCODEX_MODEL_CONFIG?.trim() || undefined);
  const keyNames = await providerKeyNames(configPath ?? paths.modelConfigPath());
  const childEnv = buildRuntimeEnv(env, { extraKeys: keyNames });
  childEnv.HMCODEX_PLATFORM = 'linux-cli';
  childEnv.HMCODEX_RELEASE_CHANNEL = releaseChannelForPolicy(executionMode === 'CONTROLLED' ? 'CONTROLLED' : 'READ_ONLY');
  childEnv.HMCODEX_DATA_DIR = paths.dataDir();
  delete childEnv.HMCODEX_BAKED_RELEASE_CHANNEL;
  if (configPath) childEnv.HMCODEX_MODEL_CONFIG = configPath;

  const runtimeArgs = [];
  if (parsed.subcommand && parsed.command === 'thread') runtimeArgs.push(parsed.subcommand);
  if (workspace) runtimeArgs.push('--workspace', workspace);
  if (parsed.options.prompt) runtimeArgs.push('--prompt', parsed.options.prompt);
  if (parsed.command === 'task') runtimeArgs.push('--execution-mode', executionMode, '--events', 'stdout');
  if (parsed.options.agentMode) runtimeArgs.push('--agent-mode', parsed.options.agentMode);
  if (parsed.options.model) runtimeArgs.push('--model', parsed.options.model);
  if (parsed.options.resume) runtimeArgs.push('--resume');
  if (parsed.options.threadId) runtimeArgs.push('--thread-id', parsed.options.threadId);
  if (parsed.options.title) runtimeArgs.push('--title', parsed.options.title);
  if (parsed.options.tool) runtimeArgs.push('--tool', parsed.options.tool);
  if (parsed.options.input) runtimeArgs.push('--input', parsed.options.input);
  if (parsed.options.output) runtimeArgs.push('--output', parsed.options.output);
  if (configPath) runtimeArgs.push('--config', configPath);

  const registryPath = join(paths.stateDir(), 'processes.json');
  await reclaimRecordedProcesses(registryPath).catch(() => undefined);
  const supervisor = createProcessSupervisor({ registryPath });
  const active = { record: undefined, runId: undefined };
  let cancelSignal;
  const onSigint = () => {
    if (!active.record) return;
    if (cancelSignal) {
      stderr.write('正在强制结束 runtime\n');
      void supervisor.terminateGroup(active.record.processId, 200);
      return;
    }
    cancelSignal = 'SIGINT';
    stderr.write('正在取消任务\n');
    if (!active.runId) {
      void supervisor.terminateGroup(active.record.processId, 200);
      return;
    }
    const registry = createTaskCancelRegistry({ storagePath: `${paths.resolveStore('trajectory.jsonl')}.cancels.json` });
    void registry.request(active.runId, { reason: 'SIGINT', requestedBy: 'linux-cli' }).catch(() => undefined);
  };
  const onSigterm = () => {
    cancelSignal = 'SIGTERM';
    if (active.record) void supervisor.terminateGroup(active.record.processId, 500);
  };
  if (!io.disableSignals) {
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
  }

  const seen = new Set();
  let finalResult;
  const policy = executionMode === 'CONTROLLED' ? 'CONTROLLED' : 'READ_ONLY';
  try {
    const outcome = await runRuntimeCommand({
      supervisor,
      entry: RUNTIME_ENTRY,
      command: parsed.command,
      args: runtimeArgs,
      env: childEnv,
      cwd: workspace ?? paths.dataDir(),
      timeoutMs: parsed.options.timeoutMs ? Number(parsed.options.timeoutMs) : undefined,
      approvalMode,
      tty: isTTY,
      approvalInput: io.approvalInput,
      readApprovalLine: io.readApprovalLine,
      onReady: (record) => { active.record = record; },
      onStderr: (line) => {
        if (parsed.options.verbose || format === 'human') stderr.write(`${redactText(line)}\n`);
      },
      onStdout: (event) => {
        if (isRuntimeEvent(event)) {
          active.runId = event.runId;
          const key = `${event.runId}:${event.sequence}:${event.eventId ?? ''}`;
          if (seen.has(key)) return;
          seen.add(key);
          if (format === 'jsonl') emitJson(event);
          else if (!parsed.options.quiet && event.kind !== 'runtime.heartbeat') stderr.write(`${humanEventLine(event)}\n`);
          if (format === 'human' && event.kind === 'approval.requested' && approvalMode === 'prompt') stderr.write(`${describeApproval(event)}\n`);
          return;
        }
        finalResult = event;
        if (format === 'jsonl' && parsed.command === 'task') {
          emitJson(event.ok === false
            ? errorResult(typeof event.error === 'string' ? event.error : 'RUNTIME_ERROR', { runId: event.runId })
            : event);
        }
      }
    });
    if (outcome.timedOut) {
      const unknown = errorResult('TASK_RESULT_UNKNOWN', { runId: outcome.runId, state: 'UNKNOWN' });
      if (format === 'jsonl') emitJson(unknown);
      else stderr.write(`${unknown.error.message}\n`);
      return EXIT.RUNTIME_ERROR;
    }
    if (cancelSignal) return cancelSignal === 'SIGINT' ? EXIT.SIGINT : EXIT.CANCELLED;
    if (outcome.protocolError) return reportError('PROTOCOL_ERROR', { runId: outcome.runId });
    const result = finalResult ?? outcome.objects.find((item) => !isRuntimeEvent(item));
    if (!result) {
      return reportError(outcome.protocolError ? 'PROTOCOL_ERROR' : 'DEPENDENCY_ERROR', { runId: outcome.runId });
    }
    if (result.ok === false) {
      const code = typeof result.error === 'string' ? result.error : result.error?.code ?? 'RUNTIME_ERROR';
      if (format === 'jsonl' && parsed.command !== 'task') emitJson(errorResult(code, { runId: result.runId }));
      if (format === 'human') stderr.write(redactText(`错误  ${code}  ${messageForCode(code)}\n`));
      return exitCodeForError(code);
    }
    if (parsed.command === 'support-info') {
      const payload = supportInfo(result, paths, policy);
      if (format === 'jsonl') emitJson(payload);
      else stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return EXIT.SUCCESS;
    }
    if (format === 'human') {
      if (parsed.command === 'health') {
        const permission = await directoryPermission(paths.dataDir());
        if (permission.wide && !parsed.options.quiet) stderr.write('警告  数据目录权限过宽\n');
        stdout.write(`健康检查通过  ${result.model?.provider ?? ''} ${result.model?.model ?? ''}\n`);
      } else if (typeof result.text === 'string' && result.text) stdout.write(`${result.text}\n`);
      else stdout.write(`${JSON.stringify(result)}\n`);
    } else if (parsed.command === 'health') {
      const permission = await directoryPermission(paths.dataDir());
      emitJson({ ...result, permissions: permission, ...(permission.wide ? { warning: 'DATA_PERMISSION_WIDE' } : {}) });
    } else if (parsed.command !== 'task') emitJson(result);
    return EXIT.SUCCESS;
  } catch (error) {
    const code = String(error?.code ?? error?.message ?? 'RUNTIME_ERROR');
    return reportError(code.includes('ENOENT') ? 'DEPENDENCY_ERROR' : code);
  } finally {
    if (!io.disableSignals) {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    }
  }
}

function supportInfo(runtimeResult, paths, policy) {
  const identity = resolvePlatformIdentity({
    HMCODEX_PLATFORM: 'linux-cli',
    HMCODEX_RELEASE_CHANNEL: releaseChannelForPolicy(policy)
  });
  return {
    ok: true,
    platform: identity.platform,
    architecture: identity.architecture,
    node: process.version,
    runtimeVersion: CLI_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    policyChannel: identity.policyChannel,
    executor: identity.executor,
    dataRoot: paths.dataDir(),
    runtime: runtimeResult
  };
}
