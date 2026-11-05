import { describe, expect, it } from 'vitest';
// @ts-ignore node builtin available under vitest
import { readFileSync } from 'node:fs';
import mainSource from '../main.ts?raw';
import { approvalAuditHtml, approvalCardLeadHtml, approvalConfirmationText } from './approval-card';
import type { ApprovalReadModel } from './models';

const approval = (patch: Partial<ApprovalReadModel>): ApprovalReadModel => ({
  requestId: 'approval-9f3c',
  capability: 'shell.execute',
  requestDigest: 'sha256:' + 'ab'.repeat(32),
  approvalId: 'intent-approval-1',
  risk: 'HIGH',
  state: 'REQUESTED',
  createdAtMs: 1,
  ...patch
});

describe('approval card lead', () => {
  it('shows the full command, directory, and the concrete risk before any digest', () => {
    const card = approval({
      command: 'cargo',
      args: ['build', '--release'],
      cwd: 'desktop/src-tauri',
      scope: { snapshotDigest: 'sha256:' + 'cd'.repeat(32) }
    });
    const lead = approvalCardLeadHtml(card);
    expect(lead).toContain('cargo build --release');
    expect(lead).toContain('工作目录：desktop/src-tauri');
    expect(lead).toContain('将编译当前 Rust 项目，并把产物写入 target 目录');
    expect(lead).toContain('风险：会写 target 目录');
    expect(lead).not.toContain('sha256');
    expect(lead).not.toContain('高风险');
    expect(lead).not.toContain(card.requestId);
    expect(lead).not.toContain(card.approvalId);

    const npm = approvalCardLeadHtml(approval({ command: 'npm', args: ['run', 'build'], cwd: 'desktop' }));
    expect(npm).toContain('npm run build');
    expect(npm).toContain('将执行 package.json 里的构建脚本');
    expect(npm).toContain('会执行 package.json 脚本');
    expect(approvalCardLeadHtml(approval({ command: 'npm', args: ['install'] }))).toContain('可能联网下载依赖');
    expect(approvalCardLeadHtml(approval({ command: 'npm', args: ['ci'] }))).toContain('将安装项目依赖');
    expect(approvalCardLeadHtml(approval({ command: 'cargo', args: ['test'] }))).toContain('将编译并运行 Rust 测试');
    expect(approvalCardLeadHtml(approval({ command: 'npx', args: ['tauri', 'build'] }))).toContain('将构建 Tauri 桌面应用，并把产物写入 target 目录');
    expect(approvalCardLeadHtml(approval({ command: 'rm', args: ['notes.txt'] }))).toContain('会删除文件');
    expect(approvalCardLeadHtml(approval({ command: 'node', args: ['-e', 'ok'] }))).toContain('将在本机执行这条命令');
  });

  it('uses the recorded summary and escapes the command line', () => {
    const lead = approvalCardLeadHtml(approval({
      command: 'npm',
      args: ['run', 'build', '<script>'],
      commandLine: 'npm run build "<script>"',
      summaryZh: '将执行 package.json 里的构建脚本',
      riskReasons: ['会执行 package.json 脚本'],
      cwd: 'desktop'
    }));
    expect(lead).toContain('npm run build');
    expect(lead).toContain('&lt;script&gt;');
    expect(lead).not.toContain('<script>');
    expect(lead).toContain('会执行 package.json 脚本');
  });

  it('puts digests, the approval id, and the risk grade in the collapsed audit block', () => {
    const card = approval({
      policyVersion: 'runtime-safety-1',
      scope: { snapshotDigest: 'sha256:snapshot' }
    });
    const audit = approvalAuditHtml(card, '高', '12:00');
    expect(audit).toContain('风险等级');
    expect(audit).toContain('>高<');
    expect(audit).not.toContain('高风险');
    expect(audit).toContain(card.requestDigest);
    expect(audit).toContain('sha256:snapshot');
    expect(audit).toContain(card.requestId);
    expect(audit).toContain(card.approvalId ?? '');
    expect(audit).toContain('runtime-safety-1');
    expect(approvalConfirmationText(card)).not.toContain('sha256');
    expect(approvalConfirmationText({ ...card, command: 'cargo', args: ['build'], cwd: 'desktop' })).toContain('cargo build');
    expect(approvalConfirmationText({ ...card, command: 'cargo', args: ['build'], cwd: 'desktop' })).not.toContain(card.requestDigest);
  });

  it('renders the lead before the collapsed audit section in the desktop card', () => {
    const card = mainSource.slice(mainSource.indexOf('const renderApprovalCard'), mainSource.indexOf('let approvalConfirmation'));
    expect(card.indexOf('approvalCardLeadHtml')).toBeGreaterThan(-1);
    expect(card.indexOf('approvalCardLeadHtml')).toBeLessThan(card.indexOf('查看审批核对信息'));
    const collapsed = card.slice(card.indexOf('查看审批核对信息'));
    expect(collapsed).toContain('approvalAuditHtml');
    expect(card).not.toContain('approval-risk-${');
    const confirm = mainSource.slice(mainSource.indexOf('const confirmHighRiskApproval'), mainSource.indexOf('let subAgentsCollapsed'));
    expect(confirm).toContain('approvalConfirmationText');
    expect(confirm).not.toContain('动作摘要');
    const styles = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    expect(styles).toContain('.approval-command-line');
    expect(styles).toContain('.approval-risk-reason');
  });
});
