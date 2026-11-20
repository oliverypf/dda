import test from 'node:test';
import assert from 'node:assert/strict';
import { installationEvidenceGap, directResponseSatisfied } from '../src/task-outcome-evidence.mjs';
import { readableNetworkResponse } from '../src/web-lookup.mjs';
import { runPlannerTurn } from '../src/agent-turns.mjs';

test('a blocked installer and a successfully written guide cannot prove installation', () => {
  const goal = '这台机子上需要安装查看pptx的软件，安装一个';
  const install = { name: 'shell.execute', command: 'winget', args: ['install', 'viewer'], state: 'SUCCEEDED' };
  assert.ok(installationEvidenceGap(goal, [{ ...install, state: 'FAILED' }, { name: 'file.write', state: 'SUCCEEDED' }]));
  assert.ok(installationEvidenceGap(goal, [{ ...install, invocationAttempted: false }]));
  assert.equal(installationEvidenceGap(goal, [install]), undefined);
  for (const request of ['请帮我安装 LibreOffice', 'Please install LibreOffice']) {
    assert.ok(installationEvidenceGap(request, []));
    assert.ok(installationEvidenceGap(request, [install]));
    const matching = { ...install, args: ['install', '--id', 'TheDocumentFoundation.LibreOffice'] };
    assert.equal(installationEvidenceGap(request, [matching]), undefined);
    assert.ok(installationEvidenceGap(request, [{ ...matching, args: [...matching.args, '--dry-run'] }]));
    assert.equal(installationEvidenceGap(request, [{ ...matching, args: [...matching.args, '--version', '24.2', '-s', 'winget'] }]), undefined);
  }
  for (const request of ['写一份查看器安装说明', '如何安装 LibreOffice', '不要安装浏览器', '安装失败是什么原因？']) {
    assert.equal(installationEvidenceGap(request, []), undefined);
  }
});

test('raw HTTP challenge and loading shell are not source evidence', () => {
  for (const [status, body] of [[202, 'Processing'], [200, 'Verify you are human'], [200, '<html><body>Loading...</body></html>']]) {
    assert.equal(readableNetworkResponse({ ok: true, status, body }), false);
  }
  assert.equal(readableNetworkResponse({ ok: true, status: 200, body: '{"price":8}' }), true);
});

test('the exact answer must match and must have no actions', () => {
  assert.equal(directResponseSatisfied('reply with ok', 'ok', [], []), true);
  assert.equal(directResponseSatisfied('reply with ok', 'pending', [], []), false);
  assert.equal(directResponseSatisfied('描述这张图片', '已收到图片。', [{}], []), false);
  assert.equal(directResponseSatisfied('描述这张图片', '无法查看图片。', [{}], []), false);
  assert.equal(directResponseSatisfied('描述这张图片', '左上角有一个红色圆形。', [{}], []), true);
  assert.equal(directResponseSatisfied('reply with ok', 'ok', [], [{ name: 'shell.execute' }]), false);
});

test('a declared executable build gets an execution step without a planning-model call', async () => {
  const result = await runPlannerTurn({ prompt: '编译exe', executableBuildRequest: true,
    projectBuildCommand: { command: 'npm', args: ['run', 'build:windows:full-local'], cwd: 'desktop' } });
  assert.deepEqual(result.plan.steps.map(step => step.actionKind), ['EXECUTE']);
  assert.match(result.plan.steps[0].summary, /build:windows:full-local/);
});
