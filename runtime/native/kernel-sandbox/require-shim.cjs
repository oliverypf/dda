'use strict';
/**
 * --require entry for sandboxed cell workers (F3/30th).
 * Must be .cjs (never bare .node / .js / .mjs). Loads the .node addon then
 * synchronously calls installFromHandoff() before returning so policy is in
 * place before libuv's thread pool / worker main / canary / cell code.
 */
const path = require('node:path');
const addonPath = path.join(__dirname, 'build', 'Release', 'dda_kernel_sandbox.node');
const addon = require(addonPath);
if (typeof addon.installFromHandoff !== 'function') {
  throw new Error('SANDBOX_UNAVAILABLE:installFromHandoff missing');
}
addon.installFromHandoff();
module.exports = addon;
