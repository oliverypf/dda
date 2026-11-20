// Whether a side process may start while a task process is already running.
// Jev chooses one of these ids. It cannot authorize a second process that
// opens the harness database: that remains a host refusal.

export const PROCESS_ADMISSIONS = Object.freeze(['OPEN_READ_PROCESS', 'DEFER']);

export const memoryReadWithoutHarnessStore = (command, operation) => {
  const name = String(command ?? '').trim();
  if (name !== 'memory' && name !== 'memories') return false;
  const selected = String(operation ?? '').trim() || 'list';
  return selected === 'list' || selected === 'get';
};

export const ruleProcessAdmission = ({ command, operation } = {}) => memoryReadWithoutHarnessStore(command, operation)
  ? {
      decision: 'OPEN_READ_PROCESS',
      confidence: 0.9,
      source: 'rule',
      reasonCode: 'READ_WITHOUT_HARNESS_STORE',
      fallbackUsed: false
    }
  : {
      decision: 'DEFER',
      confidence: 1,
      source: 'rule',
      reasonCode: 'HARNESS_STORE_HELD_BY_TASK',
      fallbackUsed: false
    };
