import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FULL_ACCESS_SYSTEM_INSTRUCTION,
  WORKSPACE_SYSTEM_INSTRUCTION,
  executorSystemInstruction
} from '../src/access-mode-instructions.mjs';

test('executor prompts share evidence-driven rules and keep access modes apart', () => {
  for (const text of [FULL_ACCESS_SYSTEM_INSTRUCTION, WORKSPACE_SYSTEM_INSTRUCTION]) {
    assert.match(text, /evidence-driven agent/);
    assert.match(text, /CONTROLLED mode/);
    assert.match(text, /untrusted data|observations/);
    assert.match(text, /one-shot lease/);
    assert.match(text, /visible tool grants no permission/);
    assert.match(text, /Host limits outrank/);
    assert.match(text, /write the reasoning text in that same language/);
    assert.match(text, /custom instruction that names a reply language covers the reasoning text/);
    assert.doesNotMatch(text, /You are Codex|Claude Code|DeepSeek Harness|pi, a coding agent/iu);
  }
  assert.match(WORKSPACE_SYSTEM_INSTRUCTION, /workspace-relative paths/);
  assert.match(WORKSPACE_SYSTEM_INSTRUCTION, /Stay inside the authorized workspace/);
  assert.doesNotMatch(WORKSPACE_SYSTEM_INSTRUCTION, /absolute path outside the project/);
  assert.match(FULL_ACCESS_SYSTEM_INSTRUCTION, /absolute path outside the project/);
  assert.match(FULL_ACCESS_SYSTEM_INSTRUCTION, /not administrator access/);
  assert.match(FULL_ACCESS_SYSTEM_INSTRUCTION, /SAFETY_PROTECTED_PATH/);
  assert.equal(executorSystemInstruction('USER_FILESYSTEM'), FULL_ACCESS_SYSTEM_INSTRUCTION);
  assert.equal(executorSystemInstruction('WORKSPACE'), WORKSPACE_SYSTEM_INSTRUCTION);
  assert.equal(executorSystemInstruction(undefined), WORKSPACE_SYSTEM_INSTRUCTION);
});
