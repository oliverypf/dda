import assert from 'node:assert/strict';
import { writeSync } from 'node:fs';
import { loadArkTS } from './sdk-host.mjs';

const [filesDir, endpoint, jevEndpoint, mode] = process.argv.slice(2);
const { LocalWorkspace } = loadArkTS('services/LocalWorkspace');
const { LocalModelTransport } = loadArkTS('services/LocalModelTransport');
const { LocalRunJournal } = loadArkTS('services/LocalRunJournal');
const { SessionEventKind } = loadArkTS('models/CodexTypes');
const threadId = 'local-thread-1700000000000-1';
const goal = 'Create project.json and check its JSON syntax.';
const workspace = new LocalWorkspace({ filesDir });
await workspace.initialize();

function interruptAt(boundary) {
  writeSync(1, JSON.stringify({ stoppedAt: boundary }) + '\n');
  process.kill(process.pid, 'SIGKILL');
}

// Stop a real process at a committed boundary or in the narrow gap after a
// workspace effect, before the original caller can record its receipt.
if (mode === 'stop-before-review') {
  const write = workspace.writeCheckpoint.bind(workspace);
  workspace.writeCheckpoint = async (thread, text) => {
    await write(thread, text);
    if (JSON.parse(text).state.phase === 'review') { interruptAt('review'); }
  };
} else if (mode === 'stop-after-effect') {
  const create = workspace.createFile.bind(workspace);
  workspace.createFile = async (path, content) => {
    await create(path, content);
    interruptAt('post-effect');
  };
}

const transport = new LocalModelTransport(workspace);
transport.configure({ baseUrl: endpoint, model: 'project-model', apiKey: 'fixture-project-key',
  jev: { endpoint: jevEndpoint, model: 'router-model', apiKey: 'fixture-router-key' } });
transport.prepareTurn([], 'Use the supplied project.');
let completed = false;
const approvals = [];
await transport.connect(event => {
  if (event.kind === SessionEventKind.ApprovalRequired) {
    approvals.push(event.command);
    writeSync(1, JSON.stringify({ approval: event.command }) + '\n');
    transport.resolveApproval(event.requestId, true);
  } else if (event.kind === SessionEventKind.TurnCompleted) {
    completed = true;
  }
});
const journal = new LocalRunJournal(workspace, threadId);
if (mode === 'resume' || mode === 'verify-and-resume') {
  const previous = await journal.load();
  const verify = mode === 'verify-and-resume';
  if (verify) {
    assert.equal(previous.pending.tool, 'create_file');
    await assert.rejects(transport.verifyCheckpoint(threadId, previous.runId, previous.revision - 1), /断点已更新/);
    const checked = await transport.verifyCheckpoint(threadId, previous.runId, previous.revision);
    assert.equal(checked.phase, 'execute');
    assert.equal(checked.pending, undefined);
    assert.equal(checked.receipts.length, 1);
    assert.equal(checked.receipts[0].id, previous.pending.id);
    assert.equal(checked.receipts[0].verifiedOnRecovery, true);
  } else {
    assert.equal(previous.phase, 'review');
  }
  assert.equal(await workspace.read('/project.json'), '{"active":true}');
  await transport.resumeTurn(threadId, goal);
  const done = await journal.load();
  assert.equal(done.runId, previous.runId);
  assert.equal(done.phase, 'done');
  assert.equal(done.role, 'full-roles');
  assert(completed);
  assert.equal(approvals.length, verify ? 1 : 0);
  assert.deepEqual(done.receipts.map(r => [r.tool, r.status]), [['create_file', 'ok'], ['command_check_json', 'ok']]);
  assert.equal(done.receipts.find(r => r.tool === 'command_check_json').exitCode, 0);
} else if (mode === 'resume-pending') {
  const previous = await journal.load();
  assert.equal(previous.phase, 'execute');
  assert.equal(previous.pending.tool, 'create_file');
  assert.equal(await workspace.read('/project.json'), '{"active":true}');
  await assert.rejects(transport.resumeTurn(threadId, goal), /未确认|未知|核对|不确定/);
  assert.deepEqual(await journal.load(), previous);
  assert.deepEqual(approvals, []);
  assert.equal(completed, false);
} else if (mode === 'invalid-check') {
  await assert.rejects(transport.sendTurn(threadId, goal));
  const state = await journal.load();
  assert.notEqual(state.phase, 'done');
  assert.equal(completed, false);
  const failed = state.receipts.find(r => r.tool === 'command_check_json');
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.status, 'failed');
} else {
  await transport.sendTurn(threadId, goal);
  assert.fail('The simulated process interruption was not reached.');
}
await transport.disconnect();
