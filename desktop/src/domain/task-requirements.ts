const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const clean = (value: string): string =>
  [...value].filter((ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  }).join('').slice(0, 120);

export const requirementsSummary = (value: unknown): string => {
  if (!isPlainObject(value)) return '';
  const labels: string[] = [];
  if (value.build === true) labels.push('构建');
  if (value.test === true) labels.push('测试');
  if (value.artifact === true) labels.push('构建产物');
  if (value.install === true) labels.push('安装');
  if (Array.isArray(value.deliverables)) {
    for (const entry of value.deliverables.slice(0, 8)) {
      if (!isPlainObject(entry)) continue;
      if (typeof entry.path === 'string') labels.push(`交付文件 ${clean(entry.path)}`);
      else if (typeof entry.extension === 'string') {
        const count = Number.isInteger(entry.count) ? entry.count as number : 1;
        labels.push(`${count} 个 ${clean(entry.extension)} 文件`);
      }
    }
  }
  return labels.length
    ? `主机核对项：${labels.join('、')}`
    : '主机核对项：无（本次不要求构建、测试、安装或交付文件）';
};
