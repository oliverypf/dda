// Operator-facing continuous-verifier configuration.
//
// The runtime owns the authoritative validation
// (`runtime/src/model-config.mjs` -> `normalizeContinuousVerifierConfig`). The
// bounds are mirrored here because the desktop writes the model config file:
// a value the runtime rejects would make every later runtime start fail closed
// on that file, so the form refuses it before it is written.
export interface ContinuousVerifierConfig {
  criteria?: string[];
  repetitions?: number;
  maxComparisons?: number;
  pivots?: number;
  seed?: string;
  maxPromptChars?: number;
  passThreshold?: number;
  failThreshold?: number;
}

// Kept in sync with `PROCESS_VERDICT_THRESHOLDS` and the normaliser defaults so
// a partially filled form is cross-checked against the same numbers the
// runtime would apply to the omitted fields.
export const VERIFIER_DEFAULTS = Object.freeze({
  repetitions: 2,
  maxComparisons: 32,
  pivots: 2,
  maxPromptChars: 60000,
  passThreshold: 0.9,
  failThreshold: 0.5
});

export const VERIFIER_CRITERIA_MAX_ITEMS = 8;
export const VERIFIER_CRITERIA_MAX_CHARS = 1000;
export const VERIFIER_SEED_MAX_CHARS = 200;

export type VerifierFormValues = Record<string, string>;

export type VerifierFormParse =
  | { ok: true; verifier?: ContinuousVerifierConfig }
  | { ok: false; error: string };

const formFields = [
  'verifierCriteria',
  'verifierRepetitions',
  'verifierMaxComparisons',
  'verifierPivots',
  'verifierSeed',
  'verifierMaxPromptChars',
  'verifierPassThreshold',
  'verifierFailThreshold'
] as const;

export const emptyVerifierFormValues = (): VerifierFormValues => {
  const values: VerifierFormValues = {};
  for (const field of formFields) values[field] = '';
  return values;
};

export const formatVerifierFormValues = (verifier?: ContinuousVerifierConfig): VerifierFormValues => {
  const values = emptyVerifierFormValues();
  if (!verifier) return values;
  values.verifierCriteria = (verifier.criteria ?? []).join('\n');
  values.verifierRepetitions = verifier.repetitions === undefined ? '' : String(verifier.repetitions);
  values.verifierMaxComparisons = verifier.maxComparisons === undefined ? '' : String(verifier.maxComparisons);
  values.verifierPivots = verifier.pivots === undefined ? '' : String(verifier.pivots);
  values.verifierSeed = verifier.seed ?? '';
  values.verifierMaxPromptChars = verifier.maxPromptChars === undefined ? '' : String(verifier.maxPromptChars);
  values.verifierPassThreshold = verifier.passThreshold === undefined ? '' : String(verifier.passThreshold);
  values.verifierFailThreshold = verifier.failThreshold === undefined ? '' : String(verifier.failThreshold);
  return values;
};

export const parseVerifierFormValues = (values: VerifierFormValues): VerifierFormParse => {
  const read = (field: string): string => (values[field] ?? '').trim();

  const criteriaLines = read('verifierCriteria')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (criteriaLines.length > VERIFIER_CRITERIA_MAX_ITEMS) {
    return { ok: false, error: `连续验证判定标准最多 ${VERIFIER_CRITERIA_MAX_ITEMS} 条` };
  }
  if (criteriaLines.some((line) => line.length > VERIFIER_CRITERIA_MAX_CHARS)) {
    return { ok: false, error: `连续验证判定标准单条最长 ${VERIFIER_CRITERIA_MAX_CHARS} 字符` };
  }

  const integer = (field: string, label: string, minimum: number, maximum: number): number | undefined | Error => {
    const raw = read(field);
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
      return new Error(`${label} 必须是 ${minimum} 到 ${maximum} 之间的整数`);
    }
    return value;
  };

  const integerFields: Array<[string, string, number, number]> = [
    ['verifierRepetitions', '连续验证重复次数', 1, 16],
    ['verifierMaxComparisons', '连续验证最大比较数', 1, 512],
    ['verifierPivots', '连续验证支点数', 1, 8],
    ['verifierMaxPromptChars', '连续验证提示长度上限', 1024, 200000]
  ];
  const parsedIntegers = new Map<string, number | undefined>();
  for (const [field, label, minimum, maximum] of integerFields) {
    const parsed = integer(field, label, minimum, maximum);
    if (parsed instanceof Error) return { ok: false, error: parsed.message };
    parsedIntegers.set(field, parsed);
  }

  const seed = read('verifierSeed');
  if (seed.length > VERIFIER_SEED_MAX_CHARS) {
    return { ok: false, error: `连续验证随机种子最长 ${VERIFIER_SEED_MAX_CHARS} 字符` };
  }

  const threshold = (field: string, label: string): number | undefined | Error => {
    const raw = read(field);
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      return new Error(`${label} 必须是 0 到 1 之间的数字`);
    }
    return value;
  };
  const parsedPass = threshold('verifierPassThreshold', '连续验证 PASS 阈值');
  if (parsedPass instanceof Error) return { ok: false, error: parsedPass.message };
  const parsedFail = threshold('verifierFailThreshold', '连续验证 FAIL 阈值');
  if (parsedFail instanceof Error) return { ok: false, error: parsedFail.message };
  // The runtime normalises the omitted side to its default before it checks the
  // ordering, so an inverted pair must be refused even when only one is typed.
  const effectivePass = parsedPass ?? VERIFIER_DEFAULTS.passThreshold;
  const effectiveFail = parsedFail ?? VERIFIER_DEFAULTS.failThreshold;
  if (effectivePass <= effectiveFail) {
    return { ok: false, error: '连续验证 PASS 阈值必须大于 FAIL 阈值' };
  }

  const verifier: ContinuousVerifierConfig = {};
  if (criteriaLines.length > 0) verifier.criteria = criteriaLines;
  const repetitions = parsedIntegers.get('verifierRepetitions');
  if (repetitions !== undefined) verifier.repetitions = repetitions;
  const maxComparisons = parsedIntegers.get('verifierMaxComparisons');
  if (maxComparisons !== undefined) verifier.maxComparisons = maxComparisons;
  const pivots = parsedIntegers.get('verifierPivots');
  if (pivots !== undefined) verifier.pivots = pivots;
  if (seed) verifier.seed = seed;
  const maxPromptChars = parsedIntegers.get('verifierMaxPromptChars');
  if (maxPromptChars !== undefined) verifier.maxPromptChars = maxPromptChars;
  if (parsedPass !== undefined) verifier.passThreshold = parsedPass;
  if (parsedFail !== undefined) verifier.failThreshold = parsedFail;
  return { ok: true, verifier: Object.keys(verifier).length > 0 ? verifier : undefined };
};
