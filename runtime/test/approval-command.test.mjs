import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describeCommandZh, formatCommandLine, publicCommandFields, redactArgs, riskReasonsZh } from '../src/approval-command.mjs';

test('approval fields keep the full command and drop secret values', () => {
  const fields = publicCommandFields({
    command: 'npm',
    args: ['install', '--token', 'sk-live-secret', 'API_KEY=plain-secret-ZZ', 'left-pad', 'secret'],
    cwd: 'desktop',
    env: { API_KEY: 'super-secret-value', PATH: 'C:\\tools' }
  });
  assert.equal(fields.command, 'npm');
  assert.deepEqual(fields.args, ['install', '--token', '[REDACTED]', 'API_KEY=[REDACTED]', 'left-pad', 'secret']);
  assert.equal(fields.commandLine, 'npm install --token [REDACTED] API_KEY=[REDACTED] left-pad secret');
  assert.equal(fields.cwd, 'desktop');
  assert.equal(fields.summaryZh, '将安装项目依赖');
  assert.deepEqual(fields.riskReasons, ['可能联网下载依赖']);
  assert.equal(JSON.stringify(fields).includes('super-secret-value'), false);
  assert.equal(JSON.stringify(fields).includes('sk-live-secret'), false);
  assert.equal(JSON.stringify(fields).includes('plain-secret-ZZ'), false);
  assert.equal(Object.hasOwn(fields, 'env'), false);

  assert.deepEqual(redactArgs(['-e', 'ok', 'ghp_abcdefghijklmnopqrstuvwxyz', 'Bearer raw-token']), ['-e', 'ok', '[REDACTED]', '[REDACTED]']);
  assert.equal(formatCommandLine('cargo', ['build', '--manifest-path', 'src tauri/Cargo.toml']), 'cargo build --manifest-path "src tauri/Cargo.toml"');
});

test('chinese descriptions name the concrete effect', () => {
  assert.equal(describeCommandZh({ command: 'cargo', args: ['build'] }), '将编译当前 Rust 项目，并把产物写入 target 目录');
  assert.deepEqual(riskReasonsZh({ command: 'cargo', args: ['build'] }), ['会写 target 目录']);
  assert.equal(describeCommandZh({ command: 'cargo', args: ['test'] }), '将编译并运行 Rust 测试');
  assert.deepEqual(riskReasonsZh({ command: 'cargo', args: ['test'] }), ['会写 target 目录']);
  assert.equal(describeCommandZh({ command: 'npm', args: ['run', 'build'] }), '将执行 package.json 里的构建脚本');
  assert.deepEqual(riskReasonsZh({ command: 'npm', args: ['run', 'build'] }), ['会执行 package.json 脚本']);
  assert.equal(describeCommandZh({ command: 'npm', args: ['ci'] }), '将安装项目依赖');
  assert.deepEqual(riskReasonsZh({ command: 'npm.cmd', args: ['install'] }), ['可能联网下载依赖']);
  assert.equal(describeCommandZh({ command: 'npx', args: ['tauri', 'build'] }), '将构建 Tauri 桌面应用，并把产物写入 target 目录');
  assert.deepEqual(riskReasonsZh({ command: 'npx', args: ['tauri', 'build'] }), ['会写 target 目录']);
  assert.equal(describeCommandZh({ command: 'del', args: ['notes.txt'] }), '将删除文件或目录');
  assert.deepEqual(riskReasonsZh({ command: 'Remove-Item', args: ['notes.txt'] }), ['会删除文件']);
  assert.equal(describeCommandZh({ command: 'node', args: ['-e', 'ok'] }), '将在本机执行这条命令');
  assert.deepEqual(riskReasonsZh({ command: 'node', args: ['-e', 'ok'] }), ['会在本机执行命令']);
});

test('trajectory tool requests still store only an arguments digest', async () => {
  const source = await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("kind: 'ToolCallRequested'");
  const call = source.slice(start, start + 700);
  assert.match(call, /argumentsDigest/);
  assert.equal(call.includes('args:'), false);
  const approval = await readFile(new URL('../src/kernel/approval-session.mjs', import.meta.url), 'utf8');
  assert.match(approval, /publicCommandFields/);
});
