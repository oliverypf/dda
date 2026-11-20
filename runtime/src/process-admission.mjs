#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDecisionEngine } from './decision/engine.mjs';
import { createJevClient } from './decision/jev-client.mjs';
import { defaultModelConfigPath, isDecisionPlaneConfigured, loadModelConfig, resolveDecisionConfig } from './model-config.mjs';

const value = (name) => {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) return args[index + 1]?.startsWith('--') ? undefined : args[index + 1];
    if (args[index].startsWith(`${name}=`)) return args[index].slice(name.length + 1);
  }
};

export async function admitSideProcess({ command, operation, env = process.env } = {}) {
  let fileConfig = {};
  try {
    fileConfig = await loadModelConfig(defaultModelConfigPath(env), { required: false });
  } catch {
    fileConfig = {};
  }
  const configured = isDecisionPlaneConfigured({ fileConfig, env });
  const decisionConfig = resolveDecisionConfig({ fileConfig, env });
  const apiKey = env[decisionConfig.apiKeyEnv]?.trim();
  const client = apiKey
    ? createJevClient({
        endpoint: decisionConfig.endpoint,
        apiKey,
        model: decisionConfig.model,
        timeoutMs: decisionConfig.timeoutMs,
        verificationTimeoutMs: decisionConfig.verificationTimeoutMs
      })
    : undefined;
  const engine = createDecisionEngine({
    client,
    enabled: configured && decisionConfig.enabled && Boolean(apiKey),
    enforce: decisionConfig.enforce,
    config: decisionConfig
  });
  return engine.decideProcessAdmission({ command, operation });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const admission = await admitSideProcess({ command: value('--command'), operation: value('--operation') });
    console.log(JSON.stringify({ ok: true, decision: admission.decision, source: admission.source, reasonCode: admission.reasonCode }));
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}
