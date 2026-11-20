/**
 * Failures already recorded with a definite reason. onLeaseConsumed revokes
 * the lease and fails the intent before throwing; onLeaseFailed must not
 * report them again as EXECUTION_OUTCOME_UNCERTAIN. Ordinary network and
 * file effects do not set the crash-journal bit, so this classification
 * cannot depend on that journal.
 */
export const isClassifiedLeaseFailure = (errorCode) => errorCode === 'SCOPE_VIOLATION';
