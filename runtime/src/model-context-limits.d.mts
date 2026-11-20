export const MIN_CONTEXT_LIMIT_TOKENS: number;
export const MAX_CONTEXT_LIMIT_TOKENS: number;
export const DEFAULT_CONTEXT_LIMIT_TOKENS: number;
export function parseContextLimitTokens(value: unknown): number | undefined;
export function resolveContextLimitTokens(input?: {
  modelId?: string;
  limits?: Readonly<Record<string, number>>;
}): { tokens: number; source: 'configured' | 'builtin' | 'default' };
