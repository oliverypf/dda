import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { projectPaths } from './windows-path.mjs';

const { desktopRoot } = projectPaths(import.meta.url);
const root = resolve(desktopRoot, 'dist');
const host = process.env.HMCODEX_HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 1420);

const contentTypes = {
  '.css': 'text/css; charset=UTF-8',
  '.html': 'text/html; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.map': 'application/json; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const resolveRequest = (pathname) => {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;

  // The MVP is a single-page app; route-like paths still use the entry document.
  if (!extname(relativePath)) return resolve(root, 'index.html');
  return null;
};

const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', `http://${host}`).pathname;
  const filePath = resolveRequest(pathname);
  if (!filePath) {
    response.statusCode = 404;
    response.end('Not found');
    return;
  }

  try {
    response.statusCode = 200;
    response.setHeader('Content-Type', contentTypes[extname(filePath)] ?? 'application/octet-stream');
    response.setHeader('Cache-Control', 'no-store');
    response.end(readFileSync(filePath));
  } catch {
    response.statusCode = 500;
    response.end('Unable to read file');
  }
});

server.listen(port, host, () => {
  console.log(`dda static preview: http://${host}:${port}/`);
});
