import { parse } from 'acorn';
import { posix } from 'node:path';

// The visible test establishes coalescing. Serialization and recovery must
// also be part of the task's requested behavior before replay can enforce them.
export function asyncQueueContract(prompt) {
  if (typeof prompt !== 'string') return false;
  const text = prompt.toLowerCase().replace(/\s+/g, ' ');
  const conflicting = /(?:do not|never|must not|cannot) (?:coalesce|merge)|(?:same[ -]key|same key workers?)[^.;]{0,20} (?:must|should|may|can) (?:run in parallel|overlap)|every (?:revision|request) must (?:execute|run) separately|不(?:要|得|应|允许)?(?:合并|串行)|允许.{0,5}(?:同键并行|同键.{0,2}重叠)|失败后(?:必须|应)?(?:停止|丢弃)/u;
  if (conflicting.test(text)) return false;
  const keyed = /\b(?:same|each|per)[ -]key\b|\bfor (?:a|the) key\b|同键|同一.{0,4}键|每个?键/u.test(text);
  const serial = /at most one|one .{0,25}at a time|serial|no overlap|not overlap|never overlap|cannot overlap|without overlap|不.{0,4}重叠|串行/u.test(text);
  const latest = /most recently requested|latest|most recent|newest|最新/u.test(text);
  const batch = /coalesc|trailing|批次|尾随|合并/u.test(text);
  const recover = /(?:fail|reject|error).{0,120}(?:pending|future|continue|recover|usable|next)|(?:recover|continue|usable).{0,50}(?:fail|reject|error)|失败.{0,35}(?:继续|恢复|后续|再次)/u.test(text);
  return keyed && serial && latest && batch && recover;
}

function walk(root) {
  const pending = [root], all = [];
  while (pending.length) {
    const node = pending.pop();
    if (!node?.type) continue;
    all.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value?.type) pending.push(value);
    }
  }
  return all;
}

function member(node, method) {
  return node?.type === 'MemberExpression' && !node.computed && node.property.name === method
    ? node.object.name : undefined;
}

function declarations(body) {
  return body.filter(n => n.type === 'VariableDeclaration').flatMap(n => n.declarations)
    .filter(d => d.id.type === 'Identifier');
}

export function asyncQueuePlan(testPath, source, assertionLine) {
  if (typeof source !== 'string' || source.length > 256 * 1024 || !Number.isInteger(assertionLine)) return;
  let tree;
  try { tree = parse(source, { sourceType:'module', ecmaVersion:'latest', locations:true }); }
  catch { return; }
  const testers = new Set(), asserts = new Set(), factories = new Map();
  for (const node of tree.body.filter(n => n.type === 'ImportDeclaration')) {
    const specifier = node.source.value;
    for (const spec of node.specifiers) {
      const exported = spec.imported?.name ?? (spec.type === 'ImportDefaultSpecifier' ? 'default' : undefined);
      if (specifier === 'node:test' && ['test','it','default'].includes(exported)) testers.add(spec.local.name);
      if (['node:assert','node:assert/strict'].includes(specifier) && ['default','strict'].includes(exported)) asserts.add(spec.local.name);
      if (!/^\.{1,2}\/[A-Za-z0-9_./-]+\.(?:mjs|js)$/u.test(specifier) || !/^[A-Za-z_$][\w$]*$/u.test(exported ?? '')) continue;
      const path = posix.normalize(posix.join(posix.dirname(testPath), specifier));
      if (!path.startsWith('../') && !posix.isAbsolute(path)) factories.set(spec.local.name, { path, specifier, exportName:exported });
    }
  }
  const plans = [];
  for (const statement of tree.body) {
    const call = statement.expression;
    if (call?.type !== 'CallExpression' || !testers.has(call.callee.name)) continue;
    const test = call.arguments.at(-1);
    if (!test?.async || test.body.type !== 'BlockStatement') continue;
    const body = test.body.body, vars = declarations(body);
    const assertion = body.map(n => n.expression).find(n => n?.type === 'CallExpression' &&
      n.loc.start.line === assertionLine && (asserts.has(member(n.callee,'equal')) || asserts.has(member(n.callee,'strictEqual'))));
    if (!assertion || assertion.arguments[1]?.type !== 'Literal') continue;
    const projected = vars.find(d => d.id.name === assertion.arguments[0]?.name)?.init ?? assertion.arguments[0];
    const log = member(projected?.callee,'join');
    const sep = projected?.arguments?.[0]?.value ?? ',';
    if (!log || typeof sep !== 'string' || !vars.some(d => d.id.name === log && d.init?.type === 'ArrayExpression' && !d.init.elements.length)) continue;
    const deferreds = new Set(vars.filter(d => member(d.init?.callee, 'withResolvers') === 'Promise').map(d => d.id.name));
    for (const d of vars) {
      const factory = factories.get(d.init?.callee?.name), worker = d.init?.arguments?.[0];
      if (!factory || d.init.arguments.length !== 1 || !worker?.async || worker.params?.length !== 2 ||
          worker.params.some(n => n.type !== 'Identifier')) continue;
      const work = walk(worker.body);
      if (!work.some(n => member(n.callee,'push') === log && n.arguments[0]?.name === worker.params[1].name)) continue;
      const submits = vars.filter(v => v.init?.callee?.name === d.id.name).map(v => v.init);
      if (submits.length !== 3 || submits.some(n => n.arguments.length !== 2 || n.arguments.some(a => a.type !== 'Literal'))) continue;
      const keys = submits.map(n => n.arguments[0].value), revisions = submits.map(n => n.arguments[1].value);
      const keyType = typeof keys[0], revisionType = typeof revisions[0];
      if (!['string','number'].includes(keyType) || !['string','number'].includes(revisionType) ||
          keys.some(k => k !== keys[0]) || revisions.some(r => typeof r !== revisionType) ||
          new Set(revisions).size !== 3 || assertion.arguments[1].value !== [revisions[0],revisions[2]].join(sep)) continue;
      const started = body.filter(n => n.start > submits[0].end && n.end < submits[1].start)
        .map(n => member(n.expression?.argument,'promise')).find(name => deferreds.has(name));
      const release = body.filter(n => n.start > submits[2].end && n.end < assertion.start)
        .map(n => member(n.expression?.callee,'resolve')).find(name => deferreds.has(name));
      if (!started || !release || started === release ||
          !work.some(n => n.type === 'CallExpression' && member(n.callee,'resolve') === started) ||
          !work.some(n => n.type === 'AwaitExpression' && member(n.argument,'promise') === release)) continue;
      plans.push({ ...factory, keyType, revisionType });
    }
  }
  return plans.length === 1 ? plans[0] : undefined;
}

function queueValues(revisionType) {
  return revisionType === 'number' ? [11,29,13,37,17,41] : ['p','z','q','y','r','w'];
}

export function asyncQueueSchedule(revisionType) {
  if (revisionType !== 'number' && revisionType !== 'string') return;
  const tokens = queueValues(revisionType).map(value => 'value:' + value);
  function rows(definitions) {
    return definitions.map(([request, batch, outcome], i) => ({
      caller:i + 1, batch, requested:tokens[request], expected:outcome === null ? 'rejected:worker' : tokens[outcome]
    }));
  }
  return {
    success:rows([[0,1,0], [1,2,2], [2,2,2], [3,3,4], [4,3,4]]),
    failure:rows([[0,1,0], [1,2,null], [2,2,null], [4,3,4]])
  };
}

// This function runs entirely inside the existing authorized test process.
// A held worker decides when a phase may finish. Time only bounds what we can
// observe, and a non-settlement is reported explicitly as such.
async function measureQueue(factory, plan, turn, delay, types) {
  const key = plan.keyType === 'number' ? 61 : 'probe-key';
  const spare = plan.keyType === 'number' ? 62 : 'probe-spare';
  const { values, schedule } = plan;
  const checks = { serial:null, latest:null, reuseAfterFailure:null };
  const callers = { success:[], failure:[] };
  const detail = { progressWindowMs:300, holdWindowMs:24 };
  const waitLimit = Symbol();
  async function bounded(promise, ms = detail.progressWindowMs) {
    const cancel = new AbortController();
    try { return await Promise.race([promise, delay(ms, waitLimit, { signal:cancel.signal })]); }
    finally { cancel.abort(); }
  }
  const safeText = value => typeof value === 'string' && value.length <= 32 && /^[A-Za-z0-9 _.,!?-]{1,32}$/u.test(value);
  function fulfilled(value) {
    if (values.includes(value)) return 'value:' + value;
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'boolean') return 'boolean:' + value;
    if (Number.isFinite(value)) return 'number:' + (Object.is(value,-0) ? '-0' : value);
    if (safeText(value)) return 'string:' + value;
    return 'other:' + typeof value;
  }
  function errorToken(prefix, error) {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
      return prefix + ':' + fulfilled(error);
    }
    if (!types.isProxy(error) && types.isNativeError(error)) {
      const message = Object.getOwnPropertyDescriptor(error, 'message')?.value;
      if (safeText(message)) return prefix + ':error:' + message;
    }
    return prefix + ':other';
  }
  function fixture(scenario) {
    const starts = [], active = new Map(), gates = values.map(() => Promise.withResolvers());
    const entered = values.map(() => Promise.withResolvers());
    const failure = new Error('synthetic worker rejection');
    let overlap = false;
    const enqueue = factory(async (id, value) => {
      const i = values.indexOf(value);
      if (i < 0 || starts.length > 16) throw Error('unsupported callback');
      starts.push(i);
      active.set(id, (active.get(id) ?? 0) + 1);
      if (active.get(id) > 1) overlap = true;
      entered[i].resolve();
      try {
        await gates[i].promise;
        if (scenario === 'failure' && i === 2) throw failure;
        return value;
      } finally { active.set(id, active.get(id)-1); }
    });
    // Track each submission immediately so a stuck sibling cannot erase
    // already-settled callers. Copy rows when their observation window closes.
    const snapshot = () => { callers[scenario] = callers[scenario].map(row => ({ ...row })); };
    const submit = (i, id = key) => {
      let row;
      if (id === key) {
        row = { ...schedule[scenario][callers[scenario].length], actual:'pending' };
        callers[scenario].push(row);
      }
      const record = token => { if (row) row.actual = token; return token; };
      let result, then;
      try {
        result = enqueue(id, values[i]);
        then = result?.then;
      } catch (error) { record(errorToken('threw', error)); throw error; }
      if (typeof then !== 'function') { record('non-promise:' + fulfilled(result)); throw Error('unsupported return'); }
      // Read the public then protocol once. Native resolution recursively
      // unwraps any nested promise and ignores repeated settlements.
      const settled = types.isPromise(result) && then === Promise.prototype.then ? result :
        Promise.resolve({ then(resolve, reject) { Reflect.apply(then, result, [resolve, reject]); } });
      return Promise.prototype.then.call(settled,
        v => record(fulfilled(v)), e => record(e === failure ? 'rejected:worker' : errorToken('rejected',e)));
    };
    return { submit, starts, overlap:() => overlap, release:i => gates[i].resolve(),
      started:async i => await bounded(entered[i].promise) !== waitLimit, snapshot,
      cleanup:() => { snapshot(); gates.forEach(g => g.resolve()); } };
  }
  const matches = (token, i) => token === 'value:' + values[i];
  const order = (starts, expected) => starts.length === expected.length && starts.every((v,i) => v === expected[i]);
  // Allow queued microtasks, immediate jobs and short timer dispatches to run
  // while the leading callback is still demonstrably blocked.
  async function drain() { await turn(); await delay(detail.holdWindowMs); await turn(); }
  async function serialAndLatest() {
    const f = fixture('success');
    try {
      const lead = f.submit(0);
      if (!await f.started(0)) { detail.serial = 'leader_not_observed'; return; }
      const a = f.submit(1), b = f.submit(2);
      await drain();
      const firstHeld = order(f.starts,[0]);
      if (f.overlap()) { checks.serial = false; detail.serial = 'concurrent_same_key'; }
      f.release(0);
      if (!await f.started(2)) {
        if (f.starts.includes(1)) checks.latest = false;
        detail.latest = 'latest_worker_not_started_by_deadline'; return;
      }
      const c = f.submit(3), d = f.submit(4);
      await drain();
      const secondHeld = order(f.starts,[0,2]);
      if (f.overlap()) { checks.serial = false; detail.serial = 'concurrent_same_key'; }
      f.release(2);
      const nextStarted = await f.started(4);
      f.release(4);
      const result = await bounded(Promise.all([lead,a,b,c,d]));
      if (checks.serial === null && (firstHeld && secondHeld && nextStarted)) checks.serial = !f.overlap();
      if (nextStarted && result !== waitLimit) {
        checks.latest = order(f.starts,[0,2,4]) && [0,2,2,4,4].every((n,i) => matches(result[i],n));
      } else if (f.starts.includes(1) || f.starts.includes(3) || result !== waitLimit) {
        checks.latest = false;
      }
      if (checks.latest !== true) detail.latest = !nextStarted ? 'next_batch_not_started_by_deadline'
        : result === waitLimit ? 'caller_pending_at_deadline' : 'order_or_caller_results_differ';
    } finally { f.cleanup(); }
  }
  async function failureAndReuse() {
    const f = fixture('failure');
    try {
      const lead = f.submit(0);
      if (!await f.started(0)) { detail.reuseAfterFailure = 'leader_not_observed'; return; }
      const a = f.submit(1), b = f.submit(2);
      f.release(0);
      if (!await f.started(2)) { detail.reuseAfterFailure = 'trailing_worker_not_observed'; return; }
      f.release(2);
      let didSubmit = false, reuse, control;
      function submitReuse() {
        if (didSubmit) return;
        didSubmit = true;
        f.snapshot();
        reuse = f.submit(4);
        control = f.submit(5,spare);
        f.release(4); f.release(5);
      }
      // A real caller may reuse the key in its first reaction to settlement.
      // Observing a timeout or flushing the scheduler first can hide a stale
      // promise that would have been returned at that instant.
      const batch = await bounded(Promise.all([lead,a,b]).then(rows => { submitReuse(); return rows; }));
      const batchOK = batch !== waitLimit && matches(batch[0],0) && batch.slice(1).every(x => x === 'rejected:worker');
      if (batch === waitLimit) detail.reuseAfterFailure = 'failed_batch_pending_at_deadline';
      else if (!batchOK) {
        checks.reuseAfterFailure = false;
        detail.reuseAfterFailure = 'failed_batch_did_not_settle_as_requested';
      }
      // A fresh-key control establishes that this factory's scheduler can run
      // another worker in this window even if the previously failed key stalls.
      if (!didSubmit) submitReuse();
      if (!matches(await bounded(control),5)) { detail.reuseAfterFailure ??= 'fresh_key_control_not_observed'; return; }
      const result = await bounded(reuse);
      if (!batchOK) return;
      checks.reuseAfterFailure = matches(result,4) && f.starts.includes(4);
      if (!checks.reuseAfterFailure) detail.reuseAfterFailure = result === waitLimit
        ? 'same_key_pending_after_failure_at_deadline' : 'same_key_did_not_run_or_wrong_outcome';
    } finally { f.cleanup(); }
  }
  try { await serialAndLatest(); } catch { detail.serial ??= 'schedule_unverified'; }
  try { await failureAndReuse(); } catch { detail.reuseAfterFailure ??= 'schedule_unverified'; }
  const status = Object.values(checks).includes(false) ? 'violated'
    : Object.values(checks).every(v => v === true) ? 'observed' : 'unverified';
  return { kind:'asyncQueue', status, checks, detail, callers };
}

export function asyncQueueInstrumentation(plan, marker) {
  if (!/^DDA_[A-Z_]+[0-9a-f]{16,64}=$/u.test(marker)) throw Error('INVALID_QUEUE_PROBE_MARKER');
  const alias = '__ddaQueue' + marker.slice(0,-1).split('_').at(-1);
  const probe = { keyType:plan.keyType, values:queueValues(plan.revisionType), schedule:asyncQueueSchedule(plan.revisionType) };
  return `\nimport { ${plan.exportName} as ${alias}Factory } from ${JSON.stringify(plan.specifier)};
import { after as ${alias}After } from 'node:test';
import { setImmediate as ${alias}Turn, setTimeout as ${alias}Delay } from 'node:timers/promises';
import * as ${alias}Types from 'node:util/types';
${alias}After(async () => {
  const receipt = await (${measureQueue.toString()})(${alias}Factory,${JSON.stringify(probe)},${alias}Turn,${alias}Delay,${alias}Types);
  process.stdout.write(${JSON.stringify(marker)} + JSON.stringify(receipt) + '\\n');
});\n`;
}
