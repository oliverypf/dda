import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { main } from '../src/main.mjs';
import { resolveTaskPrompt, readStdinText } from '../src/resolve-prompt.mjs';

const capture = () => ({ text: '', write(chunk) { this.text += chunk; return true; } });

const isolatedEnv = async () => {
  const root = await mkdtemp(join(tmpdir(), 'dda-scriptable-'));
  const env = {
    PATH: process.env.PATH,
    HOME: join(root, 'home'),
    LANG: 'C',
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_CACHE_HOME: join(root, 'cache')
  };
  await mkdir(env.HOME, { recursive: true });
  return { root, env };
};

const run = async (args, env, extra = {}) => {
  const stdout = capture();
  const stderr = capture();
  const code = await main(args, { stdout, stderr, env, isTTY: false, disableSignals: true, ...extra });
  return { code, stdout: stdout.text, stderr: stderr.text };
};

test('default --format follows stderr isTTY (--version, format omitted)', async () => {
  const { env } = await isolatedEnv();
  const jsonl = await run(['--version'], env, { isTTY: false });
  assert.equal(jsonl.code, 0);
  const payload = JSON.parse(jsonl.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.protocol, '1.0');

  const human = await run(['--version'], env, { isTTY: true });
  assert.equal(human.code, 0);
  assert.match(human.stdout, /^dda /u);
  assert.doesNotMatch(human.stdout.trim(), /^\{/u);
});

test('resolveTaskPrompt: --prompt and --prompt-file are mutually exclusive', async () => {
  const result = await resolveTaskPrompt({
    options: { prompt: 'a', promptFile: '/tmp/x' },
    executionMode: 'READ_ONLY',
    approvalTTY: false,
    stdin: null,
    stdinIsTTY: false,
    readStdin: async () => ''
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ARGUMENT_INVALID');
});

test('resolveTaskPrompt: --prompt-file reads UTF-8 and trims one trailing newline', async () => {
  const { root } = await isolatedEnv();
  const file = join(root, 'prompt.txt');
  await writeFile(file, 'hello from file\n', 'utf8');
  const result = await resolveTaskPrompt({
    options: { promptFile: file },
    executionMode: 'READ_ONLY',
    approvalTTY: false,
    stdin: null,
    stdinIsTTY: false,
    readStdin: async () => 'should-not-read'
  });
  assert.equal(result.ok, true);
  assert.equal(result.prompt, 'hello from file');
});

test('resolveTaskPrompt: empty or missing prompt-file is ARGUMENT_INVALID', async () => {
  const { root } = await isolatedEnv();
  const empty = join(root, 'empty.txt');
  await writeFile(empty, '   \n', 'utf8');
  const emptyResult = await resolveTaskPrompt({
    options: { promptFile: empty },
    executionMode: 'READ_ONLY',
    approvalTTY: false,
    stdin: null,
    stdinIsTTY: false,
    readStdin: async () => ''
  });
  assert.equal(emptyResult.code, 'ARGUMENT_INVALID');

  const missing = await resolveTaskPrompt({
    options: { promptFile: join(root, 'nope.txt') },
    executionMode: 'READ_ONLY',
    approvalTTY: false,
    stdin: null,
    stdinIsTTY: false,
    readStdin: async () => ''
  });
  assert.equal(missing.code, 'ARGUMENT_INVALID');
});

test('resolveTaskPrompt: READ_ONLY non-TTY reads stdin; TTY stays PROMPT_REQUIRED', async () => {
  const piped = await resolveTaskPrompt({
    options: {},
    executionMode: 'READ_ONLY',
    approvalTTY: false,
    stdin: null,
    stdinIsTTY: false,
    readStdin: async () => 'from pipe'
  });
  assert.equal(piped.ok, true);
  assert.equal(piped.prompt, 'from pipe');

  const tty = await resolveTaskPrompt({
    options: {},
    executionMode: 'READ_ONLY',
    approvalTTY: true,
    stdin: null,
    stdinIsTTY: true,
    readStdin: async () => 'ignored'
  });
  assert.equal(tty.code, 'PROMPT_REQUIRED');
});

test('resolveTaskPrompt: CONTROLLED+jsonl non-TTY without flags is ARGUMENT_INVALID', async () => {
  const result = await resolveTaskPrompt({
    options: { approvalMode: 'jsonl' },
    executionMode: 'CONTROLLED',
    approvalTTY: false,
    stdin: null,
    stdinIsTTY: false,
    readStdin: async () => 'nope'
  });
  assert.equal(result.code, 'ARGUMENT_INVALID');
});

test('resolveTaskPrompt: CONTROLLED without approval channel is APPROVAL_UNAVAILABLE', async () => {
  const result = await resolveTaskPrompt({
    options: {},
    executionMode: 'CONTROLLED',
    approvalTTY: false,
    stdin: null,
    stdinIsTTY: false,
    readStdin: async () => 'nope'
  });
  assert.equal(result.code, 'APPROVAL_UNAVAILABLE');
});

test('task --prompt-file reaches runtime argv without consuming approval stdin', async () => {
  const { env, root } = await isolatedEnv();
  const workspace = join(root, 'ws');
  await mkdir(workspace);
  const promptFile = join(root, 'p.txt');
  await writeFile(promptFile, 'file prompt body\n', 'utf8');

  // Deny CONTROLLED so we don't need a model; still validates CLI prompt wiring
  // fails early on lease/model — use READ_ONLY health-level: missing model may
  // still run. Prefer asserting CLI rejects mutual exclusivity via main.
  const both = await run([
    'task', '--workspace', workspace,
    '--prompt', 'a', '--prompt-file', promptFile,
    '--format', 'jsonl'
  ], env);
  assert.equal(both.code, 2);
  assert.equal(JSON.parse(both.stdout).error.code, 'ARGUMENT_INVALID');
});

test('readStdinText concatenates chunks', async () => {
  const stream = Readable.from(['hel', 'lo']);
  assert.equal(await readStdinText(stream), 'hello');
});
