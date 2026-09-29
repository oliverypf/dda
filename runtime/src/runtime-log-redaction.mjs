const SENSITIVE_VALUE_FLAGS = new Set([
  '--prompt', '--title', '--input', '--manifest', '--config-json', '--lease-network-targets'
]);

export const redactRuntimeArgv = (argv) => {
  const input = Array.isArray(argv) ? argv : [];
  const result = [];
  for (let index = 0; index < input.length; index += 1) {
    const token = String(input[index] ?? '');
    const equals = token.indexOf('=');
    if (equals > 0 && SENSITIVE_VALUE_FLAGS.has(token.slice(0, equals))) {
      result.push(`${token.slice(0, equals)}=[REDACTED]`);
      continue;
    }
    result.push(token);
    if (SENSITIVE_VALUE_FLAGS.has(token) && index + 1 < input.length) {
      result.push('[REDACTED]');
      index += 1;
    }
  }
  return result;
};
