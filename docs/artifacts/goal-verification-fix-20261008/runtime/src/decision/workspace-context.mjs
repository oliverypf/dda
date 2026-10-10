import { posix } from 'node:path';
import { toolResultDecisionClaim } from './evidence-claim.mjs';

const safeRelative = value => typeof value === 'string' && value.length <= 96
  && !/[:\u0000-\u001f]/u.test(value) && !value.replaceAll('\\', '/').startsWith('/')
  && !value.replaceAll('\\', '/').split('/').some(part => part === '.' || part === '..');
const isSource = path => /\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|rb)$/iu.test(path);
const isTest = path => /(?:^|\/)(?:test|tests|__tests__)\//iu.test(path)
  || /(?:^|\/)(?:test[-_][^/]+|[^/]+\.(?:test|spec))\.[cm]?[jt]sx?$/iu.test(path);

// Read current files through the existing authorized workspace service. The
// startup snapshot supplies candidates only; its old contents are never used
// as current evidence. Context collection neither executes a proposed tool
// nor issues a lease, and file text remains untrusted data for the decision.
export const toolWorkspaceDecisionEvidence = async ({ workspace, snapshot, name, proposedInputClaim }) => {
  if (!snapshot?.granted || !['test.execute', 'file.write', 'file.patch'].includes(name)) return [];
  let preview;
  try { preview = JSON.parse(proposedInputClaim).untrustedProposedInput; } catch { return []; }
  if (!preview || preview.pathClass || preview.cwdClass) return [];
  const cwd = preview.cwd === '.' ? '' : preview.cwd ?? '';
  if (!safeRelative(cwd)) return [];
  const directory = cwd.replaceAll('\\', '/');
  if (name === 'test.execute' && (preview.commandName !== 'node' || preview.inlineCode
    || !preview.flags?.some(flag => ['--test', '--check'].includes(flag)))) return [];
  const explicit = (name === 'test.execute' ? preview.targets ?? [] : [preview.path])
    .filter(safeRelative).map(path => posix.join(directory, path.replaceAll('\\', '/')));
  if (name !== 'test.execute' && !explicit.length) return [];
  const contextDirectory = name === 'test.execute' ? directory : posix.dirname(explicit[0]).replace(/^\.$/u, '');
  const candidates = (snapshot.entries ?? []).filter(entry => entry.kind === 'FILE' && safeRelative(entry.path))
    .map(entry => entry.path.replaceAll('\\', '/'))
    .filter(path => contextDirectory ? path.startsWith(`${contextDirectory}/`) : !path.includes('/'))
    .filter(path => isSource(path) || posix.basename(path) === 'package.json');
  const peers = new Set(candidates.filter(isTest).map(path => path.replace(/\.(?:test|spec)(\.[cm]?[jt]sx?)$/iu, '$1')));
  const rank = path => isTest(path) ? 3 : peers.has(path) ? 2 : posix.basename(path) === 'package.json' ? 1 : 0;
  const nearby = candidates.sort((a, b) => rank(b) - rank(a) || a.localeCompare(b));
  const evidence = [];
  for (const path of [...new Set([...explicit, ...nearby])].slice(0, 4)) {
    try {
      const value = await workspace.read(path, 4096);
      evidence.push({ id: `host-workspace-context-${evidence.length + 1}`, type: 'file_content',
        claim: toolResultDecisionClaim('workspace.context.read', value), source: value.digest, confidence: 1 });
    } catch { /* absent, sensitive, excluded and escaped paths provide no file evidence */ }
  }
  return evidence;
};
