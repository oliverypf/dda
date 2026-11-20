/**
 * Bounded failure tail for process tools. When both streams carry output the
 * tail is a labeled two-section block — stderr warnings get roughly half the
 * budget, and stdout's tail sits at the end where `failures:`/`error` lines
 * the reviewer needs actually land. A single stream keeps the plain tail.
 */
export const processFailureOutputTail = (output, limit = 800) => {
  if (!Number.isInteger(limit) || limit < 1) return '';
  const stdout = typeof output?.stdout === 'string' && output.stdout ? output.stdout : '';
  const stderr = typeof output?.stderr === 'string' && output.stderr ? output.stderr : '';
  if (!stdout && !stderr) return '';
  if (!stderr) return stdout.slice(-limit);
  if (!stdout) return stderr.slice(-limit);
  const stderrLabel = '[stderr]\n';
  const stdoutLabel = '\n[stdout]\n';
  const budget = Math.max(0, limit - stderrLabel.length - stdoutLabel.length);
  const tail = (text, size) => (size > 0 ? text.slice(-size) : '');
  const stderrText = tail(stderr, Math.floor(budget / 2));
  const stdoutText = tail(stdout, budget - stderrText.length);
  // The cap applies to the labeled block as a whole — a limit smaller than
  // the label overhead can never emit an unbounded stream.
  return `${stderrLabel}${stderrText}${stdoutLabel}${stdoutText}`.slice(-limit);
};
