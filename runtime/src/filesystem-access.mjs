import { lstat, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { preferMappedPath } from './platform/workspace-path.mjs';

const MAX_PATH_CHARS = 512;
const CONTROL_RE = /[\u0000-\u001f\u007f]/u;
const SECRET_PATH = /(^|[\\/])(?:\.env(?:\.[^\\/]+)?|credentials?(?:\.[^\\/]+)?|secrets?(?:\.[^\\/]+)?|tokens?(?:\.[^\\/]+)?|passwords?(?:\.[^\\/]+)?|private(?:\.[^\\/]+)?|id_rsa(?:\.[^\\/]+)?)(?:[\\/]|$)/iu;
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export class PathAccessError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PathAccessError';
    this.code = code;
  }
}

const fail = (code) => { throw new PathAccessError(code); };
const pathKey = (value) => {
  const path = resolve(preferMappedPath(value));
  return process.platform === 'win32' ? path.toLowerCase() : path;
};

export const insideRoot = (root, candidate) => {
  const rel = relative(pathKey(root), pathKey(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export const isProtectedPath = (candidate, resolved, protectedPaths = []) =>
  protectedPaths.some((path) => typeof path === 'string' && path
    && (insideRoot(path, candidate) || insideRoot(path, resolved)));

export const currentAccessMode = async (getAccessMode) => {
  try {
    return typeof getAccessMode === 'function' && await getAccessMode() === 'FULL_ACCESS'
      ? 'FULL_ACCESS' : 'REQUIRE_APPROVAL';
  } catch {
    return 'REQUIRE_APPROVAL';
  }
};

const rejectSpecialPath = (value) => {
  if (CONTROL_RE.test(value) || value.length > MAX_PATH_CHARS) fail('SAFETY_PATH_INVALID');
  if (process.platform === 'win32') {
    if (/^(?:\\\\[?.]\\|\\\?\?\\)/u.test(value)) fail('SAFETY_PATH_INVALID');
    const withoutDrive = value.replace(/^[A-Za-z]:[\\/]/u, '');
    if (withoutDrive.includes(':')
      || withoutDrive.split(/[\\/]/u).some((part) => WINDOWS_DEVICE_RE.test(part))) {
      fail('SAFETY_PATH_INVALID');
    }
  }
  if (value.split(/[\\/]/u).some((part) => part.toLowerCase() === '.git')) {
    fail('SAFETY_WORKSPACE_GIT_METADATA');
  }
  if (SECRET_PATH.test(value)) fail('SAFETY_WORKSPACE_SENSITIVE_PATH');
};

const rejectLinkChain = async (candidate, lstatImpl) => {
  let current = candidate;
  while (true) {
    try {
      if ((await lstatImpl(current)).isSymbolicLink()) fail('SAFETY_WORKSPACE_LINK_FORBIDDEN');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
};

// A model request or an old task snapshot is never sufficient authority.
export const resolveAuthorizedPath = async (value, {
  workspaceRoot,
  getAccessMode,
  forWrite = false,
  allowEmpty = false,
  protectedPaths = [],
  realpathImpl = realpath,
  statImpl = stat,
  lstatImpl = lstat
} = {}) => {
  if (!workspaceRoot || !isAbsolute(workspaceRoot)) fail('SAFETY_WORKSPACE_REQUIRED');
  if (typeof value !== 'string') fail('SAFETY_PATH_INVALID');
  if (!value && !allowEmpty) fail('SAFETY_PATH_REQUIRED');
  rejectSpecialPath(value);
  const root = preferMappedPath(await realpathImpl(workspaceRoot));
  if (!(await statImpl(root)).isDirectory()) fail('SAFETY_WORKSPACE_NOT_FOUND');
  const lexical = resolve(root, value || '.');
  rejectSpecialPath(lexical);
  const fullAccess = await currentAccessMode(getAccessMode) === 'FULL_ACCESS';
  if (!insideRoot(root, lexical) && !fullAccess) fail('SAFETY_WORKSPACE_PATH_FORBIDDEN');
  await rejectLinkChain(lexical, lstatImpl);

  let metadata;
  let exists = true;
  try {
    metadata = await lstatImpl(lexical);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (!forWrite) fail('SAFETY_WORKSPACE_NOT_FOUND');
    exists = false;
  }
  let parent;
  let absolutePath;
  if (exists) {
    if (forWrite && !metadata.isFile()) fail('SAFETY_PATH_INVALID');
    absolutePath = preferMappedPath(await realpathImpl(lexical));
  } else {
    parent = preferMappedPath(await realpathImpl(dirname(lexical)));
    if (!(await statImpl(parent)).isDirectory()) fail('SAFETY_WORKSPACE_PARENT_NOT_FOUND');
    absolutePath = resolve(parent, basename(lexical));
  }
  rejectSpecialPath(absolutePath);
  if (!insideRoot(root, absolutePath) && !fullAccess) fail('SAFETY_WORKSPACE_PATH_FORBIDDEN');

  const protectedRoots = [];
  for (const path of protectedPaths) {
    if (typeof path !== 'string' || !path) continue;
    protectedRoots.push(path);
    try {
      protectedRoots.push(preferMappedPath(await realpathImpl(path)));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      try {
        protectedRoots.push(resolve(preferMappedPath(await realpathImpl(dirname(path))), basename(path)));
      } catch (parentError) {
        if (parentError?.code !== 'ENOENT') throw parentError;
      }
    }
  }
  if (isProtectedPath(lexical, absolutePath, protectedRoots)) fail('SAFETY_PROTECTED_PATH');
  // Recheck after asynchronous resolution so revocation cannot reuse the
  // earlier grant to start a new outside-workspace operation.
  if (!insideRoot(root, absolutePath) && await currentAccessMode(getAccessMode) !== 'FULL_ACCESS') {
    fail('SAFETY_WORKSPACE_PATH_FORBIDDEN');
  }
  return {
    root,
    path: insideRoot(root, absolutePath) ? relative(root, absolutePath).split(sep).join('/') : absolutePath,
    absolutePath,
    exists,
    ...(metadata ? { metadata } : {}),
    ...(parent ? { parent } : {})
  };
};
