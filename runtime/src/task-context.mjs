// Host-owned memory of successful tool results. Later rounds and plan steps
// receive this list so a check reuses an earlier path or command instead of
// searching for a new one. It is not tied to one task type.
export const TASK_CONTEXT_MARKER = 'HOST_TASK_CONTEXT:';
export const MAX_TASK_CONTEXT_FACTS = 24;

const clean = (value, max = 180) => String(value ?? '')
  .replace(/[\u0000-\u001f\u007f\r\n]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, max);

export function factFromToolSuccess(name, output, request = {}) {
  if (!name || !output || output.ok === false) return undefined;
  const path = clean(typeof output.path === 'string' && output.path ? output.path : request.path, 220);
  const command = clean(request.command, 120);
  const args = Array.isArray(request.args) ? clean(request.args.join(' '), 120) : '';
  const cwd = clean(request.cwd, 120);
  const digest = clean(output.contentDigest || output.digest || output.outputDigest || '', 80);
  const exitCode = Number.isInteger(output.exitCode) ? output.exitCode : undefined;
  if (!path && !command) return undefined;
  const key = path ? `path:${path}` : `cmd:${cwd}:${command}:${args}`;
  return {
    key,
    tool: clean(name, 80),
    ...(path ? { path } : {}),
    ...(command ? { command } : {}),
    ...(args ? { args } : {}),
    ...(cwd ? { cwd } : {}),
    ...(digest ? { digest } : {}),
    ...(exitCode !== undefined ? { exitCode } : {})
  };
}

// Only the host callback returns this receipt after observing the invocation
// and re-opening the reported paths. Raw tool output is never a substitute.
export function factFromProcessReceipt(receipt) {
  const args = receipt.args.map(arg => /\s/u.test(arg) ? JSON.stringify(arg) : arg).join(' ');
  const artifacts = receipt.artifacts.filter(file => file.path.length <= 256).slice(0, 3)
    .map(({ path, disposition, sizeBytes, sha256, pptx }) => ({ path, disposition, sizeBytes, sha256, pptx }));
  return { key: `process:${receipt.invocationKey}`, tool: receipt.tool, command: receipt.command,
    args: args.length <= 360 ? args : `${args.slice(0, 359)}…`, cwd: clean(receipt.cwd, 180),
    exitCode: receipt.exitCode, receipt: {
      kind: receipt.kind, ...(receipt.timedOut ? { timedOut: true } : {}), ...(receipt.aborted ? { aborted: true } : {}),
      ...(receipt.signal ? { signal: receipt.signal } : {}), ...(artifacts.length ? { artifacts } : {}),
      ...(receipt.testCounts && (!receipt.outputTruncated || receipt.testReportKind === 'STRUCTURED') ? { testCounts: receipt.testCounts } : {})
    } };
}

export function rememberTaskFact(facts, fact) {
  const current = Array.isArray(facts) ? facts.filter((item) => item && item.key && item.key !== fact.key) : [];
  current.push(fact);
  return current.slice(-MAX_TASK_CONTEXT_FACTS);
}

export function renderTaskContext(facts) {
  const items = Array.isArray(facts) ? facts.filter((item) => item?.tool && (item.path || item.command)) : [];
  if (!items.length) return '';
  const recentReceipts = items.filter(fact => fact.receipt).slice(-2);
  const lines = items.map((fact) => {
    const where = fact.path || [fact.command, fact.args].filter(Boolean).join(' ');
    const extra = [
      fact.cwd ? `cwd=${fact.cwd}` : '',
      fact.digest ? `digest=${fact.digest}` : '',
      fact.exitCode !== undefined ? `exit=${fact.exitCode}` : '',
      recentReceipts.includes(fact) ? JSON.stringify(fact.receipt) : ''
    ].filter(Boolean).join(' ');
    return `- ${fact.tool} ${where}${extra ? ` ${extra}` : ''}`;
  });
  return [
    `${TASK_CONTEXT_MARKER} established results from earlier tool calls in this task.`,
    'Reuse these paths, commands, and digests for later checks and for the final answer.',
    'Do not inspect a different location for a result already recorded here.',
    ...(recentReceipts.length ? ['Summarize this step using the observed command, exit code, artifact path and disposition or test counts. Cite size, SHA-256 or slide count only as recorded. A file observation covers that path. A structural check covers the checks it ran. Claims about other files or opening a desktop application require separate observations. Carry out any verification requested for this step and identify any outstanding check.'] : []),
    ...lines
  ].join('\n');
}
