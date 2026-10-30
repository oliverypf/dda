import { describe, expect, it } from 'vitest';
import rawMainSource from '../main.ts?raw';

const mainSource = rawMainSource.replace(/\r\n/g, '\n');

// lucide's replaceElement looks icons up by PascalCase of the data-lucide name.
const pascal = (name: string): string => name.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');

describe('settings sidebar icons', () => {
  const sections = mainSource.slice(mainSource.indexOf('const settingsSections = {'));
  const sectionBlock = sections.slice(0, sections.indexOf('\n};'));
  const iconNames = [...sectionBlock.matchAll(/icon: '([a-z0-9-]+)'/g)].map((match) => match[1]);
  const mapStart = mainSource.indexOf('  createIcons({\n    icons: {');
  const iconMap = mainSource.slice(mapStart, mainSource.indexOf('\n  });', mapStart));
  const registered = new Set([...iconMap.matchAll(/^\s+([A-Z][A-Za-z0-9]*)(?=[,:\n])/gm)].map((match) => match[1]));

  it('finds every section icon (including jev and cells)', () => {
    expect(iconNames.length).toBeGreaterThanOrEqual(14);
    expect(iconNames).toContain('waypoints');
    expect(sectionBlock).toMatch(/cells: \{[^}]*icon: '/);
  });

  it.each(iconNames.length ? iconNames : ['__none__'])('registers %s in the main createIcons map', (name) => {
    expect(registered.has(pascal(name))).toBe(true);
  });
});
