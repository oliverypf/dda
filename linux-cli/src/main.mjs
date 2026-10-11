import { readFile } from 'node:fs/promises';
import { release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTaskCancelRegistry } from '../../runtime/src/task-cancel-registry.mjs';
import { buildRuntimeEnv, redactText } from '../../runtime/src/platform/environment-policy.mjs';
import { createPlatformPaths, directoryPermission, ensurePlatformDirs } from '../../runtime/src/platform/paths.mjs';
import { detectCliHost, releaseChannelForPolicy, resolvePlatformIdentity } from '../../runtime/src/platform/platform-identity.mjs';
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

同一入口可在 Linux、Windows 和鸿蒙 PC 上运行。平台由当前系统决定，也可以用
HMCODEX_PLATFORM=linux-cli|windows-cli|harmonyos-cli 显式指定。
`;

async function runtimePackageVersion() {
  try {
    const parsed = JSON.parse(await readFile(join(HERE, '../../runtime/package.json'), 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : '0.1.0';
  } catch {
    return '0.1.0';
  }
}

// Matches runtime DEFAULT_MODEL_CONFIG.apiKeyEnv. That route reads this
// variable when no config file names a credential, so the CLI forwards it
// only while the model route is still the shipped default. The string is
// inlined so the CLI process does not import the model-config module.
const DEFAULT_PROVIDER_KEY_ENV = 'OPENCODE_GO_API_KEY';
// Matches the runtime resolveDecisionConfig default key name. Jev itself is an
// explicit per-deployment opt-in (a `decision` block or HMCODEX_JEV_*), but
// the key is still forwarded while the decision route targets the default
// TypeSafe host, so an opted-in deployment works without a config file.
const DEFAULT_DECISION_KEY_ENV = 'JEV_API_KEY';
// Mirror runtime DEFAULT_MODEL_CONFIG.baseURL and the resolveDecisionConfig
// default endpoint. A default key is only forwarded while its plane still
// targets the host the key belongs to, so an overridden endpoint never
// receives the shipped OpenCode/TypeSafe credential.
const DEFAULT_MODEL_BASE_URL = 'https://opencode.ai/zen/go/v1';
const DEFAULT_DECISION_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const KEY_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;
// HMCODEX_*_API_KEY_ENV variables hold the *name* of a credential variable,
// not a secret, so the value points the CLI at a secret to forward.
const KEY_ENV_POINTER_PATTERN = /^HMCODEX_[A-Z0-9_]*_KEY_ENV$/u;

// Decide which credential variables the runtime child is allowed to see. The
// explicitly named key for each plane is always forwarded; the shipped default
// key is forwarded only while that plane still targets its default host, so an
// overridden HMCODEX_MODEL_ENDPOINT / HMCODEX_JEV_ENDPOINT never receives the
// default OpenCode/TypeSafe secret.
export async function providerKeyNames(configPath, env = {}) {
  let fileConfig = {};
  if (configPath) {
    try {
      const parsed = JSON.parse(await readFile(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fileConfig = parsed;
    } catch {
      // A missing or unreadable config still uses the runtime default keys.
    }
  }
  const envValue = (name) => {
    const value = env?.[name];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  const fileString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

  const names = [];

  // Model plane. The runtime resolves the credential variable as
  // config.apiKeyEnv -> HMCODEX_MODEL_API_KEY_ENV -> OPENCODE_GO_API_KEY.
  const modelApiKeyEnv = fileString(fileConfig.apiKeyEnv) ?? envValue('HMCODEX_MODEL_API_KEY_ENV');
  const modelBaseURL = fileString(fileConfig.baseURL) ?? envValue('HMCODEX_MODEL_BASE_URL') ?? DEFAULT_MODEL_BASE_URL;
  const modelEndpoint = fileString(fileConfig.endpoint) ?? envValue('HMCODEX_MODEL_ENDPOINT');
  const modelRouteIsDefault = modelBaseURL === DEFAULT_MODEL_BASE_URL && modelEndpoint === undefined;
  if (modelRouteIsDefault || modelApiKeyEnv === DEFAULT_PROVIDER_KEY_ENV) names.push(DEFAULT_PROVIDER_KEY_ENV);
  if (modelApiKeyEnv) names.push(modelApiKeyEnv);

  // Decision (Jev) plane. The runtime resolves the variable as
  // decision.apiKeyEnv -> HMCODEX_JEV_API_KEY_ENV -> JEV_API_KEY.
  const decision = (fileConfig.decision && typeof fileConfig.decision === 'object' && !Array.isArray(fileConfig.decision))
    ? fileConfig.decision
    : {};
  const decisionApiKeyEnv = fileString(decision.apiKeyEnv) ?? envValue('HMCODEX_JEV_API_KEY_ENV');
  const decisionEndpoint = fileString(decision.endpoint) ?? envValue('HMCODEX_JEV_ENDPOINT') ?? DEFAULT_DECISION_ENDPOINT;
  const decisionRouteIsDefault = decisionEndpoint === DEFAULT_DECISION_ENDPOINT;
  if (decisionRouteIsDefault || decisionApiKeyEnv === DEFAULT_DECISION_KEY_ENV) names.push(DEFAULT_DECISION_KEY_ENV);
  if (decisionApiKeyEnv) names.push(decisionApiKeyEnv);

  // Registry entries name their own credential variable.
  if (Array.isArray(fileConfig.models)) {
    for (const model of fileConfig.models) {
      if (typeof model?.apiKeyEnv === 'string') names.push(model.apiKeyEnv);
    }
  }

  // Any HMCODEX_*_API_KEY_ENV points at a secret the runtime will read for a
  // provider (for example the OpenViking context plane), so forward the target.
  for (const [key, value] of Object.entries(env ?? {})) {
    if (KEY_ENV_POINTER_PATTERN.test(key) && typeof value === 'string' && value.trim()) names.push(value.trim());
  }

  return [...new Set(names.filter((name) => KEY_NAME_PATTERN.test(name)))];
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

export async function main(argv, io = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  const isTTY = io.isTTY ?? Boolean(stderr.isTTY);
  // Terminal approval needs a human on both ends: questions go to stderr and
  // answers come from stdin. A piped stdin can never answer a y/N prompt.
  const stdin = io.stdin ?? process.stdin;
  const approvalTTY = io.approvalTTY ?? (isTTY && Boolean(stdin?.isTTY));
  const host = detectCliHost({
    env,
    platform: io.platform ?? process.platform,
    release: io.release ?? release()
  });
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
      platform: host
    };
    if (format === 'jsonl') emitJson({ ok: true, ...version });
    else stdout.write(`dda ${version.cli}\nruntime ${version.runtime}\nprotocol ${version.protocol}\nplatform ${version.platform}\n`);
    return EXIT.SUCCESS;
  }
  if (!COMMANDS.has(parsed.command)) return reportError('UNKNOWN_COMMAND');

  const pathEnv = {
    ...env,
    HMCODEX_PLATFORM: host,
    ...(parsed.options.dataDir ? { HMCODEX_DATA_DIR: parsed.options.dataDir } : {}),
    ...(parsed.options.config ? { HMCODEX_MODEL_CONFIG: parsed.options.config } : {})
  };
  const paths = createPlatformPaths(pathEnv);
  if (!paths.dataDir() || !paths.configDir()) return reportError('STORAGE_ERROR');

  // Directory setup creates dataDir/plugins. That must not happen before
  // migrate-data, or a fresh target is reported as TARGET_NONEMPTY.
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

  try {
    await ensurePlatformDirs(paths);
  } catch (error) {
    return reportError(error?.code === 'ENOSPC' ? 'ENOSPC' : 'STORAGE_ERROR');
  }

  const executionMode = parsed.options.executionMode ?? 'READ_ONLY';
  let workspace;
  if (parsed.command === 'task' || parsed.command === 'tools' || (parsed.command === 'thread' && parsed.subcommand === 'create')) {
    if (!parsed.options.workspace) return reportError(parsed.command === 'task' ? 'ARGUMENT_INVALID' : 'WORKSPACE_NOT_FOUND');
    try {
      workspace = resolveWorkspace(parsed.options.workspace, host);
    } catch (error) {
      return reportError(error.code ?? 'WORKSPACE_NOT_FOUND');
    }
  } else if (parsed.options.workspace) {
    try {
      workspace = resolveWorkspace(parsed.options.workspace, host);
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
    approvalMode = parsed.options.approvalMode ?? (approvalTTY ? 'prompt' : undefined);
    if (!approvalMode || (approvalMode === 'prompt' && !approvalTTY)) return reportError('APPROVAL_UNAVAILABLE');
    // A mode that needs host input but has no reader would leave every
    // request pending until it expires; fail early instead.
    if (approvalMode === 'prompt' && typeof io.readApprovalLine !== 'function') return reportError('APPROVAL_UNAVAILABLE');
    if (approvalMode === 'jsonl' && !io.approvalInput) return reportError('APPROVAL_UNAVAILABLE');
  }

  const configPath = parsed.options.config ?? (env.HMCODEX_MODEL_CONFIG?.trim() || undefined);
  const keyNames = await providerKeyNames(configPath ?? paths.modelConfigPath(), env);
  const childEnv = buildRuntimeEnv(env, { extraKeys: keyNames });
  childEnv.HMCODEX_PLATFORM = host;
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
    void registry.request(active.runId, { reason: 'SIGINT', requestedBy: host }).catch(() => undefined);
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
  // A CONTROLLED task that fails after a declined or expired approval exits
  // with the contract's approval code (5), not a generic runtime error.
  let approvalDeclined = false;
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
      tty: approvalTTY,
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
          if (event.kind === 'approval.resolved' && event.payload?.state && event.payload.state !== 'APPROVED') approvalDeclined = true;
          if (format === 'jsonl') emitJson(event);
          else if (!parsed.options.quiet && event.kind !== 'runtime.heartbeat') stderr.write(`${humanEventLine(event)}\n`);
          if (event.kind === 'approval.requested' && approvalMode === 'prompt') stderr.write(`${describeApproval(event)}\n`);
          return;
        }
        finalResult = event;
        if (format === 'jsonl' && parsed.command === 'task') {
          emitJson(event.ok === false
            ? errorResult(typeof event.error === 'string' ? event.error : 'RUNTIME_ERROR', {
                runId: event.runId,
                ...(approvalDeclined ? { approval: 'DECLINED' } : {})
              })
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
      if (format === 'human') {
        const shown = approvalDeclined ? 'APPROVAL_DENIED' : code;
        stderr.write(redactText(`错误  ${shown}  ${messageForCode(shown)}\n`));
      }
      return approvalDeclined ? EXIT.APPROVAL_DENIED : exitCodeForError(code);
    }
    if (parsed.command === 'support-info') {
      const payload = supportInfo(result, paths, policy, host, await runtimePackageVersion());
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

function supportInfo(runtimeResult, paths, policy, host, runtimeVersion) {
  const identity = resolvePlatformIdentity({
    HMCODEX_PLATFORM: host,
    HMCODEX_RELEASE_CHANNEL: releaseChannelForPolicy(policy)
  });
  return {
    ok: true,
    platform: identity.platform,
    architecture: identity.architecture,
    node: process.version,
    cliVersion: CLI_VERSION,
    runtimeVersion,
    protocolVersion: PROTOCOL_VERSION,
    policyChannel: identity.policyChannel,
    executor: identity.executor,
    dataRoot: paths.dataDir(),
    runtime: runtimeResult
  };
}
