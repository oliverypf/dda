import { realpath, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const optional = async (operation) => {
  try { return await operation(); } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
};
const key = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);

export async function assertProjectionOutput(outputPath, protectedPaths, errorCode = 'READ_MODEL_OUTPUT_CONFLICT') {
  if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('READ_MODEL_OUTPUT_REQUIRED');
  const outputReal = await optional(() => realpath(outputPath));
  const outputStat = await optional(() => stat(outputPath, { bigint: true }));
  for (const sourcePath of protectedPaths.filter(Boolean)) {
    if (key(outputPath) === key(sourcePath)) throw new Error(errorCode);
    const sourceReal = await optional(() => realpath(sourcePath));
    if (outputReal && sourceReal && key(outputReal) === key(sourceReal)) throw new Error(errorCode);
    const sourceStat = await optional(() => stat(sourcePath, { bigint: true }));
    if (outputStat && sourceStat && outputStat.ino !== 0n
      && outputStat.dev === sourceStat.dev && outputStat.ino === sourceStat.ino) throw new Error(errorCode);
  }
}
