import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TIP_PIN } from '../bin/offloop.mjs';

const OFFLOOP = fileURLToPath(new URL('../', import.meta.url));
const PRODUCT_ROOT = path.resolve(OFFLOOP, '..');
const EXPERIENCE = path.join(OFFLOOP, 'experience');
const SAMPLES = path.join(EXPERIENCE, 'samples');
const SCHEMA_PATH = path.join(EXPERIENCE, 'schema.json');
const INDEX_PATH = path.join(EXPERIENCE, 'index.json');

const ENTRY_REQUIRED = [
  'id',
  'slug',
  'source',
  'provenance',
  'tipSha',
  'tipPin',
  'pinEqual',
  'indexable',
  'dgr',
  'dgrRef',
  'dgrReason',
  'adopted',
  'experience_only',
  'reason',
  'lesson',
  'summary',
  'date',
  'runtimeMemory',
];

const INDEX_REQUIRED = [
  'schemaVersion',
  'kind',
  'schemaRef',
  'tipPin',
  'entries',
  'samples',
  'greenRule',
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadLayout() {
  const schema = readJson(SCHEMA_PATH);
  const index = readJson(INDEX_PATH);
  const samples = index.entries.map((row) => ({
    row,
    path: path.join(EXPERIENCE, row.path),
    value: readJson(path.join(EXPERIENCE, row.path)),
  }));
  return { schema, index, samples };
}

function assertRequired(value, fields, label) {
  for (const field of fields) {
    assert.ok(Object.hasOwn(value, field), `${label} must declare ${field}`);
  }
}

function assertExperienceEntry(entry, label) {
  assertRequired(entry, ENTRY_REQUIRED, label);
  assert.equal(entry.adopted, false, `${label} must remain adopted=false`);
  assert.equal(entry.experience_only, true, `${label} must remain experience_only`);
  assert.equal(entry.reason, 'experience_only', `${label} reason must be experience_only`);
  assert.equal(entry.runtimeMemory, false, `${label} cannot be runtime Memory`);
  assert.equal(entry.dgr, null, `${label} must use the explicit null DGR slot`);
  assert.equal(entry.dgrRef, null, `${label} must use the explicit null DGR reference`);
  assert.match(entry.dgrReason, /no standalone DGR/i);
  assert.equal(entry.provenance.kind, 'mvp-smoke-fixture');
  assert.match(entry.provenance.fixture, /harness2-mvploop-smoke-docs-r1/);
  assert.ok(entry.date, `${label} must have a date`);
}

function isGreen(row) {
  return row.indexable === true &&
    row.status === 'PASS' &&
    row.pinEqual === true &&
    typeof row.tipSha === 'string' &&
    row.tipSha.length > 0 &&
    row.tipSha === TIP_PIN &&
    row.tipPin === TIP_PIN;
}

test('T-H2-K4-EXPERIENCE-LAYOUT: schema, index, sources, tip, DGR, and experience-only fields are complete', () => {
  const { schema, index, samples } = loadLayout();
  assert.equal(schema.schemaVersion, 'offloop-experience-inrepo-r1');
  assert.equal(schema.tipPin, TIP_PIN);
  assert.ok(schema.$defs?.experienceEntry, 'schema must define an entry contract');
  assert.ok(schema.$defs?.experienceIndex, 'schema must define an index contract');
  assert.deepEqual(schema['x-contract'].entryRequired, ENTRY_REQUIRED);
  assert.deepEqual(schema['x-contract'].indexRequired, INDEX_REQUIRED);

  assert.equal(index.kind, 'experience-index');
  assert.equal(index.schemaRef, './schema.json');
  assert.equal(index.tipPin, TIP_PIN);
  assertRequired(index, INDEX_REQUIRED, 'index');
  assert.ok(index.entries.length >= 1 && index.entries.length <= 3, 'index must stay curated');
  assert.deepEqual(index.samples, index.entries.map((row) => row.path));
  for (const row of index.entries) {
    assertExperienceEntry(row, `index row ${row.id}`);
    assert.equal(isGreen(row), true, `${row.id} must be green only with the fixed non-empty pin`);
  }
  for (const { row, path: samplePath, value } of samples) {
    assert.ok(fs.existsSync(samplePath), `${row.path} must exist`);
    assertExperienceEntry(value, `sample ${row.id}`);
    assert.equal(value.id, row.id);
    assert.equal(value.slug, row.slug);
    assert.equal(value.tipSha, row.tipSha);
    assert.equal(value.tipPin, row.tipPin);
    assert.equal(value.pinEqual, row.pinEqual);
    assert.equal(isGreen(value), true, `${row.id} sample must satisfy index green rule`);
  }

  const curatedPath = path.relative(PRODUCT_ROOT, samples[0].path);
  const generatedPath = 'offloop/experience/generated-runtime-dump.json';
  const curatedIgnore = spawnSync('git', ['-C', PRODUCT_ROOT, 'check-ignore', '-q', curatedPath]);
  const generatedIgnore = spawnSync('git', ['-C', PRODUCT_ROOT, 'check-ignore', '-q', generatedPath]);
  assert.equal(curatedIgnore.status, 1, 'curated sample must be trackable through the ignore carve-out');
  assert.equal(generatedIgnore.status, 0, 'generated experience writes must remain ignored');
});

test('T-H2-K4-EXPERIENCE-CURATED: only small MVP-smoke fixtures with traceable provenance are indexed', () => {
  const { index, samples } = loadLayout();
  assert.ok(samples.length >= 1 && samples.length <= 3, 'sample count must remain 1–3');
  assert.equal(new Set(index.entries.map((row) => row.path)).size, samples.length);
  for (const { row, value } of samples) {
    assert.equal(row.provenance.kind, 'mvp-smoke-fixture');
    assert.match(row.source, /offloop\/scripts\/mvp-smoke\.mjs/);
    assert.match(row.provenance.fixture, /#T-H2-K5-(?:MVP-MISS|NO-EMPTY)$/);
    assert.ok(row.provenance.reportFields.includes('tipSha'));
    assert.ok(row.provenance.reportFields.includes('pinEqual'));
    assert.equal(value.report?.schema, 'offloop-mvp-smoke-r1');
    assert.equal(value.report?.mode, 'fixture');
    assert.equal(value.report?.liveOptIn, false);
    assert.equal(value.report?.candidateWrites, 0);
    assert.equal(value.report?.liveRequests, 0);
    assert.equal(value.report?.mainOpenRouterCalls, 0);
    assert.ok(JSON.stringify(value).length < 10000, 'sample must stay bounded rather than become a history dump');
  }
});

test('T-H2-K4-EXPERIENCE-NO-OUT: curated paths contain no out, secret, full-bench, or runtime-memory payload', () => {
  const { index, samples } = loadLayout();
  const curatedFiles = [SCHEMA_PATH, INDEX_PATH, ...samples.map(({ path: samplePath }) => samplePath)];
  for (const file of curatedFiles) {
    const relative = path.relative(EXPERIENCE, file);
    assert.doesNotMatch(relative, /(?:^|\/)out(?:-|\/)/i, `${relative} must not be an out-* path`);
    assert.doesNotMatch(relative, /(?:secret|credential|token)/i, `${relative} must not be a secret path`);
  }
  assert.equal(index.entries.some((row) => /out-|bench|secret|memory|policy/i.test(row.path)), false);
  for (const { value } of samples) {
    const text = JSON.stringify(value);
    assert.doesNotMatch(text, /(?:out-[^"\s]*|\.jsonl|complete bench|api[_-]?key|secret|password)/i);
    assert.equal(value.runtimeMemory, false);
    assert.equal(Object.hasOwn(value, 'memory'), false);
    assert.equal(Object.hasOwn(value, 'runtimePolicy'), false);
    assert.equal(Object.hasOwn(value, 'policy'), false);
  }
});

test('T-H2-K4-EXPERIENCE-TIP-PIN: every green row has the fixed non-empty pin and empty tips are never green', () => {
  const { index } = loadLayout();
  for (const row of index.entries) {
    assert.equal(typeof row.tipSha, 'string');
    assert.notEqual(row.tipSha, '');
    assert.equal(row.tipSha, TIP_PIN);
    assert.equal(row.tipPin, TIP_PIN);
    assert.equal(row.pinEqual, true);
    assert.equal(isGreen(row), true);
  }

  const template = index.entries[0];
  for (const tipSha of ['', null, undefined]) {
    const synthetic = {
      ...template,
      tipSha,
      pinEqual: false,
      indexable: false,
      status: 'NON_GREEN',
    };
    if (tipSha === undefined) delete synthetic.tipSha;
    assert.equal(isGreen(synthetic), false, `tipSha=${String(tipSha)} must not be green/PASS`);
    assert.notEqual(synthetic.status, 'PASS');
  }
});
