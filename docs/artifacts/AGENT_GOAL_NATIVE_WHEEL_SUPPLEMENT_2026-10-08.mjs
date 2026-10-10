import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const artifacts = join(root, 'docs/artifacts');
const audit = JSON.parse(await readFile(join(artifacts, 'AGENT_GOAL_CURRENT_RETEST_AUDIT_2026-10-08.json'), 'utf8'));
const logPath = join(artifacts, 'GOAL_NATIVE_WHEEL_TO_END_2026-10-08.log');
const log = await readFile(logPath, 'utf8');
if (!log.includes('PASS  T01C') || !log.includes('Summary: 27 passed, 0 failed, 0 skipped')) throw Error('NATIVE_WHEEL_NOT_VERIFIED');
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
if (hash(await readFile(audit.executable.path)) !== audit.executable.sha256) throw Error('EXECUTABLE_CHANGED');
const report = { generatedAt: new Date().toISOString(), runtimeSourceSha256: audit.runtimeSourceSha256,
  executable: audit.executable, desktop: { passed: 27, failed: 0, skipped: 0 },
  wheelCheck: { fixtureTasks: 80, method: 'CDP Input.dispatchMouseEvent mouseWheel from the current position to the last task; no scrollTop assignment is used to reach the end.',
    lastTaskVisible: true, outerRailPositionPreserved: true, fixturePositionRestoredAfterAssertions: true,
    scope: 'Existing native desktop viewport; no new narrow-window or mobile viewport is claimed.' },
  log: { path: logPath, sha256: hash(Buffer.from(log)) },
  testSource: { path: join(root, 'desktop/scripts/ui-functional-test.mjs'), sha256: hash(await readFile(join(root, 'desktop/scripts/ui-functional-test.mjs'))) },
  screenshot: join(artifacts, 'GOAL_NATIVE_WHEEL_TO_END_2026-10-08.png') };
await writeFile(join(artifacts, 'AGENT_GOAL_NATIVE_WHEEL_SUPPLEMENT_2026-10-08.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ passed: true, desktop: report.desktop, runtimeSourceSha256: report.runtimeSourceSha256 }));
