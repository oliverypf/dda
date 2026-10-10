import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const root = 'C:/Users/User/hmCodex-local';
const source = await readFile(`${root}/runtime/src/decision/process-intent.mjs`, 'utf8');
const monitor = pathToFileURL(`${root}/runtime/src/runtime-safety-monitor.mjs`).href;
const header = `import { parseCommand } from '${monitor}';\n
export const normalizedNodeProcessRequest = (request = {}) => {
  try {
    const parsed = parseCommand(request);
    if (!['node', 'node.exe'].includes(parsed.command)) return undefined;
    return { ...request, command: parsed.command, args: parsed.args };
  } catch { return undefined; }
};\n`;
const draft = header + source.replace("export const nodeProcessIntent = (request = {}) => {", `export const nodeProcessIntent = (request = {}) => {
  request = normalizedNodeProcessRequest(request);
  if (!request) return undefined;`);
if (!draft.includes('request = normalizedNodeProcessRequest(request);')) throw Error('DRAFT_NODE_COMMAND_PREPARE_FAILED');
await writeFile('docs/artifacts/GOAL_NODE_COMMAND_FIX_DRAFT_2026-10-08.mjs', draft, { flag: 'wx' });
console.log('Prepared isolated draft; production runtime unchanged.');
