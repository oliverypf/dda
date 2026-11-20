// Spawn failures carry errno details, but error.message, syscall, path and
// spawnargs can echo workspace paths, environment values or user arguments.
// Surface only a bounded OS error code so diagnostics stay safe to persist.
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/u;

export const spawnErrorReason = (error) => (
  typeof error?.code === 'string' && SAFE_ERROR_CODE.test(error.code) ? error.code : 'UNKNOWN'
);
