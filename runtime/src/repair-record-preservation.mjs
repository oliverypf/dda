import { parse } from 'acorn';

const identifier = value => typeof value === 'string' && /^[A-Za-z_$][\w$]{0,63}$/u.test(value);
const reserved = new Set(['constructor', 'prototype', '__proto__', 'arguments', 'eval', 'Function', 'this', 'globalThis', 'process', 'require']);
const safe = name => identifier(name) && !reserved.has(name) && !name.startsWith('__dda');
const member = node => node?.type === 'MemberExpression' && !node.computed ? node.property.name : undefined;

function nodes(root) {
  const result = [], pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!node?.type) continue;
    result.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value);
      else if (value?.type) pending.push(value);
    }
  }
  return result;
}

function propertyPath(node, owner) {
  const names = [];
  while (member(node) && safe(member(node))) {
    names.unshift(member(node));
    node = node.object;
  }
  if (node?.name === owner && names.length && names.length <= 4) return names;
}

function moduleInfo(text) {
  const ast = parse(text, { sourceType: 'module', ecmaVersion: 'latest', locations: true });
  const functions = new Map(), hashes = new Set();
  for (const outer of ast.body) {
    const node = outer.declaration ?? outer;
    if (node.type === 'FunctionDeclaration' && safe(node.id?.name)) {
      functions.set(node.id.name, { fn: node, code: text.slice(node.start, node.end) });
    } else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) {
        if (safe(d.id.name) && ['ArrowFunctionExpression','FunctionExpression'].includes(d.init?.type)) {
          functions.set(d.id.name, { fn: d.init, code: 'const ' + text.slice(d.start, d.end) + ';' });
        }
      }
    } else if (node.type === 'ImportDeclaration' && node.source.value === 'node:crypto') {
      for (const spec of node.specifiers) if (spec.imported?.name === 'createHash' && safe(spec.local.name)) hashes.add(spec.local.name);
    }
  }
  return { functions, hashes };
}

function outputObject(fn) {
  if (fn.body.type === 'ObjectExpression') return fn.body;
  const returns = fn.body.body?.filter(n => n.type === 'ReturnStatement');
  if (returns?.length === 1 && returns[0].argument?.type === 'ObjectExpression') return returns[0].argument;
}

// Recognize a key projection and a public non-null predicate over the same
// collection. A digest field alone says nothing about what should be retained.
function keyedBranch(fn, output) {
  const input = fn.params[0].name;
  const maps = new Map();
  for (const node of nodes(fn.body)) {
    const init = node.init;
    if (node.type !== 'VariableDeclarator' || init?.type !== 'NewExpression' || init.callee.name !== 'Map') continue;
    const projection = init.arguments[0];
    if (member(projection?.callee) !== 'map' || projection.callee.object.name !== input) continue;
    const callback = projection.arguments[0], pair = callback?.body;
    if (pair?.type !== 'ArrayExpression' || pair.elements.length !== 2 || !safe(callback.params[0]?.name) ||
        pair.elements[1]?.name !== callback.params[0].name) continue;
    const identity = propertyPath(pair.elements[0], callback.params[0].name);
    if (identity && safe(node.id.name)) maps.set(node.id.name, identity);
  }
  for (const field of output.properties) {
    if (field.type !== 'Property' || field.computed || !safe(field.key.name) || member(field.value?.callee) !== 'some') continue;
    const source = field.value.callee.object;
    let identity;
    if (source.type === 'ArrayExpression' && source.elements.length === 1) {
      const iterator = source.elements[0]?.argument?.callee;
      if (member(iterator) === 'values') identity = maps.get(iterator.object.name);
    } else if (source.name === input) {
      // Direct projection of an array of identified records.
      const projections = nodes(fn.body).filter(n => member(n.callee) === 'map' && n.callee.object.name === input);
      const keys = projections.map(n => {
        const cb = n.arguments[0];
        return cb?.body?.type === 'ArrayExpression' && propertyPath(cb.body.elements[0], cb.params[0]?.name);
      }).filter(Boolean);
      if (keys.length === 1) identity = keys[0];
    }
    const predicate = field.value.arguments[0], comparison = predicate?.body;
    if (!identity || !safe(predicate?.params?.[0]?.name) || comparison?.type !== 'BinaryExpression' ||
        comparison.operator !== '!==' || comparison.right.type !== 'Literal' || comparison.right.value !== null) continue;
    const branch = propertyPath(comparison.left, predicate.params[0].name);
    if (branch && !/secret|passw|token|credential|private.?key/i.test(branch.join('.'))) {
      return { identity, branch, aggregate: field.key.name };
    }
  }
}

function findConsumer(info, field) {
  const consumers = [];
  for (const [name, { fn }] of info.functions) {
    if (fn.params.length !== 2 || !fn.params.every(p => p.type === 'Identifier')) continue;
    if (nodes(fn.body).some(n => n.type === 'BinaryExpression' && n.operator === '!==' &&
        member(n.left) === field && member(n.right) === field &&
        n.left.object.name === fn.params[0].name && n.right.object.name === fn.params[1].name)) consumers.push(name);
  }
  if (consumers.length === 1) return consumers[0];
}

// Only synchronous value transformations and a bounded string hash cross the
// replay boundary. Imports, ambient names and computed property calls fall
// outside this slice and leave the candidate unverified.
const syntax = new Set(('FunctionDeclaration FunctionExpression ArrowFunctionExpression Identifier BlockStatement ' +
  'ReturnStatement VariableDeclaration VariableDeclarator NewExpression CallExpression MemberExpression ' +
  'ArrayExpression ObjectExpression Property Literal SpreadElement LogicalExpression BinaryExpression ' +
  'UnaryExpression ConditionalExpression IfStatement ChainExpression SequenceExpression').split(' '));
const methods = new Set('map sort some every filter find slice get has keys values entries from max min stringify update digest'.split(' '));
function program(info, owner, consumer) {
  const selected = new Set(), pending = [owner, consumer], hashes = new Set();
  while (pending.length) {
    const name = pending.pop();
    if (selected.has(name)) continue;
    const declaration = info.functions.get(name);
    if (!declaration) return;
    selected.add(name);
    const body = nodes(declaration.fn);
    const locals = new Set(['Map','Array','Math','JSON','undefined', ...info.functions.keys(), ...info.hashes]);
    for (const n of body) {
      if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier') locals.add(n.id.name);
      for (const p of n.params ?? []) if (p.type === 'Identifier') locals.add(p.name);
    }
    const propertyNames = new Set();
    for (const n of body) {
      if (!syntax.has(n.type) || n.async || n.generator || n.method || n.kind === 'get' || n.kind === 'set') return;
      if (n.type === 'MemberExpression') {
        if (n.computed) {
          if (n.property.type !== 'Literal' || !Number.isSafeInteger(n.property.value) || Math.abs(n.property.value) > 32) return;
        } else propertyNames.add(n.property);
      }
      if (n.type === 'Property') {
        if (n.computed || !safe(n.key.name)) return;
        propertyNames.add(n.key);
      }
      if (n.type === 'NewExpression' && n.callee.name !== 'Map') return;
      if (n.type === 'CallExpression' && !(n.callee.type === 'Identifier' ?
        info.functions.has(n.callee.name) || info.hashes.has(n.callee.name) : methods.has(member(n.callee)))) return;
    }
    for (const n of body) {
      if (n.type !== 'Identifier') continue;
      if (!safe(n.name) || (!propertyNames.has(n) && !locals.has(n.name))) return;
      if (propertyNames.has(n)) continue;
      if (info.functions.has(n.name) && !selected.has(n.name)) pending.push(n.name);
      if (info.hashes.has(n.name)) hashes.add(n.name);
    }
  }
  const source = [...hashes].map(name => 'const ' + name + '=__ddaHash;')
    .concat([...selected].map(name => info.functions.get(name).code)).join('\n');
  return source.length <= 24000 ? source : undefined;
}

export function recordPreservationPlan(path, original, digest, current, sites) {
  for (const site of sites) {
    if (site.path !== path || site.digest !== digest || original.split(/\r?\n/u)[site.line - 1] !== site.sourceLine) continue;
    try {
      const base = moduleInfo(original), actual = original === current ? base : moduleInfo(current);
      for (const [owner, { fn }] of base.functions) {
        if (fn.params.length !== 1 || fn.params[0].type !== 'Identifier') continue;
        const output = outputObject(fn);
        if (!output?.properties.some(p => !p.computed && p.key?.name === site.field && p.loc.start.line === site.line)) continue;
        const relation = keyedBranch(fn, output), consumer = findConsumer(base, site.field);
        if (!relation || !consumer) continue;
        const next = actual.functions.get(owner)?.fn;
        if (next?.body.type !== 'BlockStatement' || next.params.length !== 1 || !safe(next.params[0].name)) continue;
        const previousCode = program(base, owner, consumer);
        const candidateCode = original === current ? previousCode : program(actual, owner, consumer);
        if (!previousCode || !candidateCode) continue;
        const line = outputObject(next)?.properties.find(p => p.key?.name === site.field)?.loc.start.line;
        if (!line) continue;
        return { path, field: site.field, line, owner, consumer, ...relation, previousCode, candidateCode,
          parameter: next.params[0].name, offset: next.body.start + 1 };
      }
    } catch { /* Unsupported syntax cannot establish a record preservation condition. */ }
  }
}

export function instrumentRecordInputs(source, plan, helper, binding) {
  const call = binding + '(' + JSON.stringify(plan.path) + ',' + plan.parameter + ');';
  // Keep the original producer and assertion line numbers stable.
  return source.slice(0, plan.offset) + call + source.slice(plan.offset) +
    '\nimport { observeRecords as ' + binding + ' } from ' + JSON.stringify(helper) + ';\n';
}

// Emitted into the copy, alongside the instrumented original test. Never
// retain actual record keys, readings, clocks or codes. A plain shape from a
// neutral observation and the scalar type of an observed exception suffice.
function recordRuntime(plans, expected, marker, vm, createHash, isProxy, after) {
  const observations = new Map();
  let target, ambiguous = false;
  const at = (record, path) => path.reduce((v,k) => v && Object.hasOwn(v,k) ? v[k] : undefined, record);
  const scalar = { string: 'sample', number: 1, boolean: false };

  function ordinaryShape(object) {
    let count = 0;
    function copy(value, depth) {
      if (++count > 64 || depth > 4) throw Error('large record');
      if (value === null) return null;
      if (Object.hasOwn(scalar, typeof value)) return scalar[typeof value];
      if (typeof value !== 'object' || isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) throw Error('unsupported record');
      const keys = Object.keys(value);
      if (keys.length > 16) throw Error('large record');
      const result = Object.create(null);
      for (const key of keys) {
        if (!/^[A-Za-z_$][\w$]{0,47}$/u.test(key) || /^(?:__proto__|prototype|constructor)$/u.test(key) ||
            /secret|passw|token|credential|private.?key|api.?key/i.test(key)) throw Error('unsupported record field');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!Object.hasOwn(descriptor, 'value')) throw Error('accessor');
        result[key] = copy(descriptor.value, depth + 1);
      }
      return result;
    }
    return copy(object, 0);
  }

  function observe(path, records) {
    try {
      const plan = plans.find(p => p.path === path);
      if (!plan || isProxy(records) || !Array.isArray(records) || records.length > 64) return;
      if (!observations.has(path)) observations.set(path, {});
      const state = observations.get(path);
      for (let index = 0; index < records.length; index++) {
        const d = Object.getOwnPropertyDescriptor(records, index);
        if (!d || !Object.hasOwn(d,'value')) continue;
        const row = ordinaryShape(d.value);
        if (!row || !['string','number'].includes(typeof at(row, plan.identity))) continue;
        const value = at(row, plan.branch);
        if (value === null) {
          if (!state.ordinary) state.ordinary = row;
        } else if (Object.hasOwn(scalar, typeof value)) {
          if (state.type && state.type !== typeof value) state.ambiguous = true;
          else state.type = typeof value;
        }
      }
    } catch { /* Getters and non-record input never participate in this probe. */ }
  }
  function note(diff) {
    if (!diff?.differences?.length) return;
    if (target && (target.path !== diff.path || target.field !== diff.field)) ambiguous = true;
    else target = { path: diff.path, field: diff.field };
  }
  function measure(plan, state, code) {
    const codes = {string:['sample-a','sample-b'], number:[1,2], boolean:[false,true]}[state.type];
    const set = (row, path, value) => { at(row, path.slice(0,-1))[path.at(-1)] = value; };
    const [firstCode, secondCode] = codes;
    const controls = [[null,null], [firstCode,null], [null,firstCode], [firstCode,firstCode],
      [null,secondCode], [secondCode,null], [firstCode,secondCode], [secondCode,firstCode]];
    const pairs = [[0,1],[0,2],[1,3],[2,3],[2,1],[2,4],[1,5],[6,7]];
    const layouts = controls.map(pair => pair.map((value, i) => {
      const row = JSON.parse(JSON.stringify(state.ordinary));
      set(row, plan.identity, typeof at(row, plan.identity) === 'number' ? i + 1 : 'record-' + (i + 1));
      set(row, plan.branch, value);
      return row;
    }));
    const input = JSON.stringify(layouts);
    if (input.length > 24000) throw Error('large replay');
    const hash = (algorithm, value) => {
      if (!['sha1','sha224','sha256','sha384','sha512'].includes(algorithm) || typeof value !== 'string' || value.length > 65536) throw Error('unsupported hash');
      return createHash(algorithm).update(value,'utf8').digest('hex');
    };
    const hashAPI = `function __ddaHash(algorithm) {
      let data = '';
      return {update(s,encoding) {
        if(typeof s!=='string' || (encoding && encoding!=='utf8') || data.length+s.length>65536) throw Error();
        data+=s;return this;
      },digest(encoding) { if(encoding!=='hex') throw Error(); return __ddaDigest(algorithm,data); }};
    }`;
    const script = hashAPI + '\n' + code + '\n' +
      'const __ddaOut=JSON.parse(__ddaInput).map(row=>' + plan.owner + '(row));\n' +
      'const __ddaPairs=' + JSON.stringify(pairs) + ';\n' +
      'JSON.stringify({samples:__ddaOut.map(x=>[x[' + JSON.stringify(plan.field) + '],x[' + JSON.stringify(plan.aggregate) +
      ']]),changes:__ddaPairs.map(([a,b])=>' + plan.consumer + '(__ddaOut[a],__ddaOut[b])),same:__ddaOut.map(x=>' + plan.consumer + '(x,x))})';
    function execute() {
      const box = Object.assign(Object.create(null), { __ddaInput: input, __ddaDigest: hash });
      const output = vm.runInNewContext(script, box, { timeout: 180, contextCodeGeneration: {strings:false,wasm:false} });
      if (typeof output !== 'string' || output.length > 8192) throw Error('invalid result');
      return output;
    }
    const first = execute();
    if (first !== execute()) throw Error('unstable result');
    const { samples, changes, same } = JSON.parse(first);
    if (samples.some(([value,flag]) => !['string','number','boolean'].includes(typeof value) || typeof flag !== 'boolean') ||
        changes.some(v => typeof v !== 'boolean') || same.some(v => v !== false)) throw Error('unsupported consumer');
    const active = !samples[0][1] && samples.slice(1).every(row => row[1]);
    const distinct = pairs.map(([left,right], i) => active && samples[left][0] !== samples[right][0] && changes[i]);
    return { aggregateConstant:active, checks:{additional:distinct.slice(0,4).every(Boolean), relocated:distinct[4],
      changedValue:distinct[5] && distinct[6], swappedValues:distinct[7]} };
  }
  function verdict() {
    const site = expected === true ? target : expected.site;
    if (!site || (expected === true && ambiguous)) return;
    const plansHere = plans.filter(p => p.path === site.path && p.field === site.field);
    if (plansHere.length !== 1) return;
    const plan = plansHere[0], state = observations.get(plan.path);
    if (!state?.ordinary || !state.type || state.ambiguous) return;
    const base = measure(plan, state, plan.previousCode);
    if (!Object.values(base.checks).every(Boolean)) return;
    const result = expected === true ? base : measure(plan, state, plan.candidateCode);
    return { kind:'records', status:expected === true ? 'observed' : Object.values(result.checks).every(Boolean) ? 'preserved' : 'collapsed',
      site:{path:plan.path,line:plan.line,field:plan.field}, key:'record-1',otherKey:'record-2',
      branch:{field:plan.branch.join('.'),literal:'non-null'}, ...result };
  }
  after(() => {
    let receipt;
    try { receipt = verdict(); } catch { /* Unsupported or unstable replays have no evidence. */ }
    process.stdout.write(marker + JSON.stringify(receipt ?? {status:'unverified'}) + '\n');
  });
  return { observe, note };
}

export function recordPreservationRuntime(plans, expected, marker) {
  return `import * as __recordVM from 'node:vm';\nimport {createHash as __recordHash} from 'node:crypto';\nimport {after as __recordFinish} from 'node:test';\n` +
    recordRuntime.toString() + '\nconst __recordPreserve=recordRuntime(' + [plans,expected,marker].map(x=>JSON.stringify(x)).join(',') +
    ',__recordVM,__recordHash,types.isProxy,__recordFinish);\nexport const observeRecords=__recordPreserve.observe;\n';
}
