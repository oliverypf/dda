#!/usr/bin/env node
// Operator tool for the Prime Phase-2a host-owned kernel effect denylist.
// It can only ADD denials (there is no remove); clearing the denylist is an
// explicit operator action: delete the file. A file whose digest does not
// verify fails closed at runtime (every kernel effect key is denied).
//
//   node scripts/kernel-effect-denylist.mjs list   [--file PATH]
//   node scripts/kernel-effect-denylist.mjs verify [--file PATH]
//   node scripts/kernel-effect-denylist.mjs add --kind fs.write --risk workspace_write [--mode CONTROLLED] [--reason TEXT] [--file PATH]
import { createKernelEffectDenylist, kernelEffectDenylistKey } from '../src/kernel/effects.mjs';
import { resolveStoreFile } from '../src/platform/paths.mjs';

const args = process.argv.slice(2);
const command = args[0];
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const storagePath = option('--file', process.env.DDA_KERNEL_EFFECT_DENYLIST ?? resolveStoreFile('kernel-effect-denylist.json'));
const denylist = createKernelEffectDenylist({ storagePath });
const { integrity } = await denylist.load();

if (command === 'list' || command === 'verify') {
  process.stdout.write(`${JSON.stringify({ storagePath, integrity, entries: command === 'list' ? await denylist.list() : undefined }, null, 2)}\n`);
  process.exitCode = integrity === 'TAMPERED' ? 2 : 0;
} else if (command === 'add') {
  const key = kernelEffectDenylistKey({
    executionMode: option('--mode', 'CONTROLLED'),
    effectKind: option('--kind'),
    riskClass: option('--risk')
  });
  const result = await denylist.add(key, { reason: option('--reason', 'OPERATOR') });
  process.stdout.write(`${JSON.stringify({ storagePath, key, ...result })}\n`);
} else {
  process.stderr.write('usage: kernel-effect-denylist.mjs list|verify|add --kind <fs.write|fs.patch|test.run> --risk <class> [--mode CONTROLLED] [--reason TEXT] [--file PATH]\n');
  process.exitCode = 1;
}
