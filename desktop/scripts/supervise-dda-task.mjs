// Supervise the real dda CLI; feature edits remain attributable to its tools.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir, cp, realpath } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { dirname, resolve, relative, isAbsolute, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const digest = value => createHash('sha256').update(value).digest('hex');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const save = async (path, value) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value, null, 2) + '\n'); };
export function boundedPrompt(value) {
  const prompt = String(value ?? '').trim();
  if (!prompt || prompt.length > 8000) throw Error('PROMPT_SIZE: supply 1–8000 characters; split the task instead of silently truncating its requirements');
  return prompt;
}
export function recoveryPrompt(original, result, feedback) {
  if (!String(feedback ?? '').trim()) throw Error('RECOVERY_FEEDBACK_REQUIRED');
  return boundedPrompt(`${original.trim()}\n\n监督恢复记录（按当前文件继续，不重复已完成的写入）：\n${JSON.stringify({ previousExitCode: result.code, previousRuntimeOk: result.finalResult?.ok ?? null, previousError: result.finalResult?.error ?? null, changedFiles: result.changedFiles, validationStatus: result.validationStatus })}\n监督者独立检查的剩余问题：\n${feedback.trim()}`);
}
async function recover(spec, attempt, feedbackPath, outputPath) {
  if (!/^[a-zA-Z0-9_-]+$/.test(attempt ?? '')) throw Error('INVALID_ATTEMPT_NAME');
  const dir = scopedPath(spec.evidenceRoot, attempt);
  const result = await json(join(dir, 'result.json'));
  const after = await json(join(dir, 'workspace-after.json'));
  for (const path of spec.allowedFiles) {
    if (digest(await readFile(await plainPath(spec.workspace, path))) !== after[path]) throw Error('RECOVERY_WORKSPACE_CHANGED: ' + path);
  }
  const prompt = recoveryPrompt(await readFile(join(dir, 'prompt.txt'), 'utf8'), result, await readFile(feedbackPath, 'utf8'));
  await writeFile(outputPath, prompt, { flag: 'wx' });
  return { promptPath: resolve(outputPath), promptChars: prompt.length, previousAttempt: attempt, previousRunPreserved: true };
}
export function scopedPath(root, path) {
  const full = resolve(root, path), rel = relative(resolve(root), full);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw Error('PATH_OUTSIDE_WORKSPACE');
  return full;
}
async function plainPath(root, path) {
  const full = scopedPath(root, path);
  const actual = await realpath(full);
  scopedPath(await realpath(root), actual);
  if (actual.toLowerCase() !== full.toLowerCase()) throw Error('SYMLINK_PATH');
  return full;
}
export async function approveWrite(workspace, allowedFiles, payload) {
  if (payload.capability !== 'file.write' || typeof payload.path !== 'string'
    || !payload.requestId || !payload.requestDigest) return false;
  try {
    const target = await plainPath(workspace, payload.path);
    return allowedFiles.some(path => scopedPath(workspace, path) === target);
  } catch { return false; }
}
async function treeHashes(root) {
  const hashes = {};
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error('SYMLINK_IN_SNAPSHOT: ' + path);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) hashes[relative(root, path).replaceAll('\\', '/')] = digest(await readFile(path));
    }
  }
  await walk(root);
  return hashes;
}
export async function prepare(spec) {
  await mkdir(spec.workspace, { recursive: false });
  for (const path of spec.copyPaths) {
    const source = await plainPath(spec.sourceRoot, path), target = scopedPath(spec.workspace, path);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, errorOnExist: true, force: false, dereference: false });
  }
  const baseline = await treeHashes(spec.workspace);
  for (const path of spec.allowedFiles) if (!baseline[path]) throw Error('ALLOWED_FILE_MISSING: ' + path);
  await save(join(spec.evidenceRoot, 'baseline.json'), { createdAt: new Date().toISOString(), sourceRoot: spec.sourceRoot, workspace: spec.workspace, hashes: baseline });
  return { files: Object.keys(baseline).length, workspace: spec.workspace };
}
export async function adoptionPlan(spec, acceptedHashes) {
  const baseline = await json(join(spec.evidenceRoot, 'baseline.json'));
  const changes = [];
  // Preflight every destination before any writes, including concurrent changes.
  for (const path of spec.allowedFiles) {
    const source = await readFile(await plainPath(spec.workspace, path));
    const candidateHash = digest(source);
    if (candidateHash === baseline.hashes[path]) continue;
    if (acceptedHashes[path] !== candidateHash) throw Error('UNVERIFIED_CANDIDATE: ' + path);
    const destination = await plainPath(spec.sourceRoot, path);
    if (digest(await readFile(destination)) !== baseline.hashes[path]) throw Error('ADOPTION_CONFLICT: ' + path);
    changes.push({ path, destination, content: source, hash: candidateHash });
  }
  return changes;
}
async function adopt(spec, acceptancePath) {
  const acceptance = await json(acceptancePath);
  if (acceptance.status !== 'passed' || !acceptance.checks?.length || acceptance.checks.some(check => check.passed !== true)) throw Error('ACCEPTANCE_REQUIRED');
  const changes = await adoptionPlan(spec, acceptance.hashes ?? {});
  for (const change of changes) {
    // Retain the exact pre-adoption bytes as an additional recovery artifact.
    const backup = join(spec.evidenceRoot, 'adoption-backup', change.path);
    await mkdir(dirname(backup), { recursive: true });
    await cp(change.destination, backup, { errorOnExist: true, force: false });
    await writeFile(change.destination, change.content);
  }
  const result = { acceptedAt: new Date().toISOString(), acceptancePath: resolve(acceptancePath), changes: changes.map(({ path, hash }) => ({ path, hash })) };
  await save(join(spec.evidenceRoot, 'adoption.json'), result);
  return result;
}
export async function run(spec, attempt, promptPath) {
  if (!/^[a-zA-Z0-9_-]+$/.test(attempt ?? '')) throw Error('INVALID_ATTEMPT_NAME');
  const prompt = boundedPrompt(await readFile(promptPath, 'utf8'));
  const dir = scopedPath(spec.evidenceRoot, attempt);
  await mkdir(dir, { recursive: false });
  await writeFile(join(dir, 'prompt.txt'), prompt);
  const before = await treeHashes(spec.workspace);
  await save(join(dir, 'workspace-before.json'), before);
  const runtimeRoot = resolve(spec.sourceRoot, 'runtime');
  await save(join(dir, 'runtime-before.json'), await treeHashes(join(runtimeRoot, 'src')));
  const config = await json(spec.configPath);
  const timeoutMs = spec.timeoutMs ?? 900000;
  const args = [join(runtimeRoot, 'src/index.mjs'), 'task', '--config', spec.configPath, '--workspace', spec.workspace,
    '--prompt', prompt, '--execution-mode', 'CONTROLLED', '--lease-capabilities', 'file.write', '--lease-commands', 'node',
    '--agent-mode', 'single', '--max-tool-rounds', String(spec.maxToolRounds ?? 48), '--max-recovery-attempts', '2', '--task-timeout-ms', String(timeoutMs),
    '--trajectory-store', join(dir, 'trajectory.jsonl'), '--thread-store', join(dir, 'threads.json'), '--events', 'stdout'];
  const env = { ...process.env, HMCODEX_DATA_DIR: dir, HMCODEX_CONTEXT_PROVIDER: 'journal', HMCODEX_HARNESS_EVENT_STORE: join(dir, 'harness.db'),
    HMCODEX_RELEASE_CHANNEL: 'WINDOWS_FULL_LOCAL', HMCODEX_EXECUTION_MODE: 'CONTROLLED', HMCODEX_JEV_ENABLED: '1', HMCODEX_JEV_ENFORCE: '1', HMCODEX_EVENTS: '' };
  delete env.HMCODEX_BAKED_RELEASE_CHANNEL;
  delete env.NODE_TEST_CONTEXT;
  await save(join(dir, 'invocation.json'), { workspace: spec.workspace, runtime: args[0], model: config.model, configHash: digest(await readFile(spec.configPath)), promptChars: prompt.length, timeoutMs, allowedFiles: spec.allowedFiles, jevEnabled: true, jevEnforce: true });
  const stdout = createWriteStream(join(dir, 'stdout.jsonl')), stderr = createWriteStream(join(dir, 'stderr.log'));
  const audit = createWriteStream(join(dir, 'supervisor.jsonl'));
  const startedAt = Date.now();
  const child = spawn(process.execPath, args, { cwd: runtimeRoot, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') audit.write(JSON.stringify({ event: 'stdin.error', code: error.code }) + '\n'); });
  child.stdout.pipe(stdout); child.stderr.pipe(stderr);
  child.stdout.setEncoding('utf8');
  let pending = '', finalResult, killed = false, eventCount = 0, latestEvent, latestTool, approvalChain = Promise.resolve();
  const log = value => { audit.write(JSON.stringify(value) + '\n'); console.log(JSON.stringify(value)); };
  const handle = line => {
    let event; try { event = JSON.parse(line); } catch { return; }
    eventCount += 1; latestEvent = event.kind ?? event.type;
    const p = event.payload ?? {};
    if (event.type === 'result' || (typeof event.ok === 'boolean' && !event.kind)) finalResult = event;
    if (event.kind === 'approval.requested') approvalChain = approvalChain.then(async () => {
      const approved = await approveWrite(spec.workspace, spec.allowedFiles, p);
      log({ event: 'supervisor.approval', requestId: p.requestId, capability: p.capability, path: p.path, approved });
      if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ type: 'approval_response', requestId: p.requestId, displayedDigest: p.requestDigest, approved }) + '\n');
    });
    if (event.kind === 'tool.result') { latestTool = { name: p.name, ok: p.ok, error: p.errorCode }; log({ event: event.kind, ...latestTool }); }
    if (event.kind === 'harness.progress_checkpoint') log({ event: event.kind, payload: p });
  };
  child.stdout.on('data', chunk => { pending += chunk.toString(); let end; while ((end = pending.indexOf('\n')) >= 0) { const line = pending.slice(0, end); pending = pending.slice(end + 1); handle(line); } });
  await save(join(dir, 'process.json'), { pid: child.pid, startedAt });
  log({ event: 'supervisor.started', attempt, pid: child.pid, model: config.model, evidence: dir });
  const heartbeat = setInterval(() => log({ event: 'supervisor.progress', elapsedMs: Date.now() - startedAt, eventCount, latestEvent, latestTool }), 30000);
  const watchdog = setTimeout(() => {
    killed = true;
    if (process.platform === 'win32' && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    else child.kill('SIGTERM');
  }, timeoutMs + 60000);
  let exit;
  try { exit = await new Promise((done, reject) => { child.once('close', (code, signal) => done({ code, signal })); child.once('error', reject); }); }
  finally { clearInterval(heartbeat); clearTimeout(watchdog); }
  if (pending.trim()) handle(pending);
  await approvalChain;
  await Promise.all([finished(stdout), finished(stderr)]);
  const after = await treeHashes(spec.workspace);
  const changedFiles = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]);
  const runtimeAfter = await treeHashes(join(runtimeRoot, 'src'));
  await save(join(dir, 'workspace-after.json'), after);
  await save(join(dir, 'runtime-after.json'), runtimeAfter);
  const result = { ...exit, killed, durationMs: Date.now() - startedAt, eventCount, changedFiles, unauthorizedChanges: changedFiles.filter(path => !spec.allowedFiles.includes(path)), finalResult: finalResult ?? null, validationStatus: 'not_independently_verified' };
  await save(join(dir, 'result.json'), result);
  log({ event: 'supervisor.finished', ...exit, killed, durationMs: result.durationMs, changedFiles, runtimeOk: finalResult?.ok ?? finalResult?.payload?.ok ?? null });
  audit.end(); await finished(audit);
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, specPath, ...args] = process.argv.slice(2);
  const spec = await json(specPath);
  const result = command === 'prepare' ? await prepare(spec) : command === 'run' ? await run(spec, ...args) : command === 'recover' ? await recover(spec, ...args) : command === 'adopt' ? await adopt(spec, args[0]) : (() => { throw Error('Usage: supervise-dda-task.mjs prepare|run|recover|adopt spec.json [attempt prompt.txt | attempt feedback.txt output-prompt.txt | acceptance.json]'); })();
  console.log(JSON.stringify(command === 'run' ? { code: result.code, changedFiles: result.changedFiles, error: result.finalResult?.error, validationStatus: result.validationStatus } : result));
  if (command === 'run' && (result.code !== 0 || result.killed || result.unauthorizedChanges.length)) process.exitCode = 1;
}
