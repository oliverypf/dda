// The shared runtime loads `node:sqlite` (DatabaseSync / backup), which only
// exists on Node.js 24+. Running the CLI on an older Node surfaces an obscure
// ERR_UNKNOWN_BUILTIN_MODULE / missing-export failure from deep inside the
// runtime child. Check the version up front so the CLI fails cleanly with a
// DEPENDENCY_ERROR that names the real requirement instead.
export const MINIMUM_NODE_MAJOR = 24;

export function parseNodeMajor(version) {
  const match = /^v?(\d+)\./u.exec(String(version ?? ''));
  return match ? Number(match[1]) : undefined;
}

// Returns { ok: true } when the runtime is new enough, otherwise an object
// describing the DEPENDENCY_ERROR the caller should report.
export function checkNodeVersion(version = process.version) {
  const major = parseNodeMajor(version);
  if (major !== undefined && major >= MINIMUM_NODE_MAJOR) return { ok: true, major };
  return {
    ok: false,
    code: 'DEPENDENCY_ERROR',
    detected: String(version ?? ''),
    required: `>=${MINIMUM_NODE_MAJOR}.0.0`
  };
}
