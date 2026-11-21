import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
import { LocalWorkspace, workspaceParts } from './LocalWorkspace';
import { PackageChecks, readPackageChecks } from './LocalPackageChecks';
import { checkProjectJavaScript } from './LocalJavaScriptCheck';

export interface LocalCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface ProjectCommand {
  command: string;
  args: string[];
}

const OUTPUT_LIMIT: number = 16384;

export const LOCAL_COMMAND_HELP: string =
  'pwd, ls [path], cat path, wc [-l|-w|-c] path, check-json path, check-js path, git hash-object path, ' +
  'npm test (package.json verification scripts only)';

// The manual input accepts quoted arguments. Expansion, escapes, redirection
// and command separators have no interpretation here.
export function parseProjectCommand(line: string): ProjectCommand {
  if (!line.trim() || line.length > 8192 || /[\u0000-\u001F\u007F]/.test(line)) {
    throw new Error('请输入一行项目命令');
  }
  const words: string[] = [];
  let word = '';
  let inWord = false;
  let quote = '';
  for (const c of line) {
    if (quote) {
      if (c === quote) { quote = ''; }
      else { word += c; }
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === ' ') {
      if (inWord) { words.push(word); word = ''; inWord = false; }
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) { throw new Error('请补全参数的引号'); }
  if (inWord) { words.push(word); }
  const command = words[0];
  const args = words.slice(1);
  const error = validateProjectCommand(command, args);
  if (error) { throw new Error(error); }
  return { command: command, args: args };
}

export function projectCommandPath(args: string[], command: string = ''): string {
  if (command === 'npm') { return '/package.json'; }
  if (!args.length) { return '/'; }
  const argument = args[args.length - 1];
  if (!argument || argument.startsWith('-') || argument.startsWith('~') ||
    /[;|&<>:$`]/.test(argument)) {
    throw new Error('请输入项目路径，命令参数不支持 shell 表达式');
  }
  const relative = argument.startsWith('./') ? argument.substring(2) : argument;
  const path = argument === '.' ? '/' : argument.startsWith('/') ? argument : '/' + relative;
  workspaceParts(path);
  return path;
}

export function validateProjectCommand(command: string, args: string[]): string {
  if (!Array.isArray(args) || args.length > 2 || args.some((arg: string) => typeof arg !== 'string')) {
    return '命令参数应为独立的字符串数组';
  }
  if (command === 'pwd') { return args.length === 0 ? '' : '用法：pwd'; }
  if (command === 'npm') { return args.length === 1 && args[0] === 'test' ? '' : '用法：npm test'; }
  switch (command) {
    case 'ls':
      if (args.length === 0) { return ''; }
      if (args.length !== 1) { return '用法：ls [项目目录]'; }
      break;
    case 'cat':
    case 'check-json':
    case 'check-js':
      if (args.length !== 1) { return '用法：' + command + ' 项目文件'; }
      break;
    case 'wc':
      if (args.length === 0 || (args.length === 2 && !['-l', '-w', '-c'].includes(args[0]))) {
        return '用法：wc [-l|-w|-c] 项目文件';
      }
      break;
    case 'git':
      if (args.length !== 2 || args[0] !== 'hash-object') { return '用法：git hash-object 项目文件'; }
      break;
    default:
      return '支持的本机项目命令：' + LOCAL_COMMAND_HELP;
  }
  try {
    const path = projectCommandPath(args);
    if (path === '/' && command !== 'ls') { return '请指定项目文件'; }
    return '';
  } catch (err) {
    return (err as Error).message;
  }
}

function commandResult(exitCode: number, output: string, truncated: boolean = false): LocalCommandResult {
  const bytes = util.TextEncoder.create().encodeInto(output);
  if (bytes.length > OUTPUT_LIMIT) {
    let end = OUTPUT_LIMIT;
    while ((bytes[end] & 0xC0) === 0x80) { end--; }
    output = util.TextDecoder.create('utf-8', { ignoreBOM: true }).decodeToString(bytes.subarray(0, end));
    truncated = true;
  }
  return { exitCode: exitCode, stdout: exitCode === 0 ? output : '', stderr: exitCode === 0 ? '' : output,
    truncated: truncated };
}

// Project commands are native application tools. No command line, child-process
// entry point, physical path or executable is ever resolved from model input.
export async function runProjectCommand(workspace: LocalWorkspace, command: string, args: string[], approvedPlan?: PackageChecks):
  Promise<LocalCommandResult> {
  const error = validateProjectCommand(command, args);
  if (error) { return commandResult(2, error); }
  if (command === 'pwd') { return commandResult(0, '/\n'); }
  if (command === 'npm') {
    try {
      const plan = await readPackageChecks(workspace, parseProjectCommand);
      if (approvedPlan && approvedPlan.manifest !== plan.manifest) { return commandResult(1, '审批后 package.json 已变化，请重新核对脚本'); }
      let stdout = '';
      for (const step of plan.steps) {
        const result = await runProjectCommand(workspace, step.command, step.args);
        stdout += '> ' + step.stage + ': ' + step.display + '\n' + result.stdout;
        const bounded = commandResult(0, stdout);
        if (result.exitCode !== 0) {
          return { exitCode: result.exitCode, stdout: bounded.stdout, stderr: result.stderr,
            truncated: bounded.truncated || result.truncated };
        }
      }
      return commandResult(0, stdout);
    } catch (err) {
      return commandResult(2, (err as Error).message);
    }
  }
  const path = projectCommandPath(args);
  try {
    if (command === 'ls') {
      const entries = await workspace.list(path);
      let output = '';
      for (const entry of entries) {
        output += entry.fileName + (entry.isDirectory ? '/\n' : '\n');
        if (output.length > OUTPUT_LIMIT) { break; }
      }
      return commandResult(0, output);
    }
    const text = await workspace.read(path);
    if (command === 'cat') { return commandResult(0, text); }
    if (command === 'check-js') {
      const diagnostic = await checkProjectJavaScript(workspace, path, text);
      return diagnostic ? commandResult(1, diagnostic) : commandResult(0, path + ': JavaScript syntax OK\n');
    }
    if (command === 'git') {
      // Git's unfiltered SHA-1 object format includes the byte count and NUL.
      const encoder = util.TextEncoder.create();
      const bytes = encoder.encodeInto(text);
      const hash = cryptoFramework.createMd('SHA1');
      await hash.update({ data: encoder.encodeInto('blob ' + bytes.length + '\x00') });
      if (bytes.length) { await hash.update({ data: bytes }); }
      const digest = await hash.digest();
      let hex = '';
      for (const byte of digest.data) { hex += byte.toString(16).padStart(2, '0'); }
      return commandResult(0, hex + '\n');
    }
    if (command === 'check-json') {
      try {
        JSON.parse(text);
        return commandResult(0, path + '：JSON 有效\n');
      } catch {
        return commandResult(1, path + '：JSON 语法无效');
      }
    }
    const flag = args.length === 2 ? args[0] : '';
    const counts: number[] = [];
    if (!flag || flag === '-l') { counts.push(text.split('\n').length - 1); }
    if (!flag || flag === '-w') { counts.push((text.match(/\S+/g) ?? []).length); }
    if (!flag || flag === '-c') { counts.push(util.TextEncoder.create().encodeInto(text).length); }
    return commandResult(0, counts.join(' ') + ' ' + path + '\n');
  } catch (err) {
    const code = (err as BusinessError).code;
    const reason = code === 13900002 ? '项目路径不存在' : code === 13900013 || code === 201 ?
      '没有读取权限' : '无法读取项目路径';
    return commandResult(1, reason + '：' + path);
  }
}
