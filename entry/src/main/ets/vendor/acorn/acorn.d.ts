// Minimal typed boundary for Acorn 8.15.0. acorn.js is the unmodified
// dist/acorn.mjs ESM distribution, renamed for Harmony's JS source loader.
// Source SHA-256: b4c8c70200e72bae33cf1085e0ecb1e792c1b6924ed50cab817caf14f51bb249.
// License: src/main/resources/rawfile/third_party/Acorn-8.15.0-LICENSE.txt.
export interface ParseOptions {
  ecmaVersion: number;
  sourceType: string;
}

export function parse(source: string, options: ParseOptions): Object;
