import { posix } from 'node:path';
import { insideRoot } from '../filesystem-access.mjs';
import { toolResultDecisionClaim } from './evidence-claim.mjs';
import { READONLY_FAST_PATH_TOOLS } from './readonly-fast-path.mjs';
import { sanitizeOutput } from '../runtime-safety-monitor.mjs';

const safeRelative = value => typeof value === 'string' && value.length <= 96
  && !/[:\u0000-\u001f]/u.test(value) && !value.replaceAll('\\', '/').startsWith('/')
  && !value.replaceAll('\\', '/').split('/').some(part => part === '.' || part === '..');
const isSource = path => /\.(?:[cm]?[jt]sx?|py|rs|go|java|cs|rb)$/iu.test(path);
const isTest = path => /(?:^|\/)(?:test|tests|__tests__)\//iu.test(path)
  || /(?:^|\/)(?:test[-_][^/]+|[^/]+\.(?:test|spec))\.[cm]?[jt]sx?$/iu.test(path);

const GIT_GREP_FLAGS = new Set([
  '--heading', '--break', '--line-number', '--column', '--ignore-case', '--fixed-strings',
  '--word-regexp', '--extended-regexp', '--basic-regexp', '--files-with-matches',
  '--files-without-match', '--name-only', '--count', '--quiet', '--only-matching',
  '--invert-match', '--no-color', '--no-textconv'
]);
const GIT_LS_FILES_FLAGS = new Set(['--cached', '--stage', '--full-name', '-z', '-c', '-s']);
const GIT_REV_PARSE_FLAGS = new Set(['--show-toplevel', '--show-prefix', '--is-inside-work-tree', '--is-bare-repository']);
const literalGitPath = path => safeRelative(path) && /^[\p{L}\p{N}_. /\\-]+$/u.test(path);

const hasReadOnlyGrepPattern = args => {
  let explicitPattern = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '-e') {
      index += 1;
      if (!args[index]) return false;
      explicitPattern = true;
    } else if (!GIT_GREP_FLAGS.has(arg) && !/^-[iInHhFlLqvwcEGoz]+$/u.test(arg)) {
      // A single positional pattern is allowed. Additional positional tokens
      // could select a tree, so literal paths must follow the -- separator.
      return !explicitPattern && index === args.length - 1 && Boolean(arg) && !arg.startsWith('-');
    }
  }
  return explicitPattern;
};

// Match complete argv before it is reduced to the display and decision summary.
// The result describes the expected effect of a built-in Git command form.
export const classifyReadOnlyGitCommand = ({ command, args, cwd = '', env } = {}) => {
  if (env !== undefined || !['git', 'git.exe'].includes(command) || !Array.isArray(args)
    || args.length > 32 || args.some(arg => typeof arg !== 'string' || arg.length > 512 || /[\u0000-\u001f\u007f]/u.test(arg))) return undefined;
  if (cwd === '.') cwd = '';
  if (cwd !== '' && !literalGitPath(cwd)) return undefined;
  const [subcommand, ...argv] = args;
  const separator = argv.indexOf('--');
  const options = separator === -1 ? argv : argv.slice(0, separator);
  const paths = separator === -1 ? [] : argv.slice(separator + 1);
  if (paths.length > 8 || !paths.every(literalGitPath)) return undefined;

  if (subcommand === 'grep' && hasReadOnlyGrepPattern(options)
    || subcommand === 'ls-files' && options.every(arg => GIT_LS_FILES_FLAGS.has(arg))
    || subcommand === 'rev-parse' && separator === -1 && options.length === 1 && GIT_REV_PARSE_FLAGS.has(options[0])) {
    return { operation: `git ${subcommand}`, cwd, paths };
  }
  return undefined;
};

export const readOnlyCommandDecisionEvidence = async ({ workspace, inspection }) => {
  if (!inspection) return undefined;
  const cwdCheck = await workspace.checkPathScope(inspection.cwd);
  if (cwdCheck !== 'IN_WORKSPACE') return undefined;
  for (const path of inspection.paths) {
    const target = posix.join(inspection.cwd.replaceAll('\\', '/'), path.replaceAll('\\', '/'));
    if (await workspace.checkPathScope(target) !== 'IN_WORKSPACE') return undefined;
  }
  const claim = { operation: inspection.operation, expectedEffect: 'READ_ONLY', cwdCheck,
    explicitPathsChecked: inspection.paths.length };
  return { id: 'host-command-inspection', type: 'runtime_state', claim: JSON.stringify({ hostCommandInspection: claim }),
    source: 'host-git-argv-and-workspace-preflight', confidence: 1 };
};

export const workspaceReadScopeDecisionEvidence = async ({ workspace, name, path }) => {
  if (!READONLY_FAST_PATH_TOOLS.has(name)) return undefined;
  const target = path ?? (name.endsWith('list') ? '' : undefined);
  if (typeof target !== 'string') return undefined;
  const scope = await workspace.checkPathScope(target);
  return {
    id: 'host-workspace-read-scope', type: 'runtime_state',
    claim: JSON.stringify({ hostWorkspaceReadScope: scope }),
    source: 'host-read-path-preflight', confidence: 1
  };
};

export const workspaceWriteDecisionEvidence = async ({ name, path, accessMode, monitor, exclusions = [], history = [], pendingVerification } = {}) => {
  if (!['file.write', 'file.patch'].includes(name)) return undefined;
  const facts = {
    accessMode,
    targetCheck: 'UNVERIFIED',
    historicalRiskSignals: history.filter(code => code === 'SAFETY_BELOW_THRESHOLD' || code === 'FAILURE_OBSERVED'),
    ...(pendingVerification ? { pendingVerification } : {})
  };
  if (typeof path === 'string' && path && monitor) {
    try {
      const target = await monitor.canonicalPath(path, { forWrite: true });
      if (exclusions.some(excluded => insideRoot(excluded, target.absolutePath))) {
        facts.targetCheck = 'DENIED';
        facts.targetCheckReason = 'WORKSPACE_EXCLUDED_PATH';
      } else {
        facts.targetCheck = insideRoot(target.root, target.absolutePath) ? 'IN_WORKSPACE' : 'OUTSIDE_WORKSPACE';
        facts.targetExists = target.exists;
        if (name === 'file.patch' && target.exists === false) facts.targetCheck = 'MISSING_PATCH_TARGET';
      }
    } catch (error) {
      // Report established policy denials separately from I/O or other gaps.
      // Never send raw error messages or resolved absolute paths.
      if (typeof error?.code === 'string' && /^SAFETY_[A-Z_]{1,60}$/u.test(error.code)) {
        facts.targetCheckReason = error.code;
        if (/^SAFETY_(?:PATH_INVALID|PROTECTED_PATH|WORKSPACE_(?:PATH_FORBIDDEN|SENSITIVE_PATH|GIT_METADATA|LINK_FORBIDDEN))$/u.test(error.code)) {
          facts.targetCheck = 'DENIED';
        }
      }
    }
  }
  return { id: 'host-workspace-write-check', type: 'runtime_state', claim: JSON.stringify({ hostWorkspaceWriteCheck: facts }),
    source: 'host-write-path-preflight', confidence: 1 };
};

const fileEvidence = (index, kind, value) => ({
  id: `host-workspace-context-${index + 1}`, type: 'file_content',
  claim: toolResultDecisionClaim(kind, value), source: value.digest, confidence: 1
});

const npmScriptEvidence = async (workspace, { command, args, cwd = '.' } = {}) => {
  if (!/^npm(?:\.cmd|\.exe)?$/iu.test(command) || !Array.isArray(args)
    || args.length !== 2 || args[0] !== 'run' || !/^[a-z0-9][a-z0-9:_-]{0,63}$/iu.test(args[1])) return [];
  const directory = cwd === '.' ? '' : cwd;
  if (!safeRelative(directory)) return [];
  const resolveEntry = path => posix.join(directory.replaceAll('\\', '/'), path);
  const manifest = await workspace.read(resolveEntry('package.json'), 32 * 1024).catch(() => undefined);
  if (!manifest || manifest.truncated) return [];
  let scripts;
  try { scripts = JSON.parse(manifest.content.replace(/^\uFEFF/u, ''))?.scripts; } catch { return []; }
  const script = args[1];
  const hasScript = name => scripts && Object.hasOwn(scripts, name) && typeof scripts[name] === 'string';
  if (!hasScript(script)) return [];

  // npm can also run the matching pre/post hooks. Command text is evidence,
  // never passed to a shell or treated as authorization.
  const lifecycle = [`pre${script}`, script, `post${script}`].filter(hasScript);
  const evidence = lifecycle.map((name, i) => fileEvidence(i, 'workspace.context.npm-script', {
    ...manifest, content: `${name}: ${sanitizeOutput(scripts[name])}`
  }));
  const entryPoints = new Map();
  for (const name of lifecycle) {
    const definition = scripts[name].trim();
    const direct = /^node(?:\.exe)?\s+(?:\.\/)?([a-z0-9_./-]+\.[cm]?js)$/iu.exec(definition)?.[1];
    // Some Windows package scripts use npm's local prefix. Show the file
    // relative to this package as a candidate, without expanding the shell.
    const localPrefix = /^node(?:\.exe)?\s+"%npm_config_local_prefix%\/([a-z0-9_./-]+\.[cm]?js)"$/iu.exec(definition)?.[1];
    const path = direct ?? localPrefix;
    if (safeRelative(path)) entryPoints.set(path, Boolean(localPrefix) && entryPoints.get(path) !== false);
  }
  for (const [path, reliesOnLocalPrefix] of entryPoints) {
    const entry = await workspace.read(resolveEntry(path), 4096).catch(() => undefined);
    if (entry) evidence.push(fileEvidence(evidence.length,
      reliesOnLocalPrefix ? 'workspace.context.npm-local-prefix-candidate' : 'workspace.context.npm-entry',
      { ...entry, content: sanitizeOutput(entry.content) }));
  }
  return evidence;
};

// Read current files through the existing authorized workspace service. The
// startup snapshot supplies candidates only; its old contents are never used
// as current evidence. Context collection neither executes a proposed tool
// nor issues a lease, and file text remains untrusted data for the decision.
export const toolWorkspaceDecisionEvidence = async ({ workspace, snapshot, name, proposedInputClaim, request }) => {
  if (!snapshot?.granted) return [];
  if (name === 'shell.execute') return npmScriptEvidence(workspace, request);
  if (!['test.execute', 'file.write', 'file.patch'].includes(name)) return [];
  let preview;
  try { preview = JSON.parse(proposedInputClaim).untrustedProposedInput; } catch { return []; }
  if (!preview || preview.pathClass || preview.cwdClass) return [];
  const cwd = preview.cwd === '.' ? '' : preview.cwd ?? '';
  if (!safeRelative(cwd)) return [];
  const directory = cwd.replaceAll('\\', '/');
  if (name === 'test.execute' && (!['node', 'node.exe'].includes(preview.commandName) || preview.inlineCode
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
      evidence.push(fileEvidence(evidence.length, 'workspace.context.read', value));
    } catch { /* absent, sensitive, excluded and escaped paths provide no file evidence */ }
  }
  return evidence;
};

// A citation selects from host-known workspace sources; it never authorizes
// an arbitrary path from the answer. Re-read through the live path policy so
// stale snapshot bytes cannot be presented as a current observation.
export async function verificationSourceEvidence({ workspace, snapshot, actions = [], conclusion, receipts = [] }) {
  if (!snapshot?.granted || !conclusion) return [];
  const answer = String(conclusion);
  const cited = path => {
    if (!path || !safeRelative(path)) return false;
    let start = answer.indexOf(path);
    while (start >= 0) {
      const before = answer[start - 1] ?? '';
      const after = answer[start + path.length] ?? '';
      const extendedSuffix = after === '.' && /[a-z\d_]/iu.test(answer[start + path.length + 1] ?? '');
      if (!/[a-z\d_.\/\\-]/iu.test(before) && !/[a-z\d_\/\\-]/iu.test(after) && !extendedSuffix) return true;
      start = answer.indexOf(path, start + path.length);
    }
    return false;
  };
  const evidence = [];
  for (const receipt of receipts.toReversed()) {
    const artifact = receipt.artifacts?.find(file => cited(file.path));
    const arg = receipt.args?.find(value => /\.[\w]{1,8}$/u.test(value) && cited(value));
    if (!artifact && !arg) continue;
    const process = { kind: receipt.kind, executable: posix.basename(receipt.command.replaceAll('\\', '/')),
      ...(arg ? { citedArgument: arg } : {}), exitCode: receipt.exitCode, timedOut: receipt.timedOut, aborted: receipt.aborted,
      ...(receipt.testCounts ? { testCounts: receipt.testCounts } : {}),
      ...(artifact ? { artifact: { path: artifact.path, sizeBytes: artifact.sizeBytes, sha256: artifact.sha256, pptx: artifact.pptx } } : {}) };
    const claim = JSON.stringify(process);
    if (claim.length <= 500) evidence.push({ id: receipt.id, type: 'tool_result', claim,
      source: receipt.outputDigest, confidence: 1 });
    if (evidence.length === 3) break;
  }
  const readPaths = actions.filter(action => action.state === 'SUCCEEDED' && action.invocationAttempted !== false
    && action.verifiedResult?.workspaceRead?.scope === 'IN_WORKSPACE'
    && action.verifiedResult.workspaceRead.readOnly && action.outputDigest
    && action.outputDigest === action.verifiedResult.outputDigest
    && ['workspace.read', 'kernel.workspace_read', 'workspace.focus', 'kernel.workspace_focus'].includes(action.name))
    .map(action => action.verifiedResult.workspaceRead.path);
  // Only cite files that the current run actually observed or referenced in a
  // durable process receipt. Snapshot sections are background metadata and do
  // not establish evidence for this task.
  const paths = [...new Set(readPaths.toReversed())]
    .filter(path => cited(path) && !/\.pptx$/iu.test(path)).slice(0, 4);
  const words = new Set(answer.toLowerCase().match(/[a-z][a-z\d_.:-]{2,}|[\p{Script=Han}]{2,10}/gu) ?? []);
  for (const path of paths) {
    const value = await workspace.read(path, 32 * 1024).catch(() => undefined);
    if (value?.path !== path || !value.digest || typeof value.content !== 'string') continue;
    const lines = sanitizeOutput(value.content).split(/\r?\n/u).map((line, i) => {
      const text = line.trim();
      const tokens = new Set(text.toLowerCase().match(/[a-z][a-z\d_.:-]{2,}|[\p{Script=Han}]{2,10}/gu) ?? []);
      return { i, text, matches: [...tokens].filter(token => words.has(token)).length };
    }).filter(line => line.text).sort((a, b) => b.matches - a.matches || a.i - b.i).slice(0, 3)
      .sort((a, b) => a.i - b.i).map(line => `L${line.i + 1} ${line.text.slice(0, 100)}`);
    if (lines.length) evidence.push({ id: `cited-source-${evidence.length + 1}`, type: 'file_content',
      claim: toolResultDecisionClaim('workspace.verification-excerpts', { path, content: lines.join('\n'), truncated: true }),
      source: value.digest, confidence: 1 });
  }
  return evidence;
}
