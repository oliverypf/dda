import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaskRequirements, resolveBuildTestRequirements } from '../src/task-requirements.mjs';

test('normalizeTaskRequirements returns undefined without an own boolean flag', () => {
  for (const raw of [undefined, null, 'x', 5, [], {}, { build: 'yes' }, { build: 1, test: 'no' }]) {
    assert.equal(normalizeTaskRequirements(raw), undefined, JSON.stringify(raw));
  }
});

test('normalizeTaskRequirements coerces only literal true', () => {
  assert.deepEqual(normalizeTaskRequirements({ build: true, test: false }), {
    build: true, test: false, artifact: false, install: false
  });
  assert.deepEqual(normalizeTaskRequirements({ install: true, build: 'yes', artifact: 1 }), {
    build: false, test: false, artifact: false, install: true
  });
  assert.deepEqual(normalizeTaskRequirements({ test: true, artifact: true, install: true }), {
    build: false, test: true, artifact: true, install: true
  });
});

test('resolveBuildTestRequirements keeps inference when nothing was declared', () => {
  const inferred = { build: true, test: false, artifact: true, installer: true };
  assert.equal(resolveBuildTestRequirements(undefined, inferred), inferred);
});

test('resolveBuildTestRequirements lets declared flags override inference but keep command evidence', () => {
  const inferred = { build: true, test: true, artifact: true, installer: true };
  assert.deepEqual(
    resolveBuildTestRequirements({ build: false, test: false, artifact: false, install: false }, inferred),
    { build: false, test: false, artifact: false, installer: false }
  );
  assert.deepEqual(
    resolveBuildTestRequirements(
      { build: false, test: false, artifact: false, install: false },
      inferred,
      { build: false, test: true, artifact: false }
    ),
    { build: false, test: true, artifact: false, installer: false }
  );
  assert.deepEqual(
    resolveBuildTestRequirements(
      { build: true, test: false, artifact: false, install: false },
      { build: false, test: true, artifact: false, installer: true },
      {}
    ),
    { build: true, test: false, artifact: false, installer: true }
  );
});

test('normalizeTaskRequirements normalizes declared deliverable paths', () => {
  assert.deepEqual(normalizeTaskRequirements({ deliverables: [{ path: ' docs/out.json ' }] }), {
    build: false, test: false, artifact: false, install: false,
    deliverables: [{ path: 'docs/out.json' }]
  });
  assert.deepEqual(
    normalizeTaskRequirements({ build: true, deliverables: [{ path: String.raw`.\docs\a.md` }] }).deliverables,
    [{ path: 'docs/a.md' }]
  );
});

test('normalizeTaskRequirements drops invalid deliverable entries', () => {
  const result = normalizeTaskRequirements({
    deliverables: [
      { path: '../escape.json' },
      { path: 'a/../b.json' },
      { path: 'no-extension' },
      { path: `bad${String.fromCharCode(9)}name.json` },
      { path: 'a?.json' },
      'a.json',
      { path: 'ok.json' }
    ]
  });
  assert.deepEqual(result.deliverables, [{ path: 'ok.json' }]);
});

test('normalizeTaskRequirements normalizes format deliverables with allowlist and count clamp', () => {
  const result = normalizeTaskRequirements({
    deliverables: [
      { format: 'JSON', count: 3 },
      { format: 'pdf' },
      { format: 'exe' },
      { format: 'csv', count: 99 },
      { format: 'xlsx', count: 0 }
    ]
  });
  assert.deepEqual(result.deliverables, [
    { extension: '.json', count: 3 },
    { extension: '.pdf', count: 1 },
    { extension: '.csv', count: 16 },
    { extension: '.xlsx', count: 1 }
  ]);
});

test('normalizeTaskRequirements attaches presentation fields for pptx deliverables', () => {
  const result = normalizeTaskRequirements({
    deliverables: [
      { path: 'docs/A.PPTX', minSlides: 8, sourceSlide: 'last' },
      { format: 'pptx', count: 2, maxSlides: 12, sourceSlide: 'first' },
      { path: 'docs/b.pptx', minSlides: 0, maxSlides: 600 }
    ]
  });
  assert.deepEqual(result.deliverables, [
    { path: 'docs/A.PPTX', presentation: { min: 8, max: undefined, sourcePage: 'last', requirePath: false, requireUrl: false } },
    { extension: '.pptx', count: 2, presentation: { min: undefined, max: 12, sourcePage: undefined, requirePath: false, requireUrl: false } },
    { path: 'docs/b.pptx', presentation: { min: undefined, max: undefined, sourcePage: undefined, requirePath: false, requireUrl: false } }
  ]);
});

test('normalizeTaskRequirements keeps deliverables only when the key is an array', () => {
  const noKey = normalizeTaskRequirements({ build: true });
  assert.equal('deliverables' in noKey, false);
  assert.equal(normalizeTaskRequirements({ deliverables: 'x' }), undefined);
  assert.deepEqual(normalizeTaskRequirements({ deliverables: [] }), {
    build: false, test: false, artifact: false, install: false, deliverables: []
  });
  assert.deepEqual(normalizeTaskRequirements({ deliverables: [{ path: 'a.json' }, { path: 'a.json' }] }).deliverables,
    [{ path: 'a.json' }]);
});
