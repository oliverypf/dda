import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { attachMemoryWorkspacePaths, extractRunReusableExperience, extractDreamExperienceCandidates, selectRunLesson } from '../src/experience-extractor.mjs';
import { createMemoryVerifier } from '../src/memory-verifier.mjs';
import { createHarnessEventStore } from '../src/harness-event-store.mjs';

const LEGACY_STAT_PATTERNS = [
  /^Verified task outcome: class=([^;]+); verifier=PASS; outputDigest=sha256:[a-f0-9]{64}$/,
  /^Verified run used (.+); workspace entries=(\d+); toolCalls=(\d+)\.$/
];

test('extractRunReusableExperience distills verified commands, files, binary inspection and pitfalls while rejecting secrets/noise', () => {
  const events = [
    { eventId: 'ev-trivial', runId: 'run-1', kind: 'ToolInvocationCompleted', payload: { name: 'shell.execute', ok: true, command: 'git', args: ['status'], durationMs: 50 } },
    { eventId: 'ev-inline', runId: 'run-1', kind: 'ToolInvocationCompleted', payload: { name: 'shell.execute', ok: true, command: 'node', args: ['-e', 'console.log(1)'], durationMs: 40 } },
    { eventId: 'ev-secret', runId: 'run-1', kind: 'ToolInvocationCompleted', payload: { name: 'shell.execute', ok: true, command: 'npm', args: ['publish', 'API_KEY=topsecret'], durationMs: 1000 } },
    { eventId: 'ev-timeout', runId: 'run-1', kind: 'ToolInvocationCompleted', payload: { name: 'shell.execute', ok: false, timedOut: true, timeoutMs: 600000, durationMs: 629000 } },
    { eventId: 'ev-build', runId: 'run-1', kind: 'ToolInvocationCompleted', payload: { name: 'shell.execute', ok: true, command: 'npm', args: ['run', 'build:windows:full-local'], cwd: 'desktop', durationMs: 145000 } },
    { eventId: 'ev-file', runId: 'run-1', kind: 'TaskFileWritten', payload: { name: 'file.patch', path: 'desktop/src/main.ts' } },
    { eventId: 'ev-pe', runId: 'run-1', kind: 'ToolInvocationCompleted', payload: { name: 'workspace.inspect_binary', ok: true, durationMs: 15 } },
    { eventId: 'ev-prot', runId: 'run-1', kind: 'ToolInvocationCompleted', payload: { name: 'workspace.list', ok: false, errorCode: 'SAFETY_PROTECTED_PATH' } },
    { eventId: 'ev-amb', runId: 'run-1', kind: 'ToolInvocationCompleted', payload: { name: 'workspace.focus', ok: false, errorCode: 'EXCERPT_AMBIGUOUS' } },
    { eventId: 'ev-done', runId: 'run-1', kind: 'TaskRunCompleted', payload: { outcomeStatus: 'SUCCEEDED' } }
  ];

  const extracted = extractRunReusableExperience({
    runId: 'run-1',
    taskClass: 'test',
    threadTitle: '编译exe',
    threadCwd: 'C:\\repo\\project',
    events,
    terminalEventId: 'ev-done'
  });

  assert.ok(extracted.length >= 5, 'expected command, timeout, files, PE tool, and pitfall lessons');
  assert.ok(extracted.some((c) => c.kind === 'SKILL' && c.statement.includes('npm run build:windows:full-local') && c.statement.includes('desktop') && c.statement.includes('timeoutMs >= 300000')));
  assert.ok(extracted.some((c) => c.kind === 'SKILL' && c.statement.includes('构建时限经验')));
  assert.ok(extracted.some((c) => c.kind === 'SKILL' && c.statement.includes('desktop/src/main.ts')));
  assert.ok(extracted.some((c) => c.kind === 'MEMORY' && c.statement.includes('workspace.inspect_binary')));
  assert.ok(extracted.some((c) => c.kind === 'MEMORY' && c.statement.includes('宿主受保护目录')));
  assert.ok(extracted.some((c) => c.kind === 'MEMORY' && c.statement.includes('EXCERPT_AMBIGUOUS')));
  assert.ok(extracted.some((c) => c.statement.includes('timeoutMs=600s') && c.statement.includes('构建时限经验')));
  assert.ok(extracted.some((c) => c.statement.includes('desktop/src/main.ts')));
  assert.ok(extracted.some((c) => c.statement.includes('workspace.inspect_binary')));
  assert.ok(extracted.some((c) => c.statement.includes('宿主受保护目录')));
  assert.ok(extracted.some((c) => c.statement.includes('EXCERPT_AMBIGUOUS')));
  assert.ok(!extracted.some((c) => c.statement.includes('git status') || c.statement.includes('console.log') || c.statement.includes('topsecret')));
  assert.ok(extracted.filter((c) => c.kind === 'SKILL').every((c) => c.workspacePath === 'C:\\repo\\project'));
  assert.ok(extracted.filter((c) => c.kind === 'MEMORY').every((c) => c.workspacePath === undefined));
  for (const candidate of extracted) {
    assert.ok(!LEGACY_STAT_PATTERNS.some((re) => re.test(candidate.statement)));
  }

  const verified = createMemoryVerifier().verify({ candidates: extracted, sourceEvents: events, existingMemories: [] });
  assert.ok(verified.every((r) => r.verification.accepted === true), 'every extracted candidate passes MemoryVerifier');
});

test('a finished run learns the failed command once, then the successful command', () => {
  const events = [
    { eventId: 'ev-install', runId: 'run-build', kind: 'ToolInvocationCompleted', payload: { name: 'shell.execute', ok: false, command: 'npm', args: ['run', 'runtime:install'], cwd: 'desktop', outputTail: 'spawnSync npm.cmd EINVAL', exitCode: 1 } },
    { eventId: 'ev-build', runId: 'run-build', kind: 'ToolInvocationCompleted', payload: { name: 'shell.execute', ok: true, command: 'npm', args: ['run', 'build:exe'], cwd: 'desktop', durationMs: 180000 } },
    { eventId: 'ev-done', runId: 'run-build', kind: 'TaskRunCompleted', payload: { outcomeStatus: 'SUCCEEDED' } }
  ];
  const extracted = extractRunReusableExperience({
    runId: 'run-build',
    taskClass: 'test',
    threadTitle: '编译exe',
    threadCwd: 'C:\\repo\\project',
    events,
    terminalEventId: 'ev-done'
  });
  const first = selectRunLesson(extracted, { verified: true });
  assert.equal(first.kind, 'SKILL');
  assert.match(first.statement, /npm run runtime:install/);
  assert.match(first.statement, /EINVAL/);
  assert.match(first.statement, /不要再执行这条命令/);
  assert.equal(extracted.filter((item) => item.key === first.key).length, 1);

  const second = selectRunLesson(extracted, {
    verified: true,
    existingKeys: new Set([`workspace::${first.key}`])
  });
  assert.match(second.statement, /npm run build:exe/);
  assert.equal(selectRunLesson(extracted, {
    verified: false,
    existingKeys: new Set([`workspace::${first.key}`])
  }), undefined);
});

test('failed verification becomes a memory, not a skill, and ignores the Jev rewrite', () => {
  const extracted = extractRunReusableExperience({
    runId: 'run-fail',
    taskClass: 'modify',
    threadTitle: '编译exe',
    threadCwd: 'C:\\repo\\project',
    verificationChecks: [
      { id: 'actions.progress', status: 'FAIL', message: '1 个动作执行失败（EXECUTOR_RESULT_FAILED）' },
      { id: 'actions.duplicates', status: 'FAIL', message: '检测到重复动作指纹' },
      { id: 'jev-behavior-judge', status: 'FAIL', message: 'RULE_VERIFIER_FAILED' }
    ],
    terminalEventId: 'ev-fail'
  });
  assert.equal(extracted.length, 2);
  assert.ok(extracted.every((item) => item.kind === 'MEMORY' && String(item.key).startsWith('pitfall:')));
  assert.ok(extracted.some((item) => item.key === 'pitfall:executor-result-failed'));
  assert.ok(extracted.some((item) => item.key === 'pitfall:repeated-action'));
  assert.equal(extracted.some((item) => /RULE_VERIFIER_FAILED|Jev/u.test(item.statement)), false);
});

test('extractDreamExperienceCandidates skips fixture workspaces and deduplicates against existing memories', () => {
  const events = [
    { eventId: 'f1', runId: 'run-fix', kind: 'TaskFileWritten', payload: { path: 'src/a.js' } },
    { eventId: 'f2', runId: 'run-fix', kind: 'TaskRunCompleted', payload: { outcomeStatus: 'SUCCEEDED' } },
    { eventId: 'r1', runId: 'run-real', kind: 'ToolInvocationCompleted', payload: { name: 'test.execute', ok: true, command: 'npm', args: ['test', '--', '--run'], cwd: 'desktop', durationMs: 3000 } },
    { eventId: 'r2', runId: 'run-real', kind: 'TaskRunCompleted', payload: { outcomeStatus: 'SUCCEEDED' } }
  ];
  const threads = [
    { id: 't-fix', title: 'fixture', cwd: 'C:\\Temp\\hmcodex-ui-model-fixture-abc', turns: [{ runId: 'run-fix' }] },
    { id: 't-real', title: '运行桌面单测', cwd: 'C:\\Work\\app', turns: [{ runId: 'run-real' }] }
  ];

  const first = extractDreamExperienceCandidates(events, { threads, existingMemories: [] });
  assert.equal(first.length, 1);
  assert.match(first[0].statement, /npm test -- --run/);

  const second = extractDreamExperienceCandidates(events, {
    threads,
    existingMemories: [{ ...first[0], memoryId: 'mem-1', status: 'PROPOSED' }]
  });
  assert.equal(second.length, 0, 'already proposed key is skipped on repeat Dream run');
});

test('CLI dream run extracts concrete PROPOSED experience candidates from SQLite trajectory events', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dda-dream-extract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const trajectory = join(directory, 'trajectory.jsonl');
  const eventStore = createHarnessEventStore({ storagePath: `${trajectory}.db` });
  await eventStore.load();

  await eventStore.append({ runId: 'run-build-1', kind: 'TaskClassified', payload: { taskClass: 'test' } });
  await eventStore.append({
    runId: 'run-build-1',
    kind: 'ToolInvocationCompleted',
    payload: { name: 'shell.execute', ok: true, command: 'node', args: ['scripts/stage-desktop-build.mjs', '--profile=release'], cwd: 'desktop', durationMs: 42000 }
  });
  await eventStore.append({
    runId: 'run-build-1',
    kind: 'TaskRunCompleted',
    payload: { outcomeId: 'out-1', outcomeStatus: 'SUCCEEDED', toolCallCount: 1 }
  });

  await writeFile(`${trajectory}.threads.json`, JSON.stringify({
    schemaVersion: '1.0',
    threads: [{ id: 'th-1', title: '发布桌面构建', cwd: 'D:\\Projects\\dda', turns: [{ id: 'turn-1', runId: 'run-build-1', state: 'SUCCEEDED' }] }]
  }));

  const env = {
    ...process.env,
    DDA_RELEASE_CHANNEL: 'WINDOWS_PHASE1_5_CONTROLLED',
    DDA_TRAJECTORY_STORE: trajectory,
    DDA_THREAD_STORE: `${trajectory}.threads.json`,
    DDA_DATA_DIR: directory
  };
  delete env.DDA_HARNESS_EVENT_STORE;
  delete env.DDA_MEMORY_STORE;
  delete env.DDA_DREAM_STORE;

  const cli = fileURLToPath(new URL('../src/index.mjs', import.meta.url));
  const dreamOut = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'dream', 'run'], { env, windowsHide: true })).stdout);
  assert.equal(dreamOut.ok, true);
  assert.equal(dreamOut.proposedMemories.length, 1);
  assert.equal(dreamOut.proposedMemories[0].status, 'PROPOSED');
  assert.match(dreamOut.proposedMemories[0].statement, /stage-desktop-build\.mjs/);
  assert.equal(dreamOut.proposedMemories[0].workspacePath, 'D:\\Projects\\dda');

  // Re-running dream is idempotent and adds 0 duplicates.
  const dreamSecond = JSON.parse((await promisify(execFile)(process.execPath, [cli, 'dream', 'run'], { env, windowsHide: true })).stdout);
  assert.equal(dreamSecond.proposedMemories.length, 0);
});

test('older skills are labeled from the thread that produced the run', () => {
  const labeled = attachMemoryWorkspacePaths(
    [{ memoryId: 'memory-old', runId: 'run-old', statement: '项目改动经验（编译exe）：关键修改文件包括 `desktop/package.json`。', scope: 'workspace' }],
    [{ id: 'thread-1', cwd: 'C:\\Users\\User\\hmCodex-local', turns: [{ runId: 'run-old' }] }]
  );
  assert.equal(labeled[0].workspacePath, 'C:\\Users\\User\\hmCodex-local');
  const kept = attachMemoryWorkspacePaths(
    [{ memoryId: 'memory-new', runId: 'run-new', workspacePath: 'D:\\Kept', statement: '项目命令经验', scope: 'workspace' }],
    [{ cwd: 'C:\\Other', turns: [{ runId: 'run-new' }] }]
  );
  assert.equal(kept[0].workspacePath, 'D:\\Kept');
});
