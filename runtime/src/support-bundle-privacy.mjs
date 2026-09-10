const FORBIDDEN_KEY = /^(prompt|prompts|messages|reasoning|chain[_-]?of[_-]?thought|credentials?|password|passwd|secret|token|authorization|api[_-]?key|private[_-]?key|source[_-]?code|raw[_-]?trajectory|stdout|stderr|command|content|code|output|output_text|model_output)$/iu;
const FORBIDDEN_VALUE = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|bearer|private\s+key)\s*[:=]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9]{16,}\b/iu;
const MAX_VIOLATIONS = 32;

export const scanSupportBundle = (bundle) => {
  const violations = [];
  const visit = (value, path) => {
    if (violations.length >= MAX_VIOLATIONS) return;
    if (typeof value === 'string' && FORBIDDEN_VALUE.test(value)) {
      violations.push({ path, reason: 'SENSITIVE_VALUE' });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEY.test(key)) violations.push({ path: childPath, reason: 'FORBIDDEN_FIELD' });
      if (violations.length >= MAX_VIOLATIONS) return;
      visit(child, childPath);
      if (violations.length >= MAX_VIOLATIONS) return;
    }
  };
  visit(bundle?.stores ?? {}, 'stores');
  return { ok: violations.length === 0, violations: violations.slice(0, MAX_VIOLATIONS) };
};

export const redactSensitiveData = (value) => {
  const removed = [];
  const redact = (input, path) => {
    if (typeof input === 'string' && FORBIDDEN_VALUE.test(input)) {
      removed.push(path);
      return '[REDACTED]';
    }
    if (Array.isArray(input)) return input.map((item, index) => redact(item, `${path}[${index}]`));
    if (!input || typeof input !== 'object') return input;
    const result = {};
    for (const [key, child] of Object.entries(input)) {
      const childPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEY.test(key) || (typeof child === 'string' && FORBIDDEN_VALUE.test(child))) {
        removed.push(childPath);
        continue;
      }
      result[key] = redact(child, childPath);
    }
    return result;
  };
  return { value: redact(value, ''), removed };
};
