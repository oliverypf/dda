import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { cordisPlugin } from '../src/plugins/cordis-plugin.mjs';
import { taskRunnerPlugin } from '../src/plugins/task-runner.mjs';
import { ToolRegistry, toolRegistryPlugin } from '../src/tool-registry.mjs';
import {
  isAgentMissReplanEligible,
  isSoleHardDenyFailure,
  runVerifierRecovery
} from '../src/task-recovery-controller.mjs';

const baseWorkspace = {
  granted: true,
  rootLabel: 'fixture',
  snapshotDigest: 'sha256:snapshot',
  entries: [
    { path: 'desktop/src/main.ts', kind: 'FILE', sizeBytes: 64 },
    { path: 'desktop/src/domain', kind: 'DIR', sizeBytes: 0 }
  ],
  sections: []
};

async function runFocusFixture({ handler, rounds, stopAfterText = 'done probing' }) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'workspace.focus',
    description: 'Focus fixture.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        findText: { type: 'string', minLength: 1 }
      },
      required: ['path', 'findText'],
      additionalProperties: false
    },
    handler
  });
  const events = [];
  let round = 0;
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'fm-fixture',
      async *stream() {
        round += 1;
        if (round <= rounds) {
          yield {
            type: 'tool-call',
            id: `focus-${round}`,
            name: 'workspace.focus',
            arguments: JSON.stringify({ path: 'desktop/src/main.ts', findText: `loc-${round}` })
          };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
          return;
        }
        yield { type: 'text-delta', text: stopAfterText };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    });
  }, 'fm-focus-provider');
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    const result = await root.taskRunner.run({
      prompt: 'probe focus',
      workspace: baseWorkspace,
      onEvent: (e) => events.push(e)
    });
    return { result, events };
  } finally {
    await root.fiber.dispose();
  }
}

// T-fm-1: 4× EXCERPT_AMBIGUOUS focus only → must NOT throw TOOL_NO_NEW_EVIDENCE; nextAction present
test('T-fm-1: four EXCERPT_AMBIGUOUS focus rounds do not TOOL_NO_NEW_EVIDENCE and carry nextAction', async () => {
  const { result, events } = await runFocusFixture({
    rounds: 4,
    handler: () => {
      const err = new Error('EXCERPT_AMBIGUOUS:findText matches more than once');
      err.code = 'EXCERPT_AMBIGUOUS';
      throw err;
    }
  });
  assert.equal(result.text, 'done probing');
  const fails = events.filter((e) => e.kind === 'tool.result' && e.ok === false);
  assert.equal(fails.length, 4);
  for (const f of fails) {
    assert.equal(f.errorCode, 'EXCERPT_AMBIGUOUS');
    assert.equal(f.nextAction, 'RETRY_WITH_UNIQUE_LOCATOR_OR_LIST');
  }
  assert.equal(
    events.some((e) => String(e?.error ?? e?.message ?? '').includes('TOOL_NO_NEW_EVIDENCE')),
    false
  );
});

// T-fm-2: 4× focus ok same digest → still TOOL_NO_NEW_EVIDENCE
test('T-fm-2: four successful same-digest focus rounds still TOOL_NO_NEW_EVIDENCE', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'workspace.focus',
    description: 'Focus fixture.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        findText: { type: 'string', minLength: 1 }
      },
      required: ['path', 'findText'],
      additionalProperties: false
    },
    // Same content every time → same evidence digest (path stripped).
    handler: () => ({ content: 'unchanging-window', found: true, offsetChars: 0, digest: 'sha256:same' })
  });
  const events = [];
  let round = 0;
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'fm-vacuum',
      async *stream() {
        round += 1;
        yield {
          type: 'tool-call',
          id: `focus-ok-${round}`,
          name: 'workspace.focus',
          arguments: JSON.stringify({ path: `alias-${round}.ts`, findText: 'x' })
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    });
  }, 'fm-vacuum-provider');
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    await assert.rejects(
      root.taskRunner.run({
        prompt: 'vacuum focus',
        workspace: baseWorkspace,
        onEvent: (e) => events.push(e)
      }),
      /TOOL_NO_NEW_EVIDENCE/
    );
    // First success establishes digest; 4 same-digest rounds trigger one vacuum escape,
    // then another 4 trip TOOL_NO_NEW_EVIDENCE (focus-probe-escape-r1).
    assert.ok(events.filter((e) => e.kind === 'tool.result' && e.ok === true).length >= 4);
    assert.equal(events.filter((e) => e.kind === 'harness.focus_vacuum_escape').length, 1);
  } finally {
    await root.fiber.dispose();
  }
});

// T-fm-3: recoverable probe budget → TOOL_RECOVERABLE_PROBE_LOOP
test('T-fm-3: recoverable probe rounds hit TOOL_RECOVERABLE_PROBE_LOOP at budget 8', async () => {
  const registry = new ToolRegistry();
  registry.register({
    name: 'workspace.focus',
    description: 'Focus fixture.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1 },
        findText: { type: 'string', minLength: 1 }
      },
      required: ['path', 'findText'],
      additionalProperties: false
    },
    handler: () => {
      const err = new Error('EXCERPT_NOT_FOUND:locator');
      err.code = 'EXCERPT_NOT_FOUND';
      throw err;
    }
  });
  const events = [];
  let round = 0;
  const providerPlugin = cordisPlugin((ctx) => {
    ctx.provide('modelProvider', {
      provider: 'fixture', protocol: 'fixture', model: 'fm-probe-loop',
      async *stream() {
        round += 1;
        yield {
          type: 'tool-call',
          id: `focus-miss-${round}`,
          name: 'workspace.focus',
          arguments: JSON.stringify({ path: 'desktop/src/main.ts', findText: `miss-${round}` })
        };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      }
    });
  }, 'fm-probe-loop-provider');
  const root = new Context();
  await root.plugin(toolRegistryPlugin(registry));
  await root.plugin(providerPlugin);
  await root.plugin(taskRunnerPlugin);
  try {
    await assert.rejects(
      root.taskRunner.run({
        prompt: 'probe until budget',
        workspace: baseWorkspace,
        onEvent: (e) => events.push(e)
      }),
      /TOOL_RECOVERABLE_PROBE_LOOP/
    );
    const fails = events.filter((e) => e.kind === 'tool.result' && e.ok === false);
    // focus-probe-escape-r1: first budget hit escapes once; second exhaustion still throws.
    assert.equal(fails.length, 16);
    assert.equal(fails.every((f) => f.errorCode === 'EXCERPT_NOT_FOUND'), true);
    assert.equal(fails.every((f) => f.nextAction === 'RETRY_WITH_UNIQUE_LOCATOR_OR_LIST'), true);
    assert.equal(events.filter((e) => e.kind === 'harness.focus_probe_escape').length, 1);
  } finally {
    await root.fiber.dispose();
  }
});

// T-fm-4: writes≥1 + REPEATED_ACTION STOP → exactly one agent-miss replan; second still stops
test('T-fm-4: successfulWrites≥1 + REPEATED_ACTION yields exactly one agent_miss replan', async () => {
  assert.equal(isSoleHardDenyFailure(['SAFETY_COMMAND_NOT_ALLOWED']), true);
  assert.equal(isAgentMissReplanEligible({
    writesApplied: 0, successfulWrites: 0, failureCodes: ['REPEATED_ACTION']
  }), false);
  assert.equal(isAgentMissReplanEligible({
    writesApplied: 2, failureCodes: ['SAFETY_COMMAND_NOT_ALLOWED']
  }), false);
  assert.equal(isAgentMissReplanEligible({
    writesApplied: 2, failureCodes: ['REPEATED_ACTION', 'SAFETY_COMMAND_NOT_ALLOWED']
  }), true);

  const replanEvents = [];
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 1,
    agentMiss: {
      getWriteCounts: () => ({ writesApplied: 3, successfulWrites: 3 }),
      onReplan: (evt) => replanEvents.push(evt)
    },
    execute: async ({ attempt, recovery }) => {
      executions += 1;
      return {
        text: attempt === 1 ? 'partial' : 'retry',
        actions: [{ name: 'file.write', state: 'SUCCEEDED', argumentsDigest: `sha256:${String(attempt).padStart(64, '0')}` }],
        recoverySeen: recovery?.agentMissReplan === true
      };
    },
    verify: async ({ attempt }) => {
      // Both attempts FAIL with REPEATED_ACTION — only the first may replan.
      return {
        status: 'FAIL',
        summary: 'duplicates',
        nextAction: 'STOP_AND_REPORT',
        failureCodes: ['REPEATED_ACTION', 'JEV_BEHAVIOR_REJECTED']
      };
    }
  });

  assert.equal(replanEvents.length, 1);
  assert.equal(replanEvents[0].writesApplied, 3);
  assert.deepEqual(replanEvents[0].failureCodes, ['REPEATED_ACTION', 'JEV_BEHAVIOR_REJECTED']);
  assert.equal(executions, 2);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 2);
  assert.equal(result.agentMissReplanned, true);
  // Second FAIL must not replan again.
  assert.equal(result.report.status, 'FAIL');
  assert.ok(result.history.some((h) => h.status === 'FAIL'));
});

test('T-fm-4b: sole SAFETY hard deny never agent-miss replans', async () => {
  const replanEvents = [];
  let executions = 0;
  const result = await runVerifierRecovery({
    maxAttempts: 2,
    agentMiss: {
      getWriteCounts: () => ({ writesApplied: 5, successfulWrites: 5 }),
      onReplan: (evt) => replanEvents.push(evt)
    },
    execute: async () => {
      executions += 1;
      return { text: 'x', actions: [] };
    },
    verify: async () => ({
      status: 'FAIL',
      failureCodes: ['SAFETY_COMMAND_NOT_ALLOWED'],
      nextAction: 'STOP_AND_REPORT'
    })
  });
  assert.equal(replanEvents.length, 0);
  assert.equal(executions, 1);
  assert.equal(result.ok, false);
  assert.equal(result.attempts, 1);
});
