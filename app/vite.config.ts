import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

const MODELS_REL = 'public/models';
const PATTERN = /\.(png|jpe?g|webp)$/i;

function scanModels(dir: string) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => PATTERN.test(f))
    .sort()
    .map((f) => {
      const stat = fs.statSync(path.join(dir, f));
      return { url: `/models/${f}`, mtime: Math.floor(stat.mtimeMs) };
    });
}

// dev-only: serve a live listing of /public/models so adding/removing files
// reflects without restarting Vite (the build-time `define` snapshot is
// frozen at config load and can't be re-evaluated by HMR).
function modelsApiPlugin(): Plugin {
  return {
    name: 'mock-research-models-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      const dir = path.resolve(__dirname, MODELS_REL);
      // use() called synchronously here registers the middleware BEFORE
      // Vite's internal transformIndexHtml + spa-fallback. Returning a
      // function would register AFTER, and the html fallback would win.
      server.middlewares.use((req, res, next) => {
        if (req.url && req.url.startsWith('/api/models')) {
          try {
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Cache-Control', 'no-store');
            res.end(JSON.stringify(scanModels(dir)));
          } catch (e) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(e) }));
          }
          return;
        }
        next();
      });
      if (fs.existsSync(dir)) {
        // fs.watch fires for create/delete/rename; debounce a touch so
        // batched filesystem ops broadcast once.
        let pending: NodeJS.Timeout | null = null;
        fs.watch(dir, { persistent: false }, () => {
          if (pending) clearTimeout(pending);
          pending = setTimeout(() => {
            server.ws.send({ type: 'custom', event: 'models-changed' });
          }, 80);
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), modelsApiPlugin()],
  server: { port: 5174, strictPort: true },
  define: {
    // Build-time snapshot — used by production bundles (no dev API there).
    __MODELS__: JSON.stringify(
      scanModels(path.resolve(__dirname, MODELS_REL))
    ),
  },
});
