import test from 'node:test';
import assert from 'node:assert/strict';
import { experiencePlacement, experienceTakesEffect } from '../src/experience-placement.mjs';

test('project procedures are skills and general rules stay memories', () => {
  assert.equal(experiencePlacement({ key: 'workflow:cmd:desktop:npm run build:windows' }), 'skill');
  assert.equal(experiencePlacement({ key: 'workflow:skip:desktop:npm run runtime:install', statement: '本轮经验（编译exe）：`npm run runtime:install` 已失败（EINVAL）。下一轮不要再执行这条命令。' }), 'skill');
  assert.equal(experiencePlacement({ key: 'workflow:timeout:编译exe' }), 'skill');
  assert.equal(experiencePlacement({ key: 'project:files:编译exe', statement: '项目改动经验（编译exe）：关键修改文件包括 `desktop/package.json`。' }), 'skill');
  assert.equal(experiencePlacement({ key: 'pitfall:safety-protected-path', statement: '安全边界经验：宿主受保护目录仍禁止访问。' }), 'memory');
  assert.equal(experiencePlacement({ key: 'pitfall:excerpt-ambiguous' }), 'memory');
  assert.equal(experiencePlacement({ key: 'tool:workspace.inspect_binary' }), 'memory');
  assert.equal(experiencePlacement({
    key: 'workflow:cmd:工作区根目录:node .codex-tmp/exe-artifact-digest.mjs',
    statement: '项目命令经验：执行 `node .codex-tmp/exe-artifact-digest.mjs`。'
  }), 'skip');
  assert.equal(experienceTakesEffect({ status: 'PROPOSED', key: 'workflow:cmd:desktop:npm run build:windows', statement: '项目命令经验：在 desktop 执行 npm run build:windows。' }), true);
  assert.equal(experienceTakesEffect({ status: 'PROPOSED', key: 'pitfall:safety-protected-path', statement: '安全边界经验：受保护目录不能访问。' }), true);
  assert.equal(experienceTakesEffect({ status: 'RETRACTED', key: 'pitfall:safety-protected-path', statement: '安全边界经验：受保护目录不能访问。' }), false);
  assert.equal(experienceTakesEffect({ status: 'PROPOSED', kind: 'TASK_OUTCOME', statement: `Verified task outcome: class=unknown; verifier=PASS; outputDigest=sha256:${'ab'.repeat(32)}` }), false);
  assert.equal(experienceTakesEffect({ status: 'PROPOSED', key: 'workflow:cmd:tmp', statement: '项目命令经验：执行 node .codex-tmp/digest.mjs。' }), false);
});
