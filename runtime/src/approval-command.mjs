const SECRET_VALUE = /^(?:sk-[A-Za-z0-9]|ghp_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{8,}|glpat-|npm_[A-Za-z0-9]{16,}|ya29\.)/;
const SECRET_FLAG = /^--?(?:api[-_]?key|apikey|token|password|passwd|secret|access[-_]?token|authorization|credential)$/i;
const SECRET_ASSIGNMENT = /^([A-Za-z0-9_.-]*(?:api[-_]?key|apikey|token|password|passwd|secret|credential)[A-Za-z0-9_.-]*)=(.*)$/i;

const commandStem = (command) => String(command ?? '')
  .replace(/^.*[\\/]/u, '')
  .toLowerCase()
  .replace(/\.(?:exe|cmd|bat|com)$/iu, '');

export const redactArg = (arg) => {
  const value = String(arg);
  if (SECRET_VALUE.test(value)) return '[REDACTED]';
  if (/^(?:Bearer\s+)\S+/u.test(value)) return '[REDACTED]';
  return value;
};

/** Keep the command visible. Drop credential-shaped values and the argument after a secret flag. */
export const redactArgs = (args) => {
  if (!Array.isArray(args)) return [];
  const out = [];
  let redactNext = false;
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    if (redactNext) {
      out.push('[REDACTED]');
      redactNext = false;
      continue;
    }
    const assignment = arg.match(SECRET_ASSIGNMENT);
    if (assignment) {
      out.push(`${assignment[1]}=[REDACTED]`);
      continue;
    }
    if (SECRET_FLAG.test(arg)) {
      out.push(arg);
      redactNext = true;
      continue;
    }
    out.push(redactArg(arg));
  }
  return out;
};

export const formatCommandLine = (command, args = []) => [command, ...args]
  .filter((part) => typeof part === 'string' && part.length > 0)
  .map((part) => (/[\s"]/u.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part))
  .join(' ');

const oneLine = (text) => String(text ?? '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim();

export const describeCommandZh = ({ command, args = [] } = {}) => {
  const name = commandStem(command);
  const positional = (Array.isArray(args) ? args : []).map((item) => String(item).toLowerCase());
  if (name === 'cargo') {
    const sub = positional.find((item) => item !== '--' && !item.startsWith('-')) ?? '';
    if (sub === 'build') return '将编译当前 Rust 项目，并把产物写入 target 目录';
    if (sub === 'test') return '将编译并运行 Rust 测试';
    if (sub === 'tauri') return '将构建 Tauri 桌面应用，并把产物写入 target 目录';
  }
  if (name === 'tauri' || (positional.includes('tauri') && positional.includes('build'))) {
    return '将构建 Tauri 桌面应用，并把产物写入 target 目录';
  }
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'npx') {
    if (positional.includes('install') || positional.includes('ci')) return '将安装项目依赖';
    const script = positional[0] === 'run' ? positional[1] : ((name === 'yarn' || name === 'pnpm') ? positional[0] : '');
    if (script === 'build' || script.startsWith('build:')) return '将执行 package.json 里的构建脚本';
  }
  const line = [commandStem(command) || command, ...(Array.isArray(args) ? args : [])].join(' ');
  if (/\b(?:rm|rmdir|del|erase|unlink|remove-item)\b/iu.test(line)) return '将删除文件或目录';
  return '将在本机执行这条命令';
};

export const riskReasonsZh = ({ command, args = [] } = {}) => {
  const name = commandStem(command);
  const lowered = [command, ...(Array.isArray(args) ? args : [])].join(' ').toLowerCase();
  const reasons = [];
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'npx') {
    if (/\b(?:install|ci|add|update)\b/u.test(lowered)) reasons.push('可能联网下载依赖');
    if (/\brun\b/u.test(lowered) || ((name === 'yarn' || name === 'pnpm') && /\bbuild\b/u.test(lowered))) {
      reasons.push('会执行 package.json 脚本');
    }
  }
  if ((name === 'cargo' && /\b(?:build|test|tauri)\b/u.test(lowered)) || name === 'tauri' || (/\btauri\b/u.test(lowered) && /\bbuild\b/u.test(lowered))) {
    reasons.push('会写 target 目录');
  }
  if (/\b(?:rm|rmdir|del|erase|unlink|remove-item)\b/u.test(lowered)) reasons.push('会删除文件');
  if (reasons.length === 0) reasons.push('会在本机执行命令');
  return reasons;
};

/** Fields safe to put on an approval event and an intent. Env values are never copied. */
export const publicCommandFields = (request = {}) => {
  if (!request || typeof request !== 'object') return {};
  const command = typeof request.command === 'string' ? request.command.slice(0, 4096) : undefined;
  const args = Array.isArray(request.args)
    ? redactArgs(request.args).slice(0, 64).map((arg) => arg.slice(0, 500))
    : undefined;
  if (!command && !args?.length) return {};
  const cwd = typeof request.cwd === 'string' ? request.cwd.slice(0, 512) : undefined;
  return {
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    commandLine: formatCommandLine(command, args ?? []).slice(0, 4096),
    ...(cwd ? { cwd } : {}),
    summaryZh: oneLine(describeCommandZh({ command, args })),
    riskReasons: riskReasonsZh({ command, args }).slice(0, 8)
  };
};
