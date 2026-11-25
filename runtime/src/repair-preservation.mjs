import { parse } from 'acorn';

const parseModule = text => parse(text, { sourceType: 'module', ecmaVersion: 'latest', locations: true });
const isName = name => typeof name === 'string' && /^[$A-Z_a-z][$\w]{0,63}$/u.test(name);
const prop = node => node?.type === 'MemberExpression' && !node.computed ? node.property.name : undefined;
const chain = node => node?.type === 'ChainExpression' ? node.expression : node;
const statTypes = { isFile:'file', isDirectory:'directory', isSymbolicLink:'symlink',
  isFIFO:'fifo', isSocket:'socket', isBlockDevice:'blockDevice', isCharacterDevice:'characterDevice' };

function nodes(root) {
  const out = [], stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (!node?.type) continue;
    out.push(node);
    for (const x of Object.values(node)) {
      if (Array.isArray(x)) stack.push(...x); else if (x?.type) stack.push(x);
    }
  }
  return out;
}

function declarations(ast) {
  const locals = new Map(), imports = new Map();
  for (const statement of ast.body) {
    const node = statement.declaration ?? statement;
    if (node.type === 'VariableDeclaration') {
      for (const decl of node.declarations) if (decl.id.type === 'Identifier') locals.set(decl.id.name, decl);
    } else if (node.type === 'FunctionDeclaration') locals.set(node.id.name, node);
    else if (node.type === 'ImportDeclaration') {
      for (const spec of node.specifiers) imports.set(spec.local.name, [node.source.value, spec.imported?.name]);
    }
  }
  return { locals, imports };
}

// Compile only the source statements that construct and return the record.
// Setup (e.g. external workspace discovery) is replaced by a private synthetic
// directory. The compiled slice has no real filesystem or process capability.
function compile(text, site, verified) {
  const ast = parseModule(text), { locals, imports } = declarations(ast);
  const scopes = [];
  for (const [name, decl] of locals) {
    const fn = decl.init ?? decl;
    if (fn.body?.type !== 'BlockStatement') continue;
    for (const stmt of fn.body.body) {
      if (stmt.type !== 'ReturnStatement' || stmt.argument?.type !== 'ObjectExpression') continue;
      const field = stmt.argument.properties.find(p => !p.computed && p.key?.name === site.field);
      if (!field || (verified ? name !== verified.owner : field.loc.start.line !== site.line)) continue;
      let inside = field.value;
      while (inside?.type === 'CallExpression' && inside.arguments.length === 1 && inside.callee.type === 'Identifier') inside = inside.arguments[0];
      if (inside?.type === 'Identifier' && inside !== field.value) scopes.push({ name, fn, stmt, field, map: inside.name });
    }
  }
  if (scopes.length !== 1) return;
  const { name:owner, fn, stmt, field, map } = scopes[0];
  const start = fn.body.body.findIndex(s => s.type === 'VariableDeclaration' && s.declarations.some(d =>
    d.id.name === map && d.init?.type === 'ObjectExpression' && !d.init.properties.length));
  if (start < 0) return;
  const tail = fn.body.body.slice(start), loops = tail.filter(n => n.type === 'ForOfStatement');
  let selected;
  for (const loop of loops) {
    const key = loop.left.declarations?.[0]?.id.name, parts = nodes(loop.body);
    if (!isName(key)) continue;
    const write = parts.find(n => n.type === 'AssignmentExpression' && n.operator === '=' && n.left.computed &&
      n.left.object?.name === map && n.left.property.name === key && n.right.type === 'Identifier');
    if (!write && (!verified?.collection || loop.right.name !== verified.collection)) continue;
    const record = write?.right.name ?? verified?.record;
    const reader = parts.find(n => n.type === 'VariableDeclarator' && n.id.name === record && n.init?.type === 'AwaitExpression')?.init.argument;
    const pathCall = reader?.arguments?.[0];
    if (reader?.callee?.type !== 'Identifier' || pathCall?.type !== 'CallExpression' || pathCall.arguments.length !== 2 ||
        !['resolve','join'].includes(imports.get(pathCall.callee.name)?.[1]) || imports.get(pathCall.callee.name)?.[0] !== 'node:path' ||
        pathCall.arguments[0].type !== 'Identifier' || pathCall.arguments[1].name !== key) continue;
    if (selected) return;
    selected = { key, record, reader, dir:pathCall.arguments[0].name, parts, collection:loop.right.name };
  }
  if (!selected) return;
  const { key, record, reader, dir, parts } = selected;
  let branch = verified?.branch, aggregate = verified?.aggregate, predicate = verified?.predicate;
  if (!verified) {
    const reductions = parts.filter(n => n.type === 'AssignmentExpression' && n.operator === '||=' && n.left.type === 'Identifier' &&
      n.right.type === 'BinaryExpression' && n.right.operator === '===' && n.right.left.object?.name === record &&
      isName(prop(n.right.left)) && typeof n.right.right.value === 'string');
    if (reductions.length !== 1) return;
    const reduced = reductions[0];
    const exposed = stmt.argument.properties.filter(p => p.value?.name === reduced.left.name && isName(p.key?.name));
    if (exposed.length !== 1) return;
    aggregate = exposed[0].key.name;
    branch = { field:prop(reduced.right.left), literal:reduced.right.right.value };
    if (!/^[a-zA-Z_-]{1,28}$/u.test(branch.literal)) return;
    const body = nodes(locals.get(reader.callee.name)?.init?.body ?? locals.get(reader.callee.name)?.body);
    const tests = body.filter(n => n.type === 'ConditionalExpression' && n.consequent.value === branch.literal &&
      Object.hasOwn(statTypes, prop(n.test?.callee)));
    if (tests.length !== 1) return;
    const test = tests[0], valueName = test.test.callee.object.name;
    const statDecl = body.find(n => n.type === 'VariableDeclarator' && n.id.name === valueName && n.init?.type === 'AwaitExpression');
    if (!statDecl || !nodes(statDecl.init).some(n => n.type === 'CallExpression' &&
        imports.get(n.callee.name)?.join('/') === 'node:fs/promises/lstat')) return;
    const classification = body.find(n => n.type === 'VariableDeclarator' && n.init && nodes(n.init).includes(test));
    if (!classification || !body.some(n => n.type === 'Property' && n.key?.name === branch.field && n.value?.name === classification.id.name)) return;
    predicate = prop(test.test.callee);
  } else if (!stmt.argument.properties.some(p => p.key?.name === aggregate)) return;
  const snippet = (from,to) => text.slice(from,to);
  const tailCode = snippet(tail[0].start,stmt.end);
  const selectedDecls = new Map(), usedImports = new Map();
  const usedTypes = new Set(['file','directory','symlink','other']);
  const stack = tail.flatMap(nodes);
  const forbidden = new Set(['process','global','globalThis','require','eval','Function','constructor','__proto__','prototype','WebAssembly','Atomics','SharedArrayBuffer']);
  while (stack.length) {
    const node = stack.pop();
    if (node.type === 'CallExpression' && Object.hasOwn(statTypes, prop(node.callee))) {
      usedTypes.add(statTypes[prop(node.callee)]);
    }
    if (['ImportExpression','WhileStatement','DoWhileStatement','ForStatement','ThisExpression','WithStatement'].includes(node.type)) return;
    if (node.type !== 'Identifier') continue;
    const id = node.name;
    if (forbidden.has(id)) return;
    if (imports.has(id)) {
      const [mod,method] = imports.get(id);
      const allowed = { 'node:fs/promises':['lstat','readdir','readFile'], 'node:path':['resolve','join'], 'node:crypto':['createHash'] };
      if (!allowed[mod]?.includes(method)) return;
      usedImports.set(id,method);
    } else if (locals.has(id) && !selectedDecls.has(id)) {
      const d = locals.get(id);
      selectedDecls.set(id,d);
      stack.push(...nodes(d));
    }
  }
  const decls = [...selectedDecls.values()].sort((a,b)=> a.start-b.start).map(d =>
    (d.type === 'VariableDeclarator' ? 'const ' : '') + snippet(d.start,d.end) + ';').join('\n');
  const bindings = [...usedImports].map(([name,api]) => `const ${name} = __api.${api};`).join('\n');
  const code = `${bindings}\n${decls}\nasync function __measure(){const ${dir}='/fixture';\n${tailCode}\n}`;
  const publicKeys = [...new Set(nodes(ast).filter(n => n.type==='Literal' && typeof n.value==='string' && /^[A-Za-z_][\w.-]{0,47}$/u.test(n.value)).map(n => n.value))];
  const kinds = verified?.kinds ?? ['file','directory','symlink','other','fifo','socket','blockDevice','characterDevice'].filter(kind => usedTypes.has(kind));
  return { owner, record, key, collection:selected.collection, field:site.field, line:field.loc.start.line, aggregate, branch, predicate,
    exceptional:statTypes[predicate], kinds, code, publicKeys,
    readerStart:reader.start, readerEnd:reader.end, calleeEnd:reader.callee.end };
}

export function preservationPlan(path, original, digest, current, sites) {
  for (const site of sites) {
    if (site.path !== path || site.digest !== digest || original.split(/\r?\n/u)[site.line-1] !== site.sourceLine) continue;
    try {
      const base = compile(original,site);
      if (!base) continue;
      const actual = original === current ? base : compile(current,site,base);
      if (actual) return { path, base, actual };
    } catch { /* Unrecognized syntax or semantics leaves the probe unsupported. */ }
  }
}

export function instrumentPreservation(text, plan, helper, binding) {
  const { readerStart, calleeEnd, readerEnd, key } = plan.actual;
  const args = text.slice(calleeEnd,readerEnd).trimStart();
  if (!args.startsWith('(')) return text;
  return text.slice(0,readerStart) + binding + '(' + JSON.stringify(plan.path) + ',' + key + ',' +
    text.slice(readerStart,calleeEnd) + ',' + args.slice(1) + text.slice(readerEnd) +
    `\nimport { recordItem as ${binding} } from ${JSON.stringify(helper)};\n`;
}

// Require an actual consumer comparing both public fields on the same two
// records. Its disjunction is replayed on the synthetic returned records.
export function preservationConsumer(text, plan) {
  const { field,aggregate } = plan.base;
  if (!text.includes(field) || !text.includes(aggregate) || !text.includes('!==')) return;
  let ast;
  try { ast = parseModule(text); } catch { return; }
  for (const or of nodes(ast)) {
    if (or.type !== 'LogicalExpression' || or.operator !== '||') continue;
    const stack=[or], fields=[];
    let left,right,valid=true;
    while (stack.length) {
      const n=stack.pop();
      if (n.type==='LogicalExpression' && n.operator==='||') { stack.push(n.left,n.right);continue; }
      const a=chain(n.left), b=chain(n.right);
      if (n.type!=='BinaryExpression' || n.operator!=='!==' || !prop(a) || prop(a)!==prop(b) ||
          !isName(a.object?.name) || !isName(b.object?.name)) { valid=false; break; }
      left??=a.object.name; right??=b.object.name;
      if (left!==a.object.name || right!==b.object.name || left===right) {valid=false;break;}
      fields.push(prop(a));
    }
    if (valid && fields.includes(field) && fields.includes(aggregate))
      return { left,right, expression:text.slice(or.start,or.end) };
  }
}

// Executed inside an empty VM realm. Only a bounded primitive-to-primitive
// hash bridge crosses realms. All resource reads use the in-memory fixture.
function syntheticApi() {
  const hash = globalThis.__hash;
  delete globalThis.__hash;
  const state = JSON.parse(globalThis.__states);
  delete globalThis.__states;
  const typeBits = { file:0o100000, directory:0o040000, symlink:0o120000, other:0,
    fifo:0o010000, socket:0o140000, blockDevice:0o060000, characterDevice:0o020000 };
  const missing = () => Object.assign(Error('missing fixture'), { code: 'ENOENT' });
  const __api = {
    join: (...p) => p.join('/'), resolve: (...p) => p.join('/'),
    readdir: async () => [],
    readFile: async p => {
      if (!Object.hasOwn(state,p)) throw missing();
      return 'constant fixture bytes';
    },
    lstat: async p => {
      if (!Object.hasOwn(state,p)) throw missing();
      const kind=state[p];
      return { isSymbolicLink:()=>kind==='symlink', isFile:()=>kind==='file', isDirectory:()=>kind==='directory',
        isFIFO:()=>kind==='fifo', isSocket:()=>kind==='socket', isBlockDevice:()=>kind==='blockDevice',
        isCharacterDevice:()=>kind==='characterDevice',
        size:22,mode:typeBits[kind] | 0o644,mtimeMs:5 };
    },
    createHash: algorithm => {
      let text='';
      return { update(value,encoding) {
        if (typeof value!=='string' || (encoding && encoding!=='utf8') || text.length+value.length>65536) throw Error('unsupported hash input');
        text+=value;return this;
      }, digest(encoding) {
        if (encoding!=='hex') throw Error('unsupported encoding');
        return hash(algorithm,text);
      } };
    }
  };
  // A UTF-8 string passed to hash.update and Buffer.from(s,'utf8') passed to
  // hash.update have identical bytes. Other Buffer operations are unsupported.
  const Buffer = { from:(s,enc) => {
    if (typeof s!=='string' || enc!=='utf8') throw Error('unsupported bytes');
    return s;
  }};
  return { __api, Buffer };
}

function runtimePreservation(plans, expected, marker, vm, cryptoHash, isProxy, synthetic, finish) {
  let observed, ambiguous = false;
  const groups = new Map();
  function note(inputs) {
    if (!inputs || !inputs.differences.length) return;
    const names = new Set(inputs.differences.map(d => d.path[0]));
    if (names.size!==1) {ambiguous=true;return;}
    const evidence = { path:inputs.path,field:inputs.field,key:[...names][0] };
    if (observed && JSON.stringify(observed)!==JSON.stringify(evidence)) ambiguous=true;
    observed=evidence;
  }
  function recordItem(path,key,reader,...args) {
    try {
      if (groups.size<192 && typeof key==='string' && typeof args[0]==='string' && args[0].length<2048) {
        const parts=args[0].split(/[\\/]/u), leaf=parts.pop();
        const options=args[1];
        let groupable = args.length===1;
        const scalar={};
        if (args.length===2 && options && !isProxy(options) && Object.getPrototypeOf(options)===Object.prototype) {
          const keys=Object.keys(options).sort();
          groupable=keys.length<8 && keys.every(k => {
            const d=Object.getOwnPropertyDescriptor(options,k);
            if (!d || !Object.hasOwn(d,'value') || typeof d.value!=='boolean') return false;
            scalar[k]=d.value;return true;
          });
        }
        if (leaf===key && groupable) {
          const id=JSON.stringify([path,parts,scalar]);
          if (!groups.has(id)) groups.set(id,{path,keys:new Set()});
          const keys=groups.get(id).keys;
          if (keys.size<64) keys.add(key);
        }
      }
    } catch { /* Unsupported observations leave the workspace test untouched. */ }
    return Reflect.apply(reader,undefined,args);
  }
  function evaluate(plan, consumer, key, otherKey) {
    const { field,aggregate,exceptional,kinds }=plan;
    if (!exceptional || exceptional === 'file') throw Error('no ordinary-file control');
    const produce = (first,second) => {
      const filesystem={['/fixture/'+key]: first, ['/fixture/'+otherKey]:second};
      const box=vm.createContext({ __hash:(algorithm,text) => {
        if (!['sha1','sha224','sha256','sha384','sha512'].includes(algorithm) || typeof text!=='string' || text.length>65536) return '';
        return cryptoHash(algorithm).update(text,'utf8').digest('hex');
      },__states:JSON.stringify(filesystem) },{codeGeneration:{strings:false,wasm:false},microtaskMode:'afterEvaluate'});
      const program = 'const {__api,Buffer}=('+synthetic+')();\n'+plan.code+
        '\n__measure().then(x => {globalThis.__answer=JSON.stringify(x)},() => {});';
      vm.runInContext(program,box,{timeout:160});
      if (typeof box.__answer!=='string' || box.__answer.length>8192) throw Error('unsupported producer');
      const result=JSON.parse(box.__answer);
      if (typeof result[aggregate]!=='boolean' || !['string','number','boolean'].includes(typeof result[field])) throw Error('unobserved return');
      return result;
    };
    const changed=(a,b) => {
      const code='const '+consumer.left+'=JSON.parse(__a),'+consumer.right+'=JSON.parse(__b);('+consumer.expression+')';
      return vm.runInNewContext(code,{__a:JSON.stringify(a),__b:JSON.stringify(b)},{timeout:100})===true;
    };
    const distinguish = (before, after) => before[field] !== after[field] && changed(before, after);
    const run=()=>{
      // Change the type at exactly one key. Reuse the ordinary layout so that
      // size, content, timestamps and the other key stay fixed in each pair.
      const ordinary = produce('file','file');
      const forKey = kinds.map(kind => kind === 'file' ? ordinary : produce(kind,'file'));
      const forOther = kinds.map(kind => kind === 'file' ? ordinary : produce('file',kind));
      const left = forKey[kinds.indexOf(exceptional)];
      const right = forOther[kinds.indexOf(exceptional)];
      const both = produce(exceptional,exceptional);
      const aggregateConstant=left[aggregate]===true && right[aggregate]===true && both[aggregate]===true;
      const control=ordinary[aggregate]===false && aggregateConstant;
      const fileTypes = [];
      for (const [name, snapshots] of [[key,forKey], [otherKey,forOther]]) {
        for (let i = 0; i < kinds.length; i++) {
          for (let j = i + 1; j < kinds.length; j++) {
            fileTypes.push({ key:name, from:kinds[i], to:kinds[j],
              distinguished:distinguish(snapshots[i],snapshots[j]) });
          }
        }
      }
      return { samples:[...forKey,...forOther,both].map(r=>[r[field],r[aggregate]]), aggregateConstant, fileTypes,
        additional:control && distinguish(right,both), relocated:control && distinguish(right,left) };
    };
    const first=run(), second=run();
    if (JSON.stringify(first)!==JSON.stringify(second)) throw Error('unstable controls');
    return first;
  }
  function verdict() {
    const lookup=expected===true ? observed : {path:expected?.site?.path,field:expected?.site?.field,key:expected?.key};
    if (!lookup || (expected===true && ambiguous)) return;
    const plan=plans.find(p=>p.path===lookup.path && p.base.field===lookup.field);
    if (!plan?.consumer || !plan.actualConsumer) return;
    const key=lookup.key;
    const safe=k=>typeof k==='string' && plan.base.publicKeys.includes(k) && !/secret|password|token|credential|private.?key/i.test(k);
    if (!safe(key)) return;
    let otherKey;
    for (const group of groups.values()) {
      if (group.path!==plan.path || !group.keys.has(key)) continue;
      otherKey=[...group.keys].find(k=>k!==key && safe(k) && (expected===true || k===expected.otherKey));
      if (otherKey) break;
    }
    if (!otherKey) return;
    const original=evaluate(plan.base,plan.consumer,key,otherKey);
    if (!original.additional || !original.relocated) return;
    const result=expected===true ? original : evaluate(plan.actual,plan.actualConsumer,key,otherKey);
    // A normalization is free to merge inputs the old producer already treated
    // as equal. Compare only previously observable distinctions, on both keys.
    const fileTypes = result.fileTypes.filter((_, i) => original.fileTypes[i].distinguished);
    const preserved = result.additional && result.relocated && fileTypes.every(pair => pair.distinguished);
    const status=expected===true ? 'observed' : preserved ? 'preserved' : 'collapsed';
    return { status,site:{path:plan.path,field:plan.actual.field,line:plan.actual.line},key,otherKey,
      branch:plan.base.branch,aggregateConstant:result.aggregateConstant,fileTypes,
      checks:{additional:result.additional,relocated:result.relocated} };
  }
  finish(()=>{
    let receipt;
    try { receipt=verdict(); } catch { /* A missing dependency or unsafe slice has no verdict. */ }
    process.stdout.write(marker + JSON.stringify(receipt ?? {status:'unverified'})+'\n');
  });
  return { recordItem,note };
}

export function preservationRuntime(plans, expected, marker) {
  return `import * as __vm from 'node:vm';\nimport { createHash as __createHash } from 'node:crypto';\nimport { after as __finish } from 'node:test';\n` +
    runtimePreservation.toString() + `\nconst __preserve=runtimePreservation(${JSON.stringify(plans)},${JSON.stringify(expected)},${JSON.stringify(marker)},__vm,__createHash,types.isProxy,${JSON.stringify(syntheticApi.toString())},__finish);\nexport const recordItem=__preserve.recordItem;\n`;
}
