#!/usr/bin/env node
// Run independent Windows validation suites concurrently and aggregate results.
// UI suites are intentionally not included: they share one installed process
// and the user's local store and must run sequentially after this command.

import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { projectPaths } from './windows-path.mjs';

const { desktopRoot, runtimeRoot } = projectPaths(import.meta.url);
// Invoke npm through node.exe on Windows. Node's child_process.spawn rejects
// .cmd shims with EINVAL when shell=false, and shell=true emits a deprecation
// warning (and weakens argument boundaries). The npm CLI is shipped beside
// the active Node installation.
const npmCli = process.platform === 'win32'
  ? resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  : null;
const npmCommand = process.platform === 'win32' ? process.execPath : 'npm';
const npmArgs = (args) => (npmCli ? [npmCli, ...args] : args);

const suites = [
  { name: 'runtime', cwd: runtimeRoot, command: npmCommand, args: npmArgs(['test']) },
  { name: 'desktop', cwd: desktopRoot, command: npmCommand, args: npmArgs(['test']) },
  // node:test scripts under desktop/scripts are excluded from the Vitest run;
  // run them here so the W10 evidence gate and build-channel tests are covered.
  { name: 'desktop-scripts', cwd: desktopRoot, command: npmCommand, args: npmArgs(['run', 'test:scripts']) },
  { name: 'phase3-evidence', cwd: desktopRoot, command: npmCommand, args: npmArgs(['run', 'test:phase3-evidence']) },
  {
    name: 'typescript',
    cwd: desktopRoot,
    command: process.execPath,
    args: [join(desktopRoot, 'node_modules/typescript/bin/tsc'), '--noEmit']
  },
  {
    name: 'tauri-rust',
    cwd: desktopRoot,
    command: process.execPath,
    args: [join(desktopRoot, 'scripts', 'build-openviking-sidecar.mjs'), '--debug', '--test']
  }
];

const startedAt = Date.now();
const runSuite = (suite) => new Promise((resolveResult) => {
  const suiteStarted = Date.now();
  console.log(`[parallel] START ${suite.name}: ${suite.command} ${suite.args.join(' ')}`);
  let child;
  try {
    // Keep shell=false for every suite so argument boundaries stay explicit.
    child = spawn(suite.command, suite.args, {
      cwd: suite.cwd,
      stdio: 'inherit',
      windowsHide: true,
      shell: false
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = { ...suite, code: 1, signal: null, error: message, durationMs: Date.now() - suiteStarted };
    console.error(`[parallel] FAIL ${suite.name} (${result.durationMs}ms): ${message}`);
    resolveResult(result);
    return;
  }
  child.once('error', (error) => {
    const result = { ...suite, code: 1, signal: null, error: error.message, durationMs: Date.now() - suiteStarted };
    console.error(`[parallel] FAIL ${suite.name} (${result.durationMs}ms): ${error.message}`);
    resolveResult(result);
  });
  child.once('exit', (code, signal) => {
    const result = { ...suite, code: code ?? 1, signal, error: null, durationMs: Date.now() - suiteStarted };
    const label = result.code === 0 && !result.signal ? 'PASS' : 'FAIL';
    console.log(`[parallel] ${label} ${suite.name} (${result.durationMs}ms, exit=${result.code}${result.signal ? `, signal=${result.signal}` : ''})`);
    resolveResult(result);
  });
});

const results = await Promise.all(suites.map(runSuite));
console.log(`[parallel] SUMMARY total=${results.length} passed=${results.filter((result) => result.code === 0 && !result.signal).length} failed=${results.filter((result) => result.code !== 0 || result.signal).length} elapsedMs=${Date.now() - startedAt}`);
if (results.some((result) => result.code !== 0 || result.signal)) process.exitCode = 1;
