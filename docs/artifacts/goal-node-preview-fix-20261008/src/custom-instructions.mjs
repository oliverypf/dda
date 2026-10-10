// Operator preferences are global configuration, separate from task/workspace data.
export const normalizeCustomInstructions = (value) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('MODEL_CONFIG_INVALID_FIELD:customInstructions');
  const text = value.trim();
  if (text.length > 8000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    throw new Error('MODEL_CONFIG_INVALID_FIELD:customInstructions');
  }
  return text || undefined;
};

// Wrap before usage tracking so cache-prefix telemetry describes the actual
// system prompt. Each request gets one copy, including tool rounds and roles.
export const withCustomInstructions = (provider, value) => {
  const instructions = normalizeCustomInstructions(value);
  if (!instructions) return provider;
  return {
    ...provider,
    stream(request) {
      const system = [request.system,
        'User custom instructions (apply alongside the role requirements, required output format, and host capability limits):',
        instructions].filter(Boolean).join('\n\n');
      return provider.stream({ ...request, system });
    }
  };
};
