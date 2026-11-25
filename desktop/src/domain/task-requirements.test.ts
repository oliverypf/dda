import { describe, expect, it } from 'vitest';
import { requirementsSummary } from './task-requirements';

describe('requirementsSummary', () => {
  it('is empty for non-objects', () => {
    expect(requirementsSummary(undefined)).toBe('');
    expect(requirementsSummary(['build'])).toBe('');
    expect(requirementsSummary('build')).toBe('');
  });

  it('states none when nothing is required', () => {
    expect(requirementsSummary({ build: false, test: false, artifact: false, install: false, deliverables: [] }))
      .toBe('主机核对项：无（本次不要求构建、测试、安装或交付文件）');
    expect(requirementsSummary({})).toBe('主机核对项：无（本次不要求构建、测试、安装或交付文件）');
  });

  it('lists flags and deliverables in order', () => {
    expect(requirementsSummary({
      build: true, test: false, artifact: true, install: false,
      deliverables: [{ path: 'docs/a.pptx' }, { extension: '.json', count: 2 }]
    })).toBe('主机核对项：构建、构建产物、交付文件 docs/a.pptx、2 个 .json 文件');
  });
});
