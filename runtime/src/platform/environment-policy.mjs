const RUNTIME_ALLOW = [
  /^PATH$/u,
  /^HOME$/u,
  /^USER$/u,
  /^LOGNAME$/u,
  /^LANG$/u,
  /^LC_[A-Z0-9_]+$/u,
  /^XDG_[A-Z0-9_]+$/u,
  /^HMCODEX_(?!.*(?:KEY|TOKEN|SECRET|PASSWORD))[A-Z0-9_]+$/u,
  /^TERM$/u,
  /^SHELL$/u,
  /^TMPDIR$/u,
  /^TZ$/u,
  /^USERPROFILE$/u,
  /^APPDATA$/u,
  /^LOCALAPPDATA$/u,
  /^HOMEDRIVE$/u,
  /^HOMEPATH$/u,
  /^SystemRoot$/u,
  /^WINDIR$/u,
  /^TEMP$/u,
  /^TMP$/u,
  /^PATHEXT$/u,
  /^COMSPEC$/u
];

const SECRET_KEY = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)(?:_|$)/iu;
const SECRET_TEXT = /Bearer\s+\S+|((?:api[_-]?key|token|authorization|password)\s*[=:]\s*)\S+/giu;

const isAllowedRuntimeKey = (key, extraKeys) => extraKeys.has(key)
  || RUNTIME_ALLOW.some((pattern) => pattern.test(key));

/**
 * Environment passed to the runtime process. Provider key variables are
 * forwarded only when the caller names them. Values are never returned by
 * the redaction helpers.
 */
export function buildRuntimeEnv(input = {}, { extraKeys = [] } = {}) {
  const allowedExtras = new Set(extraKeys.filter((key) => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)));
  const env = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue;
    if (!isAllowedRuntimeKey(key, allowedExtras)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Controlled children receive only the declared delta. The parent environment
 * is not copied.
 */
export function buildChildEnv(delta = {}) {
  if (!delta || typeof delta !== 'object' || Array.isArray(delta)) throw new Error('CHILD_ENV_INVALID');
  const env = {};
  const entries = Object.entries(delta);
  if (entries.length > 32) throw new Error('CHILD_ENV_INVALID');
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || SECRET_KEY.test(key) || typeof value !== 'string' || value.length > 4096 || value.includes('\0')) {
      throw new Error('CHILD_ENV_INVALID');
    }
    env[key] = value;
  }
  return env;
}

export function redactText(value) {
  return String(value ?? '').replace(SECRET_TEXT, (match, prefix) => prefix ? `${prefix}[REDACTED]` : 'Bearer [REDACTED]');
}
