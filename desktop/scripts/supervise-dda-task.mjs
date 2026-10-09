// Compatibility entry point; the implementation ships inside dda runtime.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSupervisionCommand } from '../../runtime/src/task-supervision.mjs';
export * from '../../runtime/src/task-supervision.mjs';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runSupervisionCommand(process.argv.slice(2));
  console.log(JSON.stringify(result));
  if (result.ok === false) process.exitCode = 1;
}
