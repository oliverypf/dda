import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const s = readFileSync(resolve(root, 'src/main.ts'), 'utf8');
const c = readFileSync(resolve(root, 'src/styles.css'), 'utf8');

const checks = {
  'S3-01-six-pages': s.includes('data-page="workbench"') && s.includes('data-page="runs"') && s.includes('data-page="workspace"') && s.includes('data-page="memory"') && s.includes('data-page="safety"') && s.includes('data-page="diagnostics"'),
  'S3-01-nav-state': s.includes("hmcodex.activePage") && s.includes("hmcodex.nav"),
  'S3-01-status-shell': s.includes('renderPageStatus') && c.includes('page-status-stale'),
  'S3-02-receipt': s.includes('lastSubmitReceipt') && s.includes('pending') && s.includes('accepted') && s.includes('rejected'),
  'S3-02-next-step': s.includes('runStateNextStep') && s.includes("QUARANTINED: '已隔离，需查看原因并处理治理状态后再发起新任务。'"),
  'S3-04-quarantine-terminal': s.includes("['SUCCEEDED', 'FAILED', 'CANCELLED', 'QUARANTINED']"),
  'S3-03-route-panel': s.includes('renderRoutePanel') && s.includes('pinnedModel'),
  'S3-04-approval-workbench': s.includes('renderApprovalCard') && s.includes('workbench-approvals'),
  'S3-05-timeline-evidence': s.includes('timeline-details') && s.includes('evidenceKind'),
  'S3-05-terminal-panel': s.includes('renderEvidencePanel') && s.includes('evidence-panel'),
  'S3-05-verifier-unknown-not-success': s.includes("payload.status === 'UNKNOWN' || payload.status === 'ABSTAIN' ? 'PENDING'") && s.includes('data-verification-unknown'),
  'S3-06-runs-page': s.includes('renderRunsPage') && s.includes('runsPage') && s.includes('focus-run'),
  'S3-06-run-focus-persist': s.includes('hmcodex.focusedRunId') && s.includes("localStorage.getItem('hmcodex.focusedRunId')"),
  'S3-06-decision-dag-workbench': s.includes('renderDecisionTrace'),
  'S3-07-workspace-page': s.includes('renderWorkspacePage'),
  'S3-07-memory-page': s.includes('renderMemoryPage') && s.includes('run-dream') && s.includes('start-dream-maintenance'),
  'S3-07-safety-page': s.includes('renderSafetyPage') && s.includes('executionTypeLabel'),
  'S3-07-diagnostics-page': s.includes('renderDiagnosticsPage') && s.includes('run-recovery-check'),
  'S3-09-a11y': c.includes('prefers-reduced-motion') && c.includes('pointer: coarse') && c.includes('prefers-contrast')
};

const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
const payload = { checkedAtMs: Date.now(), total: Object.keys(checks).length, missing, checks };

const artifactDir = resolve(root, '..', 'docs', 'artifacts');
const artifactPath = resolve(artifactDir, 'WINDOWS_PHASE3_EVIDENCE.json');
mkdirSync(artifactDir, { recursive: true });
writeFileSync(artifactPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
process.stdout.write('artifact=' + artifactPath + '\n');
process.exitCode = missing.length ? 1 : 0;

