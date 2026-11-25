import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { instrumentPreservation, preservationConsumer, preservationPlan, preservationRuntime } from './repair-preservation.mjs';
import { instrumentRecordInputs, recordPreservationPlan, recordPreservationRuntime } from './repair-record-preservation.mjs';
import { asyncQueueInstrumentation } from './repair-async-queue.mjs';

const MAX_FILES = 384;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_PROBE_BYTES = 256 * 1024;
const PREFIX = '.dda-candidate-';
const fail = reason => { throw new Error(`CANDIDATE_${reason}`); };
const escaped = rel => rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);

// Only wrap an intact, synchronous chain of single-argument calls. Parsing
// prevents source-like comments, template strings or partial lines becoming
// instrumentation. The original calls and their lexical receiver stay intact.
function producerExpressions(text, fields) {
  const tree = parse(text, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const matches = [], names = new Set(), literals = new Set();
  const stack = [[tree, '']];
  while (stack.length) {
    const [node, scope] = stack.pop();
    if (node.type === 'Identifier' && names.size < 2000) names.add(node.name);
    if (node.type === 'Literal' && typeof node.value === 'string' && /^[A-Za-z_$][A-Za-z0-9_$.-]{0,47}$/u.test(node.value) && literals.size < 512) literals.add(node.value);
    const field = node.type === 'Property' && !node.computed && node.kind === 'init' ? node.key.name
      : node.type === 'VariableDeclarator' ? node.id.name : undefined;
    if (fields.has(field)) {
      const call = node.value ?? node.init;
      let input = call;
      while (input?.type === 'CallExpression' && !input.optional && input.arguments.length === 1 &&
          input.callee.type === 'Identifier' && input.callee.name !== 'eval') input = input.arguments[0];
      let base = input;
      while (base?.type === 'MemberExpression' && !base.optional && !base.computed && base.property.type === 'Identifier') base = base.object;
      if (call !== input && base?.type === 'Identifier' && node.loc.start.line === call.loc.end.line) {
        matches.push({ field, scope, line: node.loc.start.line, call, input });
      }
    }
    const owner = node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' ? node.id?.name
      : node.type === 'VariableDeclarator' && ['ArrowFunctionExpression','FunctionExpression'].includes(node.init?.type) ? node.id?.name
      : node.type === 'MethodDefinition' && !node.computed ? node.key.name : undefined;
    const nextScope = owner ? scope + '/' + owner : scope;
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) stack.push([child, nextScope]);
      } else if (value?.type) stack.push([value, nextScope]);
    }
  }
  return { matches, names, literals };
}

function wrapProducers(path, original, digest, current, proposed, helper, traceName, registry) {
  const sites = proposed.filter(s => s?.path === path && s.digest === digest && Number.isSafeInteger(s.line) &&
    s.line > 0 && typeof s.sourceLine === 'string' && typeof s.field === 'string');
  if (!sites.length) return current;
  let oldTree, tree;
  try {
    const fields = new Set(sites.map(s => s.field));
    oldTree = producerExpressions(original, fields);
    tree = current === original ? oldTree : producerExpressions(current, fields);
  } catch { return current; }
  const lines = original.split(/\r?\n/u);
  const edits = [];
  for (const site of sites) {
    if (lines[site.line - 1] !== site.sourceLine) continue;
    const old = oldTree.matches.filter(m => m.field === site.field && m.line === site.line);
    if (old.length !== 1) continue;
    if (current !== original && oldTree.matches.filter(m => m.field === site.field && m.scope === old[0].scope).length !== 1) continue;
    const candidates = current === original ? old : tree.matches.filter(m => m.field === site.field && m.scope === old[0].scope);
    if (candidates.length !== 1) continue;
    const { call, input, line } = candidates[0];
    if (edits.some(e => e.start < call.end && call.start < e.end)) continue;
    const index = registry.length;
    registry.push({ path, field: site.field, line, names: [...tree.names], literals: [...tree.literals] });
    const param = traceName + 'Input';
    const wrapped = current.slice(call.start, input.start) + param + '(' + current.slice(input.start, input.end) + ')' + current.slice(input.end, call.end);
    edits.push({ start: call.start, end: call.end, text: `${traceName}(${index}, ${param} => ${wrapped})` });
  }
  if (!edits.length) return current;
  let result = current;
  for (const edit of edits.sort((a,b) => b.start-a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result + `\nimport { capture as ${traceName} } from ${JSON.stringify(helper)};\n`;
}

// Emitted inside the copy. Keep only bounded primitive fingerprints. Opaque
// data can disambiguate two snapshots in memory without exposing its contents.
function buildTrace(registry, isProxy, createHmac, salt) {
  const sites = registry.map(s => ({ ...s, known: new Set([...s.names, ...s.literals]), labels: new Set(s.literals), values: new Map() }));
  const privateKey = /secret|passw|passwd|token|credential|private.?key|api.?key|authorization|cookie|session.?id/i;
  const fingerprint = value => createHmac('sha256', salt).update(value).digest('hex');
  const missing = { missing: true };
  let count = 0, disabled = false;
  function snapshot(value, site) {
    let nodes = 0;
    const leaves = new Map(), seen = new Set();
    function walk(v, key, path, depth) {
      if (++nodes > 640 || depth > 9) throw new Error();
      const type = typeof v;
      if (v !== null && type === 'object') {
        if (isProxy(v) || seen.has(v)) throw new Error();
        const proto = Object.getPrototypeOf(v);
        if (proto !== null && proto !== Object.prototype && proto !== Array.prototype) throw new Error();
        seen.add(v);
        const keys = Reflect.ownKeys(v);
        if (keys.length > 192 || keys.some(k => typeof k !== 'string' || k.length > 180)) throw new Error();
        const array = Array.isArray(v);
        const container = array ? 'array' : 'object';
        leaves.set(key, { signature: container, path, display: { type: container } });
        for (const k of keys.sort()) {
          const d = Object.getOwnPropertyDescriptor(v,k);
          if (!d.enumerable && array && k === 'length') {
            walk(d.value, key + '/length', path && [...path,'length'], depth+1);
            continue;
          }
          if (!d.enumerable || !Object.hasOwn(d,'value')) throw new Error();
          const safe = path && !privateKey.test(k) && (site.known.has(k) || (array && /^\d{1,3}$/u.test(k)));
          walk(d.value, key + '/' + fingerprint(k), safe ? [...path,k] : null, depth+1);
        }
        seen.delete(v);
        return;
      }
      if (!['undefined','string','number','boolean'].includes(type) && v !== null) throw new Error();
      if (type === 'string' && v.length > 4096) throw new Error();
      let display = { type };
      if (v === null || type === 'boolean' || (type === 'number' && Number.isSafeInteger(v) && Math.abs(v) <= 16)) display = v;
      else if (type === 'string' && site.labels.has(v) && /^[a-z][a-z_-]{0,15}$/u.test(v) && !privateKey.test(v)) display = v;
      const encoded = Object.is(v, -0) ? '-0' : String(v);
      leaves.set(key, { signature: type + ':' + fingerprint(encoded), path, display });
    }
    walk(value,'',[],0);
    return leaves;
  }
  const same = (a,b) => a.size === b.size && [...a].every(([k,v]) => b.get(k)?.signature === v.signature);
  function capture(index, evaluate) {
    const site = sites[index];
    let data;
    const result = evaluate(value => {
      try { if (!disabled) data = snapshot(value, site); } catch { /* opaque input */ }
      return value;
    });
    try {
      if (++count > 512) disabled = true;
      if (!disabled && ['string','number','boolean'].includes(typeof result) && (typeof result !== 'string' || result.length <= 512)) {
        if (!site.values.has(result)) site.values.set(result,data);
        else {
          const old = site.values.get(result);
          if (!old || !data || !same(old,data)) site.values.set(result,undefined);
        }
        if (site.values.size > 48) disabled = true;
      }
    } catch { disabled = true; }
    return result;
  }
  function difference(a,b) {
    if (disabled || Object.is(a,b)) return;
    const possible = sites.filter(s => s.values.has(a) || s.values.has(b));
    if (possible.length !== 1) return;
    const site = possible[0], left = site.values.get(a), right = site.values.get(b);
    if (!left || !right) return;
    const differences = [];
    let truncated = false;
    for (const key of new Set([...left.keys(),...right.keys()])) {
      const x = left.get(key), y = right.get(key);
      if (x?.signature === y?.signature) continue;
      const path = (x ?? y).path;
      if (!path || differences.length >= 8) { truncated = true; continue; }
      // When a whole object appears, show the changed leaves rather than all
      // its keys, including unrelated or private members.
      if ((!x || !y) && ['array','object'].includes((x ?? y).signature)) continue;
      differences.push({ path, before: x ? x.display : missing, after: y ? y.display : missing });
    }
    if (differences.length) return { path: site.path, line: site.line, field: site.field, differences, truncated };
  }
  return { capture, difference };
}

function localPath(root, value, allowRoot = false) {
  if (typeof value !== 'string' || /[\0:]/u.test(value) || isAbsolute(value) || win32.isAbsolute(value)) fail('PATH');
  const path = relative(root, resolve(root, value));
  if ((!path && !allowRoot) || escaped(path) || path.split(sep).some(part => /^\.git$|^node_modules$|^\.dda-candidate-/iu.test(part))) fail('PATH');
  return path.split(sep).join('/');
}

async function readText(workspace, path, size, signal) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) fail('FILE_LIMIT');
  let content = '', digest;
  for (;;) {
    signal?.throwIfAborted();
    const page = await workspace.read(path, undefined, content.length);
    if (page.path !== path || page.sizeBytes !== size || typeof page.content !== 'string' || !page.digest ||
        (digest && page.digest !== digest) || page.format) fail('SOURCE_CHANGED_OR_UNSUPPORTED');
    digest = page.digest;
    content += page.content;
    if (content.length > size || (page.truncated && !page.content)) fail('READ_LIMIT');
    if (!page.truncated) break;
  }
  if ('sha256:' + createHash('sha256').update(content).digest('hex') !== digest) fail('NON_UTF8_OR_SOURCE_CHANGED');
  return { content, digest };
}

// This function is emitted only into the temporary test module. Preserve the
// receiver, the already-resolved function, the rest arguments and its exception.
function evaluateAssertion(marker, difference, expectedReceiver, receiver, fn, ...args) {
  if (receiver !== expectedReceiver || args.length < 2) throw new Error('CANDIDATE_ASSERTION_BINDING');
  const summarize = value => {
    if (typeof value === 'string') return value.length <= 180 ? value : { type: 'string', prefix: value.slice(0, 180), length: value.length };
    if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0) ? value : { type: 'number', value: Object.is(value, -0) ? '-0' : String(value) };
    if (typeof value === 'boolean' || value === null) return value;
    // Avoid invoking toJSON, coercion, getters or user inspection hooks.
    return { type: typeof value };
  };
  const emit = passed => {
    const count = evaluateAssertion.count = (evaluateAssertion.count ?? 0) + 1;
    if (count > 17) return;
    const evidence = count === 17 ? { passed: false, overflow: true, operands: [] }
      : { passed, operands: [summarize(args[0]), summarize(args[1])] };
    if (!passed && count < 17 && difference) {
      try { evidence.producerInputs = difference(args[0],args[1]); } catch { /* Preserve the original assertion. */ }
    }
    process.stdout.write(marker + JSON.stringify(evidence) + '\n');
  };
  let result;
  try { result = Reflect.apply(fn, receiver, args); }
  catch (error) { emit(false); throw error; }
  emit(true);
  return result;
}

function instrument(source, line, marker, helper) {
  const lines = source.split('\n');
  const match = /^(\s*)([$\w]+)\.(equal|strictEqual|deepEqual|deepStrictEqual|notEqual|notStrictEqual|notDeepEqual|notDeepStrictEqual)\((.*)\);?\s*$/u.exec(lines[line - 1] ?? '');
  if (!Number.isSafeInteger(line) || line < 1 || !match) fail('UNSUPPORTED_ASSERTION');
  const [, space, binding, method, args] = match;
  if (args.includes(';') || args.includes('//')) fail('AMBIGUOUS_ASSERTION_LINE');
  const imports = [...source.matchAll(/^\s*import\s+(?:(\*\s+as)\s+)?([$\w]+)\s+from\s+(['"])(node:assert(?:\/strict)?|assert(?:\/strict)?)\3\s*;?\s*$/gmu)];
  const original = imports.find(m => m[2] === binding);
  if (!original) fail('UNSUPPORTED_ASSERT_IMPORT');
  const unique = marker.replace(/[^a-zA-Z0-9_]/gu, '');
  const receiver = unique + 'Receiver';
  const difference = helper ? unique + 'Difference' : 'undefined';
  lines[line - 1] = `${space}${unique}Check(${JSON.stringify(marker)}, ${difference}, ${receiver}, ${binding}, ${binding}.${method}, ${args});`;
  // Append declarations to retain the source line of the original failing call.
  return lines.join('\n') + `\nimport ${original[1] ? '* as ' : ''}${receiver} from ${JSON.stringify(original[4])};\n` +
    (helper ? `import { difference as ${difference} } from ${JSON.stringify(helper)};\n` : '') +
    evaluateAssertion.toString().replaceAll('evaluateAssertion', unique + 'Check') + '\n';
}

// Node resolves packages by walking ancestor directories. Guard the candidate
// module graph so omitted dependencies cannot resolve out of the private copy.
function bootSource(source, root) {
  return `import { registerHooks, isBuiltin } from 'node:module';
import { realpathSync } from 'node:fs';
import { relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = realpathSync(${JSON.stringify(root)});
const target = new URL(import.meta.url);
target.search = 'dda-candidate-source=1';
registerHooks({
  resolve(specifier, context, next) {
    const result = next(specifier, context);
    if (isBuiltin(result.url)) return result;
    if (!result.url.startsWith('file:')) throw new Error('CANDIDATE_MODULE_OUTSIDE_COPY');
    const path = relative(root, realpathSync(fileURLToPath(result.url)));
    if (path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) throw new Error('CANDIDATE_MODULE_OUTSIDE_COPY');
    return result;
  },
  load(url, context, next) {
    if (url === target.href) return { format: 'module', source: ${JSON.stringify(source)}, shortCircuit: true };
    return next(url, context);
  }
});
await import(target.href);
`;
}

export async function withCandidateWorkspace({ workspace, targetPath, targetDigest, assertionLine, candidatePath, candidateContent, producerSites = [], preservation, asyncQueuePlan, cwd = '.', signal }, run) {
  const baseline = candidatePath === undefined && candidateContent === undefined;
  if (!workspace?.root || typeof workspace.list !== 'function' || typeof workspace.read !== 'function' ||
      (!baseline && (typeof candidateContent !== 'string' || Buffer.byteLength(candidateContent) > MAX_FILE_BYTES)) || !/^sha256:[a-f0-9]{64}$/u.test(targetDigest ?? '')) fail('UNSUPPORTED_INPUT');
  const root = await realpath(workspace.root);
  const target = localPath(root, targetPath), candidate = baseline ? undefined : localPath(root, candidatePath), working = localPath(root, cwd, true);
  if (!/\.(?:mjs|js)$/iu.test(target) || (!baseline && (!/\.(?:mjs|js)$/iu.test(candidate) || target.toLowerCase() === candidate.toLowerCase()))) fail('UNSUPPORTED_TARGET');
  const marker = 'DDA_ASSERT_' + randomBytes(16).toString('hex') + '=';
  const preservationMarker = preservation ? 'DDA_PRESERVE_' + randomBytes(16).toString('hex') + '=' : undefined;
  const queueMarker = asyncQueuePlan ? 'DDA_QUEUE_' + randomBytes(16).toString('hex') + '=' : undefined;
  const queueProduct = asyncQueuePlan && localPath(root, asyncQueuePlan.path);
  const scratch = await mkdtemp(join(root, PREFIX));
  const identity = await lstat(scratch);
  try {
    const sites = Array.isArray(producerSites) ? producerSites.slice(0,3) : [];
    const registry = [];
    const plans = [], recordPlans = [], consumers = [];
    const traceName = marker.slice(0,-1) + 'Trace';
    const modulePath = join(scratch, '.' + traceName + '.mjs');
    const helper = sites.length ? pathToFileURL(modulePath).href : undefined;
    const queue = [''], seen = new Set();
    let targetSource;
    let total = 0, hasTarget = false, hasCandidate = false, hasQueueProduct = false;
    // A bounded UTF-8 workspace copy retains package scopes and relative fixture
    // files. Generated dependencies and the real Git database are never copied.
    for (let index = 0; index < queue.length; index++) {
      signal?.throwIfAborted();
      const directory = queue[index];
      const listing = await workspace.list(directory);
      if (!listing.granted || listing.truncated) fail('INCOMPLETE_DIRECTORY');
      for (const entry of listing.entries) {
        const name = basename(entry.path);
        if (name === '.git' || name === 'node_modules' || name.startsWith(PREFIX)) continue;
        const path = localPath(root, entry.path);
        if (dirname(path).split(sep).join('/') !== (directory || '.') || seen.has(path) || entry.contentsOmitted) fail('UNSUPPORTED_ENTRY');
        seen.add(path);
        if (seen.size > MAX_FILES || path.split('/').length > 20) fail('WORKSPACE_LIMIT');
        const original = join(root, path);
        if (relative(root, await realpath(original)) !== relative(root, original) || (await lstat(original)).isSymbolicLink()) fail('LINK');
        const dest = join(scratch, path);
        if (entry.kind === 'DIRECTORY') {
          await mkdir(dest);
          queue.push(path);
          continue;
        }
        if (entry.kind !== 'FILE' || !Number.isSafeInteger(entry.sizeBytes) || (total += entry.sizeBytes) > MAX_BYTES) fail('WORKSPACE_LIMIT');
        const { content: originalContent, digest } = await readText(workspace, path, entry.sizeBytes, signal);
        let content = originalContent;
        if (path === queueProduct) {
          if (digest !== asyncQueuePlan.productDigest) fail('QUEUE_SOURCE_CHANGED');
          hasQueueProduct = true;
        }
        if (path === candidate) { content = candidateContent; hasCandidate = true; }
        if (path === target) {
          if (targetDigest !== digest) fail('TARGET_CHANGED');
          targetSource = originalContent;
          const queueProbe = queueMarker ? asyncQueueInstrumentation(asyncQueuePlan, queueMarker) : '';
          content = bootSource(instrument(content, assertionLine, marker, helper) + queueProbe, scratch);
          hasTarget = true;
        } else if (helper && /\.(?:mjs|js)$/iu.test(path)) {
          if (preservation && sites.some(s=>s?.path===path)) {
            const plan=preservation.kind === 'records' ? undefined : preservationPlan(path,originalContent,digest,content,sites);
            if (plan) {
              plans.push(plan);
              content=instrumentPreservation(content,plan,helper,traceName+'Record');
            }
            if (preservation === true || preservation.kind === 'records') {
              const recordPlan = recordPreservationPlan(path, originalContent, digest, content, sites);
              if (recordPlan) {
                recordPlans.push(recordPlan);
                content = instrumentRecordInputs(content, recordPlan, helper, traceName + 'Records');
              }
            }
          }
          content = wrapProducers(path, originalContent, digest, content, sites, helper, traceName, registry);
        }
        if (preservation && /\.(?:js|mjs)$/iu.test(path) && originalContent.includes('!==') && sites.some(s=>s?.field && originalContent.includes(s.field))) {
          consumers.push({ original:originalContent, actual:path===candidate ? candidateContent : originalContent });
        }
        await writeFile(dest, content, { flag: 'wx', mode: 0o600 });
      }
    }
    if (!hasTarget || (!baseline && !hasCandidate) || (working && !queue.includes(working)) || (queueProduct && !hasQueueProduct)) fail('MISSING_INPUT');
    if (helper) {
      for (const plan of plans) {
        for (const source of consumers) {
          plan.consumer=preservationConsumer(source.original,plan);
          if (plan.consumer) {
            plan.actualConsumer=source.original===source.actual ? plan.consumer : preservationConsumer(source.actual,plan);
            break;
          }
        }
      }
      let keep = '';
      let notify = '';
      if (preservation) {
        if (plans.length || !recordPlans.length) {
          keep = preservationRuntime(plans, preservation, preservationMarker);
          notify = '__preserve.note(d);';
        }
        if (recordPlans.length) {
          keep += recordPreservationRuntime(recordPlans, preservation, preservationMarker);
          notify += '__recordPreserve.note(d);';
        }
      }
      const traceModule = `import { types } from 'node:util';\nimport { createHmac, randomBytes } from 'node:crypto';\n` +
        keep + buildTrace.toString() + `\nconst __trace = buildTrace(${JSON.stringify(registry)}, types.isProxy, createHmac, randomBytes(32));
export const capture=__trace.capture;
export function difference(a,b){ const d=__trace.difference(a,b); ${notify} return d; }\n`;
      await writeFile(modulePath, traceModule, { flag: 'wx', mode: 0o600 });
    }
    // Prevent a Git command in this copy from discovering the actual checkout
    // in its parent. A test that requires a real repository must create its own.
    await writeFile(join(scratch, '.git'), 'unavailable in candidate workspace\n', { flag: 'wx' });
    // A trusted task-specific acceptance hook may need a small synthetic probe
    // module. Keep it inside the private copy and make its name opaque to the
    // model. The hook gets a one-shot writer rather than filesystem access.
    let probeWritten = false;
    const writeProbe = async source => {
      if (probeWritten || typeof source !== 'string' || !source.length || Buffer.byteLength(source, 'utf8') > MAX_PROBE_BYTES) fail('PROBE_LIMIT');
      probeWritten = true;
      const path = '.dda-task-acceptance-' + randomBytes(12).toString('hex') + '.mjs';
      await writeFile(join(scratch, path), bootSource(source, scratch), { flag: 'wx', mode: 0o600 });
      return relative(join(scratch, working), join(scratch, path)).split(sep).join('/');
    };
    signal?.throwIfAborted();
    return await run({ cwd: relative(root, join(scratch, working)).split(sep).join('/'), marker, preservationMarker, queueMarker, writeProbe, targetSource });
  } finally {
    const current = await lstat(scratch).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (current?.isSymbolicLink()) await unlink(scratch);
    else if (current) {
      if (current.dev !== identity.dev || current.ino !== identity.ino || await realpath(scratch) !== scratch) fail('CLEANUP_IDENTITY');
      await rm(scratch, { recursive: true, force: true, maxRetries: 2 });
    }
  }
}
