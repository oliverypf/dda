import assert from 'node:assert/strict';
import test from 'node:test';
import { createDecisionEngine } from '../src/decision/engine.mjs';
import { memoryReadWithoutHarnessStore, ruleProcessAdmission } from '../src/decision/process-admission.mjs';

test('memory list and get do not need the harness store', () => {
  assert.equal(memoryReadWithoutHarnessStore('memory', 'list'), true);
  assert.equal(memoryReadWithoutHarnessStore('memories', ''), true);
  assert.equal(memoryReadWithoutHarnessStore('memory', 'get'), true);
  assert.equal(memoryReadWithoutHarnessStore('memory', 'propose'), false);
  assert.equal(memoryReadWithoutHarnessStore('dashboard', 'list'), false);
  assert.equal(ruleProcessAdmission({ command: 'memory', operation: 'list' }).decision, 'OPEN_READ_PROCESS');
  assert.equal(ruleProcessAdmission({ command: 'recovery' }).decision, 'DEFER');
  assert.equal(ruleProcessAdmission({ command: 'memory', operation: 'propose' }).reasonCode, 'HARNESS_STORE_HELD_BY_TASK');
});

test('Jev may open or defer a read process and cannot authorize a harness writer', async () => {
  const calls = [];
  const engine = createDecisionEngine({
    enabled: true,
    client: {
      async decide(request) {
        calls.push(request.questions.processAdmission.choices);
        const open = request.state.action.summary.includes('get');
        return { answers: { processAdmission: { choice: open ? 'OPEN_READ_PROCESS' : 'DEFER', confidence: 0.8 } }, latencyMs: 3 };
      }
    }
  });
  const opened = await engine.decideProcessAdmission({ command: 'memory', operation: 'get' });
  const deferred = await engine.decideProcessAdmission({ command: 'memory', operation: 'list' });
  const writer = await engine.decideProcessAdmission({ command: 'memory', operation: 'retract' });
  assert.equal(opened.decision, 'OPEN_READ_PROCESS');
  assert.equal(opened.source, 'jev');
  assert.equal(deferred.decision, 'DEFER');
  assert.equal(deferred.source, 'jev');
  assert.equal(writer.decision, 'DEFER');
  assert.equal(writer.reasonCode, 'HARNESS_STORE_HELD_BY_TASK');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['OPEN_READ_PROCESS', 'DEFER']);
});

test('a disabled Jev plane opens the read and does not call out', async () => {
  let called = false;
  const engine = createDecisionEngine({
    enabled: false,
    client: { async decide() { called = true; return {}; } }
  });
  const admission = await engine.decideProcessAdmission({ command: 'memory' });
  assert.equal(admission.decision, 'OPEN_READ_PROCESS');
  assert.equal(admission.reasonCode, 'JEV_DISABLED_PROCESS_ADMISSION');
  assert.equal(called, false);
});

test('an illegal Jev choice falls back to opening the read', async () => {
  const engine = createDecisionEngine({
    enabled: true,
    client: { async decide() { return { answers: { processAdmission: { choice: 'OPEN_EXCLUSIVE' } } }; } }
  });
  const admission = await engine.decideProcessAdmission({ command: 'memory', operation: 'list' });
  assert.equal(admission.decision, 'OPEN_READ_PROCESS');
  assert.equal(admission.fallbackUsed, true);
  assert.equal(admission.reasonCode, 'JEV_PROCESS_ADMISSION_INVALID');
});
