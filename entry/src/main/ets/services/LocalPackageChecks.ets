import { LocalWorkspace } from './LocalWorkspace';

interface ProjectScripts {
  pretest?: string;
  test?: string;
  posttest?: string;
}

interface ProjectManifest { scripts?: ProjectScripts; }
interface CheckCommand { command: string; args: string[]; }
type ParseCommand = (line: string) => CheckCommand;

export interface PackageCheck {
  stage: string;
  display: string;
  command: string;
  args: string[];
}

export interface PackageChecks {
  manifest: string;
  steps: PackageCheck[];
}

// Read the entire lifecycle before approval. Never pass a package script to a shell.
export async function readPackageChecks(workspace: LocalWorkspace, parse: ParseCommand): Promise<PackageChecks> {
  let manifest: string;
  try { manifest = await workspace.read('/package.json'); }
  catch (_) { throw new Error('无法读取项目根目录的 package.json'); }
  let pkg: ProjectManifest;
  try { pkg = JSON.parse(manifest) as ProjectManifest; }
  catch (_) { throw new Error('package.json 的 JSON 语法无效'); }
  const scripts = pkg?.scripts;
  if (!scripts || typeof scripts.test !== 'string' || !scripts.test.trim()) {
    throw new Error('package.json 中缺少 test 脚本');
  }
  const lines: (string | undefined)[] = [scripts.pretest, scripts.test, scripts.posttest];
  const stages = ['pretest', 'test', 'posttest'];
  const steps: PackageCheck[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined || line === '') { continue; }
    if (typeof line !== 'string' || line.length > 4096 || /[\x00-\x1f\x7f]/.test(line)) {
      throw new Error('package.json 中的 ' + stages[index] + ' 脚本无效');
    }
    for (const segment of line.split('&&')) {
      const display = segment.trim();
      // Under this compatibility form the device parses ECMAScript without running the file.
      const check = display.replace(/^node +--check +/, 'check-js ');
      let command: CheckCommand;
      try { command = parse(check); }
      catch (_) { throw new Error(stages[index] + ' 包含鸿蒙端未支持的脚本命令'); }
      if (!['check-js', 'check-json', 'git'].includes(command.command) ||
        (command.command === 'git' && command.args[0] !== 'hash-object')) {
        throw new Error(stages[index] + ' 仅支持 JavaScript、JSON 语法检查和 Git 文件摘要');
      }
      if (steps.length >= 12) { throw new Error('单次 npm test 最多支持 12 个检查'); }
      steps.push({ stage: stages[index], display: display, command: command.command, args: command.args });
    }
  }
  return { manifest: manifest, steps: steps };
}

export function describePackageChecks(plan: PackageChecks): string {
  return plan.steps.map((step: PackageCheck) => step.stage + '   ' + step.display).join('\n');
}
