import { util } from '@kit.ArkTS';
import { BusinessError } from '@kit.BasicServicesKit';
import { parse } from '../vendor/acorn/acorn.js';
import { LocalWorkspace, workspaceParts } from './LocalWorkspace';

interface ParserLocation {
  line: number;
  column: number;
}

interface ParserError extends Error {
  loc?: ParserLocation;
}

interface PackageManifest {
  type?: string;
}

// Parse ECMAScript 2024, including a leading hashbang. .cjs always uses
// Script grammar; .mjs uses Module grammar (including top-level await).
// File-local syntax only: imports are parsed without resolving or loading.
export function checkJavaScript(path: string, source: string, declaredModule: boolean = false): string {
  if (!/\.(?:js|cjs|mjs)$/.test(path)) { return path + ': 请指定 .js、.cjs 或 .mjs 文件\n'; }
  if (util.TextEncoder.create().encodeInto(source).length > 64 * 1024) {
    return path + ': 单次语法检查最多支持 64 KiB UTF-8 文本\n';
  }
  try {
    const isModule = path.endsWith('.mjs') || (path.endsWith('.js') && declaredModule);
    parse(source, { ecmaVersion: 2024, sourceType: isModule ? 'module' : 'script' });
    return '';
  } catch (err) {
    const error = err as ParserError;
    if (!error.loc) { return path + ': 解析器未能完成检查，输入可能嵌套过深\n'; }
    const message = error.message.replace(/\s*\(\d+:\d+\)$/, '').replace(/[\u0000-\u001F\u007F]/g, ' ').slice(0, 180);
    // Acorn's column is zero-based. Both diagnostic coordinates are one-based.
    return path + ':' + error.loc.line + ':' + (error.loc.column + 1) + ': ' + message + '\n';
  }
}

export async function checkProjectJavaScript(workspace: LocalWorkspace, path: string, source: string): Promise<string> {
  if (!path.endsWith('.js')) { return checkJavaScript(path, source); }
  // Only the closest in-project manifest supplies the grammar for .js.
  // A manifest without a type starts a fresh Script scope.
  const parts = workspaceParts(path);
  parts.pop();
  while (true) {
    const filename = '/' + parts.concat(['package.json']).join('/');
    let manifest: string;
    try {
      manifest = await workspace.read(filename);
    } catch (err) {
      if ((err as BusinessError).code !== 13900002) { return filename + ': 无法读取项目的包配置\n'; }
      if (!parts.length) { return checkJavaScript(path, source); }
      parts.pop();
      continue;
    }
    try {
      const pkg = JSON.parse(manifest.replace(/^\uFEFF/, '')) as PackageManifest;
      if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
        return filename + ': 包配置必须是 JSON 对象\n';
      }
      if (pkg.type !== undefined && !['module', 'commonjs'].includes(pkg.type)) {
        return filename + ': 包配置 type 应为 module 或 commonjs\n';
      }
      return checkJavaScript(path, source, pkg.type === 'module');
    } catch (_) {
      return filename + ': 包配置的 JSON 语法无效\n';
    }
  }
}
