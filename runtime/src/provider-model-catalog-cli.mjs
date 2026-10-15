#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { defaultModelConfigPath } from './model-config.mjs';
import { runCatalogCli } from './provider-model-catalog.mjs';

const readStdin = async () => {
  if (process.argv[2] !== 'save') return undefined;
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

const configPath = process.env.DDA_MODEL_CONFIG?.trim() || defaultModelConfigPath();
let result;
try {
  const stdin = process.argv[2] === 'save' ? await readStdin() : undefined;
  result = await runCatalogCli({
    command: process.argv[2],
    configPath,
    env: process.env,
    stdin,
    fetchImpl: globalThis.fetch,
    createSessionId: () => randomUUID()
  });
} catch {
  result = { ok: false, error: '模型目录命令失败。' };
}
process.stdout.write(`${JSON.stringify(result)}\n`);
