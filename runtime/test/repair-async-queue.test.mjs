import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asyncQueueContract, asyncQueueInstrumentation, asyncQueuePlan, asyncQueueSchedule } from '../src/repair-async-queue.mjs';

const exec = promisify(execFile);
const target = 'spec/renderer.test.mjs';
const marker = 'DDA_QUEUE_0123456789abcdef=';
const visible = `import t from 'node:test';
import a from 'node:assert/strict';
import { batch as bind } from '../src/render.mjs';
t('pending render uses newest setting', async () => {
  const ready = Promise.withResolvers();
  const stop = Promise.withResolvers();
  const seen = [];
  const put = bind(async (slot, setting) => {
    seen.push(setting);
    if (setting === 'old') { ready.resolve(); await stop.promise; }
    return setting;
  });
  const one = put(72, 'old');
  await ready.promise;
  const two = put(72, 'middle');
  const three = put(72, 'new');
  stop.resolve();
  await Promise.all([one,two,three]);
  const trajectory = seen.join('/');
  a.equal(trajectory, 'old/new');
});`;
const line = visible.split('\n').findIndex(s => s.includes('a.equal(')) + 1;
const base = `export function batch(work) {
  const active = new Map();
  return function submit(slot, value) {
    let state = active.get(slot);
    if (state) {
      if (!state.tail) state.tail = { value, done:Promise.withResolvers() };
      state.tail.value = value;
      return state.tail.done.promise;
    }
    state = { tail:null };
    active.set(slot,state);
    const first = { value, done:Promise.withResolvers() };
    async function run() {
      let part = first;
      while (part) {
        try { part.done.resolve(await work(slot,part.value)); }
        catch (err) { part.done.reject(err); }
        part = state.tail;
        state.tail = null;
      }
      active.delete(slot);
    }
    setTimeout(run,12);
    return first.done.promise;
  };
}`;

test('uses the failing assertion, held worker and requested keyed behavior to select a replay', () => {
  assert.deepEqual(asyncQueuePlan(target,visible,line), {
    path:'src/render.mjs', specifier:'../src/render.mjs', exportName:'batch', keyType:'number', revisionType:'string'
  });
  assert.equal(asyncQueuePlan(target,visible.replace("a.equal(trajectory, 'old/new')","a.equal(trajectory, 'old/middle/new')"),line),undefined);
  assert.equal(asyncQueuePlan(target,visible.replace('await ready.promise;', 'await Promise.resolve();'),line),undefined);
  assert.equal(asyncQueuePlan(target,visible,line-1),undefined);
  assert.ok(asyncQueueContract('Each key runs one worker at a time, coalescing the latest request. A failed job must allow future work.'));
  assert.ok(asyncQueueContract('Each key runs one worker at a time, coalescing the latest request. Different keys may run in parallel. Allow future work after a failure and recover.'));
  assert.ok(asyncQueueContract('同键任务不能重叠，待处理请求合并为最新修订，失败后同键还能继续执行。'));
  assert.equal(asyncQueueContract('Serialize each key. Coalesce the latest work.'),false);
  assert.equal(asyncQueueContract('Each key is serial. Never coalesce the latest work. Failure allows future work.'),false);
  const schedule = asyncQueueSchedule('number');
  assert.deepEqual(schedule.success.map(row => row.batch), [1,2,2,3,3]);
  assert.deepEqual(schedule.success.map(row => row.requested), ['value:11','value:29','value:13','value:37','value:17']);
  assert.deepEqual(schedule.success.map(row => row.expected), ['value:11','value:13','value:13','value:17','value:17']);
  assert.deepEqual(schedule.failure.map(row => row.expected), ['value:11','rejected:worker','rejected:worker','value:17']);
  assert.equal(asyncQueueSchedule('boolean'), undefined);
});

test('measures blocked rounds and post-failure reuse on an actual factory with delayed dispatch', async t => {
  const dir = await mkdtemp(join(tmpdir(),'dda-scheduler-test-'));
  t.after(() => rm(dir,{recursive:true,force:true,maxRetries:2}));
  await mkdir(join(dir,'spec'));
  await mkdir(join(dir,'src'));
  const plan = asyncQueuePlan(target,visible,line);
  await writeFile(join(dir,target), visible+asyncQueueInstrumentation(plan,marker));
  async function measure(text) {
    await writeFile(join(dir,'src/render.mjs'),text);
    const env = {...process.env};
    delete env.NODE_TEST_CONTEXT;
    const result = await exec(process.execPath,['--test','--test-reporter=tap',target],{cwd:dir,env,timeout:10000});
    const receipt = result.stdout.split(/\r?\n/u).find(l => l.includes(marker));
    assert.ok(receipt,result.stdout);
    return JSON.parse(receipt.slice(receipt.indexOf(marker)+marker.length));
  }
  const good = await measure(base);
  assert.equal(good.status,'observed');
  assert.deepEqual(good.checks,{serial:true,latest:true,reuseAfterFailure:true});
  const schedule = asyncQueueSchedule('string');
  for (const scenario of ['success','failure']) {
    assert.deepEqual(good.callers[scenario], schedule[scenario].map(row => ({...row,actual:row.expected})));
  }
  const slow = await measure(base.replace('setTimeout(run,12);','setTimeout(run,380);'));
  assert.equal(slow.status,'unverified');
  assert.deepEqual(slow.checks,{serial:null,latest:null,reuseAfterFailure:null});
  assert.deepEqual(slow.callers.success,[{...schedule.success[0],actual:'pending'}]);
  assert.deepEqual(slow.callers.failure,[{...schedule.failure[0],actual:'pending'}]);
  // Normal bursts still pass the exact original test, but the post-error key remains occupied.
  const stale = await measure(base.replace('part.done.reject(err);','part.done.reject(err); return;'));
  assert.equal(stale.status,'violated');
  assert.deepEqual(stale.checks,{serial:true,latest:true,reuseAfterFailure:false});
  assert.equal(stale.detail.reuseAfterFailure,'same_key_pending_after_failure_at_deadline');
  assert.deepEqual(stale.callers.failure.map(row => row.actual),['value:p','rejected:worker','rejected:worker','pending']);
  // A pending request is lost only when a second burst arrives during the tail.
  const lost = await measure(base.replace('let part = first;', 'let part = first; let rounds = 0;')
    .replace('part = state.tail;', 'part = ++rounds >= 2 ? null : state.tail; if (!part && state.tail) state.tail.done.resolve(undefined);'));
  assert.equal(lost.status,'violated');
  assert.equal(lost.checks.latest,false);
  const overlapping = await measure(base
    .replace('if (!state.tail) state.tail = { value, done:Promise.withResolvers() };',
      'if (!state.tail) { state.tail = { value, done:Promise.withResolvers() }; const tail=state.tail; setImmediate(() => { state.tail=null; Promise.resolve(work(slot,tail.value)).then(tail.done.resolve,tail.done.reject); }); }')
    .replace('part = state.tail;', 'part = null;')
    .replace('      state.tail = null;', ''));
  assert.equal(overlapping.status,'violated');
  assert.equal(overlapping.checks.serial,false);

  // Promise routing alone can be wrong even when all workers run in order.
  const misplaced = await measure(base.replace('return state.tail.done.promise;', 'return state.previous.promise;')
    .replace('async function run() {', 'state.previous = first.done; async function run() {')
    .replace('part = state.tail;', 'part = state.tail; if (part) state.previous = part.done;')
    .replace('catch (err) { part.done.reject(err); }', 'catch (err) { part.done.promise.catch(() => {}); part.done.reject(err); }'));
  assert.deepEqual(misplaced.checks,{serial:true,latest:false,reuseAfterFailure:false});
  assert.deepEqual(misplaced.callers.success.map(row => row.actual),['value:p','value:p','value:p','value:q','value:q']);
  assert.deepEqual(misplaced.callers.failure.map(row => row.actual),['value:p','value:p','value:p','value:r']);

  const missedCaller = await measure(base.replace('return state.tail.done.promise;',
    "if (value === 'z') return new Promise(() => {}); return state.tail.done.promise;"));
  assert.deepEqual(missedCaller.callers.success.map(row => row.actual),['value:p','pending','value:q','value:r','value:r']);
  assert.deepEqual(missedCaller.callers.failure.map(row => row.actual),['value:p','pending','rejected:worker','value:r']);

  const wrongValues = await measure(base.replace('return state.tail.done.promise;', `return state.tail.done.promise.then(() => {
      if (value === 'z') return undefined;
      if (value === 'q') return Object.defineProperty({}, 'toJSON', {get(){throw Error('unsafe');}});
      if (value === 'y') return 0;
      if (value === 'r') return false;
    }, () => {
      const error = new Error('short failure');
      if (value === 'z') Object.defineProperty(error, 'message', { get(){ throw Error('unsafe'); } });
      throw error;
    });`));
  assert.deepEqual(wrongValues.callers.success.map(row => row.actual),['value:p','undefined','other:object','number:0','boolean:false']);
  assert.deepEqual(wrongValues.callers.failure.map(row => row.actual),['value:p','rejected:other','rejected:error:short failure','value:r']);

  // A single read of a public then getter may yield a method that resolves to
  // another promise. All caller results must agree with directly awaiting it.
  const nested = await measure(base.replace('return function submit', 'function submit')
    .replace('    return first.done.promise;\n  };', `    return first.done.promise;
  };
  return (slot, value) => {
    const inner = submit(slot,value);
    let reads = 0;
    const result = new Proxy({ get then() {
      if (++reads !== 1) throw Error('then obtained twice');
      return function(resolve) {
        if (this !== result) throw Error('wrong receiver');
        resolve(inner);
      };
    } }, {});
    return result;
  };`));
  assert.deepEqual(nested.callers,good.callers);
  assert.deepEqual(nested.checks,good.checks);

  const getterError = await measure(base.replace('let state = active.get(slot);',
    "if (slot === 61) return { get then() { throw Error('cannot open promise'); } }; let state = active.get(slot);"));
  assert.equal(getterError.status,'unverified');
  assert.deepEqual(getterError.callers.success,[{...schedule.success[0],actual:'threw:error:cannot open promise'}]);
  const synchronous = await measure(base.replace('let state = active.get(slot);',
    "if (slot === 61) throw new Proxy({}, { get() { throw Error('unsafe'); } }); let state = active.get(slot);"));
  assert.equal(synchronous.callers.failure[0].actual,'threw:other');
  const nonPromise = await measure(base.replace('let state = active.get(slot);',
    "if (slot === 61) return 0; let state = active.get(slot);"));
  assert.equal(nonPromise.callers.success[0].actual,'non-promise:number:0');
  const primitive = await measure(base.replace('return state.tail.done.promise;',
    "return state.tail.done.promise.catch(() => { throw 'bad'; });"));
  assert.equal(primitive.callers.failure[1].actual,'rejected:string:bad');
});
