import { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

let detectedMappings;

const normalizeWindowsPath = (value) => String(value ?? '')
  .replaceAll('/', '\\')
  .replace(/^\\\\\?\\UNC\\/i, '\\\\')
  .replace(/^\\\\\?\\/i, '')
  .replace(/[\\]+$/u, '')
  .toLowerCase();

const uncParts = (value) => {
  const raw = String(value ?? '').replaceAll('/', '\\');
  const withoutDevicePrefix = raw.replace(/^\\\\\?\\UNC\\/i, '\\\\');
  if (!withoutDevicePrefix.startsWith('\\\\')) return undefined;
  const parts = withoutDevicePrefix.slice(2).split('\\');
  if (parts.length < 2 || !parts[0] || !parts[1]) return undefined;
  const root = `\\\\${parts[0]}\\${parts[1]}`;
  const suffix = parts.slice(2).filter(Boolean).join('\\');
  return { root, suffix: suffix ? `\\${suffix}` : '' };
};

const detectMappings = () => {
  if (detectedMappings) return detectedMappings;
  const configured = process.env.HMCODEX_MAPPED_DRIVES;
  const output = configured
    ? configured
    : spawnSync('net.exe', ['use'], { encoding: 'utf8', windowsHide: true, timeout: 2000 }).stdout ?? '';
  const drives = [...String(output).matchAll(/(?:^|\s)([A-Z]):(?=\s|$)/gim)]
    .map((match) => match[1].toUpperCase());
  detectedMappings = [...new Set(drives)].flatMap((drive) => {
    try {
      return [{ drive, root: realpathSync.native(`${drive}:\\`) }];
    } catch {
      return [];
    }
  });
  return detectedMappings;
};

/**
 * Keep the fastest spelling of a Windows network path. A mapped drive is
 * selected only when its native root is the exact UNC server/share root, so
 * a matching suffix can never redirect to an unrelated drive.
 */
export const preferMappedPath = (value, { platform = process.platform, mappings } = {}) => {
  if (platform !== 'win32' || typeof value !== 'string') return value;
  if (/^[A-Za-z]:[\\/]/u.test(value)) return value;
  const parts = uncParts(value);
  if (!parts) return value;
  const expectedRoot = normalizeWindowsPath(parts.root);
  for (const mapping of mappings ?? detectMappings()) {
    if (normalizeWindowsPath(mapping.root) === expectedRoot) {
      return `${mapping.drive}:${parts.suffix}`;
    }
  }
  return value;
};

/** Resolve an existing path while preserving a mapped-drive spelling. */
export const canonicalMappedPath = (value, options = {}) => {
  if (typeof value !== 'string' || !value.trim()) return '';
  const resolved = resolve(value);
  try {
    return preferMappedPath(realpathSync.native(resolved), options);
  } catch {
    return preferMappedPath(resolved, options);
  }
};

export const resetDetectedMappingsForTest = () => {
  detectedMappings = undefined;
};
