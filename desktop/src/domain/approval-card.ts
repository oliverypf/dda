import type { ApprovalReadModel } from './models';

const escapeHtml = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const commandStem = (command: string): string => command
  .replace(/^.*[\\/]/u, '')
  .toLowerCase()
  .replace(/\.(?:exe|cmd|bat|com)$/iu, '');

export const formatCommandLine = (command?: string, args: string[] = []): string => [command, ...args]
  .filter((part): part is string => typeof part === 'string' && part.length > 0)
  .map((part) => (/[\s"]/u.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part))
  .join(' ');

export const describeCommandZh = ({ command = '', args = [] }: { command?: string; args?: string[] }): string => {
  const name = commandStem(command);
  const positional = args.map((item) => item.toLowerCase());
  if (name === 'cargo') {
    const sub = positional.find((item) => item !== '--' && !item.startsWith('-')) ?? '';
    if (sub === 'build') return '将编译当前 Rust 项目，并把产物写入 target 目录';
    if (sub === 'test') return '将编译并运行 Rust 测试';
    if (sub === 'tauri') return '将构建 Tauri 桌面应用，并把产物写入 target 目录';
  }
  if (name === 'tauri' || (positional.includes('tauri') && positional.includes('build'))) {
    return '将构建 Tauri 桌面应用，并把产物写入 target 目录';
  }
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'npx') {
    if (positional.includes('install') || positional.includes('ci')) return '将安装项目依赖';
    const script = positional[0] === 'run' ? positional[1] : ((name === 'yarn' || name === 'pnpm') ? positional[0] : '');
    if (script === 'build' || script.startsWith('build:')) return '将执行 package.json 里的构建脚本';
  }
  const line = [commandStem(command) || command, ...args].join(' ');
  if (/\b(?:rm|rmdir|del|erase|unlink|remove-item)\b/iu.test(line)) return '将删除文件或目录';
  return '将在本机执行这条命令';
};

export const riskReasonsZh = ({ command = '', args = [] }: { command?: string; args?: string[] }): string[] => {
  const name = commandStem(command);
  const lowered = [command, ...args].join(' ').toLowerCase();
  const reasons: string[] = [];
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'npx') {
    if (/\b(?:install|ci|add|update)\b/u.test(lowered)) reasons.push('可能联网下载依赖');
    if (/\brun\b/u.test(lowered) || ((name === 'yarn' || name === 'pnpm') && /\bbuild\b/u.test(lowered))) {
      reasons.push('会执行 package.json 脚本');
    }
  }
  if ((name === 'cargo' && /\b(?:build|test|tauri)\b/u.test(lowered)) || name === 'tauri' || (/\btauri\b/u.test(lowered) && /\bbuild\b/u.test(lowered))) {
    reasons.push('会写 target 目录');
  }
  if (/\b(?:rm|rmdir|del|erase|unlink|remove-item)\b/u.test(lowered)) reasons.push('会删除文件');
  if (reasons.length === 0) reasons.push('会在本机执行命令');
  return reasons;
};

const leadOf = (approval: ApprovalReadModel) => {
  const args = approval.args ?? [];
  const hasCommand = Boolean(approval.command || approval.commandLine || args.length);
  const commandLine = approval.commandLine || (approval.command || args.length ? formatCommandLine(approval.command, args) : '');
  const summary = approval.summaryZh || (hasCommand ? describeCommandZh({ command: approval.command, args }) : '');
  const reasons = approval.riskReasons?.length
    ? approval.riskReasons
    : (hasCommand ? riskReasonsZh({ command: approval.command, args }) : []);
  return { commandLine, summary, reasons };
};

/** Visible part of an approval card. Digests and the approval id stay out of this block. */
export const approvalCardLeadHtml = (approval: ApprovalReadModel): string => {
  const lead = leadOf(approval);
  const host = approval.host
    ? `${approval.method ?? 'GET'} ${approval.scheme ?? 'https'}://${approval.host}${approval.port ? `:${approval.port}` : ''}`
    : '';
  const parts = [
    lead.commandLine ? `<div class="approval-command-line">${escapeHtml(lead.commandLine)}</div>` : '',
    approval.cwd ? `<div class="approval-cwd">工作目录：${escapeHtml(approval.cwd)}</div>` : '',
    lead.summary ? `<p class="approval-summary">${escapeHtml(lead.summary)}</p>` : '',
    lead.reasons.length ? `<p class="approval-risk-reason">风险：${escapeHtml(lead.reasons.join('；'))}</p>` : '',
    approval.path ? `<div class="approval-cwd">路径：${escapeHtml(approval.path)}</div>` : '',
    host ? `<div class="approval-cwd">${escapeHtml(host)}</div>` : ''
  ].filter(Boolean);
  return parts.length ? `<div class="approval-lead">${parts.join('')}</div>` : '';
};

export const approvalAuditHtml = (approval: ApprovalReadModel, riskLabel?: string, expiresLabel?: string): string => {
  const fields: Array<[string, string | undefined]> = [
    ['风险等级', riskLabel],
    ['策略', approval.policyVersion],
    ['有效至', expiresLabel],
    ['工作区快照摘要', approval.scope?.snapshotDigest],
    ['动作摘要', approval.requestDigest],
    ['审批编号', approval.requestId],
    ['审批记录', approval.approvalId]
  ];
  return `<dl class="panel-fields">${fields
    .filter((entry): entry is [string, string] => Boolean(entry[1]))
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('')}</dl>`;
};

export const approvalConfirmationText = (approval: ApprovalReadModel): string => {
  const lead = leadOf(approval);
  const host = approval.host
    ? `${approval.method ?? 'GET'} ${approval.scheme ?? 'https'}://${approval.host}${approval.port ? `:${approval.port}` : ''}`
    : '';
  return [
    lead.commandLine || approval.capability,
    approval.cwd ? `工作目录：${approval.cwd}` : '',
    lead.summary,
    lead.reasons.length ? `风险：${lead.reasons.join('；')}` : '',
    approval.path ? `路径：${approval.path}` : '',
    host
  ].filter(Boolean).join('\n');
};
