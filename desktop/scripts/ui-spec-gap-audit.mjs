import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const mainPath = fileURLToPath(new URL('../src/main.ts', import.meta.url));
const specPath = fileURLToPath(new URL('../../docs/UI_UX_SPEC.md', import.meta.url));
const testPaths = [fileURLToPath(new URL('./ui-diagnostics-test.mjs', import.meta.url)), fileURLToPath(new URL('./ui-memory-test.mjs', import.meta.url))];
const [source, spec, ...tests] = await Promise.all([readFile(mainPath, 'utf8'), readFile(specPath, 'utf8'), ...testPaths.map((path) => readFile(path, 'utf8'))]);
const testEvidence = tests.join('\n');
const checks = [
  { id: 'diff-proposed-executed-verified', label: 'Diff 分层 proposed/executed/verified', patterns: [/proposed/i, /executed/i, /verified/i], ui: /diff|变更|差异/i, requiredSurface: /data-diff-state|renderWorkspaceDiff/i, missingEvidence: [] },
  { id: 'council-proposal-critique-judge-probe', label: 'Council Proposal/Critique/Judge/Probe UI', patterns: [/Proposal/i, /Critique/i, /Judge/i, /Probe/i], ui: /council|审议/i, requiredSurface: /data-council-kind|renderCouncilPanel/i, missingEvidence: [] },
  { id: 'memory-sensitivity-version-conflict', label: 'Memory 敏感性/版本/冲突操作', patterns: [/sensitivity/i, /conflict/i, /supersed/i, /memory.*version/i], ui: /memory|记忆/i, requiredSurface: /data-action=\"memory-action\"[^>]*(?:sensitivity|supersed|conflict)|memoryAction\([^)]*(?:sensitivity|supersed|conflict)/i, missingEvidence: [] },
  { id: 'export-flow', label: '导出动作与完成反馈', patterns: [/export-data/i, /support.?bundle/i], ui: /export|导出|support.?bundle/i },
  { id: 'recovery-detail-page', label: '恢复页远端/workspace/approval/lease 详情', patterns: [/remote/i, /workspace.*diff/i, /pending.*approval/i, /revoked.*lease/i], ui: /恢复|recovery/i, requiredSurface: /逐项恢复事实|recovery-details|data-recovery-remote-state/i, missingEvidence: [] },
];
const results = checks.map((check) => {
  const sourceHits = check.patterns.filter((pattern) => pattern.test(source)).length;
  const uiHit = check.ui.test(source);
  const surfaceHit = check.requiredSurface ? check.requiredSurface.test(source) : uiHit;
  const evidenceComplete = (!check.missingEvidence || check.missingEvidence.length === 0) && (check.id === 'export-flow' || testEvidence.length > 0);
  const status = sourceHits === check.patterns.length && uiHit && surfaceHit && evidenceComplete ? 'PASS' : 'PARTIAL';
  return { id: check.id, label: check.label, status, sourceHits, required: check.patterns.length, uiSurfacePresent: uiHit, requiredSurfacePresent: surfaceHit, ...(status === 'PARTIAL' ? { missingEvidence: check.missingEvidence ?? ['运行时端到端证据'] } : {}) };
});
const output = { heuristic: true, note: 'Source heuristic only; PASS requires keyword evidence plus a matching UI surface marker, and still does not prove the full runtime flow.', generatedAt: new Date().toISOString(), spec: spec.includes('## 11.') && spec.includes('## 18.'), results, overall: results.every((result) => result.status === 'PASS') ? 'PASS' : 'PARTIAL' };
console.log(JSON.stringify(output, null, 2));
if (process.argv.includes('--strict') && output.overall !== 'PASS') process.exitCode = 2;
