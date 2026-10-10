#!/usr/bin/env node
import { main } from '../src/main.mjs';
import { createStdioApprovalIO } from '../src/terminal-approval.mjs';

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
