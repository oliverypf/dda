import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';

const KINDS = new Set(['history', 'paging', 'queue']);
const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*(?:^|\/)(?:\.git|node_modules)(?:\/|$))[A-Za-z0-9_./-]{1,320}$/u;

const cleanDetail = value => String(value ?? '').replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 600);

function productSpecifier(path, cwd = '.') {
  const normalized = String(path ?? '').replaceAll('\\', '/').replace(/^\.\//u, '');
  if (!SAFE_PATH.test(normalized) || normalized.endsWith('/')) return;
  const base = String(cwd || '.').replaceAll('\\', '/').replace(/^\.\//u, '') || '.';
  const relative = posix.relative(base, normalized);
  if (!relative || relative.startsWith('../') || relative === '..') return './' + normalized;
  return './' + relative;
}

// Each function below also runs inside the candidate copy. Its only dependencies
// are Node builtins and the implementation under test. Each check gets fresh state.
async function migrationChecks({ runCommand }, check, assert) {
  const { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'dda-migration-'));
  const fixture = async (name, verify) => {
    const directory = join(root, name);
    await mkdir(directory);
    const sourceRoot = join(directory, 'archive');
    const targetRoot = join(directory, 'restored');
    await check(name, () => verify({ directory, sourceRoot, targetRoot }));
  };
  const names = async directory => (await readdir(directory)).sort();
  const migrate = (sourceRoot, targetRoot, apply = false) =>
    runCommand('migrate-data', { sourceRoot, targetRoot, apply });

  try {
    await fixture('dryRun', async ({ directory, sourceRoot, targetRoot }) => {
      await mkdir(sourceRoot);
      await writeFile(join(sourceRoot, 'index.txt'), 'record');
      const { code, report } = await migrate(sourceRoot, targetRoot);
      assert.equal(code, 0);
      assert.equal(report.status, 'PLANNED');
      assert.equal(report.filesConsidered, 1);
      assert.equal(report.filesCopied, 0);
      assert.deepEqual(await names(directory), ['archive']);
    });
    await fixture('apply', async ({ directory, sourceRoot, targetRoot }) => {
      const relative = join('chunks', '2025', 'part.dat');
      const bytes = Buffer.from([29, 0, 131, 244, 10]);
      await mkdir(join(sourceRoot, 'chunks', '2025'), { recursive: true });
      await writeFile(join(sourceRoot, relative), bytes);
      await writeFile(join(sourceRoot, 'catalog'), 'catalog-v2\n');
      await mkdir(targetRoot);
      const { code, report } = await migrate(sourceRoot, targetRoot, true);
      assert.equal(code, 0);
      assert.equal(report.status, 'COMPLETED');
      assert.equal(report.filesConsidered, 2);
      assert.equal(report.filesCopied, 2);
      assert.equal(report.digestVerified, true);
      assert.deepEqual(await readFile(join(targetRoot, relative)), bytes);
      assert.equal(await readFile(join(targetRoot, 'catalog'), 'utf8'), 'catalog-v2\n');
      assert.deepEqual(await names(targetRoot), ['catalog', 'chunks']);
    });
    await fixture('occupied', async ({ sourceRoot, targetRoot }) => {
      await mkdir(sourceRoot);
      await writeFile(join(sourceRoot, 'index.txt'), 'record');
      const plugins = join(targetRoot, 'plugins');
      await mkdir(plugins, { recursive: true });
      await writeFile(join(plugins, 'custom.conf'), 'retain settings');
      const { code, report } = await migrate(sourceRoot, targetRoot, true);
      assert.notEqual(code, 0);
      assert.equal(report.status, 'STOPPED');
      assert.equal(report.reason, 'TARGET_NONEMPTY');
      assert.deepEqual(await names(targetRoot), ['plugins']);
      assert.deepEqual(await names(plugins), ['custom.conf']);
      assert.equal(await readFile(join(plugins, 'custom.conf'), 'utf8'), 'retain settings');
    });
    await fixture('health', async ({ directory, sourceRoot, targetRoot }) => {
      const { code, report } = await runCommand('health', { sourceRoot, targetRoot });
      assert.equal(code, 0);
      assert.equal(report.status, 'READY');
      const expected = [join(targetRoot, 'plugins'),
        ...['cache', 'state', 'log', 'config'].map(name => join(directory, 'platform', name))];
      for (const path of expected) assert.ok((await stat(path)).isDirectory());
    });
    await fixture('missing', async ({ directory, sourceRoot, targetRoot }) => {
      const { code, report } = await migrate(sourceRoot, targetRoot, true);
      assert.equal(code, 0);
      assert.equal(report.status, 'NOT_NEEDED');
      assert.equal(report.filesCopied, 0);
      assert.equal(report.digestVerified, true);
      assert.deepEqual(await names(directory), []);
    });
    await fixture('missingArgument', async ({ directory, targetRoot }) => {
      const { code, report } = await runCommand('migrate-data', { targetRoot });
      assert.equal(code, 2);
      assert.equal(report.reason, 'ARGUMENT_INVALID');
      assert.deepEqual(await names(directory), []);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function paginationChecks({ pageEvents }, check, assert) {
  const row = (time, id, channel = 'work') => ({ time, id, channel });
  const matches = (page, expectedItems, cursor) => {
    assert.deepEqual(page.items, expectedItems);
    assert.deepEqual(page.nextCursor, cursor ? { time: cursor.time, id: cursor.id } : null);
  };
  const winter = row(10, 'winter'), jazz = row(14, 'jazz'), lake = row(14, 'lake');
  const amber = row(14, 'amber'), spruce = row(14, 'spruce'), rail = row(17, 'rail');
  const rows = [spruce, winter, jazz, rail, amber, lake];
  await check('ties', () => {
    const first = pageEvents(rows, { limit: 2 });
    matches(first, [rail, amber], amber);
    const second = pageEvents(rows, { limit: 2, after: first.nextCursor });
    matches(second, [jazz, lake], lake);
    matches(pageEvents(rows, { limit: 2, after: second.nextCursor }), [spruce, winter], null);
  });
  await check('oldest', () => {
    const page = pageEvents(rows, { limit: 2, direction: 'oldest', after: { time: 14, id: 'amber' } });
    matches(page, [jazz, lake], lake);
  });
  await check('removed', () => {
    const first = pageEvents(rows, { limit: 3 });
    matches(first, [rail, amber, jazz], jazz);
    const justBefore = row(14, 'birch'), justAfter = row(14, 'kite');
    const changed = [justBefore, justAfter, row(18, 'snow'), ...rows.filter(value => value !== jazz)];
    const next = pageEvents(changed, { limit: 3, after: first.nextCursor });
    matches(next, [justAfter, lake, spruce], spruce);
    matches(pageEvents(changed, { limit: 3, after: next.nextCursor }), [winter], null);
  });
  await check('channel', () => {
    const foreign = row(14, 'kelp', 'home');
    const batch = [...rows, foreign];
    matches(pageEvents(batch, { channel: 'work', after: { time: foreign.time, id: foreign.id }, limit: 2 }), [lake, spruce], spruce);
    matches(pageEvents(batch, { channel: 'work', after: { time: 14, id: 'spruce' }, limit: 2 }), [winter], null);
  });
  await check('input', () => {
    const order = [lake, rail, winter];
    const immutable = Object.freeze(order.slice());
    matches(pageEvents(immutable, { direction: 'oldest', limit: 3 }), [winter, lake, rail], null);
    assert.deepEqual(immutable, order);
  });
}

async function queueChecks({ createRefreshQueue }, check, assert) {
  // Promises control the worker transitions. An observation deadline limits
  // waiting for missing work; when timing alone is inconclusive, request a retest.
  const expired = Symbol('observation deadline');
  const withinWindow = async promise => {
    let timer;
    const deadline = new Promise(resolve => { timer = setTimeout(resolve, 350, expired); });
    try { return await Promise.race([promise, deadline]); }
    finally { clearTimeout(timer); }
  };

  await check('independent', async () => {
    const entered = Promise.withResolvers(), otherEntered = Promise.withResolvers(), release = Promise.withResolvers();
    const request = createRefreshQueue(async (key, revision) => {
      if (key === 'blocked' && revision === 6) {
        entered.resolve(true);
        await release.promise;
      }
      if (key === 'free') otherEntered.resolve(true);
      return key + '/' + revision;
    });
    const first = request('blocked', 6);
    if (await withinWindow(entered.promise) === expired) { release.resolve(); return null; }
    const outcomes = Promise.all([first, request('free', 8), request('blocked', 7)]);
    let independent;
    try { independent = await withinWindow(otherEntered.promise); }
    finally { release.resolve(); }
    const actual = await withinWindow(outcomes);
    if (actual === expired) return null;
    assert.deepEqual(actual, ['blocked/6', 'free/8', 'blocked/7']);
    return independent === expired ? null : true;
  });
  await check('coalesce', async () => {
    const started = Promise.withResolvers(), trailing = Promise.withResolvers();
    const finishFirst = Promise.withResolvers(), finishTrailing = Promise.withResolvers();
    const visits = [];
    let active = 0, maximum = 0;
    const request = createRefreshQueue(async (_key, revision) => {
      visits.push(revision);
      maximum = Math.max(maximum, ++active);
      try {
        if (revision === 11) { started.resolve(true); await finishFirst.promise; }
        if (revision === 15) { trailing.resolve(true); await finishTrailing.promise; }
        return 'v' + revision;
      } finally { active--; }
    });
    try {
      const first = request('index', 11);
      if (await withinWindow(started.promise) === expired) return null;
      const middle = [request('index', 13), request('index', 15)];
      finishFirst.resolve();
      if (await withinWindow(trailing.promise) === expired) return null;
      const last = [request('index', 18), request('index', 27)];
      finishTrailing.resolve();
      const actual = await withinWindow(Promise.all([first, ...middle, ...last]));
      if (actual === expired) return null;
      assert.deepEqual(actual, ['v11', 'v15', 'v15', 'v27', 'v27']);
      assert.deepEqual(visits, [11, 15, 27]);
      assert.equal(maximum, 1);
    } finally { finishFirst.resolve(); finishTrailing.resolve(); }
  });
  for (const leaderFails of [true, false]) {
    await check(leaderFails ? 'leaderFailure' : 'failure', async () => {
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      const error = new Error('worker failure');
      const visits = [];
      const request = createRefreshQueue(async (_key, revision) => {
        visits.push(revision);
        if (revision === 21) { entered.resolve(true); await release.promise; }
        if (revision === (leaderFails ? 21 : 34)) throw error;
        return revision + 1;
      });
      const first = request('archive', 21);
      if (await withinWindow(entered.promise) === expired) { release.resolve(); return null; }
      const pending = Promise.allSettled([first, request('archive', 30), request('archive', 34)]);
      release.resolve();
      const actual = await withinWindow(pending);
      if (actual === expired) return null;
      const rejected = { status: 'rejected', reason: error };
      const fulfilled = value => ({ status: 'fulfilled', value });
      const expected = leaderFails ? [rejected, fulfilled(35), fulfilled(35)] : [fulfilled(22), rejected, rejected];
      assert.deepEqual(actual, expected);
      for (const outcome of actual) if (outcome.status === 'rejected') assert.equal(outcome.reason, error);
      const reuse = await withinWindow(request('archive', 40));
      if (reuse === expired) return null;
      assert.equal(reuse, 41);
      assert.deepEqual(visits, [21, 34, 40]);
    });
  }

  // Mirror the task's independent acceptance suite. The smaller probe above
  // checks the same contract with different values, while these cases keep
  // the exact release and caller timing that the independent harness uses.
  // A candidate that only passes the public two-test assertion must not be
  // accepted when it overlaps a trailing batch or settles callers together.
  const nextTurn = () => new Promise(resolve => setImmediate(resolve));
  await check('externalIndependent', async () => {
    const gate = Promise.withResolvers();
    const calls = [];
    const request = createRefreshQueue(async (key, revision) => {
      calls.push(key + ':' + revision);
      if (key === 'left' && revision === 1) await gate.promise;
      return key + ':' + revision;
    });
    try {
      const left = request('left', 1);
      await nextTurn();
      const right = request('right', 3);
      const again = request('left', 2);
      const settled = Promise.allSettled([left, right, again]);
      await nextTurn();
      const whileBlocked = [...calls];
      gate.resolve();
      const outcomes = await withinWindow(settled);
      if (outcomes === expired) return null;
      assert.deepEqual(whileBlocked, ['left:1', 'right:3']);
      assert.deepEqual(outcomes.map(row => row.value), ['left:1', 'right:3', 'left:2']);
    } finally { gate.resolve(); }
  });
  await check('externalTrailing', async () => {
    const head = Promise.withResolvers();
    const middle = Promise.withResolvers();
    const calls = [];
    let running = 0;
    let highWater = 0;
    const request = createRefreshQueue(async (_key, revision) => {
      calls.push(revision);
      running++;
      highWater = Math.max(highWater, running);
      try {
        if (revision === 1) await head.promise;
        if (revision === 3) await middle.promise;
        return revision;
      } finally { running--; }
    });
    try {
      const first = request('a', 1);
      await nextTurn();
      const second = request('a', 2);
      const third = request('a', 3);
      head.resolve();
      await nextTurn();
      const duringMiddle = [...calls];
      const fourth = request('a', 4);
      const fifth = request('a', 5);
      await nextTurn();
      const beforeRelease = [...calls];
      middle.resolve();
      const values = await withinWindow(Promise.all([first, second, third, fourth, fifth]));
      if (values === expired) return null;
      assert.deepEqual(duringMiddle, [1, 3]);
      assert.deepEqual(beforeRelease, [1, 3]);
      assert.deepEqual(calls, [1, 3, 5]);
      assert.equal(highWater, 1);
      assert.deepEqual(values, [1, 3, 3, 5, 5]);
    } finally { head.resolve(); middle.resolve(); }
  });
  await check('externalLeaderFailure', async () => {
    const gate = Promise.withResolvers();
    const error = new Error('rebuild unavailable');
    const calls = [];
    const request = createRefreshQueue(async (_key, value) => {
      calls.push(value);
      if (value === 0) { await gate.promise; throw error; }
      return value * 10;
    });
    try {
      const first = request('x', 0);
      await nextTurn();
      const pending = Promise.allSettled([first, request('x', 2), request('x', 4)]);
      gate.resolve();
      const outcomes = await withinWindow(pending);
      if (outcomes === expired) return null;
      const [a, b, c] = outcomes;
      assert.equal(a.status, 'rejected');
      assert.equal(a.reason, error);
      assert.deepEqual([b, c], [{ status: 'fulfilled', value: 40 }, { status: 'fulfilled', value: 40 }]);
      assert.deepEqual(calls, [0, 4]);
    } finally { gate.resolve(); }
  });
  await check('externalTrailingFailure', async () => {
    const gate = Promise.withResolvers();
    const error = new Error('bad revision');
    const calls = [];
    const request = createRefreshQueue(async (_key, value) => {
      calls.push(value);
      if (value === 'base') await gate.promise;
      if (value === 'invalid') throw error;
      return value;
    });
    try {
      const leader = request('x', 'base');
      await nextTurn();
      const pending = Promise.allSettled([leader, request('x', 'superseded'), request('x', 'invalid')]);
      gate.resolve();
      const outcomes = await withinWindow(pending);
      if (outcomes === expired) return null;
      const [a, b, c] = outcomes;
      assert.deepEqual(a, { status: 'fulfilled', value: 'base' });
      assert.deepEqual([b.status, c.status], ['rejected', 'rejected']);
      assert.equal(b.reason, error);
      assert.equal(c.reason, error);
      assert.equal(await withinWindow(request('x', 'valid')), 'valid');
      assert.deepEqual(calls, ['base', 'invalid', 'valid']);
    } finally { gate.resolve(); }
  });
  await check('externalRollback', async () => {
    const gate = Promise.withResolvers();
    const calls = [];
    const request = createRefreshQueue(async (_key, revision) => {
      calls.push(revision);
      if (revision === 5) await gate.promise;
      return revision + 100;
    });
    try {
      const first = request('x', 5);
      await nextTurn();
      const all = Promise.all([first, request('x', 12), request('x', 2)]);
      gate.resolve();
      const values = await withinWindow(all);
      if (values === expired) return null;
      assert.deepEqual(values, [105, 102, 102]);
      assert.deepEqual(calls, [5, 2]);
    } finally { gate.resolve(); }
  });
  await check('rollback', async () => {
    const started = Promise.withResolvers(), release = Promise.withResolvers();
    const revisions = [];
    const request = createRefreshQueue(async (_key, revision) => {
      revisions.push(revision);
      if (revision === 55) { started.resolve(true); await release.promise; }
      return revision;
    });
    const head = request('counter', 55);
    if (await withinWindow(started.promise) === expired) { release.resolve(); return null; }
    const pending = Promise.all([head, request('counter', 89), request('counter', 23)]);
    release.resolve();
    const actual = await withinWindow(pending);
    if (actual === expired) return null;
    assert.deepEqual(actual, [55, 23, 23]);
    assert.deepEqual(revisions, [55, 23]);
  });
}

async function measureTask(run, product, marker) {
  const assert = (await import('node:assert/strict')).default;
  const checks = {};
  const details = {};
  await run(product, async (name, observe) => {
    try { checks[name] = await observe() === null ? null : true; }
    catch (error) {
      checks[name] = false;
      const detail = String(error?.message ?? error).replace(/[\u0000-\u001f\u007f\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 800);
      if (detail) details[name] = detail;
    }
  }, assert);
  const outcomes = Object.values(checks);
  const status = outcomes.includes(false) ? 'failed' : outcomes.includes(null) ? 'unverified' : 'passed';
  process.stdout.write(marker + JSON.stringify({ status, checks, ...(Object.keys(details).length ? { details } : {}) }) + '\n');
  if (status === 'failed') process.exitCode = 1;
}

function probeSource(kind, specifier, marker) {
  const probe = { history: migrationChecks, paging: paginationChecks, queue: queueChecks }[kind];
  return measureTask.toString() + '\n' + probe.toString() + '\n'
    + 'await measureTask(' + probe.name + ', await import(' + JSON.stringify(specifier) + '), '
    + JSON.stringify(marker) + ');\n';
}

/**
 * Build a trusted pre-write acceptance hook for one of the frozen task
 * classes. The hook receives only candidate-copy helpers from RepairRetest.
 * The model cannot choose the task kind, module path, probe source, or checks.
 */
export function createTaskAcceptanceHook({ kind, productPath, timeoutMs = 8_000 } = {}) {
  if (!KINDS.has(kind)) throw new TypeError('TASK_ACCEPTANCE_KIND');
  const fixedPath = productSpecifier(productPath);
  if (productPath !== undefined && !fixedPath) throw new TypeError('TASK_ACCEPTANCE_PATH');
  return async ({ cwd, candidate, baseline, run, writeProbe }) => {
    if (baseline) return { status: 'passed', checks: { baseline: true } };
    if (typeof run !== 'function' || typeof writeProbe !== 'function') return { status: 'unverified', detail: 'Candidate probe helpers unavailable.' };
    const specifier = fixedPath ?? productSpecifier(candidate?.path, cwd);
    if (!specifier) return { status: 'unverified', detail: 'Candidate product path is unavailable.' };
    const marker = `DDA_TASK_ACCEPT_${randomBytes(16).toString('hex')}=`;
    try {
      const probe = await writeProbe(probeSource(kind, specifier, marker));
      const result = await run({ command: 'node', args: [probe], cwd, timeoutMs, maxOutputBytes: 48 * 1024 });
      const line = String(result?.stdout ?? '').split(/\r?\n/u).find(value => value.startsWith(marker));
      let receipt;
      try { receipt = line ? JSON.parse(line.slice(marker.length)) : undefined; } catch { receipt = undefined; }
      if (!receipt || !['passed', 'failed', 'unverified'].includes(receipt.status)) return { status: 'unverified', detail: cleanDetail(result?.stderr || result?.stdout || 'Probe returned no receipt.') };
      return { status: receipt.status, checks: receipt.checks, ...(receipt.detail ? { detail: cleanDetail(receipt.detail) } : {}) };
    } catch (error) {
      return { status: 'unverified', detail: cleanDetail(error) };
    }
  };
}

export const taskAcceptanceKinds = Object.freeze([...KINDS]);
