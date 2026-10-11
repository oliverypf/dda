import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HARNESS_PROTOCOL_VERSION,
  HARNESS_STORAGE_SCHEMA_VERSION,
  HARNESS_PRODUCER_VERSION,
  HARNESS_POLICY_VERSION,
  harnessVersions
} from '../src/versions.mjs';

test('version constants keep their historical runtime values', () => {
  // These values are consumed by stored events, migrations and release
  // manifests. Drifting them silently would break on-disk compatibility.
  assert.equal(HARNESS_PROTOCOL_VERSION, '1.0');
  assert.equal(HARNESS_STORAGE_SCHEMA_VERSION, 1);
  assert.equal(HARNESS_PRODUCER_VERSION, 'hmcodex-runtime@0.1.0');
  assert.equal(HARNESS_POLICY_VERSION, 'runtime-safety-1');
});

test('harnessVersions bundle is frozen and self-consistent', () => {
  assert.ok(Object.isFrozen(harnessVersions));
  assert.equal(harnessVersions.protocolVersion, HARNESS_PROTOCOL_VERSION);
  assert.equal(harnessVersions.storageSchemaVersion, HARNESS_STORAGE_SCHEMA_VERSION);
});
