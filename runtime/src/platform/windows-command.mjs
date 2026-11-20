import { stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { SafetyError } from '../runtime-safety-monitor.mjs';

// Bare npm/npx shims on Windows are a POSIX shell script plus a .cmd batch
// file; neither can be spawned with shell:false (ENOENT / EINVAL). The
// provisioned Node installation ships the real CLI entry point beside the
// node binary, so map only the bare tool names to `node <cli>` here. Wrappers
// are never read or interpreted, PATH is not searched for a replacement, and
// there is no cmd.exe / shell:true / PowerShell fallback.
const WINDOWS_TOOL_CLI = new Map([
  ['npm', 'npm-cli.js'],
  ['npx', 'npx-cli.js']
]);

const bareWindowsTool = (command) => {
  if (typeof command !== 'string' || !command || command.includes('/') || command.includes('\\')) return undefined;
  const tool = command.toLowerCase().replace(/\.cmd$/u, '');
  return WINDOWS_TOOL_CLI.has(tool) ? tool : undefined;
};

export const resolveWindowsProcessCommand = async (
  { command, args } = {},
  { platform = process.platform, execPath = process.execPath } = {}
) => {
  const tool = platform === 'win32' ? bareWindowsTool(command) : undefined;
  if (!tool) return { command, args };
  const cli = join(dirname(execPath), 'node_modules', 'npm', 'bin', WINDOWS_TOOL_CLI.get(tool));
  const metadata = await stat(cli).catch(() => undefined);
  if (!metadata?.isFile()) throw new SafetyError('EXECUTOR_NODE_CLI_UNAVAILABLE', tool);
  return { command: execPath, args: [cli, ...(args ?? [])] };
};
