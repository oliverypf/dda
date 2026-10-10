import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const root = 'C:/Users/User/hmCodex-local/docs/artifacts';
const batch = join(root, 'agent-goal-runs/20261007T155025244Z-90c4fb48');
const cases = [];
for (const name of (await readdir(batch)).sort()) {
  let result; try { result = JSON.parse(await readFile(join(batch, name, 'result.json'), 'utf8')); } catch { continue; }
  const requests = JSON.parse(await readFile(join(batch, name, 'model-requests.json'), 'utf8'));
  cases.push({ ...result, observedProviderFailures: requests.filter(request => request.error).map(request => ({ sequence: request.sequence,
    upstreamStatus: request.upstreamStatus ?? null, error: request.error, transportCode: request.transportErrorCode ?? null })),
    originalResultSha256: createHash('sha256').update(await readFile(join(batch, name, 'result.json'))).digest('hex') });
}
const availability = JSON.parse(await readFile(join(root, 'GOAL_MODEL_AVAILABILITY_2026-10-08.json'), 'utf8'));
const report = { generatedAt: new Date().toISOString(), status: 'ABORTED_PROVIDER_IMPAIRMENT', batchId: '20261007T155025244Z-90c4fb48',
  runtimeSourceSha256: '2f4cf8b2dc3533b1f31d1ed6ff0de4b23ed3cd5044fa093c15b8896cf25f6320', plannedRuns: 24, completedRuns: cases.length,
  preservedOriginalRows: cases, incompleteOrUnstartedRuns: 24 - cases.length,
  terminatedActiveCase: '1-code-feature-001-ordinary-codex', activeCaseOutcome: 'UNKNOWN_AFTER_EXPLICIT_TEST_TERMINATION',
  stopEvidence: 'Both clients observed repeated Pro HTTP500 responses; a minimal Pro call timed out while a same-account Flash call returned200. Only the verified test harness PID12736 and its own children were terminated.',
  modelAvailability: availability, completedFullComparison: false, provesCurrentEconomicAdvantage: false,
  caveats: ['Original successful, failed and timed-out rows remain unchanged. No interrupted or unstarted case is credited.',
    'The incomplete active case had live in-memory request records that the terminated parent could not finalize; usage and fees remain unknown.',
    'Provider impairment prevents quality, speed or economic advantage attribution from this partial batch.'], goalStatus: 'active' };
await writeFile(join(root, 'AGENT_GOAL_DIAGNOSTIC_RECOVERY_ABORTED_2026-10-08.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
await writeFile(join(root, 'AGENT_GOAL_DIAGNOSTIC_RECOVERY_ABORTED_2026-10-08.md'), [
  '# Pro 对照中止记录：2026-10-08', '', `原计划 24 次，已完成 ${cases.length} 次；其余中断或未执行。`, '',
  '双方均遭遇 Pro HTTP500；最小 Pro 请求超时，同账号 Flash 最小请求成功。为避免连续重试，已终止唯一核实的测试进程及其子进程。原始成功、失败和超时结果全部保留；未完成项目不计通过，不据此宣称任何客户端优势。', '',
  '这是明确终止的测试批次，不是观察超时。后续将在修正测试验收边界后，用双方相同的 Flash 模型运行完整固定任务集；真实 Pro 升级仍需路由恢复。', '',
  '[完整中止记录](C:/Users/User/hmCodex-local/docs/artifacts/AGENT_GOAL_DIAGNOSTIC_RECOVERY_ABORTED_2026-10-08.json) · [路由探针](C:/Users/User/hmCodex-local/docs/artifacts/GOAL_MODEL_AVAILABILITY_2026-10-08.json)', ''
].join('\n'), { flag: 'wx' });
console.log(JSON.stringify({ completedRuns: cases.length, statuses: cases.map(row => ({ task: row.taskId, client: row.client, status: row.status })) }));
