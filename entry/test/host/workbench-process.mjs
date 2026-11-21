import assert from 'node:assert/strict';
import { loadArkTS } from './sdk-host.mjs';

const [filesDir, endpoint, phase] = process.argv.slice(2);
const { WorkbenchStore } = loadArkTS('services/WorkbenchStore');
const { LocalWorkspace } = loadArkTS('services/LocalWorkspace');
const { LocalModelTransport } = loadArkTS('services/LocalModelTransport');
const { CodexSession } = loadArkTS('services/CodexSession');
const { SessionEventKind, MessageRole } = loadArkTS('models/CodexTypes');
const store = new WorkbenchStore({ filesDir });
const saved = await store.load();
const workspace = new LocalWorkspace({ filesDir });
await workspace.initialize();
const transport = new LocalModelTransport(workspace);
const session = new CodexSession(transport);
const first = phase === 'first';
const prompt = first ? 'create the project note' : 'continue the same task';
if (first) {
  assert.equal(saved, null);
} else {
  assert.equal(saved.baseUrl, endpoint);
  assert.equal(saved.model, 'test-model');
  assert.equal(saved.current.draft, 'saved draft');
  assert.equal(saved.current.messages.at(-1).text, 'note written');
  session.selectThread(saved.current.threadId);
  assert.equal(await workspace.read('/note.txt'), 'local data');
}
const history = saved?.current.messages ?? [];
transport.configure({ baseUrl: endpoint, model: saved?.model ?? 'test-model', apiKey: '' });
transport.prepareTurn(history, saved?.instructions ?? 'use short replies');
let answer = '';
const approvals = [];
let completed = false;
session.setListener(event => {
  if (event.kind === SessionEventKind.ApprovalRequired) {
    approvals.push(event.command);
    session.resolveApproval(event.requestId, first);
  } else if (event.kind === SessionEventKind.AssistantDelta) {
    answer += event.text;
  } else if (event.kind === SessionEventKind.TurnCompleted) {
    completed = true;
  }
});
await session.connect();
await session.sendPrompt(prompt);
assert.equal(completed, true);
assert.equal(approvals.length, 1);
assert(approvals[0].includes(first ? '/note.txt' : '/denied.txt'));
assert.equal(answer, first ? 'note written' : 'request denied');
if (!first) { assert.equal(session.currentThread(), saved.current.threadId); }
assert.deepEqual((await session.readDirectory('/')).map(entry => entry.fileName), ['note.txt']);
const current = { threadId: session.currentThread(), title: 'project note', draft: 'saved draft', messages: [
  ...history, { id: phase + '-u', role: MessageRole.User, text: prompt },
  { id: phase + '-a', role: MessageRole.Assistant, text: answer }
] };
await store.save({ current, tasks: [], instructions: 'use short replies', memories: [], baseUrl: endpoint, model: 'test-model' });
await session.disconnect();
