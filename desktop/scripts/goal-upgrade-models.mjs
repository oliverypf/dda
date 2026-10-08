export const resolveUpgradeModels = (config, { activeModel, strongModel } = {}) => {
  const records = config.models ?? [];
  const fromId = id => records.find(record => [record.id, record.modelId, record.model].includes(id));
  const activeId = activeModel ?? config.roleBindings?.executor?.modelId ?? config.model;
  const strongId = strongModel ?? config.roleBindings?.critic?.modelId;
  if (!strongId) throw Error('UPGRADE_STRONG_MODEL_REQUIRED');
  const route = id => {
    const record = fromId(id);
    const model = record?.model ?? id;
    const value = { ...config, ...record, model };
    if (!['chat-completions'].includes(value.protocol)) throw Error('UPGRADE_REQUIRES_CHAT_COMPLETIONS_ROUTES');
    if (!value.apiKeyEnv || !(value.endpoint || value.baseURL)) throw Error('UPGRADE_MODEL_ROUTE_INCOMPLETE');
    return value;
  };
  const active = route(activeId), strong = route(strongId);
  if (active.model === strong.model) throw Error('UPGRADE_REQUIRES_DISTINCT_ACTUAL_MODELS');
  return { active, strong };
};
export const automaticStrongSelectionProven = ({ events = [], decisions = [], actualStrongExecutor, finalSuccess }) => {
  const unwrap = event => event.payload?.payload ?? event.payload ?? {};
  return actualStrongExecutor === true && finalSuccess === true
    && events.some(event => event.kind === 'DecisionLayerEvaluated' && unwrap(event).source === 'jev' && unwrap(event).action === 'ESCALATE')
    && decisions.some(decision => decision.decisionType === 'SELECT_SAFE_MODEL_FALLBACK'
      && decision.selectedOptionId === 'strong-model' && decision.reasonCodes?.includes('JEV_DECISION'));
};
