import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PRODUCT_ROOT, TIP_PIN, resolveOutputPaths } from '../bin/offloop.mjs';

const OFFLOOP = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(OFFLOOP, 'bin', 'offloop.mjs');

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness2-product-cli-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function runCli(args, env = {}) {
  const child = spawnSync(process.execPath, [CLI, ...args], {
    cwd: path.resolve(OFFLOOP, '..'),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.signal || 'CLI must exit normally');
  return child;
}

function jsonLine(stdout, phase = 'tip-check') {
  const line = stdout
    .split(/\r?\n/)
    .find((candidate) => {
      try {
        return JSON.parse(candidate).phase === phase;
      } catch {
        return false;
      }
    });
  assert.ok(line, `missing ${phase} JSON line in stdout:\n${stdout}`);
  return JSON.parse(line);
}

test('T-H2-K3-CLI-ROOT: product-root defaults and opts/env/productRoot priority stay portable', (t) => {
  const root = tempRoot(t);
  const envOut = path.join(root, 'env-out');
  const envExperience = path.join(root, 'env-experience');
  const explicitOut = path.join(root, 'explicit-out');
  const explicitExperience = path.join(root, 'explicit-experience');

  const explicit = resolveOutputPaths({
    productRoot: path.join(root, 'product'),
    outDir: explicitOut,
    experienceDir: explicitExperience,
    env: { OFFLOOP_OUT_DIR: envOut, OFFLOOP_EXPERIENCE_DIR: envExperience },
  });
  assert.deepEqual(explicit, { outDir: explicitOut, experienceDir: explicitExperience });

  const env = resolveOutputPaths({
    productRoot: path.join(root, 'product'),
    env: { OFFLOOP_OUT_DIR: envOut, OFFLOOP_EXPERIENCE_DIR: envExperience },
  });
  assert.deepEqual(env, { outDir: envOut, experienceDir: envExperience });

  const defaults = resolveOutputPaths({ productRoot: path.join(root, 'product'), env: {} });
  assert.equal(defaults.outDir, path.join(root, 'product', 'out'));
  assert.equal(defaults.experienceDir, path.join(root, 'product', 'experience'));
  assert.ok(!defaults.outDir.includes('dda-drive'));
  assert.ok(!defaults.experienceDir.includes('dda-drive'));
  assert.ok(PRODUCT_ROOT.endsWith(path.join('dda', 'offloop')));
});

test('T-H2-K3-CLI-HELP: help documents core/live, tip-path and output contracts', () => {
  const child = runCli(['help']);
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /core（核心）/);
  assert.match(child.stdout, /live（在线）/);
  assert.match(child.stdout, /tip-path（tip 路径）/);
  assert.match(child.stdout, /tipSha|tip pin/i);
  assert.match(child.stdout, /output director|outDir/i);
  assert.match(child.stdout, /OFFLOOP_OUT_DIR/);
  assert.match(child.stdout, /productRoot\/out/);
  assert.doesNotMatch(child.stdout, /\/workspace\/dda-drive/);
});

test('T-H2-K3-CLI-MISS: bounded fixture MISS delegates to run-from-miss and writes auditable EXPERIENCE', (t) => {
  const root = tempRoot(t);
  const outDir = path.join(root, 'out');
  const experienceDir = path.join(root, 'experience');
  const envOut = path.join(root, 'env-out');
  const child = runCli(
    [
      'miss',
      '--fixture',
      '--tip-sha',
      TIP_PIN,
      '--out-dir',
      outDir,
      '--experience-dir',
      experienceDir,
    ],
    { OFFLOOP_OUT_DIR: envOut, OFFLOOP_EXPERIENCE_DIR: path.join(root, 'env-experience') },
  );
  assert.equal(child.status, 0, `${child.stderr}\n${child.stdout}`);
  const tip = jsonLine(child.stdout);
  assert.deepEqual(
    { tipSha: tip.tipSha, pinEqual: tip.pinEqual, status: tip.status },
    { tipSha: TIP_PIN, pinEqual: true, status: 'PASS' },
  );

  const experienceFiles = fs.readdirSync(experienceDir).filter((name) => name.endsWith('.md'));
  assert.ok(experienceFiles.length > 0, 'bounded MISS must retain EXPERIENCE or CANDIDATE evidence');
  for (const file of experienceFiles) {
    const body = fs.readFileSync(path.join(experienceDir, file), 'utf8');
    assert.match(body, /^# EXPERIENCE/m);
    assert.match(body, /adopted_candidate/);
    assert.match(body, /source runs/);
    assert.match(body, /poison loop/);
    assert.doesNotMatch(path.join(experienceDir, file), /dda-drive/);
  }

  const summaryPath = path.join(outDir, 'offloop-cli-summary.json');
  assert.ok(fs.existsSync(summaryPath), 'product CLI summary must be written');
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.tipSha, TIP_PIN);
  assert.equal(summary.tipSource, 'explicit:--tip-sha');
  assert.equal(summary.pinEqual, true);
  assert.equal(summary.candidateWrites, 0);
  assert.equal(summary.liveRequests, 0);
  assert.equal(summary.mainOpenRouterCalls, 0);
  assert.equal(summary.outDir, outDir);
  assert.equal(summary.experienceDir, experienceDir);
  assert.equal(summary.status, 'PASS');
  assert.equal(fs.existsSync(envOut), false, 'CLI option must outrank output environment');
});

test('T-H2-K3-CLI-TIP-PIN: empty, missing, and drifting tips fail closed; happy path records pinEqual', (t) => {
  const root = tempRoot(t);
  const output = () => path.join(root, `out-${Math.random().toString(16).slice(2)}`);

  const empty = runCli(['miss', '--fixture', '--tip-sha', '', '--out-dir', output()]);
  assert.notEqual(empty.status, 0);
  const emptyTip = jsonLine(empty.stdout);
  assert.equal(emptyTip.status, 'FAIL');
  assert.equal(emptyTip.tipSha, null);
  assert.equal(emptyTip.pinEqual, false);
  assert.doesNotMatch(empty.stdout, /"status":\s*"PASS"/);

  const missing = runCli(
    ['miss', '--fixture', '--out-dir', output()],
    { DDA_TIP_REPO: path.join(root, 'does-not-exist') },
  );
  assert.notEqual(missing.status, 0);
  const missingTip = jsonLine(missing.stdout);
  assert.equal(missingTip.status, 'FAIL');
  assert.equal(missingTip.tipSha, null);
  assert.equal(missingTip.pinEqual, false);
  assert.match(missingTip.tipSource, /DDA_TIP_REPO/);

  const drifted = runCli(['miss', '--fixture', '--tip-path', path.resolve(OFFLOOP, '..'), '--out-dir', output()]);
  assert.notEqual(drifted.status, 0);
  const driftedTip = jsonLine(drifted.stdout);
  assert.equal(driftedTip.status, 'FAIL');
  assert.notEqual(driftedTip.tipSha, TIP_PIN);
  assert.equal(driftedTip.pinEqual, false);
  assert.doesNotMatch(drifted.stdout, /"status":\s*"PASS"/);

  const happy = runCli(
    ['miss', '--fixture', '--out-dir', output()],
    { DDA_TIP_REPO: '/workspace/dda-tip-r25' },
  );
  assert.equal(happy.status, 0, `${happy.stderr}\n${happy.stdout}`);
  const happyTip = jsonLine(happy.stdout);
  assert.equal(happyTip.tipSha, TIP_PIN);
  assert.match(happyTip.tipSource, /DDA_TIP_REPO/);
  assert.equal(happyTip.pinEqual, true);
  assert.equal(happyTip.status, 'PASS');
});
