const REQUIREMENT_KEYS = Object.freeze(['build', 'test', 'artifact', 'install']);
const DELIVERABLE_FORMATS = new Set(['json', 'csv', 'tsv', 'txt', 'md', 'pdf', 'docx', 'xlsx', 'pptx']);

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizePresentation = (entry) => ({
  min: Number.isInteger(entry.minSlides) && entry.minSlides > 0 && entry.minSlides <= 500 ? entry.minSlides : undefined,
  max: Number.isInteger(entry.maxSlides) && entry.maxSlides > 0 && entry.maxSlides <= 500 ? entry.maxSlides : undefined,
  sourcePage: entry.sourceSlide === 'last' || entry.sourceSlide === 'any' ? entry.sourceSlide : undefined,
  requirePath: false,
  requireUrl: false
});

const normalizeDeliverable = (entry) => {
  if (!isPlainObject(entry)) return undefined;
  if (typeof entry.path === 'string') {
    const path = entry.path.trim();
    if (path.length < 1 || path.length > 512) return undefined;
    if ([...path].some((ch) => ch.codePointAt(0) < 0x20 || ch.codePointAt(0) === 0x7f || '<>"|*?'.includes(ch))) return undefined;
    const normalized = path.replaceAll('\\', '/').replace(/^\.\//u, '');
    if (normalized.split('/').some((segment) => segment === '..')) return undefined;
    if (!/\.[a-z][a-z0-9]{0,11}$/iu.test(normalized)) return undefined;
    return { path: normalized, ...(/\.pptx$/iu.test(normalized) ? { presentation: normalizePresentation(entry) } : {}) };
  }
  if (typeof entry.format === 'string') {
    const format = entry.format.toLowerCase();
    if (!DELIVERABLE_FORMATS.has(format)) return undefined;
    const count = Number.isInteger(entry.count) ? Math.min(16, Math.max(1, entry.count)) : 1;
    return { extension: `.${format}`, count, ...(format === 'pptx' ? { presentation: normalizePresentation(entry) } : {}) };
  }
  return undefined;
};

const normalizeDeliverables = (deliverables) => {
  const seenPaths = new Set();
  const specs = [];
  for (const entry of deliverables) {
    if (specs.length >= 8) break;
    const spec = normalizeDeliverable(entry);
    if (!spec) continue;
    if (spec.path) {
      if (seenPaths.has(spec.path)) continue;
      seenPaths.add(spec.path);
    }
    specs.push(spec);
  }
  return specs;
};

export const normalizeTaskRequirements = (raw) => {
  if (!isPlainObject(raw)) return undefined;
  const declared = Array.isArray(raw.deliverables) ? normalizeDeliverables(raw.deliverables) : undefined;
  if (!REQUIREMENT_KEYS.some((key) => typeof raw[key] === 'boolean') && !Array.isArray(raw.deliverables)) return undefined;
  return {
    build: raw.build === true,
    test: raw.test === true,
    artifact: raw.artifact === true,
    install: raw.install === true,
    ...(declared ? { deliverables: declared } : {})
  };
};

export const resolveBuildTestRequirements = (declared, inferred, fromCommands = {}) => {
  if (declared === undefined) return inferred;
  return {
    build: declared.build === true || fromCommands.build === true,
    test: declared.test === true || fromCommands.test === true,
    artifact: declared.artifact === true || fromCommands.artifact === true,
    installer: inferred?.installer === true && (declared.build === true || declared.artifact === true)
  };
};
