/**
 * The semantic verifier is evidence, not authorization. For high-risk work it
 * must also be operationally independent from the executor's provider, or the
 * result must fail closed before any success claim is recorded.
 */
export const isHighRiskTask = ({ mode, taskClass } = {}) =>
  mode === 'CONTROLLED' || ['modify', 'test'].includes(taskClass);

export const evaluateSemanticVerifierIndependence = ({
  mode,
  taskClass,
  executorBinding,
  semanticBinding,
  executorProvider,
  semanticProvider,
  executorModel,
  semanticModel
} = {}) => {
  const required = isHighRiskTask({ mode, taskClass });
  const modelIsDifferent = executorModel?.provider !== semanticModel?.provider
    || executorModel?.model !== semanticModel?.model;
  const satisfied = !required || Boolean(
    semanticBinding?.kind === 'MODEL'
    && semanticProvider
    && executorBinding?.kind === 'MODEL'
    && semanticProvider !== executorProvider
    && semanticBinding.modelId !== executorBinding.modelId
    && modelIsDifferent
  );
  return {
    required,
    satisfied,
    ...(required && !satisfied ? { reasonCode: 'SEMANTIC_VERIFIER_INDEPENDENCE_REQUIRED' } : {})
  };
};
