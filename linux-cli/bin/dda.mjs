#!/usr/bin/env node
import { checkNodeVersion } from '../src/node-check.mjs';

// Fail cleanly before importing the rest of the CLI (and before the runtime
// child loads node:sqlite) when the host Node is older than the runtime needs.
const node = checkNodeVersion(process.version);
if (!node.ok) {
  process.stderr.write(`错误  DEPENDENCY_ERROR  Node、runtime 或 provider 依赖不可用。Linux CLI 需要 Node.js 24 或更新版本（当前 ${node.detected}，需要 ${node.required}）\n`);
  process.exit(10);
}

const { main } = await import('../src/main.mjs');
const { createStdioApprovalIO } = await import('../src/terminal-approval.mjs');

// CONTROLLED tasks need a real approval channel: `--approval-mode prompt`
// asks y/N on the terminal (stdin and stderr must both be TTYs) and
// `--approval-mode jsonl` reads approval_response lines from stdin. Without
// this wiring every prompt answer was treated as a denial and jsonl requests
// waited until they expired.
const approval = createStdioApprovalIO({ stdin: process.stdin, stderr: process.stderr });
let code;
try {
  code = await main(process.argv.slice(2), {
    stdin: process.stdin,
    approvalInput: approval.approvalInput,
    readApprovalLine: approval.readApprovalLine
  });
} finally {
  approval.close();
}
process.exitCode = code ?? 0;
