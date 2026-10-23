import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuleVerifier } from '../src/rule-verifier.mjs';
import { createTaskProgress, FAILURE_CLASSES } from '../src/task-harness.mjs';
import {
  ACCEPTANCE_ALREADY_GREEN,
  assertVerificationGate,
  extractAcceptanceCommands,
  hasAcceptanceGreen,
  hasAllAcceptanceCommandsGreen,
  isProcessNoiseFailure,
  looksLikeAcceptanceCommand,
  normalizeCommandJoin,
  precheckShellExecuteInput,
  shouldBlockAcceptanceRerun,
  stripShellQuotes
} from '../src/acceptance-match.mjs';
import { RECOVERABLE_TOOL_ERROR_CODES } from '../src/rule-verifier.mjs';
import { exitCodeForError, messageForCode, rebuildFailedTaskResult } from '../../linux-cli/src/exit-codes.mjs';

const dig = (c) => `sha256:${c.repeat(64)}`;
const ACCEPT = 'node node_modules/vitest/vitest.mjs run --configLoader native src/domain/windows-desktop-cells.test.ts';
const PROMPT = `Fix the bug.\nThen run:\n  cd desktop && ${ACCEPT}\nIf tests fail, fix and re-run until green.`;

const acceptanceShell = ({ state = 'SUCCEEDED', errorCode, command = 'node', args = ACCEPT.split(' ').slice(1), argumentsDigest = dig('a') } = {}) => ({
  name: 'shell.execute',
  state,
  command,
  args,
  argumentsDigest,
  ...(state === 'SUCCEEDED' ? { outputDigest: dig('o'), ok: true } : {}),
  ...(errorCode ? { errorCode } : {}),
  ...(state === 'FAILED' ? { ok: false } : {})
});

test('acceptance extract matches bench-style vitest prompt lines', () => {
  const cmds = extractAcceptanceCommands({ prompt: PROMPT });
  assert.ok(cmds.length >= 1);
  assert.ok(cmds.some((c) => c.includes('vitest') && c.includes('windows-desktop-cells.test.ts')));
  assert.equal(
    normalizeCommandJoin('node', ACCEPT.split(' ').slice(1)),
    ACCEPT
  );
  assert.equal(hasAcceptanceGreen([acceptanceShell()], cmds), true);
  assert.equal(hasAcceptanceGreen([acceptanceShell({ state: 'FAILED', errorCode: 'EXECUTOR_RESULT_FAILED' })], cmds), false);
});

test('T27 writesApplied≥1 without acceptance → VERIFICATION_REQUIRED throw + exit 1 + recovery class', () => {
  assert.ok(FAILURE_CLASSES.includes('VERIFICATION_REQUIRED'));
  assert.equal(exitCodeForError('VERIFICATION_REQUIRED'), 1);
  assert.match(messageForCode('VERIFICATION_REQUIRED'), /验收/);

  const progress = createTaskProgress();
  progress.observe({ kind: 'lease.consumed', payload: { capability: 'file.write', ok: true } });
  progress.observe({ ok: false, error: 'VERIFICATION_REQUIRED' });
  assert.equal(progress.snapshot().recovery.failureClass, 'VERIFICATION_REQUIRED');
  assert.equal(progress.snapshot().writesApplied, 1);

  const cmds = extractAcceptanceCommands({ prompt: PROMPT });
  const harness = { writesApplied: 1, writesAppliedUnverified: 0 };
  const actions = [
    { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') }
  ];
  assert.throws(
    () => assertVerificationGate({ harness, actions, acceptanceCommands: cmds }),
    (error) => {
      assert.equal(error.message, 'VERIFICATION_REQUIRED');
      return true;
    }
  );
  // Must be a throw path — callers must not paper this over with {ok:false}.
  assert.equal(typeof assertVerificationGate({ harness: { writesApplied: 0 }, actions: [], acceptanceCommands: cmds }), 'undefined');

  const rebuilt = rebuildFailedTaskResult({
    error: 'VERIFICATION_REQUIRED',
    harness: progress.snapshot()
  });
  assert.equal(rebuilt.ok, false);
  assert.equal(rebuilt.error.code, 'VERIFICATION_REQUIRED');
  assert.equal(rebuilt.harness.recovery.failureClass, 'VERIFICATION_REQUIRED');
});

test('T27b APPLIED_UNVERIFIED without acceptance also gates', () => {
  const cmds = extractAcceptanceCommands({ prompt: PROMPT });
  assert.throws(
    () => assertVerificationGate({
      harness: { writesApplied: 0, writesAppliedUnverified: 0 },
      actions: [{ name: 'file.patch', state: 'APPLIED_UNVERIFIED', errorCode: 'TOOL_OUTPUT_AFTER_EFFECT' }],
      acceptanceCommands: cmds
    }),
    /VERIFICATION_REQUIRED/
  );
  assert.throws(
    () => assertVerificationGate({
      harness: { writesApplied: 0, writesAppliedUnverified: 1 },
      actions: [],
      acceptanceCommands: cmds
    }),
    /VERIFICATION_REQUIRED/
  );
});

test('T28 acceptance green + unrelated shell FAIL + workspace.focus FAIL → actions.progress PASS (no PLAN_STEP_FAILED)', () => {
  const cmds = extractAcceptanceCommands({ prompt: PROMPT });
  const actions = [
    { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') },
    { name: 'workspace.focus', state: 'FAILED', errorCode: 'TOOL_HANDLER_FAILED', argumentsDigest: dig('f') },
    acceptanceShell({ state: 'FAILED', errorCode: 'EXECUTOR_RESULT_FAILED', command: 'npm', args: ['install', 'left-pad'], argumentsDigest: dig('n') }),
    acceptanceShell({ state: 'SUCCEEDED' })
  ];
  // Unrelated shell (npm install) is noise once acceptance is green; focus always noise.
  assert.equal(isProcessNoiseFailure(actions[1], { acceptanceGreen: true, acceptanceCommands: cmds }), true);
  assert.equal(isProcessNoiseFailure(actions[2], { acceptanceGreen: true, acceptanceCommands: cmds }), true);
  assert.equal(isProcessNoiseFailure(actions[3], { acceptanceGreen: true, acceptanceCommands: cmds }), false);

  const report = createRuleVerifier().verify({
    prompt: PROMPT,
    output: 'patched and verified',
    workspace: { granted: true },
    actions,
    acceptanceCommands: cmds
  });
  assert.equal(report.status, 'PASS', JSON.stringify(report.checks?.map((c) => [c.id, c.status]), null, 0));
  assert.equal(report.checks.find((c) => c.id === 'actions.progress')?.status, 'PASS');
  assert.equal(report.checks.find((c) => c.id === 'evidence.tests')?.status, 'PASS');
  assertVerificationGate({
    harness: { writesApplied: 1, writesAppliedUnverified: 0 },
    actions,
    acceptanceCommands: cmds
  });
});

test('T28b focus FAIL alone never hardFails actions.progress (Q-r3-2)', () => {
  const report = createRuleVerifier().verify({
    prompt: 'inspect only',
    output: 'looked around',
    workspace: { granted: true },
    actions: [
      { name: 'workspace.focus', state: 'FAILED', errorCode: 'TOOL_HANDLER_FAILED', argumentsDigest: dig('f') },
      { name: 'workspace.read', state: 'SUCCEEDED', argumentsDigest: dig('r'), outputDigest: dig('o') }
    ]
  });
  assert.notEqual(report.checks.find((c) => c.id === 'actions.progress')?.status, 'FAIL');
  assert.ok(!report.failureCodes?.includes('ACTION_FAILED'));
});

test('T28c failed acceptance shell resolved by later same-intent success', () => {
  const cmds = extractAcceptanceCommands({ prompt: PROMPT });
  const failed = acceptanceShell({ state: 'FAILED', errorCode: 'EXECUTOR_RESULT_FAILED' });
  const passed = acceptanceShell({ state: 'SUCCEEDED' });
  const report = createRuleVerifier().verify({
    prompt: PROMPT,
    output: 're-ran acceptance',
    workspace: { granted: true },
    actions: [
      { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') },
      failed,
      passed
    ],
    acceptanceCommands: cmds
  });
  assert.equal(report.status, 'PASS');
  assert.equal(report.checks.find((c) => c.id === 'actions.progress')?.status, 'PASS');
});

test('T29 write ok + acceptance never green → still fail (do not soft-pass)', () => {
  const cmds = extractAcceptanceCommands({ prompt: PROMPT });
  const actions = [
    { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') },
    acceptanceShell({
      state: 'FAILED',
      errorCode: 'EXECUTOR_RESULT_FAILED',
      command: 'npm',
      args: ['install'],
      argumentsDigest: dig('n')
    })
  ];
  // No acceptance green: unrelated shell remains a hard failure → actions.progress FAIL.
  const report = createRuleVerifier().verify({
    prompt: PROMPT,
    output: 'wrote but did not verify',
    workspace: { granted: true },
    actions,
    acceptanceCommands: cmds
  });
  assert.equal(report.status, 'FAIL');
  assert.equal(report.checks.find((c) => c.id === 'actions.progress')?.status, 'FAIL');
  // Gate also throws VERIFICATION_REQUIRED when somehow step PASS without green.
  assert.throws(
    () => assertVerificationGate({
      harness: { writesApplied: 1 },
      actions: [actions[0]],
      acceptanceCommands: cmds
    }),
    (error) => error.message === 'VERIFICATION_REQUIRED'
  );
});

test('T29b at-least-once green survives a later red of the same acceptance command', () => {
  const cmds = extractAcceptanceCommands({ prompt: PROMPT });
  const actions = [
    { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') },
    acceptanceShell({ state: 'SUCCEEDED' }),
    acceptanceShell({ state: 'FAILED', errorCode: 'EXECUTOR_RESULT_FAILED', argumentsDigest: dig('b') })
  ];
  assert.equal(hasAcceptanceGreen(actions, cmds), true);
  assertVerificationGate({
    harness: { writesApplied: 1 },
    actions,
    acceptanceCommands: cmds
  });
});

test('T30 no writes / no APPLIED_UNVERIFIED → §1.1 does not break existing success', () => {
  const cmds = extractAcceptanceCommands({ prompt: 'say hello' });
  assert.equal(
    assertVerificationGate({
      harness: { writesApplied: 0, writesAppliedUnverified: 0 },
      actions: [{ name: 'workspace.read', state: 'SUCCEEDED', argumentsDigest: dig('r'), outputDigest: dig('o') }],
      acceptanceCommands: cmds
    }),
    undefined
  );
  const report = createRuleVerifier().verify({
    prompt: 'say hello',
    output: 'hello',
    workspace: { granted: true },
    actions: [{ name: 'workspace.read', state: 'SUCCEEDED', argumentsDigest: dig('r'), outputDigest: dig('o') }]
  });
  assert.equal(report.status, 'PASS');
});


// ——— C1 observation (freeze-harness-c1-observation-r1) ———

const T2_PROMPT = `Fix linux-cli/src/exit-codes.mjs rebuildFailedTaskResult.

Use file.patch. Then run:
  cd linux-cli && node --test --test-name-pattern='^rebuildFailedTaskResult' test/observability.test.mjs
Stop when green.

Lease: only command name \`node\` is allowed (no npm, npx, bash, or sh).
Acceptance ONLY (cwd=linux-cli): node --test --test-name-pattern='^rebuildFailedTaskResult' test/observability.test.mjs
If node or the test file is missing: stop and report an environment issue; do NOT try to install dependencies.
`;

const t2UnquotedArgs = ['--test', '--test-name-pattern=^rebuildFailedTaskResult', 'test/observability.test.mjs'];

test('T-c1-1 T2 quoted prompt cmd + unquoted shell args → hasAcceptanceGreen; gate ok with writes', () => {
  assert.equal(
    stripShellQuotes("--test-name-pattern='^rebuildFailedTaskResult'"),
    '--test-name-pattern=^rebuildFailedTaskResult'
  );
  const cmds = extractAcceptanceCommands({ prompt: T2_PROMPT });
  assert.ok(cmds.length >= 1, JSON.stringify(cmds));
  assert.ok(
    cmds.some((c) => c.includes('rebuildFailedTaskResult') && c.includes('node --test')),
    JSON.stringify(cmds)
  );
  const join = normalizeCommandJoin('node', t2UnquotedArgs);
  assert.match(join, /--test-name-pattern=\^rebuildFailedTaskResult/);
  assert.doesNotMatch(join, /'/);
  const greenShell = {
    name: 'shell.execute',
    command: 'node',
    args: t2UnquotedArgs,
    state: 'SUCCEEDED',
    ok: true,
    argumentsDigest: dig('t2a'),
    outputDigest: dig('t2o')
  };
  assert.equal(hasAcceptanceGreen([greenShell], cmds), true);
  const actions = [
    { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') },
    greenShell
  ];
  assert.equal(
    assertVerificationGate({
      harness: { writesApplied: 1, writesAppliedUnverified: 0 },
      actions,
      acceptanceCommands: cmds
    }),
    undefined
  );
});

test('T-c1-2 bare node --test is extractable; looksLikeAcceptanceCommand true', () => {
  const bare = "node --test --test-name-pattern='^rebuildFailedTaskResult' test/observability.test.mjs";
  assert.equal(looksLikeAcceptanceCommand(bare), true);
  assert.equal(looksLikeAcceptanceCommand('node --test test/observability.test.mjs'), true);
  const cmds = extractAcceptanceCommands({
    prompt: `Acceptance ONLY (cwd=linux-cli): ${bare}\n`
  });
  assert.ok(cmds.some((c) => c.includes('node --test') && c.includes('rebuildFailedTaskResult')), JSON.stringify(cmds));
  // Still recognize without Acceptance ONLY prefix
  const cmds2 = extractAcceptanceCommands({ prompt: `${bare}\n` });
  assert.ok(cmds2.some((c) => c.includes('node --test')), JSON.stringify(cmds2));
});

test('T-c1-3 after green, same intent → ACCEPTANCE_ALREADY_GREEN; no duplicates FAIL / no STALL', () => {
  const cmds = extractAcceptanceCommands({ prompt: T2_PROMPT });
  const green = {
    name: 'shell.execute',
    command: 'node',
    args: t2UnquotedArgs,
    state: 'SUCCEEDED',
    ok: true,
    argumentsDigest: dig('t2a'),
    outputDigest: dig('t2o')
  };
  const proposed = {
    name: 'shell.execute',
    command: 'node',
    args: t2UnquotedArgs,
    argumentsDigest: dig('t2a')
  };
  const gate = shouldBlockAcceptanceRerun(proposed, [green], cmds);
  assert.equal(gate.block, true);
  assert.equal(gate.errorCode, ACCEPTANCE_ALREADY_GREEN);

  const rejected = {
    ...proposed,
    state: 'FAILED',
    ok: false,
    errorCode: ACCEPTANCE_ALREADY_GREEN
  };
  assert.equal(
    isProcessNoiseFailure(rejected, { acceptanceGreen: true, acceptanceCommands: cmds }),
    true
  );

  // Verifier: write + green + same-intent reject must PASS without REPEATED_ACTION
  const report = createRuleVerifier().verify({
    prompt: T2_PROMPT,
    output: 'fixed and verified once',
    workspace: { granted: true },
    actions: [
      { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') },
      green,
      rejected
    ],
    acceptanceCommands: cmds
  });
  assert.equal(report.status, 'PASS', JSON.stringify(report.checks?.map((c) => [c.id, c.status, c.message])));
  assert.equal(report.checks.find((c) => c.id === 'actions.duplicates')?.status, 'PASS');
  assert.notEqual(report.status, 'STALLED');
  assert.ok(!report.failureCodes?.includes('REPEATED_ACTION'));
  assert.equal(report.checks.find((c) => c.id === 'actions.progress')?.status, 'PASS');

  // Also: successful re-execution of same intent after green (pre-gate residue) must not STALL
  const greenAgain = { ...green, argumentsDigest: dig('t2a'), outputDigest: dig('t2o2') };
  const report2 = createRuleVerifier().verify({
    prompt: T2_PROMPT,
    output: 're-ran by mistake',
    workspace: { granted: true },
    actions: [
      { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') },
      green,
      greenAgain
    ],
    acceptanceCommands: cmds
  });
  assert.equal(report2.checks.find((c) => c.id === 'actions.duplicates')?.status, 'PASS', JSON.stringify(report2.checks));
  assert.ok(!report2.failureCodes?.includes('REPEATED_ACTION'));
});

test('T-c1-3b writes without green still VERIFICATION_REQUIRED (do not relax)', () => {
  const cmds = extractAcceptanceCommands({ prompt: T2_PROMPT });
  assert.throws(
    () => assertVerificationGate({
      harness: { writesApplied: 1 },
      actions: [{ name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') }],
      acceptanceCommands: cmds
    }),
    (error) => error.message === 'VERIFICATION_REQUIRED'
  );
});


// ——— C2 bounded recovery (freeze-harness-c2-bounded-recovery-r1) ———

test('T-c2-1 missing command → precheck TOOL_INVALID_INPUT; does not look like success', () => {
  for (const input of [{}, { command: null }, { command: 12 }, { command: '' }, { command: '   ' }]) {
    const result = precheckShellExecuteInput(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(result.errorCode, 'TOOL_INVALID_INPUT');
    assert.equal(result.nextAction, 'FIX_ARGS');
    assert.match(result.message, /command/i);
  }
  assert.equal(precheckShellExecuteInput({ command: 'node' }).ok, true);
  assert.equal(precheckShellExecuteInput({ command: 'node', args: ['--test'] }).ok, true);
});

test('T-c2-2 TOOL_INVALID_INPUT is recoverable; progress not hard FAIL without green', () => {
  assert.equal(RECOVERABLE_TOOL_ERROR_CODES.has('TOOL_INVALID_INPUT'), true);
  assert.equal(RECOVERABLE_TOOL_ERROR_CODES.has('TOOL_INVALID_INPUT_JSON'), true);
  const report = createRuleVerifier().verify({
    prompt: 'inspect',
    output: 'tried a bad shell then will fix args',
    workspace: { granted: true },
    actions: [
      { name: 'workspace.read', state: 'SUCCEEDED', argumentsDigest: dig('r'), outputDigest: dig('o') },
      {
        name: 'shell.execute',
        state: 'FAILED',
        ok: false,
        errorCode: 'TOOL_INVALID_INPUT',
        argumentsDigest: dig('bad')
      }
    ]
  });
  assert.notEqual(report.checks.find((c) => c.id === 'actions.progress')?.status, 'FAIL');
  assert.ok(!report.failureCodes?.includes('ACTION_FAILED'), JSON.stringify(report.failureCodes));
  // Recoverable → UNKNOWN/CONTINUE-ish, not hard FAIL on progress
  assert.ok(['UNKNOWN', 'PASS', 'SKIPPED'].includes(report.checks.find((c) => c.id === 'actions.progress')?.status));
});

test('T-c2-3 writes + acceptance green + 1× TOOL_INVALID_INPUT → verifier PASS', () => {
  const cmds = extractAcceptanceCommands({ prompt: T2_PROMPT });
  const green = {
    name: 'shell.execute',
    command: 'node',
    args: t2UnquotedArgs,
    state: 'SUCCEEDED',
    ok: true,
    argumentsDigest: dig('t2a'),
    outputDigest: dig('t2o')
  };
  const bad = {
    name: 'shell.execute',
    state: 'FAILED',
    ok: false,
    errorCode: 'TOOL_INVALID_INPUT',
    argumentsDigest: dig('bad'),
    nextAction: 'FIX_ARGS'
  };
  assert.equal(
    isProcessNoiseFailure(bad, { acceptanceGreen: true, acceptanceCommands: cmds }),
    true
  );
  const report = createRuleVerifier().verify({
    prompt: T2_PROMPT,
    output: 'fixed, verified, then a bad shell',
    workspace: { granted: true },
    actions: [
      { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') },
      green,
      bad
    ],
    acceptanceCommands: cmds
  });
  assert.equal(report.status, 'PASS', JSON.stringify(report.checks?.map((c) => [c.id, c.status, c.message])));
  assert.equal(report.checks.find((c) => c.id === 'actions.progress')?.status, 'PASS');
  assert.ok(!report.failureCodes?.includes('ACTION_FAILED'));
  assert.ok(!report.failureCodes?.includes('REPEATED_ACTION'));
  assertVerificationGate({
    harness: { writesApplied: 1 },
    actions: [
      { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') },
      green,
      bad
    ],
    acceptanceCommands: cmds
  });
});

test('T-c2-4 writes + only bad shell, no green → still VERIFICATION_REQUIRED', () => {
  const cmds = extractAcceptanceCommands({ prompt: T2_PROMPT });
  const actions = [
    { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') },
    {
      name: 'shell.execute',
      state: 'FAILED',
      ok: false,
      errorCode: 'TOOL_INVALID_INPUT',
      argumentsDigest: dig('bad')
    }
  ];
  assert.equal(hasAcceptanceGreen(actions, cmds), false);
  assert.throws(
    () => assertVerificationGate({
      harness: { writesApplied: 1 },
      actions,
      acceptanceCommands: cmds
    }),
    (error) => error.message === 'VERIFICATION_REQUIRED'
  );
  // Verifier must not soft-pass the whole run as if acceptance succeeded
  const report = createRuleVerifier().verify({
    prompt: T2_PROMPT,
    output: 'wrote but never verified',
    workspace: { granted: true },
    actions,
    acceptanceCommands: cmds
  });
  assert.notEqual(report.status, 'PASS');
});


// ——— C3 multi-acceptance all-green (freeze-harness-c3-complex-r1) ———

test('T-c3-1 dual acceptance: only one green + writes → VERIFICATION_REQUIRED; both green → ok', () => {
  const cmdA = 'node --test test/assemble.test.mjs';
  const cmdB = 'node --test test/tag.test.mjs';
  const cmds = [cmdA, cmdB];
  const write = { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') };
  const greenA = {
    name: 'shell.execute',
    command: 'node',
    args: ['--test', 'test/assemble.test.mjs'],
    state: 'SUCCEEDED',
    ok: true,
    argumentsDigest: dig('a'),
    outputDigest: dig('oa')
  };
  const greenB = {
    name: 'shell.execute',
    command: 'node',
    args: ['--test', 'test/tag.test.mjs'],
    state: 'SUCCEEDED',
    ok: true,
    argumentsDigest: dig('b'),
    outputDigest: dig('ob')
  };

  assert.equal(hasAllAcceptanceCommandsGreen([greenA], cmds), false);
  assert.equal(hasAllAcceptanceCommandsGreen([greenA, greenB], cmds), true);
  assert.equal(hasAcceptanceGreen([greenA], cmds), true); // any-green still true

  assert.throws(
    () => assertVerificationGate({
      harness: { writesApplied: 1 },
      actions: [write, greenA],
      acceptanceCommands: cmds
    }),
    (error) => error.message === 'VERIFICATION_REQUIRED'
  );
  assert.equal(
    assertVerificationGate({
      harness: { writesApplied: 1 },
      actions: [write, greenA, greenB],
      acceptanceCommands: cmds
    }),
    undefined
  );

  // Single-cmd path unchanged: one green is enough
  assert.equal(
    assertVerificationGate({
      harness: { writesApplied: 1 },
      actions: [write, greenA],
      acceptanceCommands: [cmdA]
    }),
    undefined
  );
});

// ——— verification-required-after-pass-r1 (freeze-harness-verification-required-after-pass-r1) ———

test('T-vrp-1: final verification PASS → gate does not throw VERIFICATION_REQUIRED', () => {
  // run62 t3a shape: writesApplied≥1, acceptance observation may miss (multi-cmd
  // extract / digest-only test.execute), but final verification is PASS.
  const cmds = extractAcceptanceCommands({
    prompt: `Fix bug.\nThen run:\n  cd desktop && ${ACCEPT}\nAcceptance ONLY (cwd=desktop): ${ACCEPT}\n`
  });
  assert.ok(cmds.length >= 2, 'fixture should extract ≥2 acceptance lines like t3 prompt');
  const actions = [
    { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') },
    // digest-only test.execute: hasAcceptanceGreen true, hasAllAcceptanceCommandsGreen false
    { name: 'test.execute', state: 'SUCCEEDED', argumentsDigest: dig('t'), outputDigest: dig('o') }
  ];
  assert.equal(hasAcceptanceGreen(actions, cmds), true);
  assert.equal(hasAllAcceptanceCommandsGreen(actions, cmds), false);
  assert.throws(
    () => assertVerificationGate({
      harness: { writesApplied: 1 },
      actions,
      acceptanceCommands: cmds
    }),
    (error) => error.message === 'VERIFICATION_REQUIRED'
  );
  assert.equal(
    assertVerificationGate({
      harness: { writesApplied: 1 },
      actions,
      acceptanceCommands: cmds,
      verification: { status: 'PASS', nextAction: 'COMPLETE' }
    }),
    undefined
  );
});

test('T-vrp-2: final FAIL/UNCERTAIN/absent still gates when acceptance not green', () => {
  const cmds = extractAcceptanceCommands({ prompt: PROMPT });
  const actions = [
    { name: 'file.patch', state: 'SUCCEEDED', argumentsDigest: dig('w'), outputDigest: dig('x') }
  ];
  for (const verification of [
    undefined,
    { status: 'FAIL' },
    { status: 'UNCERTAIN', failureCodes: ['JEV_EVIDENCE_REQUIRED'] },
    { status: 'UNKNOWN' }
  ]) {
    assert.throws(
      () => assertVerificationGate({
        harness: { writesApplied: 1 },
        actions,
        acceptanceCommands: cmds,
        ...(verification ? { verification } : {})
      }),
      (error) => error.message === 'VERIFICATION_REQUIRED',
      `expected throw for verification=${JSON.stringify(verification)}`
    );
  }
  // Red path with green acceptance still ok (do not mis-fail).
  assert.equal(
    assertVerificationGate({
      harness: { writesApplied: 1 },
      actions: [...actions, acceptanceShell()],
      acceptanceCommands: cmds,
      verification: { status: 'UNCERTAIN' }
    }),
    undefined
  );
});

