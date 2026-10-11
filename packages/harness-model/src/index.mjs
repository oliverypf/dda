// @dda/harness-model — platform-agnostic surface shared by every dda client.
//
// This package intentionally has no runtime dependencies and no platform code.
// It only holds value objects, vocabulary and the stable CLI contract so that
// linux-cli, the desktop shell and (eventually) the HarmonyOS client can agree
// on the same semantics while the heavy behaviour is extracted incrementally
// out of runtime/src/index.mjs. See docs/MONOLITH_EXTRACTION_STATUS.md for an
// honest account of what still lives in the monolith.

export * from './versions.mjs';
export * from './exit-codes.mjs';
export * from './event-kinds.mjs';
