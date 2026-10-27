#!/usr/bin/env bash
# Post-SCAN one-shot: resolve CLOSED runId → node on-closed.mjs --run N → print action.
# See post-scan-on-closed.mjs / README 「扫收」checklist.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/post-scan-on-closed.mjs" "$@"
