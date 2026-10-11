// @dda/harness-core — the "core" half of the architecture split.
//
// Today this package exposes HarnessFacade: the stable entry surface platform
// shells (starting with linux-cli) use to drive the runtime. The heavy agent
// behaviour still lives in runtime/src/index.mjs; the facade drives it as a
// supervised child process. As behaviour is extracted out of the monolith,
// it will land here behind the same facade surface, so shells do not change.
//
// See docs/MONOLITH_EXTRACTION_STATUS.md for what is and is not extracted yet.

export { HarnessFacade, createHarnessFacade, optionsToArgs } from './harness-facade.mjs';

// Re-export the shared model so shells can depend on a single entry point.
export * from '../../harness-model/src/index.mjs';
