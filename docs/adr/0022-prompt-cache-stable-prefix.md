# Stable provider prompt-cache prefixes and usage accounting

## Status

Accepted for Windows Phase 4 on 2026-09-15.

## Context

dda previously sent valid model requests but did not persist provider-reported cached input tokens. Historical cache hit rate is therefore unknown. A value of zero would be misleading because it would mix uninstrumented calls with reported cache misses.

Provider prompt caches reuse an identical request prefix. They do not cache model answers and do not grant permission to reuse a prior execution result. The useful ideas adopted from Reasonix are deterministic prompt structure, append-only conversation turns, stable cache routing per workspace/model/role, and explicit cache hit/miss accounting.

## Decision

- Keep system instructions and tool schemas stable. Canonicalize object keys and sort the unordered tool catalogue before each provider request.
- Put bounded workspace context before dynamic history and the current user prompt. Append tool calls and results without rewriting earlier turns.
- Derive provider cache routing identifiers from hashed workspace scope, endpoint, model, role, system instructions, and tool definitions. Never send a workspace path, prompt, source text, credential, or thread identifier in a cache header.
- Isolate planner, executor, candidate, verifier, council, and judge cache routes.
- Read exact usage from provider responses. Persist one redacted `ModelUsageRecorded` fact per invocation, including failed and cancelled calls when available.
- Calculate `cacheHitRate = cachedInputTokens / cacheEligibleInputTokens` and report `cacheCoverage = cacheReportedCalls / calls`. Missing provider cache fields remain `UNKNOWN`.
- Show input, cached input, uncached input, hit rate, and coverage together. A high hit rate must not be optimized by sending unnecessary context.
- Keep canonical event history separate from provider-visible context. Add cache-aware compaction only after real usage measurements show a need near the context limit.

`HMCODEX_PROMPT_CACHE=off` restores the prior request layout and random session routing. `HMCODEX_STREAM_USAGE=off` disables Chat Completions `stream_options.include_usage` for an incompatible gateway.

## Consequences

Existing history has no reliable cache metric. Measurements start with this instrumentation and must be labeled `SINCE_USAGE_INSTRUMENTATION`. No fixed 99% hit rate is promised; the observed rate depends on provider support, prefix stability, workspace changes, role traffic, and context length. The Windows Node/Cordis runtime owns this behavior directly; no App Server is introduced.

