// Canonical harness version vocabulary.
//
// These constants used to live inside runtime/src/harness-event-store.mjs, which
// is reached transitively by the monolithic runtime/src/index.mjs. They are the
// first genuinely platform-agnostic values extracted into @dda/harness-model so
// every client (linux-cli, desktop, HarmonyOS) can agree on the same protocol,
// storage-schema and policy identities without importing the runtime monolith.
//
// Values must stay byte-for-byte identical to the historical runtime definitions
// so stored events, migrations and release manifests keep validating.

export const HARNESS_PROTOCOL_VERSION = '1.0';
export const HARNESS_STORAGE_SCHEMA_VERSION = 1;
export const HARNESS_APP_VERSION = process.env.DDA_APP_VERSION?.trim() || '0.1.0';
export const HARNESS_PRODUCER_VERSION = 'hmcodex-runtime@0.1.0';
export const HARNESS_POLICY_VERSION = 'runtime-safety-1';

export const harnessVersions = Object.freeze({
  protocolVersion: HARNESS_PROTOCOL_VERSION,
  storageSchemaVersion: HARNESS_STORAGE_SCHEMA_VERSION,
  appVersion: HARNESS_APP_VERSION,
  producerVersion: HARNESS_PRODUCER_VERSION,
  policyVersion: HARNESS_POLICY_VERSION
});
