import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig } from 'vite';
import { projectPaths } from './scripts/windows-path.mjs';

// Keep Vite/Vitest and the helper scripts on the same mapped-drive-aware root.
// In particular, do not derive the root solely from import.meta.url: Node may
// canonicalise that URL to the UNC spelling of an active mapped drive.
const { desktopRoot } = projectPaths(import.meta.url);
const indexPath = join(desktopRoot, 'index.html');

export default defineConfig({
  clearScreen: false,
  // Prefer the active mapped drive when the repository is opened from a UNC
  // share. Keeping the root dynamic also makes packaged/local checkouts work.
  root: desktopRoot,
  plugins: [
    {
      name: 'mapped-drive-index',
      configureServer(server) {
        // Vite's HTML middleware calls fs.realpathSync.native on this mapped drive,
        // which can block for many seconds even though direct reads work normally.
        // Serve the tiny entry document directly and leave JS/CSS handling to Vite.
        server.middlewares.use((request, response, next) => {
          const pathname = (request.url ?? '/').split('?', 1)[0];
          if (pathname !== '/' && pathname !== '/index.html') {
            next();
            return;
          }

          try {
            const html = readFileSync(indexPath, 'utf8');
            response.statusCode = 200;
            response.setHeader('Content-Type', 'text/html; charset=UTF-8');
            response.setHeader('Cache-Control', 'no-store');
            response.end(html);
          } catch {
            next();
          }
        });
      }
    }
  ],
  // Automatic dependency discovery scans the mapped node_modules tree and can
  // block the first browser request. The app imports only explicit ESM modules.
  optimizeDeps: {
    noDiscovery: true
  },
  server: {
    strictPort: true,
    host: '127.0.0.1',
    port: 1420,
    watch: {
      usePolling: true,
      interval: 250
    }
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    sourcemap: true
  }
});
